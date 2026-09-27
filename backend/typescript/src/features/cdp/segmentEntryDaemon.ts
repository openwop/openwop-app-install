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

/** Pure diff: contactIds present now but not in the prior snapshot. `prev === null`
 *  (first observation) returns [] — seed, never fire for the existing population. */
export function computeNewEntrants(prev: readonly string[] | null, current: readonly string[]): string[] {
  if (prev === null) return [];
  const before = new Set(prev);
  return current.filter((id) => !before.has(id));
}

/** One diff pass over every watched segment. Returns the number of entry events emitted. */
export async function sweepSegmentEntries(storage: Storage, now: number = Date.now()): Promise<number> {
  const slot = Math.floor(now / DEFAULT_INTERVAL_MS);
  let emitted = 0;
  for (const seg of await listWatchedSegments()) {
    try {
      // Fire-once across the fleet: only one instance processes a segment per slot.
      const claim = await storage.claimOnce(`cdp:segment-entry:${seg.tenantId}:${seg.segmentId}:${slot}`, new Date(now).toISOString());
      if (!claim) continue;
      const members = await resolveSegmentMembers(seg.tenantId, seg.segmentId);
      const currentIds = members.map((c) => c.contactId);
      const prior = await snapshots.get(snapKey(seg.tenantId, seg.segmentId));
      const newEntrants = computeNewEntrants(prior ? prior.memberIds : null, currentIds);
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
