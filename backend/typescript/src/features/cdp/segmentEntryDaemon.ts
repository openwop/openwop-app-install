/**
 * Segment-entered trigger (ADR 0267 / CDP-E) — a membership-diff daemon.
 *
 * For each segment opted into `watchEntries`, resolve current membership each
 * tick, diff against the last snapshot, and emit `crm.segment.entered` per newly-
 * entered contact. A journey workflow bound to that event type (the existing
 * `HostEventBinding` path — RFC 0083/ADR 0034) fires per new entrant. REUSES the
 * trigger bridge; it does NOT build a parallel trigger source (ADR 0262 ruling).
 *
 * First observation SEEDS the snapshot without emitting (so turning watching on
 * doesn't fire a journey for every existing member). Multi-instance safe: a
 * per-(segment, slot) `claimOnce` gates one processor per tick.
 */
import type { Storage } from '../../storage/storage.js';
import { runUnderWorkerContract } from '../../storage/eventEraAdapter.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { listWatchedSegments, resolveSegmentMembers } from '../crm/segmentsService.js';
import { createLogger } from '../../observability/logger.js';
import { tenantFeatureCheck } from '../../host/tenantFeatureGate.js';
import { isErasureTombstoned } from '../consent/consentService.js';

const log = createLogger('cdp.segmentEntryDaemon');
const DEFAULT_INTERVAL_MS = 60_000;

/** The host event type a journey binds to. */
export const SEGMENT_ENTERED_EVENT = 'crm.segment.entered';

interface SnapshotRow {
  /** `${tenantId}::${segmentId}` */
  key: string;
  tenantId: string;
  segmentId: string;
  memberIds: string[];
  at: string;
}

const snapshots = new DurableCollection<SnapshotRow>('cdp:segment-snapshot', (r) => r.key, undefined, (r) => r.tenantId);
const snapKey = (tenantId: string, segmentId: string): string => `${tenantId}::${segmentId}`;

/**
 * ADR 1024 D5.3 (`CDP2WF-8`) — the DSAR eraser for `cdp:segment-snapshot`.
 *
 * A snapshot's `memberIds` lists the contact ids that were in a watched segment at the
 * last pass. It is personal data (who belongs to which audience) and no eraser or purger
 * reached it: the store self-heals only while its segment stays watched, and an
 * unwatched segment's snapshot sat there until tenant deletion. The id is REMOVED from
 * every snapshot of the tenant (CAS per row; the snapshot itself is the segment's and is
 * kept). The subject key arrives already expanded by the seam (email → contactId and its
 * merged-away contacts), so an exact id match is the whole rule.
 *
 * An erased contact that still matches the segment is kept OUT of later passes by
 * `withoutErased` below (the erasure tombstone), so the id does not come back and no
 * `crm.segment.entered` fires for it.
 */
export async function eraseSegmentSnapshotSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return; // fail-closed — never a tenant-wide sweep
  // Member ids are CRM contact ids (`crm:`-prefixed, `contactsService.createContact`); any
  // other key shape (an email, a session, a userId) matches nothing, so skip the scan.
  if (!subjectKey.startsWith('crm:')) return;
  let touched = 0;
  for (const row of await snapshots.listForTenantIndexed(tenantId)) {
    if (row.tenantId !== tenantId || !row.memberIds.includes(subjectKey)) continue;
    let cur: SnapshotRow | null = row;
    for (let attempt = 0; attempt < 5 && cur && cur.memberIds.includes(subjectKey); attempt++) {
      if (await snapshots.compareAndSwap(cur, { ...cur, memberIds: cur.memberIds.filter((id) => id !== subjectKey) })) { touched++; cur = null; break; }
      cur = await snapshots.get(row.key);
    }
    // Only a row that STILL holds the id after the retries is a failure (a concurrent
    // removal is success, not a lost race).
    if (cur && cur.memberIds.includes(subjectKey)) throw new Error('segment snapshot erasure lost every CAS; retry the erasure');
  }
  if (touched) log.info('cdp_segment_snapshot_member_erased', { tenantId, snapshots: touched });
}

/** ADR 1024 D5.3 (closing grade H1) — the ids a pass may record and emit. An erased
 *  contact keeps an anonymised row, so a segment rule that does not test the address can
 *  still match it: without this the next pass put the id straight back into the snapshot
 *  (undoing the erasure) and emitted `crm.segment.entered`, which could enrol the erased
 *  person in a journey again. Only ids NOT in the prior snapshot are checked (an erased id
 *  was removed from it, so it is always among them); a reseed checks every id once. */
async function withoutErased(tenantId: string, ids: readonly string[], prior: readonly string[] | null): Promise<string[]> {
  const known = new Set(prior ?? []);
  const out: string[] = [];
  for (const id of ids) {
    if (known.has(id) || !(await isErasureTombstoned(tenantId, id))) out.push(id);
  }
  return out;
}

/** Pure diff: contactIds present now but not in the prior snapshot. `prev === null`
 *  (first observation) returns [] — seed, never fire for the existing population. */
export function computeNewEntrants(prev: readonly string[] | null, current: readonly string[]): string[] {
  if (prev === null) return [];
  const before = new Set(prev);
  return current.filter((id) => !before.has(id));
}

/** ADR 0820 §7 / G10 — the toggle this daemon's work belongs to. */
export const SEGMENT_ENTRY_FEATURE_ID = 'cdp';

/**
 * ADR 0820 §7 / G10 — a snapshot older than this is RE-SEEDED, never diffed. A
 * tenant whose `cdp` access lapsed is skipped (its snapshot stops moving), so on
 * re-entitlement days later a diff would fire a journey for everyone who entered
 * during the lapse. A fleet outage is minutes, well inside this window, so its
 * entrants still fire on recovery.
 */
export const SNAPSHOT_RESEED_AFTER_MS = 6 * 60 * 60_000;

/** One diff pass over every watched segment. Returns the number of entry events emitted. */
export async function sweepSegmentEntries(storage: Storage, now: number = Date.now()): Promise<number> {
  const slot = Math.floor(now / DEFAULT_INTERVAL_MS);
  let emitted = 0;
  // ADR 0820 §7 / G10 — per-tenant gate (toggle + plan), memoized for this pass.
  const mayUse = tenantFeatureCheck(SEGMENT_ENTRY_FEATURE_ID);
  for (const seg of await listWatchedSegments()) {
    try {
      // Silent, cheap skip: no claim, no membership resolve, no event.
      if (!(await mayUse(seg.tenantId))) continue;
      // Fire-once across the fleet: only one instance processes a segment per slot.
      const claim = await storage.claimOnce(`cdp:segment-entry:${seg.tenantId}:${seg.segmentId}:${slot}`, new Date(now).toISOString());
      // `claimOnce` returns `{ claimed, existing }` — always truthy, so the gate is
      // `.claimed` (W35-CDP-CLAIM-1: `!claim` never skipped, and every instance emitted).
      if (!claim.claimed) continue;
      const members = await resolveSegmentMembers(seg.tenantId, seg.segmentId);
      const prior = await snapshots.get(snapKey(seg.tenantId, seg.segmentId));
      const currentIds = await withoutErased(seg.tenantId, members.map((c) => c.contactId), prior ? prior.memberIds : null);
      const fresh = prior && now - Date.parse(prior.at) <= SNAPSHOT_RESEED_AFTER_MS ? prior : null;
      const newEntrants = computeNewEntrants(fresh ? fresh.memberIds : null, currentIds);
      for (const contactId of newEntrants) {
        await emitHostEvent({ type: SEGMENT_ENTERED_EVENT, tenantId: seg.tenantId, payload: { segmentId: seg.segmentId, contactId } });
        emitted += 1;
      }
      await snapshots.put({ key: snapKey(seg.tenantId, seg.segmentId), tenantId: seg.tenantId, segmentId: seg.segmentId, memberIds: currentIds, at: new Date(now).toISOString() });
    } catch (err) {
      log.warn('segment-entry sweep failed for segment', { segmentId: seg.segmentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return emitted;
}

export interface SegmentEntryDaemon {
  stop: () => void;
}

export function startSegmentEntryDaemon(deps: { storage: Storage }): SegmentEntryDaemon {
  const intervalMs = Number(process.env.OPENWOP_SEGMENT_ENTRY_SWEEP_MS) || DEFAULT_INTERVAL_MS;
  const tick = (): void => {
    void sweepSegmentEntries(deps.storage).catch((err) =>
      log.warn('segment-entry tick failed', { error: err instanceof Error ? err.message : String(err) }),
    );
  };
  const handle = setInterval(() => runUnderWorkerContract(tick), intervalMs);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
}
