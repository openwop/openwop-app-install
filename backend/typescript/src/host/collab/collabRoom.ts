/**
 * Collaboration ROOM — per-instance Yjs sync + snapshot persistence (ADR 0335
 * Phase 1b-i). The backend is SCHEMA-AGNOSTIC: it never interprets document
 * content — it relays Yjs sync/update/awareness bytes between the sockets in a
 * room and persists the merged Y.Doc state as an opaque snapshot. The FE seeds a
 * fresh room by syncing its loaded document in on first bind (Phase 2), so the
 * backend needs no ProseMirror schema.
 *
 * Cross-instance fan-out is Phase 1b-ii (Postgres NOTIFY, signal-not-payload —
 * the NOTIFY 8 KB cap). Until then a room is single-instance; with the toggle OFF
 * (dormant) that is safe, and the enable-gate forbids prod-enable before fan-out.
 *
 * Echo-prevention (architect-required): a local Y.Doc `update` is broadcast to
 * peers ONLY when its transaction origin is a local socket — never when it is the
 * REMOTE sentinel (an applied peer/fan-out update), so applying a received update
 * never re-emits it.
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { DurableCollection, publishHostExtEvent, subscribeHostExtEvent } from '../hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { collabCanvasType } from './collabRegistry.js';
import { defaultDeriveState, replaceRootFromState, type CollabShape } from './collabStateMirror.js';
import { getCanvasForTenant, updateCanvasForTenant, pruneConsecutiveCollabVersions } from '../canvasSurface.js';

const log = createLogger('host.collab.room');

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
/** Transaction origin for updates we APPLIED from a peer — never re-broadcast. */
const REMOTE = Symbol('collab-remote');
const SAVE_DEBOUNCE_MS = 2000;

/** Rows created before tenant tagging (or by test seams) index under this
 *  sentinel — never a real tenant, so teardown purges can never mis-match. */
const UNTAGGED_TENANT = 'untenanted';

/** Registered by collabServer (which owns the seed-claim collection; importing
 *  it here would cycle): restores the claim when a live room survives a store
 *  invalidation, so a later opener can't win a second seed into the non-empty
 *  room (grade pass 3 F1). */
let restoreSeedClaim: ((tenantId: string, canvasId: string) => Promise<void>) | null = null;
export function setSeedClaimRestorer(fn: (tenantId: string, canvasId: string) => Promise<void>): void {
  restoreSeedClaim = fn;
}

// ADR 0359 grade pass (DATA-B3 + N6): rows carry the tenant (so account/tenant
// teardown's purge matches them — snapshot blobs are DOCUMENT CONTENT and must
// honor erasure) and a persistence-boundary validator (a corrupt row is an
// observable skip, not a silent empty room). `tenantId` is optional in the
// TYPE only for pre-tag rows (none in prod — the toggle never shipped ON);
// every new persist writes it, so the store self-heals.
interface CollabSnapshot { canvasId: string; tenantId?: string; state: string; updatedAt: string }
const snapshots = new DurableCollection<CollabSnapshot>(
  'collab:snapshot',
  (s) => s.canvasId,
  (parsed) => {
    const p = parsed as Partial<CollabSnapshot> | null;
    if (!p || typeof p.canvasId !== 'string' || !p.canvasId || typeof p.state !== 'string' || !p.state || typeof p.updatedAt !== 'string') return null;
    return { canvasId: p.canvasId, ...(typeof p.tenantId === 'string' ? { tenantId: p.tenantId } : {}), state: p.state, updatedAt: p.updatedAt };
  },
  (s) => s.tenantId ?? UNTAGGED_TENANT,
);

// ── Phase 1b-ii — cross-instance fan-out (signal-not-payload) ──────────────
// The Postgres NOTIFY payload is capped at 8 KB, and a Yjs update can exceed it,
// so we NEVER put the update in the notification: we write it to a durable store
// keyed by an id and NOTIFY only {canvasId, updateId, originId}. A receiver on
// another instance fetches the update and applies it. Reuses the storage pub/sub
// (`publishHostExtEvent` — one multiplexed, self-healing LISTEN connection per
// instance on Postgres; an in-process emitter on memory/sqlite).
const FANOUT_CHANNEL = 'collab.update';
/** Per-process id — distinguishes this instance's own NOTIFYs (echo guard). */
const INSTANCE_ID = randomUUID();
/** How long a fanned-out update row lingers for peers to fetch before the writer prunes it. */
const FANOUT_PRUNE_MS = 30_000;
interface CollabUpdate { updateId: string; canvasId: string; tenantId?: string; update: string; createdAt: string }
const collabUpdates = new DurableCollection<CollabUpdate>('collab:update', (u) => u.updateId, undefined, (u) => u.tenantId ?? UNTAGGED_TENANT);
let fanoutSubscribed = false;

/** Publish a genuinely-local edit to the other instances (signal-not-payload). */
async function publishUpdate(canvasId: string, update: Uint8Array, tenantId?: string): Promise<void> {
  try {
    const updateId = randomUUID();
    await collabUpdates.put({ updateId, canvasId, ...(tenantId ? { tenantId } : {}), update: Buffer.from(update).toString('base64'), createdAt: new Date().toISOString() });
    await publishHostExtEvent(FANOUT_CHANNEL, JSON.stringify({ canvasId, updateId, originId: INSTANCE_ID }));
    // Best-effort self-prune (peers have fetched by now). A writer crash orphans
    // a small row — a periodic sweep is a documented follow-up.
    setTimeout(() => { void collabUpdates.delete(updateId).catch(() => undefined); }, FANOUT_PRUNE_MS);
  } catch (err) {
    log.warn('collab fanout publish failed', { canvasId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Apply a fanned-out update from ANOTHER instance to a locally-held room. */
async function onFanoutNotify(payload: string): Promise<void> {
  try {
    const { canvasId, updateId, originId } = JSON.parse(payload) as { canvasId: string; updateId: string; originId: string };
    if (originId === INSTANCE_ID) return;      // our own edit — echo guard
    const room = rooms.get(canvasId);
    if (!room) return;                          // no local subscribers on this instance
    const row = await collabUpdates.get(updateId);
    if (!row) return;                           // already pruned / not yet visible
    Y.applyUpdate(room.doc, Buffer.from(row.update, 'base64'), REMOTE); // REMOTE ⇒ not re-fanned
  } catch (err) {
    log.warn('collab fanout apply failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Subscribe to the fan-out channels once per instance (idempotent). */
export async function initCollabFanout(): Promise<void> {
  if (fanoutSubscribed) return;
  fanoutSubscribed = true;
  try {
    await subscribeHostExtEvent(FANOUT_CHANNEL, (p) => { void onFanoutNotify(p); });
    // ADR 0359 grade pass (B1) — external host.canvas writes reach every
    // instance's copy of a live room, not just the write-serving instance.
    await subscribeHostExtEvent(EXTWRITE_CHANNEL, (p) => { void onExtWriteNotify(p); });
  }
  catch (err) { fanoutSubscribed = false; log.warn('collab fanout subscribe failed', { error: err instanceof Error ? err.message : String(err) }); }
}

// ── ADR 0359 Phase 1 — orphaned-update sweep ───────────────────────────────
// `publishUpdate` self-prunes its row after FANOUT_PRUNE_MS, but a writer crash
// between put and the timer leaves the row forever. A periodic sweep deletes
// rows old enough that every peer has long since fetched them. The collection
// is tiny and transient (rows live ~30 s), so the bounded-cadence full list()
// is cheap.
const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Rows older than this are unquestionably orphans (≫ FANOUT_PRUNE_MS). */
const SWEEP_ORPHAN_AGE_MS = 2 * FANOUT_PRUNE_MS;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export async function sweepOrphanedCollabUpdates(now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    const rows = await collabUpdates.list();
    for (const row of rows) {
      const age = now - Date.parse(row.createdAt);
      if (Number.isFinite(age) && age > SWEEP_ORPHAN_AGE_MS) {
        if (await collabUpdates.delete(row.updateId)) removed += 1;
      }
    }
    if (removed > 0) log.info('collab update sweep pruned orphans', { removed });
    // ADR 0359 grade pass (B1) — expired liveness leases (an instance crash
    // skips the evict delete) are pruned on the same cadence; TTL guards
    // correctness, this only reclaims the rows.
    for (const lease of await leases.list()) {
      const expired = now - Date.parse(lease.expiresAt);
      if (Number.isFinite(expired) && expired > SWEEP_ORPHAN_AGE_MS) await leases.delete(lease.id);
    }
  } catch (err) {
    log.warn('collab update sweep failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return removed;
}

/** Start the periodic sweep (idempotent; unref'd so it never holds the process open). */
export function startCollabUpdateSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweepOrphanedCollabUpdates(); }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Test-only: stop the sweep timer. */
export function __stopCollabUpdateSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

/** Set at (every) authorized join — the derive path needs tenant + type.
 *  ADR 0481: `resource` marks a NON-canvas room (today: 'workflow'); its
 *  derive dispatches to the registered resource driver and every
 *  canvas-specific branch (extwrite reapply, invalidation reseed) is inert. */
export interface RoomMeta { tenantId: string; canvasTypeId?: string; resource?: 'workflow' }

/** ADR 0481 — a non-canvas resource's derive authority (the workflow head
 *  writer). Registered at module load by the owning host module (the
 *  setSeedClaimRestorer pattern — importing it here would cycle). The room
 *  calls it under the SAME 5-min floor + evict-force discipline as the
 *  canvas derive; the driver owns validation (failing ⇒ SKIP, stale beats
 *  invalid) and the full save-path pairing. */
export interface CollabResourceDriver {
  derive(roomId: string, doc: Y.Doc, meta: RoomMeta, force: boolean): Promise<void>;
}
const resourceDrivers = new Map<string, CollabResourceDriver>();
export function registerCollabResourceDriver(resource: string, driver: CollabResourceDriver): void {
  resourceDrivers.set(resource, driver);
}

interface Room {
  doc: Y.Doc;
  awareness: Awareness;
  conns: Set<WebSocket>;
  /** Awareness client ids each connection controls — so a disconnect clears
   *  exactly that client's remote cursor (the y-websocket pattern), not the
   *  server's own clientID. */
  controlled: Map<WebSocket, Set<number>>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  meta: RoomMeta | null;
  /** ADR 0359 Phase 6 — last host.canvas derive (the 5-min floor). */
  lastDeriveAt: number;
  /** COLLAB-5 — the snapshot row this room last read/wrote (the CAS baseline).
   *  Null ⇒ the next persist is an insert-if-absent. */
  lastSnapshot: CollabSnapshot | null;
  /** Grade pass 3b — consecutive CAS misses (convergence observability +
   *  reschedule backoff; reset on a successful swap). */
  persistMisses: number;
}

/** ADR 0359 Phase 6 — the server-origin sentinel for apply-into-room writes:
 *  relayed to local sockets + fanned out (origin ≠ REMOTE), never treated as
 *  a peer echo. */
const SERVER = Symbol('collab-server');
/** Coarse periodic floor for live-session host.canvas derives; evict forces. */
const DERIVE_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Derive host.canvas from the room's live CRDT (ADR 0359 D6): element types
 * materialize the root map; `canvas.document` uses its registered
 * model-specific derive. Version provenance = `capturedBy: 'collab'`; the
 * type's validator gates the write (a failing derive is SKIPPED — stale beats
 * invalid); `source: 'collab'` bypasses the write hooks (this IS the CRDT
 * authority speaking).
 */
async function deriveHostCanvas(canvasId: string, room: Room, force: boolean): Promise<void> {
  if (!room.meta) return;
  // ADR 0481 — non-canvas resources dispatch to their registered driver
  // under the same floor/force discipline; no canvas read ever happens.
  if (room.meta.resource) {
    const driver = resourceDrivers.get(room.meta.resource);
    if (!driver) return;
    const now = Date.now();
    if (!force && now - room.lastDeriveAt < DERIVE_MIN_INTERVAL_MS) return;
    room.lastDeriveAt = now;
    try {
      await driver.derive(canvasId, room.doc, room.meta, force);
    } catch (err) {
      log.warn('collab resource derive failed', { roomId: canvasId, resource: room.meta.resource, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (!room.meta.canvasTypeId) return;
  const entry = collabCanvasType(room.meta.canvasTypeId);
  if (!entry || (!entry.shape && !entry.deriveState)) return;
  const now = Date.now();
  if (!force && now - room.lastDeriveAt < DERIVE_MIN_INTERVAL_MS) return;
  room.lastDeriveAt = now;
  try {
    const current = await getCanvasForTenant(room.meta.tenantId, canvasId);
    if (!current) return;
    const derived = entry.deriveState
      ? entry.deriveState(room.doc, current.state as Record<string, unknown>)
      : defaultDeriveState(room.doc);
    if (!derived || Object.keys(derived).length === 0) return; // empty room — never clobber
    if (entry.validate) {
      const v = entry.validate(derived);
      if (v.errors.length > 0) {
        log.warn('collab derive skipped — failed the type validator', { canvasId, first: v.errors[0]?.message ?? '' });
        return;
      }
    }
    const res = await updateCanvasForTenant(room.meta.tenantId, canvasId, derived, {
      // force: the room-close capture must not be lost to the 30s snapshot
      // throttle (the derive is already 5-min-floor-limited and I5-deduped).
      merge: 'replace', snapshot: { capturedBy: 'collab', force: true }, source: 'collab',
    });
    // DATA-I5 — consecutive auto-derive versions collapse so a long session
    // never evicts user/AI-named versions out of the 50-slot history.
    if (res) await pruneConsecutiveCollabVersions(room.meta.tenantId, canvasId, res.newVersion);
    log.info('collab derived host.canvas', { canvasId, canvasTypeId: room.meta.canvasTypeId });
  } catch (err) {
    log.warn('collab derive failed', { canvasId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** True iff this instance holds a live room for the canvas. */
export function hasLiveRoom(canvasId: string): boolean { return rooms.has(canvasId); }

// ── ADR 0359 grade pass (B1) — CROSS-INSTANCE room liveness ────────────────
// `hasLiveRoom` is per-process, but a room can be live on several of the ≤5
// instances at once (each holds its own Y.Doc copy, converging via the update
// fan-out). The write hooks (409 veto / apply-into-room / invalidation) must
// therefore consult a durable LEASE: one row per (canvasId, instance), written
// on join, refreshed by a heartbeat while the room has connections, deleted on
// evict, and TTL-guarded against instance crashes. Without this, an external
// write served by a non-room-holding instance skips the veto/apply and
// invalidates the store out from under a live room — a silent lost update.
interface CollabLease { id: string; canvasId: string; tenantId?: string; instanceId: string; expiresAt: string }
const leases = new DurableCollection<CollabLease>('collab:lease', (l) => l.id, undefined, (l) => l.tenantId ?? UNTAGGED_TENANT);
const LEASE_TTL_MS = 60_000;
const LEASE_REFRESH_MS = 20_000;
let leaseTimer: ReturnType<typeof setInterval> | null = null;

async function putLease(canvasId: string, room: Room): Promise<void> {
  try {
    await leases.put({
      id: `${canvasId}:${INSTANCE_ID}`,
      canvasId,
      ...(room.meta?.tenantId ? { tenantId: room.meta.tenantId } : {}),
      instanceId: INSTANCE_ID,
      expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
    });
  } catch (err) {
    log.warn('collab lease put failed', { canvasId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Anti-entropy (grade-pass CODE-3): incremental fan-out deltas can be lost
 *  (a swallowed publish failure, a pruned row read too late, a LISTEN
 *  reconnect blip), and nothing else re-exchanges state between instances —
 *  divergence would be sticky until every room evicted. On the heartbeat,
 *  a room that has PEERS on other instances publishes its FULL state through
 *  the normal fan-out lane; `Y.applyUpdate` is idempotent (known state ⇒ no
 *  change, no re-broadcast), so this heals any gap within one heartbeat and
 *  costs nothing when single-instance. */
async function publishAntiEntropy(canvasId: string, room: Room): Promise<void> {
  try {
    const now = Date.now();
    const others = (await leases.listByPrefix(`${canvasId}:`))
      .some((l) => l.instanceId !== INSTANCE_ID && Date.parse(l.expiresAt) > now);
    if (!others) return;
    await publishUpdate(canvasId, Y.encodeStateAsUpdate(room.doc), room.meta?.tenantId);
  } catch (err) {
    log.warn('collab anti-entropy publish failed', { canvasId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** One heartbeat pass (exported for tests): lease refresh + anti-entropy +
 *  the flush retry for connection-less DIRTY residents (an eviction whose
 *  final flush failed keeps the room resident + leased; the heartbeat is the
 *  bounded retry loop that eventually completes that eviction — F2). */
export async function __runCollabHeartbeatOnce(): Promise<void> {
  for (const [canvasId, room] of rooms) {
    if (room.conns.size > 0) {
      await putLease(canvasId, room);
      await publishAntiEntropy(canvasId, room);
      continue;
    }
    if (room.dirty) {
      await putLease(canvasId, room);
      evict(canvasId, room); // re-runs the flush loop; destroys only on success
    }
  }
}

/** Heartbeat: refresh the lease for every local room that still has sockets. */
export function startCollabLeaseHeartbeat(): void {
  if (leaseTimer) return;
  leaseTimer = setInterval(() => { void __runCollabHeartbeatOnce(); }, LEASE_REFRESH_MS);
  leaseTimer.unref?.();
}

/** Test-only: stop the lease heartbeat. */
export function __stopCollabLeaseHeartbeat(): void {
  if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
}

/** True iff ANY instance holds an unexpired lease for the canvas (local
 *  fast-path first — no KV read when this instance has the room). */
export async function hasLiveRoomGlobal(canvasId: string): Promise<boolean> {
  if (rooms.has(canvasId)) return true;
  try {
    const now = Date.now();
    return (await leases.listByPrefix(`${canvasId}:`)).some((l) => Date.parse(l.expiresAt) > now);
  } catch (err) {
    log.warn('collab lease read failed', { canvasId, error: err instanceof Error ? err.message : String(err) });
    // Fail toward "live": a transient read failure must not trigger a store
    // invalidation under a possibly-live room (the destructive branch).
    return true;
  }
}

// ── ADR 0359 grade pass (B1) — external-write fan-out ──────────────────────
// An external host.canvas write applied into THIS instance's room reaches its
// sockets, but rooms on OTHER instances must re-apply it too. Signal-not-
// payload: receivers re-read host.canvas (the state is already durable there).
const EXTWRITE_CHANNEL = 'collab.extwrite';

export async function notifyExternalCanvasWrite(canvasId: string): Promise<void> {
  try { await publishHostExtEvent(EXTWRITE_CHANNEL, JSON.stringify({ canvasId, originId: INSTANCE_ID })); }
  catch (err) { log.warn('collab extwrite publish failed', { canvasId, error: err instanceof Error ? err.message : String(err) }); }
}

async function onExtWriteNotify(payload: string): Promise<void> {
  try {
    const { canvasId, originId } = JSON.parse(payload) as { canvasId: string; originId: string };
    if (originId === INSTANCE_ID) return; // the origin already applied locally
    const room = rooms.get(canvasId);
    if (!room?.meta) return;
    if (room.meta.resource) return; // ADR 0481 — external canvas writes never target a resource room
    const shape = room.meta.canvasTypeId ? collabCanvasType(room.meta.canvasTypeId)?.shape : undefined;
    if (!shape) return;
    const current = await getCanvasForTenant(room.meta.tenantId, canvasId);
    if (!current) return;
    room.doc.transact(() => replaceRootFromState(room.doc.getMap<unknown>('doc'), shape, current.state as Record<string, unknown>), SERVER);
    room.lastDeriveAt = Date.now(); // the write IS host.canvas — no echo-derive
    // NOTE: two instances applying the same external state build distinct Y
    // items; the root-map keys resolve LWW so the docs still converge (the
    // loser's items become unreferenced — reclaimed by the evict compaction).
  } catch (err) {
    log.warn('collab extwrite apply failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Operator introspection (grade-pass CODE-7) — THIS instance's live rooms.
 *  Served by the superadmin `_debug` route; never document content, only
 *  lifecycle metadata an operator needs to reason about a stuck/diverged room. */
export function listLiveRooms(): { canvasId: string; tenantId?: string; canvasTypeId?: string; conns: number; dirty: boolean; lastDeriveAt: number; persistMisses: number }[] {
  const out: { canvasId: string; tenantId?: string; canvasTypeId?: string; conns: number; dirty: boolean; lastDeriveAt: number; persistMisses: number }[] = [];
  for (const [canvasId, room] of rooms) {
    out.push({
      canvasId,
      ...(room.meta?.tenantId ? { tenantId: room.meta.tenantId } : {}),
      ...(room.meta?.canvasTypeId ? { canvasTypeId: room.meta.canvasTypeId } : {}),
      conns: room.conns.size,
      dirty: room.dirty,
      lastDeriveAt: room.lastDeriveAt,
      persistMisses: room.persistMisses,
    });
  }
  return out;
}

/** Test-only: simulate an extwrite notification from another instance. */
export async function __deliverExtWrite(payload: string): Promise<void> { await onExtWriteNotify(payload); }
/** Test-only: write a snapshot row as another instance would (COLLAB-5 races). */
export async function __putCollabSnapshotRaw(canvasId: string, state: string, tenantId?: string): Promise<void> {
  await snapshots.put({ canvasId, ...(tenantId ? { tenantId } : {}), state, updatedAt: new Date().toISOString() });
}
/** Test-only: run one persist pass on a live room (marks dirty first so the
 *  pass always executes; non-compact so the encode is byte-deterministic). */
export async function __persistRoomForTest(canvasId: string): Promise<void> {
  const room = rooms.get(canvasId);
  if (!room) return;
  room.dirty = true;
  await persist(canvasId, room, false);
}
/** Test-only: delete the snapshot row (simulates an invalidation racing a room). */
export async function __deleteCollabSnapshotRow(canvasId: string): Promise<void> { await snapshots.delete(canvasId); }
/** Test-only: read the raw base64 snapshot state. */
export async function __getCollabSnapshotRaw(canvasId: string): Promise<string | null> {
  return (await snapshots.get(canvasId))?.state ?? null;
}
/** Test-only: read the full validator-reconstructed snapshot row. */
export async function __getCollabSnapshotRow(canvasId: string): Promise<CollabSnapshot | null> {
  return snapshots.get(canvasId);
}
/** Test-only: the CAS the persist path uses (the field-order pin). */
export async function __casCollabSnapshotForTest(expected: CollabSnapshot | null, next: CollabSnapshot): Promise<boolean> {
  return snapshots.compareAndSwap(expected, next);
}

/** Test-only: fabricate ANOTHER instance's liveness lease. */
export async function __putCollabLease(canvasId: string, instanceId: string, ttlMs: number): Promise<void> {
  await leases.put({ id: `${canvasId}:${instanceId}`, canvasId, instanceId, expiresAt: new Date(Date.now() + ttlMs).toISOString() });
}
/** Test-only: clear all liveness leases. */
export function __clearCollabLeases(): Promise<void> { return leases.__clear(); }

/** True iff a durable CRDT snapshot exists (the store is authoritative). */
export async function hasCollabSnapshot(canvasId: string): Promise<boolean> {
  return (await snapshots.get(canvasId)) !== null;
}

/**
 * Apply an EXTERNAL host.canvas write (AI authoring, run, restore) into the
 * live room as a server-origin whole-doc replace (ADR 0359 D6): fanned to this
 * instance's sockets AND the other instances; the snapshot save rides the
 * normal debounce. Whole-doc semantics — concurrent keystrokes in the apply
 * window lose (the documented external-import rule).
 */
export function applyExternalState(canvasId: string, shape: CollabShape, state: Record<string, unknown>): boolean {
  const room = rooms.get(canvasId);
  if (!room) return false;
  room.doc.transact(() => replaceRootFromState(room.doc.getMap<unknown>('doc'), shape, state), SERVER);
  // The write that just landed IS host.canvas — an immediate echo-derive would
  // only add version churn; push the floor forward.
  room.lastDeriveAt = Date.now();
  return true;
}
const rooms = new Map<string, Room>();

/** In-flight room constructions (grade-pass CODE-1): two users first-opening
 *  the same canvas race the `await snapshots.get` window — without this lock
 *  both build a Y.Doc, the second `rooms.set` wins, and the two clients are
 *  wired to DIFFERENT rooms (split-brain that the same-instance fan-out echo
 *  guard can never heal, both persisting to one snapshot key, the loser's
 *  Y.Doc leaked). Concurrent joins now await ONE construction. */
const roomLoads = new Map<string, Promise<Room>>();

async function loadRoom(canvasId: string): Promise<Room> {
  const existing = rooms.get(canvasId);
  if (existing) return existing;
  const inFlight = roomLoads.get(canvasId);
  if (inFlight) return inFlight;
  const p = buildRoom(canvasId).finally(() => roomLoads.delete(canvasId));
  roomLoads.set(canvasId, p);
  return p;
}

async function buildRoom(canvasId: string): Promise<Room> {
  const doc = new Y.Doc({ gc: false }); // gc off — snapshots reference item ids
  const snap = await snapshots.get(canvasId);
  if (snap?.state) {
    // RTCC-2: re-seed applies the snapshot FAITHFULLY (no catalog validation) —
    // the CRDT must be reconstructed exactly for convergence. Any invalid state
    // it carries is bounded to the collab lane by the derive→host.canvas gate; it
    // never reaches durable/shared surfaces. (See the persist() note above.)
    try { Y.applyUpdate(doc, Buffer.from(snap.state, 'base64'), REMOTE); }
    catch (err) { log.warn('collab snapshot restore failed', { canvasId, error: err instanceof Error ? err.message : String(err) }); }
  }
  const room: Room = { doc, awareness: new Awareness(doc), conns: new Set(), controlled: new Map(), saveTimer: null, dirty: false, meta: null, lastDeriveAt: 0, lastSnapshot: snap ?? null, persistMisses: 0 };
  // Broadcast local edits to peers + schedule a debounced snapshot save. Only
  // socket-origin updates are broadcast (REMOTE-origin applies are skipped).
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    room.dirty = true;
    scheduleSave(canvasId, room);
    // ALWAYS relay to LOCAL sockets — a peer/fan-out update (origin REMOTE) must
    // still reach the clients on THIS instance; exclude only the originating
    // local socket (it already has the change).
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    writeUpdate(enc, update);
    broadcast(room, encoding.toUint8Array(enc), origin instanceof Object ? (origin as WebSocket) : null);
    // Fan out to OTHER instances ONLY for genuinely-local edits — never for an
    // update we ourselves applied from a peer (origin REMOTE), which would loop.
    if (origin !== REMOTE) void publishUpdate(canvasId, update, room.meta?.tenantId);
  });
  room.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = [...added, ...updated, ...removed];
    if (changed.length === 0) return;
    // Track which client ids each connection controls, so its cursor is cleared
    // on disconnect (the update's origin is the originating socket).
    if (origin instanceof Object && room.controlled.has(origin as WebSocket)) {
      const owned = room.controlled.get(origin as WebSocket)!;
      for (const id of [...added, ...updated]) owned.add(id);
      for (const id of removed) owned.delete(id);
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(room.awareness, changed));
    broadcast(room, encoding.toUint8Array(enc), origin instanceof Object ? (origin as WebSocket) : null);
  });
  rooms.set(canvasId, room);
  return room;
}

function scheduleSave(canvasId: string, room: Room, delayMs = SAVE_DEBOUNCE_MS): void {
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    // ADR 0359 Phase 6 — the periodic derive floor rides the snapshot debounce.
    void persist(canvasId, room).then(() => deriveHostCanvas(canvasId, room, false));
  }, delayMs);
}

/** Compact mid-session once the encoded state outgrows this (grade pass 3 F4 —
 *  the evict-only compaction let a marathon session grow without bound). */
const COMPACT_THRESHOLD_BYTES = 1024 * 1024;

async function persist(canvasId: string, room: Room, compact = false): Promise<void> {
  // RTCC-2 (ADR-reviewed, bounded-by-design): the snapshot is the RAW Y.Doc
  // update, stored schema-agnostic ON PURPOSE — it MUST round-trip byte-faithful
  // for `Y.applyUpdate` convergence (buildRoom) + cross-instance CAS-merge
  // (COLLAB-5). Do NOT add a catalog-validate gate here: dropping an
  // invalid-deriving snapshot loses the session's in-progress work (the snapshot
  // is the ONLY durability for live state — host.canvas gets only validated,
  // 5-min-floored derives) and leaves `room.dirty` set → the debounced save
  // reschedules forever; storing a validated/derived doc instead of the CRDT
  // BREAKS convergence (a derived doc is not a Yjs update). Invalid/unknown-field
  // state is bounded away from durable/shared surfaces by the ONE validated choke
  // — the derive→host.canvas gate (see the `entry.validate` skip below), pinned
  // by the RTCC-2/RTCC-3 trust-boundary test. Observability of the sticky case is
  // the derive-skip warn there.
  room.saveTimer = null;
  if (!room.dirty && !compact) return;
  room.dirty = false;
  try {
    let update = Y.encodeStateAsUpdate(room.doc);
    if (update.byteLength > COMPACT_THRESHOLD_BYTES) compact = true;
    if (compact) {
      // ADR 0359 grade pass (DATA-I4): the live doc runs gc:false, so tombstone
      // CONTENT accumulates across a session. On room close, re-encode through a
      // fresh gc'd doc — deleted content collapses to GC markers, bounding the
      // stored blob. The compacted state still merges with every client (GC
      // structs are protocol-valid); live docs stay gc:false (item-id refs).
      const tmp = new Y.Doc(); // default gc: true
      Y.applyUpdate(tmp, update);
      update = Y.encodeStateAsUpdate(tmp);
      tmp.destroy();
    }
    const state = Buffer.from(update).toString('base64');
    const next: CollabSnapshot = { canvasId, ...(room.meta?.tenantId ? { tenantId: room.meta.tenantId } : {}), state, updatedAt: new Date().toISOString() };
    // NOTE: the CAS compares raw stored TEXT bytes (host_ext_kv.v is TEXT on
    // both pg and sqlite) — migrating that column to jsonb would reorder keys
    // and make EVERY swap miss forever (a merge-reschedule livelock in which
    // edits silently stop persisting). The column must stay TEXT.
    // ADR 0359 residuals (COLLAB-5): CONVERGENT persistence, not last-writer-
    // wins. The swap is CAS'd against the row this room last read/wrote; a miss
    // means another instance persisted concurrently — MERGE its state into our
    // doc (Y.applyUpdate is a CRDT join; REMOTE origin relays to local sockets,
    // never re-fans), adopt the winner as the new baseline, and reschedule so
    // the next save persists the merged SUPERSET. CAS compares raw JSON, so the
    // field order here MUST match the collection validator's reconstruction
    // (pinned by test — drift would fail every swap).
    if (await snapshots.compareAndSwap(room.lastSnapshot, next)) {
      room.lastSnapshot = next;
      room.persistMisses = 0;
      return;
    }
    const theirs = await snapshots.get(canvasId);
    if (theirs?.state) {
      // Grade pass 3b (code #2) — CONVERGED skip: on a hot multi-instance doc
      // the fan-out has usually already converged both docs, so the loser's
      // stored bytes equal what we just tried to write. Adopt the winner as
      // the baseline and stop — no merge, no reschedule, no 2s churn.
      if (theirs.state === state) {
        room.lastSnapshot = theirs;
        room.persistMisses = 0;
        return;
      }
      try { Y.applyUpdate(room.doc, Buffer.from(theirs.state, 'base64'), REMOTE); }
      catch (err) { log.warn('collab snapshot merge failed', { canvasId, error: err instanceof Error ? err.message : String(err) }); }
      room.lastSnapshot = theirs;
      // Grade pass 3b (code #1/#5) — convergence must be OBSERVABLE: repeated
      // misses are the fingerprint of serialization skew (a rolling deploy
      // writing a different row shape — the whole-row byte CAS never matches)
      // or a pathologically hot doc. Rate-limited so healthy occasional races
      // stay quiet.
      room.persistMisses += 1;
      if (room.persistMisses === 3 || room.persistMisses % 10 === 0) {
        log.warn('collab snapshot CAS missing repeatedly — serialization skew or hot-doc contention', { canvasId, consecutiveMisses: room.persistMisses });
      }
    } else {
      // Row VANISHED — either a canvas delete or a store INVALIDATION, both
      // deliberate teardowns. Never blind-resurrect (grade pass 3 F1):
      room.lastSnapshot = null;
      if (rooms.get(canvasId) !== room) {
        // The delete race: pruneCollabSnapshot tore this room down while our
        // CAS was in flight — re-inserting would orphan a snapshot for a
        // deleted canvas. Drop the write entirely.
        return;
      }
      // The invalidation race: our lease lapsed (heartbeat stall) and an
      // external write invalidated the store. host.canvas is the authority
      // for that write — restore our liveness FIRST (lease + seed claim, so
      // no further invalidation and no later double-seed), and for shaped
      // types RE-APPLY host.canvas into the doc before re-inserting, so the
      // external write is preserved rather than clobbered by our stale CRDT.
      await putLease(canvasId, room);
      if (room.meta) {
        await restoreSeedClaim?.(room.meta.tenantId, canvasId);
        // ADR 0481 — a resource room derives FROM the doc (the room is the
        // authority), so a vanished snapshot just re-inserts; no reseed read.
        const shape = room.meta.resource ? undefined : (room.meta.canvasTypeId ? collabCanvasType(room.meta.canvasTypeId)?.shape : undefined);
        if (shape) {
          const current = await getCanvasForTenant(room.meta.tenantId, canvasId);
          if (current) {
            room.doc.transact(() => replaceRootFromState(room.doc.getMap<unknown>('doc'), shape, current.state as Record<string, unknown>), SERVER);
            room.lastDeriveAt = Date.now();
          }
        } else {
          // canvas.document has no generic state→Y apply — the re-insert may
          // clobber the invalidating external write (the documented ≤60s
          // lease-staleness residual, now bounded: the restored lease stops
          // the loop). Loud, never silent.
          log.error('collab snapshot vanished under a live document room — re-inserting; the invalidating external write may be lost', { canvasId });
        }
      }
    }
    room.dirty = true;
    // Backoff grows with consecutive misses (capped) so a losing instance
    // stops re-encoding full state every 2s indefinitely (code #2).
    scheduleSave(canvasId, room, SAVE_DEBOUNCE_MS * Math.min(room.persistMisses + 1, 5));
  } catch (err) {
    log.error('collab snapshot save failed', { canvasId, error: err instanceof Error ? err.message : String(err) });
    room.dirty = true; // retry on the next update
  }
}

function broadcast(room: Room, payload: Uint8Array, except: WebSocket | null): void {
  for (const ws of room.conns) {
    if (ws === except) continue;
    if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch { /* drop */ } }
  }
}

/**
 * Wire an already-AUTHORIZED socket (Phase 1a) into its canvas room: run the Yjs
 * sync handshake, relay messages, and clean up + evict the room on close.
 */
export async function joinCollabRoom(ws: WebSocket, canvasId: string, meta?: RoomMeta): Promise<void> {
  const room = await loadRoom(canvasId);
  if (meta) room.meta = meta; // every join is authorized — same values each time
  room.conns.add(ws);
  room.controlled.set(ws, new Set());
  // ADR 0359 grade pass (B1) — advertise cross-instance liveness immediately
  // (the heartbeat refreshes it; evict releases it).
  void putLease(canvasId, room);

  ws.on('message', (data: ArrayBuffer | Buffer | Buffer[]) => {
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data as ArrayBuffer);
      const dec = decoding.createDecoder(bytes);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        readSyncMessage(dec, enc, room.doc, ws); // origin = ws → its own updates broadcast to peers
        if (encoding.length(enc) > 1) { try { ws.send(encoding.toUint8Array(enc)); } catch { /* drop */ } }
      } else if (type === MSG_AWARENESS) {
        applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws);
      }
    } catch (err) {
      log.warn('collab message error', { canvasId, error: err instanceof Error ? err.message : String(err) });
    }
  });

  ws.on('close', () => {
    room.conns.delete(ws);
    // Clear exactly the client ids this connection controlled (so its remote
    // cursor disappears immediately, not after the 30 s awareness timeout).
    const owned = room.controlled.get(ws);
    room.controlled.delete(ws);
    if (owned && owned.size > 0) removeAwarenessStates(room.awareness, [...owned], null);
    if (room.conns.size === 0) evict(canvasId, room);
  });

  // Kick off the handshake: send our state vector (syncStep1); the client replies
  // with the missing updates + its own step1.
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  writeSyncStep1(enc, room.doc);
  try { ws.send(encoding.toUint8Array(enc)); } catch { /* drop */ }
}

function evict(canvasId: string, room: Room): void {
  // Final flush + a FORCED host.canvas derive (ADR 0359 D6 — room-close is the
  // canonical parity point: History/Compare/preview/share read a truthful
  // host.canvas the moment the session ends), then drop the in-memory Y.Doc.
  if (room.saveTimer) { clearTimeout(room.saveTimer); room.saveTimer = null; }
  void (async () => {
    // Grade-pass CODE-8: while a room is live the snapshot store is the ONLY
    // durable copy — a failed final flush must not silently drop the session's
    // edits. Bounded retries; on persistent failure the room STAYS RESIDENT
    // (dirty) so a later join/update/heartbeat can still flush it.
    let flushed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await persist(canvasId, room, true); // compact on close (DATA-I4)
      if (!room.dirty) { flushed = true; break; }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
    // A CAS-miss inside the loop reschedules — that timer must die with the
    // eviction, not fire into a destroyed doc (grade pass 3 F2).
    if (room.saveTimer) { clearTimeout(room.saveTimer); room.saveTimer = null; }
    // The room-close parity derive runs EVEN on a partial flush (grade pass 3
    // F2): a CAS miss MERGED the winner into this doc, so deriving from it is
    // the truthful superset — only the exclusive snapshot write is pending.
    await deriveHostCanvas(canvasId, room, true);
    if (!flushed) {
      // Keep the resident dirty room LEASED — dropping the lease here exposed
      // its snapshot to invalidation-under-a-live-room (F2 fed F1). The
      // heartbeat refreshes the lease and retries the flush until it lands.
      await putLease(canvasId, room);
      log.error('collab eviction flush failed — room kept resident (leased) with unsaved edits', { canvasId });
      return;
    }
    // ADR 0359 grade pass (B1) — release THIS instance's liveness lease.
    await leases.delete(`${canvasId}:${INSTANCE_ID}`).catch(() => undefined);
    if (rooms.get(canvasId) === room && room.conns.size === 0) {
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(canvasId);
    }
  })().catch((err) => {
    // ADR 0734: a detached async IIFE must never be able to reject into the process —
    // under Node's default --unhandled-rejections=throw that kills the instance. Every
    // await above is currently caught internally (persist, deriveHostCanvas, putLease
    // all swallow; leases.delete has its own .catch), so this is a guard against a
    // FUTURE await that is not, never a fix for an observed rejection. Trade-off: if
    // awareness.destroy() throws, the lease is already gone but the room is not
    // deleted, so hasLiveRoom() reports true locally with no global lease. A bad state
    // behind one log line beats crashing a multi-tenant server.
    log.error('collab eviction failed', { canvasId, error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * Prune a canvas's durable collab snapshot + drop its in-memory room (ADR 0335 —
 * data hygiene on canvas delete; mirrors the comments feature's onCanvasDeleted
 * prune). Seed claims + transient update rows are pruned by the feature hook /
 * self-prune respectively.
 */
export async function pruneCollabSnapshot(canvasId: string): Promise<void> {
  const room = rooms.get(canvasId);
  if (room) {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.awareness.destroy();
    room.doc.destroy();
    rooms.delete(canvasId);
  }
  await snapshots.delete(canvasId);
}

/** Test-only: drop all in-memory rooms (does not touch persisted snapshots). */
export function __resetCollabRooms(): void {
  for (const [, room] of rooms) { if (room.saveTimer) clearTimeout(room.saveTimer); room.doc.destroy(); }
  rooms.clear();
}

/** Test-only: this instance's fan-out origin id (to craft/echo-test notifies). */
export function __collabInstanceId(): string { return INSTANCE_ID; }
/** Test-only: simulate a fan-out notification arriving from another instance. */
export async function __deliverFanout(payload: string): Promise<void> { await onFanoutNotify(payload); }
/** Test-only: store a fanned-out update row (as a peer instance would). */
export async function __putFanoutUpdate(updateId: string, canvasId: string, update: Uint8Array): Promise<void> {
  await collabUpdates.put({ updateId, canvasId, update: Buffer.from(update).toString('base64'), createdAt: new Date().toISOString() });
}
