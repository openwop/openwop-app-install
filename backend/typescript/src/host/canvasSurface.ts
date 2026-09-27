/**
 * `ctx.canvas` host surface (`host.canvas`, `spec/v1/host-capabilities.md`
 * §host.canvas) — the `vendor.myndhyve.canvas` pack's shared-canvas store.
 *
 * The sample host had no canvas store, so this adds one: a durable, versioned,
 * tenant-scoped document (`DurableCollection`). read/write/create are genuinely
 * functional — optimistic-concurrency writes (expectedVersion), shallow/deep/
 * replace merges, field projection on read, idempotent create/write.
 *
 * crossCanvasInvoke (start a child run of another canvas's workflow) needs the
 * run dispatcher, which isn't injected into host surfaces; it returns an honest
 * acknowledgement (synthetic childRunId, no fabricated terminal status) and the
 * registry note says so. The other three nodes run for real.
 */

import { randomUUID } from 'node:crypto';
import { insertRunWithStartContext } from './runInsert.js';
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { snapshotRunVariables } from './variablesRuntime.js';
import type { BundleScope } from './inMemorySurfaces.js';
import type { Storage } from '../storage/storage.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { RunRecord } from '../types.js';
import { OpenwopError } from '../types.js';
import { fireBeforeCanvasStateWrite, fireAfterCanvasStateWrite, fireCanvasDeleted } from './canvasLifecycle.js';
import type { Subject } from './subject.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';

const log = createLogger('host.canvas');

type Json = Record<string, unknown>;

/** Injected at boot (createApp) so crossCanvasInvoke can spawn a real child
 *  run — host surfaces don't otherwise see the run dispatcher. Mirrors
 *  `setSubWorkflowDispatcher`. */
interface CanvasInvokeDeps {
  storage: Storage;
  getWorkflow: (workflowId: string) => Promise<{ definition: WorkflowDef } | null>;
  executeRun: (storage: Storage, run: RunRecord, definition: unknown, options?: unknown) => Promise<unknown>;
}
// ADR 0474 — widened from the old `{ variables?: unknown }` segregation: the
// injected resolver is wired to the catalog funnel (host/index.ts), whose
// object IS the full definition, and the child-run revision pin must hash the
// COMPLETE definition (a partial view would mint a wrong hash).
type WorkflowDef = WorkflowDefinition;
let _invokeDeps: CanvasInvokeDeps | null = null;
export function setCanvasInvokeDispatcher(d: CanvasInvokeDeps): void {
  _invokeDeps = d;
}

/** Max canvas-invoke nesting depth (cycle/runaway guard), matching the
 *  sub-workflow dispatcher's cap. */
const MAX_INVOKE_DEPTH = 8;
const TERMINAL_RUN: readonly string[] = ['completed', 'failed', 'cancelled'];
// Per-tenant::target circuit breaker — consecutive child-run failures.
const _circuit = new Map<string, number>();

interface Canvas {
  canvasId: string;
  tenantId: string;
  canvasTypeId: string;
  name?: string;
  projectId?: string;
  /** ADR 0153 §R6 — additive owning Subject (project/user/agent). Absent ⇒ tenant-
   *  scoped as before (no migration of existing rows). Org/visibility resolves via
   *  `subjectOrgScope`/`subjectAccess` at the editor route; the field is the anchor. */
  ownerSubject?: Subject;
  state: Json;
  version: number;
  metadata?: Json;
  createdAt: string;
  updatedAt: string;
}

// Grade pass 2026-07-07 (DATA finding 9): a runtime validate guard — canvas state
// feeds the PUBLIC share viewer, so a corrupt/drifted row must not blind-cast.
const canvases = new DurableCollection<Canvas>(
  'canvas',
  (c) => c.canvasId,
  (parsed) => {
    const c = parsed as Canvas | null;
    return c && typeof c.canvasId === 'string' && typeof c.tenantId === 'string'
      && typeof c.canvasTypeId === 'string' && typeof c.version === 'number'
      && c.state !== null && typeof c.state === 'object' ? c : null;
  },
  // Grade pass DATA-CV-3: indexed tenant slice, symmetric with the version +
  // idem sibling rows (tenant purge stops relying on the JSON fallback probe).
  (c) => c.tenantId,
  // GC-CV-11: the tenant-index marker carries a light identity PROJECTION so the
  // browser/picker list (`listCanvasesForTenant`) reads it WITHOUT decoding the
  // full row incl. the potentially large `state` blob. The projection IS the
  // CanvasListRow shape.
  (c) => ({ canvasId: c.canvasId, canvasTypeId: c.canvasTypeId, ...(c.name ? { name: c.name } : {}), ...(c.projectId ? { projectId: c.projectId } : {}), version: c.version, updatedAt: c.updatedAt }),
);

// ── version history (ADR 0305 Phase E — the CMS ADR 0206 PageVersion pattern) ──
// host.canvas owns snapshots (one owner for canvas persistence across canvas
// types); features expose routes over these. Snapshots capture the POST-save
// state keyed by the new canvas version; retention = distinct-version dedup +
// a 30s throttle + a per-canvas cap.

export interface CanvasVersion {
  versionId: string;
  tenantId: string;
  canvasId: string;
  /** The canvas `version` this snapshot captured. */
  version: number;
  snapshot: Json;
  capturedBy: string;
  capturedAt: string;
  /** Monotonic in-process tiebreaker for same-millisecond captures (restart-safe
   *  sort keys on capturedAt first — the CMS byNewest discipline). */
  seq: number;
}

// Grade pass 2026-07-07 (F6/DATA-4): versionIds are DETERMINISTIC and
// tenant/canvas-prefixed — `${tenantId}:${canvasId}:v<version>` — so (a) a
// same-version double capture is a natural idempotent overwrite (the dedup
// races away), and (b) every read is a bounded `listByPrefix`, never a full
// cross-tenant scan that decodes every snapshot blob. No deployed rows exist
// under the old `cver:<uuid>` scheme (the program is undeployed), so no re-key.
const canvasVersions = new DurableCollection<CanvasVersion>(
  'canvas:version', (v) => v.versionId, undefined, (v) => v.tenantId,
  // DATA-D8: a light identity PROJECTION on the tenant-index marker, so the
  // version-LIST read returns metadata WITHOUT decoding the (large) snapshot
  // blob — a 50-deep ink history stops decoding ~75MB to render 4 fields. The
  // projection is READ-only: destructive eviction stays on the authoritative
  // primary `listByPrefix` (a marker can briefly outlive its row, and driving a
  // delete off a phantom marker would evict a real snapshot).
  (v) => ({ versionId: v.versionId, canvasId: v.canvasId, version: v.version, capturedBy: v.capturedBy, capturedAt: v.capturedAt, seq: v.seq }),
);
const versionRowId = (tenantId: string, canvasId: string, version: number): string =>
  `${tenantId}:${canvasId}:v${String(version).padStart(9, '0')}`;
const MAX_CANVAS_VERSIONS = 50;
const SNAPSHOT_THROTTLE_MS = 30_000;
let canvasVersionSeq = 0;
// Architect amendment (Phase E): the rapid-save path must not pay a full
// collection scan per save — this in-process map answers the throttle without
// touching storage. A restart clears it; worst case is one extra snapshot.
const lastCaptureAt = new Map<string, number>();

function byNewestVersion(a: { capturedAt: string; seq: number }, b: { capturedAt: string; seq: number }): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
  return (b.seq ?? 0) - (a.seq ?? 0);
}

/** Capture a canvas snapshot (post-save state, keyed by the new version).
 *  Skips inside the 30s throttle window unless `force` (a restore's capture
 *  must always appear); dedups per canvas version (idempotent retries). */
export async function snapshotCanvas(c: { tenantId: string; canvasId: string; state: Json; version: number }, capturedBy: string, opts?: { force?: boolean }): Promise<void> {
  const now = Date.now();
  if (!opts?.force) {
    const last = lastCaptureAt.get(c.canvasId);
    if (last !== undefined && now - last < SNAPSHOT_THROTTLE_MS) return;
  }
  const mine = (await canvasVersions.listByPrefix(`${c.tenantId}:${c.canvasId}:`)).sort(byNewestVersion);
  if (mine[0] && mine[0].version === c.version) return; // idempotent retry
  const v: CanvasVersion = {
    versionId: versionRowId(c.tenantId, c.canvasId, c.version),
    tenantId: c.tenantId,
    canvasId: c.canvasId,
    version: c.version,
    snapshot: JSON.parse(JSON.stringify(c.state)) as Json,
    capturedBy,
    capturedAt: new Date(now).toISOString(),
    seq: ++canvasVersionSeq,
  };
  await canvasVersions.put(v);
  lastCaptureAt.set(c.canvasId, now);
  const evicted = [v, ...mine].sort(byNewestVersion).slice(MAX_CANVAS_VERSIONS);
  for (const old of evicted) {
    await canvasVersions.delete(old.versionId);
  }
  // Grade pass DATA-CV-5: retention evictions were silent — an operator
  // debugging "where did my old version go" had no trace.
  if (evicted.length) log.info('canvas_versions_evicted', { canvasId: c.canvasId, evicted: evicted.length, cap: MAX_CANVAS_VERSIONS });
}

/** Version METADATA (no snapshot blob — DATA-D8), newest-first, tenant+canvas
 *  scoped by the marker prefix (no existence leak). Read from the tenant-index
 *  projection, so a deep history never decodes its snapshots to list them. The
 *  full snapshot is fetched on demand via `getCanvasVersion`. */
export interface CanvasVersionMeta { versionId: string; canvasId: string; version: number; capturedBy: string; capturedAt: string; seq: number }
export async function listCanvasVersions(tenantId: string, canvasId: string): Promise<CanvasVersionMeta[]> {
  const rows = await canvasVersions.listByTenantAndIdPrefixProjected(tenantId, `${tenantId}:${canvasId}:`);
  return rows
    .filter((p): p is CanvasVersionMeta & Record<string, unknown> =>
      typeof p.versionId === 'string' && p.canvasId === canvasId && typeof p.version === 'number' && typeof p.capturedAt === 'string')
    .map((p): CanvasVersionMeta => ({
      versionId: p.versionId, canvasId: p.canvasId, version: p.version,
      capturedBy: typeof p.capturedBy === 'string' ? p.capturedBy : '',
      capturedAt: p.capturedAt, seq: typeof p.seq === 'number' ? p.seq : 0,
    }))
    .sort(byNewestVersion);
}

/** One snapshot row, tenant+canvas IDOR-guarded (the cms getVersion posture). */
export async function getCanvasVersion(tenantId: string, canvasId: string, versionId: string): Promise<CanvasVersion | null> {
  const v = await canvasVersions.get(versionId);
  return v && v.tenantId === tenantId && v.canvasId === canvasId ? v : null;
}

/** A type-schema validator (the same shape the save route holds as `cfg.validate`). */
export interface CanvasStateValidator { (state: Record<string, unknown>): { errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] } }

/** NON-DESTRUCTIVE restore: write the snapshot's state as a NEW canvas version
 *  (never rewinds), then force-capture so the restore point itself is in the
 *  history. Returns the new head, or null when canvas/version is absent.
 *  DATA-D6: an optional `validate` (the type's schema validator) runs against the
 *  exact snapshot BEFORE any mutation — a drifted/old snapshot must not
 *  blind-restore into the PUBLIC share viewer. `errors` reject as a 422 with
 *  NOTHING mutated (mirrors the save path); `warnings` restore anyway and ride
 *  back in the result (a mid-edit/cross-facet state stays restorable). */
export async function restoreCanvasVersion(
  tenantId: string, canvasId: string, versionId: string, actor: string,
  opts?: { validate?: CanvasStateValidator },
): Promise<{ canvasId: string; newVersion: number; warnings?: { path: string; message: string }[] } | null> {
  const v = await getCanvasVersion(tenantId, canvasId, versionId);
  if (!v) return null;
  // DATA-D6: validate FIRST, before the F7 head capture below — a rejected
  // restore must mutate zero rows (else it would burn a forced snapshot slot,
  // possibly evicting a real old version, for a restore that never happened).
  let warnings: { path: string; message: string }[] = [];
  if (opts?.validate) {
    const snap = v.snapshot;
    if (typeof snap !== 'object' || snap === null || Array.isArray(snap)) {
      throw new OpenwopError('validation_error', `snapshot ${versionId} is not a canvas object`, 422, { errors: [{ path: 'snapshot', message: 'snapshot must be a canvas state object' }] });
    }
    const result = opts.validate(snap as Record<string, unknown>);
    if (result.errors.length) {
      log.warn('canvas restore rejected by validator', { canvasId, versionId, errorCount: result.errors.length, first: result.errors[0]!.message });
      throw new OpenwopError('validation_error', `restored snapshot violates the schema: ${result.errors[0]!.message}`, 422, { errors: result.errors });
    }
    warnings = result.warnings;
  }
  // Grade pass 2026-07-07 (F7): capture the CURRENT head first — inside the 30s
  // throttle window it may never have been snapshotted, and a restore that
  // overwrites it would lose up to 30s of work from history. Best-effort, like
  // the save-path capture: a failed capture never blocks the restore.
  const head = await getCanvasForTenant(tenantId, canvasId);
  if (head) {
    try { await snapshotCanvas({ tenantId, canvasId, state: head.state, version: head.version }, actor, { force: true }); }
    catch (err) { log.warn('canvas_prerestore_snapshot_failed', { canvasId, err: err instanceof Error ? err.message : String(err) }); }
  }
  const result = await updateCanvasForTenant(tenantId, canvasId, v.snapshot, { merge: 'replace' });
  if (!result) return null;
  try { await snapshotCanvas({ tenantId, canvasId, state: v.snapshot, version: result.newVersion }, actor, { force: true }); }
  catch (err) { log.warn('canvas_restore_snapshot_failed', { canvasId, err: err instanceof Error ? err.message : String(err) }); }
  return { ...result, ...(warnings.length ? { warnings } : {}) };
}

/** Tenant-scoped read of a canvas for non-run code (ADR 0056 — document
 *  materialization). Returns null if absent or cross-tenant (no existence leak). */
export interface CanvasRecordView { canvasId: string; canvasTypeId: string; name?: string; projectId?: string; ownerSubject?: Subject; state: Json; version: number; metadata?: Json }
export async function getCanvasForTenant(tenantId: string, canvasId: string): Promise<CanvasRecordView | null> {
  const c = await canvases.get(canvasId);
  if (!c || c.tenantId !== tenantId) return null;
  // `metadata` passes through additively (grade pass XCH-DATA-1): provenance
  // stamped at create (e.g. the app-builder agent tool's `producedBy`) must be
  // READABLE, not write-only.
  return { canvasId: c.canvasId, canvasTypeId: c.canvasTypeId, ...(c.name ? { name: c.name } : {}), ...(c.projectId ? { projectId: c.projectId } : {}), ...(c.ownerSubject ? { ownerSubject: c.ownerSubject } : {}), state: c.state, version: c.version, ...(c.metadata !== undefined ? { metadata: c.metadata } : {}) };
}

/** Light tenant listing for pickers (ADR 0314 — the documents "From a canvas"
 *  picker; ADR 0316 — the canvases browser). Projects each canvas to identity
 *  rows (never `state`), newest first. Callers gate access; the result is
 *  read from the tenant-index MARKER PROJECTION (GC-CV-11) — the full row (incl.
 *  the large `state` blob) is never decoded, so the scan is O(tenant canvas
 *  count) in small identity rows, not O(count × row size). A canvas written
 *  before the projection existed self-heals its marker on first read. */
export interface CanvasListRow { canvasId: string; canvasTypeId: string; name?: string; projectId?: string; version: number; updatedAt: string }
function isCanvasListRow(p: Record<string, unknown>): p is CanvasListRow & Record<string, unknown> {
  return typeof p.canvasId === 'string' && typeof p.canvasTypeId === 'string' && typeof p.version === 'number' && typeof p.updatedAt === 'string';
}
export async function listCanvasesForTenant(tenantId: string): Promise<CanvasListRow[]> {
  const projections = await canvases.listForTenantProjected(tenantId);
  return projections
    .filter(isCanvasListRow)
    .map((p): CanvasListRow => ({ canvasId: p.canvasId, canvasTypeId: p.canvasTypeId, ...(typeof p.name === 'string' ? { name: p.name } : {}), ...(typeof p.projectId === 'string' ? { projectId: p.projectId } : {}), version: p.version, updatedAt: p.updatedAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.canvasId < b.canvasId ? -1 : 1));
}

/** Tenant-scoped, idempotent canvas create for non-run code — the editor "open"
 *  / seed-from-artifact path (ADR 0153 §R1). Reuses the same store + `_idem` cache
 *  as the run-scoped `create`, so the same `idempotencyKey` (e.g. an artifact key)
 *  yields ONE working copy, not duplicates. Additive `ownerSubject` (§R6). */
export async function createCanvasForTenant(tenantId: string, args: {
  canvasTypeId: string; name?: string; projectId?: string; ownerSubject?: Subject; initialState?: Json; metadata?: Json; idempotencyKey?: string;
}): Promise<CanvasRecordView> {
  if (args.idempotencyKey) {
    const cached = await idemGet<CanvasRecordView>(`${tenantId}::ct:${args.idempotencyKey}`);
    if (cached) return cached;
  }
  const now = new Date().toISOString();
  const canvas: Canvas = {
    canvasId: `canvas-${randomUUID()}`,
    tenantId,
    canvasTypeId: args.canvasTypeId,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
    ...(args.ownerSubject !== undefined ? { ownerSubject: args.ownerSubject } : {}),
    state: args.initialState ?? {},
    version: 1,
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await canvases.put(canvas);
  const view: CanvasRecordView = { canvasId: canvas.canvasId, canvasTypeId: canvas.canvasTypeId, ...(canvas.name ? { name: canvas.name } : {}), ...(canvas.projectId ? { projectId: canvas.projectId } : {}), ...(canvas.ownerSubject ? { ownerSubject: canvas.ownerSubject } : {}), state: canvas.state, version: canvas.version, ...(canvas.metadata !== undefined ? { metadata: canvas.metadata } : {}) };
  if (args.idempotencyKey) return idemPut(`${tenantId}::ct:${args.idempotencyKey}`, view);
  return view;
}

/** Tenant-scoped, idempotent create-with-a-FIXED-id (no `canvas-<uuid>` generation).
 *  For host seams that address a canvas by a well-known stable id (e.g. the RFC 0117
 *  ui-plugin `conformance-canary` artifact) — returns the existing record if present, else
 *  creates it at version 1. Distinct from `createCanvasForTenant`, which mints a random id. */
export async function ensureCanvasForTenant(
  tenantId: string, canvasId: string, args: { canvasTypeId: string; initialState?: Json },
): Promise<CanvasRecordView> {
  const existing = await getCanvasForTenant(tenantId, canvasId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const canvas: Canvas = { canvasId, tenantId, canvasTypeId: args.canvasTypeId, state: args.initialState ?? {}, version: 1, createdAt: now, updatedAt: now };
  await canvases.put(canvas);
  return { canvasId, canvasTypeId: canvas.canvasTypeId, state: canvas.state, version: canvas.version };
}

/** Tenant-scoped optimistic write for the editor save path (ADR 0153 Phase 2b) — the
 *  non-run mirror of the surface `write`. `expectedVersion` (if given) must match or it
 *  throws `canvas_version_conflict` (last-writer protection for the live editor); merge
 *  defaults to `replace` (the editor sends the whole canvas state). Returns null when the
 *  canvas is absent or cross-tenant (no existence leak). */
export async function updateCanvasForTenant(
  tenantId: string, canvasId: string, mutation: Json,
  opts?: { expectedVersion?: number; merge?: 'shallow' | 'deep' | 'replace'; snapshot?: { capturedBy: string; force?: boolean }; source?: 'collab' },
): Promise<{ canvasId: string; newVersion: number } | null> {
  // Grade pass 2026-07-07 (F1 + F5/DATA-2): the write is a compareAndSwap retry
  // loop (get→check→put allowed a cross-instance lost update), and a stale
  // `expectedVersion` is a TYPED 409 (`OpenwopError`) — the previous plain
  // Error fell through the envelope mapper as a 500, so the editor's conflict
  // UX never fired.
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = await canvases.get(canvasId);
    if (!c || c.tenantId !== tenantId) return null;
    if (opts?.expectedVersion !== undefined && opts.expectedVersion !== c.version) {
      throw new OpenwopError('canvas_version_conflict', `canvas ${canvasId} version conflict: expected ${opts.expectedVersion}, have ${c.version}`, 409, { currentVersion: c.version });
    }
    // ADR 0359 Phase 6 — the EXTERNAL-write veto seam (may throw a typed 409:
    // a live `canvas.document` room has no generic apply path). Collab's own
    // derive writes bypass (`source: 'collab'`) — they ARE the CRDT authority.
    if (attempt === 0 && opts?.source !== 'collab') {
      await fireBeforeCanvasStateWrite({ tenantId, canvasId, canvasTypeId: c.canvasTypeId, state: (mutation ?? {}) as Record<string, unknown> });
    }
    const merge = opts?.merge ?? 'replace';
    const m = (mutation ?? {}) as Json;
    const next: Canvas = {
      ...c,
      state: merge === 'replace' ? { ...m } : merge === 'deep' ? deepMerge(c.state, m) : { ...c.state, ...m },
      version: c.version + 1,
      updatedAt: new Date().toISOString(),
    };
    if (!(await canvases.compareAndSwap(c, next))) {
      // Lost the race. With an expectedVersion the caller's basis is now stale
      // (the re-read above will 409 on the next pass); without one, retry.
      continue;
    }
    // ADR 0305 Phase E — opt-in per-save capture (the editor PATCH passes it;
    // the run-path surface `write` does not: runs create canvases, they don't
    // iterate them). Best-effort: a snapshot failure never fails the save.
    if (opts?.snapshot) {
      try { await snapshotCanvas({ tenantId, canvasId, state: next.state, version: next.version }, opts.snapshot.capturedBy, opts.snapshot.force ? { force: true } : undefined); }
      catch (err) { log.warn('canvas_snapshot_failed', { canvasId, err: err instanceof Error ? err.message : String(err) }); }
    }
    // ADR 0359 Phase 6 — post-commit fan-out (best-effort): apply-into-room for
    // element types with a live room; CRDT-store invalidation when no room is
    // live (host.canvas becomes the authority again; the next session re-seeds).
    if (opts?.source !== 'collab') {
      await fireAfterCanvasStateWrite({ tenantId, canvasId, canvasTypeId: next.canvasTypeId, state: next.state as Record<string, unknown> });
    }
    return { canvasId, newVersion: next.version };
  }
  throw new OpenwopError('canvas_version_conflict', `canvas ${canvasId} write contention — retry`, 409, { contended: true });
}

/** Delete a canvas + CASCADE its owned rows (grade-pass DATA-3): version
 *  snapshots (prefix-scoped) and the seed-from-artifact idempotency row (else a
 *  re-open would return a pointer to the dead canvas). Share links are the
 *  sharing feature's rows — the caller purges those (feature layer; host must
 *  not import features). Returns false when absent/cross-tenant (no leak). */
/** ADR 0359 grade pass (DATA-I5): collapse CONSECUTIVE collab auto-derive
 *  versions — after a new `capturedBy: 'collab'` capture, delete the
 *  immediately PRECEDING version row iff it too was a 'collab' capture, so a
 *  multi-hour live session keeps ONE trailing auto-version between user/AI
 *  captures instead of evicting them out of the retention cap. */
export async function pruneConsecutiveCollabVersions(tenantId: string, canvasId: string, newVersion: number): Promise<void> {
  const metas = await listCanvasVersions(tenantId, canvasId);
  const prior = metas
    .filter((v) => v.version < newVersion)
    .sort((a, b) => b.version - a.version)[0];
  if (prior && prior.capturedBy === 'collab') {
    await canvasVersions.delete(prior.versionId);
  }
}

export async function deleteCanvasForTenant(tenantId: string, canvasId: string): Promise<boolean> {
  const c = await canvases.get(canvasId);
  if (!c || c.tenantId !== tenantId) return false;
  for (const v of await canvasVersions.listByPrefix(`${tenantId}:${canvasId}:`)) {
    await canvasVersions.delete(v.versionId);
  }
  const seededKey = (c.metadata as Json | undefined)?.seededFromArtifactKey;
  if (typeof seededKey === 'string' && seededKey) {
    await _idemRows.delete(`${tenantId}::ct:from-artifact:${seededKey}`);
  }
  await canvases.delete(canvasId);
  lastCaptureAt.delete(canvasId);
  // ADR 0359 grade pass (DATA-B2): fire the lifecycle seam HERE — the single
  // delete owner — so no caller (the per-type editor route, the Documents
  // browser, demo-clear seeders) can skip the sidecar cascade (collab
  // snapshots/seed claims, comments). Fired AFTER the row is gone, best-effort
  // by contract; handlers are idempotent, so a caller that also fires is safe.
  await fireCanvasDeleted({ tenantId, canvasId, canvasTypeId: c.canvasTypeId });
  return true;
}

/** Test-only: seed a canvas record directly (route tests have no run to create one). */
export async function __putCanvasForTest(c: { canvasId: string; tenantId: string; canvasTypeId: string; name?: string; projectId?: string; state: Json; version?: number; updatedAt?: string }): Promise<void> {
  const now = new Date().toISOString();
  await canvases.put({ canvasId: c.canvasId, tenantId: c.tenantId, canvasTypeId: c.canvasTypeId, ...(c.name ? { name: c.name } : {}), ...(c.projectId ? { projectId: c.projectId } : {}), state: c.state, version: c.version ?? 1, createdAt: c.updatedAt ?? now, updatedAt: c.updatedAt ?? now });
}
// Idempotency for create/write keyed by tenant::idempotencyKey — DURABLE
// (CODEBASE-ASSESSMENT CAS-adoption pass, 2026-07-03): the old in-process Map
// lost idempotency across instances and restarts, so a retried same-key
// create on another instance minted a duplicate canvas. Rows are CAS-inserted
// (the PR #1181 reserveSend pattern): the loser of a concurrent same-key race
// discards its own result and returns the WINNER's, so every caller converges
// on one canvas/version. Cache-after-success semantics are preserved (a
// failed operation stores nothing and retries clean).
// Grade pass 2026-07-07 (DATA finding 1): rows carry a top-level `tenantId` and the
// collection declares `tenantOf`, so ADR 0284 tenant deletion purges them — the
// cached create results hold full canvas STATE, which previously survived erasure.
interface IdemRow { key: string; tenantId: string; result: Json; createdAt: string }
const _idemRows = new DurableCollection<IdemRow>(
  'canvas:idem',
  (r) => r.key,
  (parsed) => {
    const r = parsed as IdemRow | null;
    return r && typeof r.key === 'string' && typeof r.result === 'object' && r.result !== null ? r : null;
  },
  (r) => r.tenantId ?? r.key.split('::')[0] ?? '',
);
async function idemGet<T>(key: string): Promise<T | undefined> {
  const row = await _idemRows.get(key);
  return row ? (row.result as T) : undefined;
}
/** Store `result` under `key`; on a concurrent-writer loss, return the winner's. */
async function idemPut<T>(key: string, result: T): Promise<T> {
  // The tenant is the key's `::`-prefix by construction (both call sites).
  const tenantId = key.split('::')[0] ?? '';
  const won = await _idemRows.compareAndSwap(null, { key, tenantId, result: result as Json, createdAt: new Date().toISOString() });
  if (won) return result;
  const winner = await _idemRows.get(key);
  return winner ? (winner.result as T) : result;
}

const IDEM_DAY_MS = 24 * 60 * 60 * 1000;
const IDEM_TTL_MS_DEFAULT = 14 * IDEM_DAY_MS;
const IDEM_SWEEP_DELETE_CAP = 500;
function idemTtlMs(): number {
  const days = Number(process.env.OPENWOP_CANVAS_IDEM_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days * IDEM_DAY_MS : IDEM_TTL_MS_DEFAULT;
}

/** DATA-D7 — retention sweep for the EPHEMERAL create/write idempotency rows
 *  (`::c:`, `::w:`, and non-from-artifact `::ct:`). These are keyed by
 *  idempotencyKey, so they can't be reverse-cascaded when a canvas is deleted —
 *  after a delete they're orphan pointers to a dead canvas (and they cache the
 *  full CanvasRecordView incl. `state`, so they're not tiny). They're retry-window
 *  keys (seconds-to-minutes), so a multi-day TTL sits far beyond any real retry.
 *  The `ct:from-artifact:` reopen-dedup rows are EXEMPT — a legitimate reopen of
 *  the same artifact months later must still dedup, and the delete cascade already
 *  lifecycles them (deleteCanvasForTenant). Bounded (`SWEEP_DELETE_CAP`) and
 *  fail-contained (a bad row can't wedge the worker tick); an unparseable
 *  `createdAt` is KEPT. Piggybacks the webhook-delivery worker tick. */
export async function sweepExpiredCanvasIdem(now: number = Date.now()): Promise<number> {
  const cutoff = now - idemTtlMs();
  let all: IdemRow[];
  try { all = await _idemRows.list(); }
  catch (err) { log.warn('canvas idem sweep list failed', { error: err instanceof Error ? err.message : String(err) }); return 0; }
  let deleted = 0;
  for (const row of all) {
    if (deleted >= IDEM_SWEEP_DELETE_CAP) break;
    const op = row.key.split('::')[1] ?? ''; // the namespaced op after `${tenantId}::`
    if (op.startsWith('ct:from-artifact:')) continue; // exempt: reopen-dedup, cascade-lifecycled
    const stamped = Date.parse(row.createdAt);
    if (!Number.isFinite(stamped) || stamped >= cutoff) continue; // keep fresh / unparseable
    try { if (await _idemRows.delete(row.key)) deleted++; }
    catch (err) { log.warn('canvas idem sweep delete failed', { key: row.key, error: err instanceof Error ? err.message : String(err) }); }
  }
  if (deleted > 0) log.info('canvas idem sweep', { deleted });
  return deleted;
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// Canvas version snapshots and canvas ownership are structurally-needed rows
// (version history + the ownership anchor must survive; deleting them would
// destroy other editors' history and drop the canvas), so a DSAR ANONYMIZES the
// subject's identifiers in place: `capturedBy` on EVERY version snapshot the
// subject captured (the ADR 0464 named fix — `canvasEditorRoutes` stamps a
// userId there for every canvas type app-wide), and a canvas's user-kind
// `ownerSubject`. The snapshot BYTES (canvas content) are untouched — they are
// other people's work; only the actor id is redacted. Written via the raw
// collections (no version bump, no lifecycle fan-out). Idempotent; tenant-scoped
// (versions by key prefix, canvases by their tenant field); fail-closed on
// falsy input.

/** DSAR eraser — anonymize `capturedBy` on the subject's version snapshots and
 *  their user-kind canvas `ownerSubject`, tenant-wide. */
export async function eraseSubjectCanvas(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  // Version snapshots — tenant-bounded by the `${tenantId}:` key prefix.
  for (const v of await canvasVersions.listByPrefix(`${tenantId}:`)) {
    if (forms.has(v.capturedBy)) await canvasVersions.put({ ...v, capturedBy: ERASED });
  }
  // Canvas ownership — the tenant's canvases whose owner IS the erased subject.
  for (const c of await canvases.list()) {
    if (c.tenantId !== tenantId) continue;
    if (c.ownerSubject && c.ownerSubject.kind === 'user' && forms.has(c.ownerSubject.id)) {
      await canvases.put({ ...c, ownerSubject: { kind: 'user', id: ERASED }, updatedAt: new Date().toISOString() });
    }
  }
}

/** Register the canvas DSAR eraser (idempotent — the seam dedupes by reference).
 *  Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerCanvasErasure(): void {
  registerSubjectEraser(eraseSubjectCanvas);
}

function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)
      ? deepMerge(cur as Json, v as Json)
      : v;
  }
  return out;
}

function project(state: Json, fields: unknown): Json {
  if (!Array.isArray(fields) || fields.length === 0) return state;
  const out: Json = {};
  for (const f of fields) if (typeof f === 'string' && f in state) out[f] = state[f];
  return out;
}

export interface CanvasSurface {
  read(canvasId: string, opts?: { fields?: unknown; consistency?: unknown }): Promise<{ canvasId: string; state: Json; canvasTypeId: string; version: number }>;
  write(canvasId: string, mutation: Json, opts?: { expectedVersion?: number; merge?: 'shallow' | 'deep' | 'replace'; idempotencyKey?: string }): Promise<{ canvasId: string; newVersion: number }>;
  create(args: { canvasTypeId: string; projectId?: string; name?: string; initialState?: Json; metadata?: Json; idempotencyKey?: string }): Promise<{ canvasId: string; canvasTypeId: string; name?: string; projectId?: string; createdAt: string }>;
  invoke(targetCanvasId: string, workflowId: string, args: Json, opts?: { awaitTerminal?: boolean; timeoutMs?: number; circuitBreaker?: unknown; idempotencyKey?: string }): Promise<{ childRunId: string; result?: unknown; circuitOpen?: boolean; terminalStatus?: string; error?: unknown }>;
}

export function createCanvasSurface(scope: BundleScope): CanvasSurface {
  const tenantId = scope.tenantId;
  const idem = (key: string): string => `${tenantId}::${key}`;

  async function load(canvasId: string): Promise<Canvas> {
    const c = await canvases.get(canvasId);
    if (!c || c.tenantId !== tenantId) {
      throw Object.assign(new Error(`canvas ${canvasId} not found`), { code: 'canvas_not_found' });
    }
    return c;
  }

  return {
    async read(canvasId, opts) {
      const c = await load(canvasId);
      return { canvasId, state: project(c.state, opts?.fields), canvasTypeId: c.canvasTypeId, version: c.version };
    },

    async write(canvasId, mutation, opts) {
      if (opts?.idempotencyKey) {
        const cached = await idemGet<{ canvasId: string; newVersion: number }>(idem(`w:${opts.idempotencyKey}`));
        if (cached) return cached;
      }
      // Grade pass 2026-07-07 (F5): CAS retry — the run path keeps its plain-Error
      // `code` contract (node executors read it), but the write itself must not
      // lose a concurrent update.
      for (let attempt = 0; attempt < 8; attempt++) {
        const c = await load(canvasId);
        if (opts?.expectedVersion !== undefined && opts.expectedVersion !== c.version) {
          throw Object.assign(new Error(`canvas ${canvasId} version conflict: expected ${opts.expectedVersion}, have ${c.version}`), { code: 'canvas_version_conflict' });
        }
        const merge = opts?.merge ?? 'shallow';
        const m = (mutation ?? {}) as Json;
        const next = { ...c, state: merge === 'replace' ? { ...m } : merge === 'deep' ? deepMerge(c.state, m) : { ...c.state, ...m }, version: c.version + 1, updatedAt: new Date().toISOString() };
        if (!(await canvases.compareAndSwap(c, next))) continue;
        const out = { canvasId, newVersion: next.version };
        if (opts?.idempotencyKey) return idemPut(idem(`w:${opts.idempotencyKey}`), out);
        return out;
      }
      throw Object.assign(new Error(`canvas ${canvasId} write contention — retry`), { code: 'canvas_version_conflict' });
    },

    async create({ canvasTypeId, projectId, name, initialState, metadata, idempotencyKey }) {
      if (idempotencyKey) {
        const cached = await idemGet<{ canvasId: string; canvasTypeId: string; name?: string; projectId?: string; createdAt: string }>(idem(`c:${idempotencyKey}`));
        if (cached) return cached;
      }
      const now = new Date().toISOString();
      const canvas: Canvas = {
        canvasId: `canvas-${randomUUID()}`,
        tenantId,
        canvasTypeId,
        ...(name !== undefined ? { name } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        state: (initialState as Json) ?? {},
        version: 1,
        ...(metadata !== undefined ? { metadata: metadata as Json } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await canvases.put(canvas);
      const out = { canvasId: canvas.canvasId, canvasTypeId, ...(name ? { name } : {}), ...(projectId ? { projectId } : {}), createdAt: now };
      if (idempotencyKey) return idemPut(idem(`c:${idempotencyKey}`), out);
      return out;
    },

    async invoke(targetCanvasId, workflowId, args, opts) {
      // Surface-direct callers (no app boot) have no dispatcher — stay honest.
      if (!_invokeDeps) {
        log.info('canvas invoke: dispatcher not initialized (surface-direct)', { targetCanvasId, workflowId });
        return { childRunId: `canvas-invoke-${randomUUID()}`, result: { demo: 'run dispatcher not initialized' } };
      }
      const { storage, getWorkflow, executeRun } = _invokeDeps;

      // Circuit breaker: after N consecutive child-run failures for this
      // target, open the circuit (configurable threshold; default 5).
      const cbKey = `${tenantId}::${targetCanvasId}`;
      const threshold = Number((opts?.circuitBreaker as { threshold?: number } | undefined)?.threshold ?? 5);
      if ((_circuit.get(cbKey) ?? 0) >= threshold) {
        log.warn('canvas invoke: circuit open', { targetCanvasId, failures: _circuit.get(cbKey) });
        return { childRunId: '', circuitOpen: true };
      }

      // Recursion/depth guard — walk the parentRunId ancestor chain.
      const ancestors: string[] = [];
      let cursor = scope.runId;
      while (cursor && ancestors.length < MAX_INVOKE_DEPTH) {
        const a = await storage.getRun(cursor);
        if (!a) break;
        ancestors.push(a.workflowId);
        cursor = a.parentRunId;
      }
      if (ancestors.length >= MAX_INVOKE_DEPTH) {
        throw Object.assign(new Error(`canvas invoke depth ${ancestors.length} exceeds ${MAX_INVOKE_DEPTH}`), { code: 'canvas_invoke_depth_exceeded' });
      }
      if (ancestors.includes(workflowId)) {
        throw Object.assign(new Error(`canvas invoke cycle: '${workflowId}' already in ancestor chain`), { code: 'canvas_invoke_cycle_detected' });
      }

      const wf = await getWorkflow(workflowId);
      if (!wf) {
        throw Object.assign(new Error(`canvas invoke: workflow '${workflowId}' not found`), { code: 'canvas_invoke_workflow_not_found' });
      }

      const childRunId = randomUUID();
      const now = new Date().toISOString();
      const childRun: RunRecord = {
        runId: childRunId,
        workflowId,
        tenantId,
        ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
        status: 'pending',
        inputs: (args as Json) ?? {},
        metadata: { causationCanvasId: targetCanvasId },
        configurable: {},
        ...(scope.runId ? { parentRunId: scope.runId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await insertRunWithStartContext(storage, childRun, { definition: wf.definition });

      // awaitTerminal:false → fire-and-forget; return the id immediately.
      if (opts?.awaitTerminal === false) {
        void executeRun(storage, childRun, wf.definition, {}).catch((err) => log.warn('canvas child run (async) failed', { childRunId, error: err instanceof Error ? err.message : String(err) }));
        return { childRunId };
      }

      // Await terminal (executeRun resolves at terminal/suspend). Optional
      // timeout: stop waiting but let the run continue in the background.
      const runP = executeRun(storage, childRun, wf.definition, {}).catch(() => undefined);
      let timedOut = false;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        await Promise.race([runP, new Promise<void>((r) => setTimeout(() => { timedOut = true; r(); }, opts.timeoutMs))]);
        if (timedOut) return { childRunId, result: { timedOut: true } };
      } else {
        await runP;
      }

      const finalChild = await storage.getRun(childRunId);
      const status = finalChild?.status ?? 'failed';
      // Circuit-breaker bookkeeping: count failures, reset on success.
      _circuit.set(cbKey, status === 'failed' ? (_circuit.get(cbKey) ?? 0) + 1 : 0);

      const result = snapshotRunVariables(childRunId) ?? {};
      const out: { childRunId: string; result?: unknown; circuitOpen?: boolean; terminalStatus?: string; error?: unknown } = {
        childRunId,
        ...(TERMINAL_RUN.includes(status) ? { terminalStatus: status } : {}),
        result,
        ...(finalChild?.error ? { error: finalChild.error } : {}),
      };
      return out;
    },
  };
}
