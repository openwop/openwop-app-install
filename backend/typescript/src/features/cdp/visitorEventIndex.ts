/** ADR 0954 P0 — one owner for admission, canonical visitor indexing and
 * deletion. The existing reverse row is a receipt published BEFORE plaintext.
 * CAS deletion fences absent primaries/forward rows too. No expiry is authority. */
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { canonicalize } from '../../host/auditChainService.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { isErasureTombstoned, tombstoneId } from '../consent/consentService.js';
import { collectedIdentityValues, collectedIdentityForms } from './collectedEventIdentity.js';
import type { CollectedEvent } from './collectService.js';

export interface VisitorEventRow { key: string; tenantId: string; visitor: string; eventId: string; eventType: string; at: string }
interface ForwardRow { key: string; tenantId: string; eventId: string; visitorHash?: string; eventType?: string; at?: string; deleted?: true; visitor?: string }
interface DeletedEvent { eventId: string; tenantId: string; deleted: true }
interface Receipt {
  reservationId?: string; eventId: string; tenantId: string;
  state?: 'pending' | 'live' | 'deleting' | 'deleted'; operation?: string;
  digest?: string; subjectHashes?: string[]; forwardKey?: string;
  at?: string; eventType?: string; piiFields?: string[]; schemaVersion?: number;
  legacyForwardKeys?: string[]; projectionOnly?: true;
  /** Pre-receipt legacy reverse pointer, removed only after strict cleanup. */
  key?: string;
}
export const VISITOR_EVENT_CAP = 5_000;
const reservationId = (tenantId: string, eventId: string): string => `${tenantId}::${eventId}`;
const visitorHash = (tenantId: string, visitor: string): string => createHash('sha256').update(JSON.stringify([tenantId, 'cdp-visitor-v1', visitor])).digest('hex');
const prefixOf = (tenantId: string, visitor: string): string => `${tenantId}::${visitorHash(tenantId, visitor)}::`;
const forwardKeyOf = (ev: CollectedEvent): string | undefined => typeof ev.payload.visitor === 'string' && ev.payload.visitor.length > 0 ? `${prefixOf(ev.tenantId, ev.payload.visitor)}${ev.eventId}` : undefined;
const digestOf = (eventType: string, payload: Record<string, unknown>): string => createHash('sha256').update(canonicalize({ eventType, payload })).digest('hex');
const refused = (): OpenwopError => new OpenwopError('conflict', 'Collected event is closed or changed; use a new event identity.', 409, { reason: 'collected_event_closed' });
const log = createLogger('features.cdp.eventOwner');
const index = new DurableCollection<ForwardRow>('cdp:visitor-event', (r) => r.key, undefined, (r) => r.tenantId);
const reverse = new DurableCollection<Receipt>('cdp:visitor-event-of', (r) => r.reservationId ?? r.eventId, undefined, (r) => r.tenantId);
const backfilled = new DurableCollection<{ tenantId: string; at: string; format?: 'receipt-hash-v1' }>('cdp:visitor-index-built', (r) => r.tenantId, undefined, (r) => r.tenantId);
export const collectedEvents = new DurableCollection<CollectedEvent | DeletedEvent>(
  'cdp:collected-event', (e) => e.eventId, undefined, (e) => e.tenantId, undefined,
  async (eventId) => {
    // Compatibility only: normal deletes know the tenant and use the owner.
    // A rare direct-delete hook recovers context from authoritative receipts.
    for (const row of await reverse.list()) if (row.eventId === eventId) await deleteCollectedEvent(row.tenantId, eventId);
  },
);
export function isLiveCollectedEvent(row: CollectedEvent | DeletedEvent): row is CollectedEvent { return !('deleted' in row); }
function pendingReceipt(ev: CollectedEvent): Receipt {
  return { reservationId: reservationId(ev.tenantId, ev.eventId), tenantId: ev.tenantId, eventId: ev.eventId,
    state: 'pending', operation: randomUUID(), digest: digestOf(ev.eventType, ev.payload),
    subjectHashes: [...new Set(collectedIdentityValues(ev).flatMap(collectedIdentityForms).map((value) => tombstoneId(ev.tenantId, value)))],
    ...(forwardKeyOf(ev) ? { forwardKey: forwardKeyOf(ev) } : {}), at: ev.at, eventType: ev.eventType, piiFields: ev.piiFields,
    ...(ev.schemaVersion !== undefined ? { schemaVersion: ev.schemaVersion } : {}) };
}
async function barrier(ev: CollectedEvent): Promise<void> {
  for (const value of new Set(collectedIdentityValues(ev).flatMap(collectedIdentityForms))) {
    if (await isErasureTombstoned(ev.tenantId, value)) {
      await deleteCollectedEvent(ev.tenantId, ev.eventId);
      throw new OpenwopError('subject_erased', 'Collected event identity was erased.', 409);
    }
  }
}
/** A stale backfill snapshot cannot create a primary or index someone else's
 * payload. A conflicting reservation needs explicit recovery, never rewriting. */
export async function indexCollectedEvent(snapshot: Pick<CollectedEvent, 'eventId' | 'tenantId'>): Promise<void> {
  const current = await collectedEvents.get(snapshot.eventId);
  if (!current || current.tenantId !== snapshot.tenantId || !isLiveCollectedEvent(current)) return;
  const canonical = pendingReceipt(current);
  let receipt = await reverse.get(canonical.reservationId!);
  if (!receipt && await reverse.compareAndSwap(null, canonical)) receipt = canonical;
  receipt ??= await reverse.get(canonical.reservationId!);
  if (receipt?.state === 'deleting' || receipt?.state === 'deleted') {
    await deleteCollectedEvent(current.tenantId, current.eventId);
    throw refused();
  }
  if (!receipt || receipt.tenantId !== current.tenantId || (receipt.state !== 'pending' && receipt.state !== 'live')
    || receipt.digest !== canonical.digest || receipt.at !== current.at || receipt.schemaVersion !== current.schemaVersion
    || canonicalize(receipt.piiFields ?? []) !== canonicalize(current.piiFields)) throw refused();
  await barrier(current);
  if (canonical.forwardKey) {
    const row: ForwardRow = { key: canonical.forwardKey, tenantId: current.tenantId, eventId: current.eventId,
      visitorHash: visitorHash(current.tenantId, String(current.payload.visitor)), eventType: current.eventType, at: current.at };
    let indexed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const old = await index.get(row.key);
      if (old?.deleted) throw refused();
      if (old) { if (canonicalize(old) !== canonicalize(row)) throw refused(); indexed = true; break; }
      if (await index.compareAndSwap(null, row)) { indexed = true; break; }
    }
    if (!indexed) throw refused();
  }
  const after = await collectedEvents.get(current.eventId);
  if (!after || !isLiveCollectedEvent(after) || canonicalize(after) !== canonicalize(current)) throw refused();
  if (receipt.state !== 'live' && !(await reverse.compareAndSwap(receipt, { ...receipt, state: 'live' }))) {
    const newer = await reverse.get(canonical.reservationId!);
    if (newer?.state !== 'live' || newer.digest !== canonical.digest) throw refused();
  }
}
/** The only new-event writer (including the demo seed). */
export async function persistCollectedEvent(candidate: CollectedEvent): Promise<CollectedEvent> {
  const existing = await collectedEvents.get(candidate.eventId);
  if (existing) {
    if (existing.tenantId !== candidate.tenantId || !isLiveCollectedEvent(existing)) throw refused();
    await indexCollectedEvent(existing); return existing;
  }
  const offered = pendingReceipt(candidate);
  let own = await reverse.get(offered.reservationId!);
  if (!own && await reverse.compareAndSwap(null, offered)) own = offered;
  own ??= await reverse.get(offered.reservationId!);
  if (!own || own.tenantId !== candidate.tenantId || own.state !== 'pending' || own.digest !== offered.digest || !own.at) {
    const winner = await collectedEvents.get(candidate.eventId);
    if (winner?.tenantId === candidate.tenantId && isLiveCollectedEvent(winner)) { await indexCollectedEvent(winner); return winner; }
    throw refused();
  }
  const row: CollectedEvent = { ...candidate, at: own.at, piiFields: own.piiFields ?? [],
    ...(own.schemaVersion !== undefined ? { schemaVersion: own.schemaVersion } : {}) };
  if (own.schemaVersion === undefined) delete row.schemaVersion;
  await barrier(row);
  if (!(await collectedEvents.compareAndSwap(null, row))) {
    const winner = await collectedEvents.get(row.eventId);
    if (!winner || winner.tenantId !== row.tenantId || !isLiveCollectedEvent(winner)) throw refused();
    await indexCollectedEvent(winner); return winner;
  }
  await indexCollectedEvent(row);
  return row;
}
/** Replay precedes revalidation but repairs the stored winner's index/schema. */
export async function replayCollectedEvent(tenantId: string, eventId: string, eventType: string, payload: Record<string, unknown>): Promise<CollectedEvent | null> {
  const stored = await collectedEvents.get(eventId);
  if (stored) {
    if (stored.tenantId !== tenantId || !isLiveCollectedEvent(stored)) throw refused();
    await indexCollectedEvent(stored); return stored;
  }
  const receipt = await reverse.get(reservationId(tenantId, eventId));
  if (!receipt) return null;
  if (receipt.state !== 'pending' || receipt.digest !== digestOf(eventType, payload) || !receipt.at) throw refused();
  return persistCollectedEvent({ tenantId, eventId, eventType, payload, piiFields: receipt.piiFields ?? [], at: receipt.at,
    ...(receipt.schemaVersion !== undefined ? { schemaVersion: receipt.schemaVersion } : {}) });
}
/** Fence absent rows too; failed cleanup retains a discoverable deleting receipt. */
export async function deleteCollectedEvent(tenantId: string, eventId: string): Promise<boolean> {
  const id = reservationId(tenantId, eventId); let closed: Receipt | null = null; let wasLive = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await collectedEvents.get(eventId);
    if (current && current.tenantId !== tenantId) throw refused();
    wasLive ||= current !== null && isLiveCollectedEvent(current);
    const prior = await reverse.get(id);
    if (prior?.state === 'deleted' && current && !isLiveCollectedEvent(current)) return false;
    const oldKeys = (await index.listByPrefix(`${tenantId}::`)).filter((row) => row.tenantId === tenantId && row.eventId === eventId && row.visitorHash === undefined && !row.deleted).map((row) => row.key);
    const legacy = await reverse.get(eventId);
    if (legacy?.tenantId === tenantId && legacy.key) oldKeys.push(legacy.key);
    const next: Receipt = { ...(current && isLiveCollectedEvent(current) ? pendingReceipt(current) : {}), ...prior,
      reservationId: id, tenantId, eventId, state: 'deleting', legacyForwardKeys: [...new Set([...(prior?.legacyForwardKeys ?? []), ...oldKeys])] };
    if (await reverse.compareAndSwap(prior, next)) { closed = next; break; }
  }
  if (!closed) throw refused();
  let fenced = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await collectedEvents.get(eventId);
    if (current && current.tenantId !== tenantId) throw refused();
    if (current && !isLiveCollectedEvent(current)) { fenced = true; break; }
    if (await collectedEvents.compareAndSwap(current, { tenantId, eventId, deleted: true })) { fenced = true; break; }
  }
  if (!fenced) throw refused();
  if (closed.forwardKey) {
    let removed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const old = await index.get(closed.forwardKey);
      if (old?.deleted) { removed = true; break; }
      if (old && (old.tenantId !== tenantId || old.eventId !== eventId)) throw refused();
      if (await index.compareAndSwap(old, { key: closed.forwardKey, tenantId, eventId, deleted: true })) { removed = true; break; }
    }
    if (!removed) throw refused();
  }
  // Legacy forward-first crashes and old dedupe overwrites can leave MORE than
  // the one key named by the old reverse row. Preserve all keys before fencing.
  for (const key of closed.legacyForwardKeys ?? []) await index.delete(key);
  for (let attempt = 0; attempt < 5; attempt++) {
    const legacy = await reverse.get(eventId);
    if (!legacy || legacy.state === 'deleted') break;
    if (legacy.tenantId !== tenantId) throw refused();
    if (legacy.key) await index.delete(legacy.key);
    if (await reverse.compareAndSwap(legacy, { tenantId, eventId, state: 'deleted' })) break;
    if (attempt === 4) throw refused();
  }
  if (!(await reverse.compareAndSwap(closed, { reservationId: id, tenantId, eventId, state: 'deleted' }))) {
    if ((await reverse.get(id))?.state !== 'deleted') throw refused();
  }
  return wasLive;
}

/** Orphaned old projections are not authority over a different canonical
 * visitor. Their cleanup receipt never fences or deletes that primary. */
async function finishProjectionCleanup(receipt: Receipt): Promise<void> {
  for (const key of receipt.legacyForwardKeys ?? []) await index.delete(key);
  for (let attempt = 0; attempt < 5; attempt++) {
    const legacy = await reverse.get(receipt.eventId);
    if (!legacy || legacy.tenantId !== receipt.tenantId || !legacy.key || !receipt.legacyForwardKeys?.includes(legacy.key)) break;
    if (await reverse.compareAndSwap(legacy, { tenantId: receipt.tenantId, eventId: receipt.eventId, state: 'deleted' })) break;
    if (attempt === 4) throw refused();
  }
  if (!(await reverse.compareAndSwap(receipt, { reservationId: receipt.reservationId, tenantId: receipt.tenantId, eventId: receipt.eventId, state: 'deleted', projectionOnly: true }))) {
    if ((await reverse.get(receipt.reservationId!))?.state !== 'deleted') throw refused();
  }
}
/** After storage initialization: finish known deletion/index work. An absent
 * pending primary has no payload to invent and awaits its identical caller. */
export async function reconcileCollectedEventReceipts(): Promise<void> {
  let failed = 0;
  let rows: Receipt[];
  try { rows = await reverse.list(); }
  catch { log.warn('cdp_event_receipt_recovery_unavailable'); return; }
  for (const row of rows) {
    try {
      if (row.state === 'deleting' && row.projectionOnly) await finishProjectionCleanup(row);
      else if (row.state === 'deleting') await deleteCollectedEvent(row.tenantId, row.eventId);
      else if (row.state === 'pending') await indexCollectedEvent(row);
    } catch { failed++; } // preserve the receipt; one poison row cannot prevent host boot
  }
  if (failed) log.warn('cdp_event_receipt_recovery_incomplete', { failed });
}
export async function eraseCollectedEventsForIdentity(tenantId: string, subjectKey: string): Promise<number> {
  const subjects = new Set(collectedIdentityForms(subjectKey));
  const hashes = new Set([...subjects].map((subject) => tombstoneId(tenantId, subject))); const ids = new Set<string>();
  for (const receipt of await reverse.listByPrefix(`${tenantId}::`)) {
    if (receipt.tenantId === tenantId && receipt.subjectHashes?.some((hash) => hashes.has(hash))) {
      if (receipt.projectionOnly) { await finishProjectionCleanup(receipt); continue; }
      const current = await collectedEvents.get(receipt.eventId);
      if (current && isLiveCollectedEvent(current) && (current.tenantId !== tenantId || receipt.digest !== digestOf(current.eventType, current.payload))) throw refused();
      ids.add(receipt.eventId);
    }
  }
  // Legacy event IDs have no tenant prefix: retain authoritative primary fallback.
  for (const row of await collectedEvents.list()) {
    if (row.tenantId === tenantId && isLiveCollectedEvent(row) && collectedIdentityValues(row).flatMap(collectedIdentityForms).some((value) => subjects.has(value))) ids.add(row.eventId);
  }
  for (const eventId of ids) await deleteCollectedEvent(tenantId, eventId);
  // Old forward-only rows still contain plaintext visitor IDs, even if their
  // reverse row vanished or now points at another dedupe winner. Erase only
  // the matching obsolete projection; do not erase the other person's event.
  for (const row of await index.listByPrefix(`${tenantId}::`)) {
    if (row.tenantId !== tenantId || row.visitorHash !== undefined || typeof row.visitor !== 'string' || !collectedIdentityForms(row.visitor).some((value) => subjects.has(value))) continue;
    const id = `${tenantId}::projection::${createHash('sha256').update(row.key).digest('hex')}`;
    let cleanup = await reverse.get(id);
    if (!cleanup) {
      const candidate: Receipt = { reservationId: id, tenantId, eventId: row.eventId, state: 'deleting', projectionOnly: true, subjectHashes: [...hashes], legacyForwardKeys: [row.key] };
      if (await reverse.compareAndSwap(null, candidate)) cleanup = candidate;
      else cleanup = await reverse.get(id);
    }
    if (!cleanup || cleanup.tenantId !== tenantId || !cleanup.projectionOnly) throw refused();
    if (cleanup.state !== 'deleted') await finishProjectionCleanup(cleanup);
  }
  return ids.size;
}
async function ensureBackfilled(tenantId: string): Promise<void> {
  if ((await backfilled.get(tenantId))?.format === 'receipt-hash-v1') return;
  for (const ev of await collectedEvents.list()) if (ev.tenantId === tenantId && isLiveCollectedEvent(ev)) await indexCollectedEvent(ev);
  await backfilled.put({ tenantId, at: new Date().toISOString(), format: 'receipt-hash-v1' });
}
/** Bounded per-visitor reads; current primaries validate every candidate. Stored
 * rows carry tenant-bound hashes rather than plaintext visitor keys. */
export async function eventsForVisitors(tenantId: string, visitors: Iterable<string>, eventTypes?: ReadonlySet<string>): Promise<{ events: VisitorEventRow[]; truncated: boolean }> {
  await ensureBackfilled(tenantId);
  const out: VisitorEventRow[] = []; let truncated = false;
  for (const visitor of new Set(visitors)) {
    if (!visitor) continue;
    const rows = (await index.listByPrefix(prefixOf(tenantId, visitor))).filter((r) => r.tenantId === tenantId && !r.deleted && r.visitorHash === visitorHash(tenantId, visitor));
    rows.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    if (rows.length > VISITOR_EVENT_CAP) truncated = true;
    for (const row of rows.slice(0, VISITOR_EVENT_CAP)) {
      const canonical = await collectedEvents.get(row.eventId);
      if (!canonical || canonical.tenantId !== tenantId || !isLiveCollectedEvent(canonical) || canonical.payload.visitor !== visitor || canonical.eventType !== row.eventType || canonical.at !== row.at) continue;
      if (!eventTypes || eventTypes.has(canonical.eventType)) out.push({ key: row.key, tenantId, visitor, eventId: row.eventId, eventType: canonical.eventType, at: canonical.at });
    }
  }
  return { events: out, truncated };
}
