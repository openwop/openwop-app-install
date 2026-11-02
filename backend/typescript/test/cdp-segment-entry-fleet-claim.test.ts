/**
 * W35-CDP-CLAIM-1 — the segment-entry sweep is fire-once ACROSS THE FLEET.
 *
 * `sweepSegmentEntries` gated on `if (!claim)`, but `storage.claimOnce` returns
 * `{ claimed, existing }`, which is always truthy, so the per-(segment, slot)
 * lease never skipped anything. With more than one Cloud Run instance
 * (maxScale 3), every instance resolved membership, read the same prior
 * snapshot, and emitted `crm.segment.entered` for the same entrant. Each
 * duplicate starts a bound journey run.
 *
 * Two "instances" here are two concurrent sweeps over ONE shared storage, for
 * the same slot. Membership resolution yields before returning, so both sweeps
 * read the prior snapshot before either writes it. That is the real race; a
 * sequential pair would pass without the fix, because the second diff is empty.
 *
 * grade-tests w67 (TST-CBM-3): red when the gate tests the always-truthy
 * `claim` instead of `claim.claimed`, or when the lease key drops the slot.
 * Each case opens its OWN storage, so neither depends on the other's snapshot
 * (shuffle-safe). `SLOT_MS` mirrors the daemon's private `DEFAULT_INTERVAL_MS`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let members: string[] = [];
const resolveSegmentMembers = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 5));
  return members.map((contactId) => ({ contactId }));
});
vi.mock('../src/features/crm/segmentsService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/crm/segmentsService.js')>()),
  listWatchedSegments: async () => [{ tenantId: 'acme', segmentId: 'seg-1' }],
  resolveSegmentMembers: () => resolveSegmentMembers(),
}));
vi.mock('../src/host/tenantFeatureGate.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/tenantFeatureGate.js')>()),
  tenantFeatureCheck: () => async () => true,
}));
const emitted: Array<{ type: string; payload: unknown }> = [];
vi.mock('../src/host/hostEventDispatcher.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/hostEventDispatcher.js')>()),
  emitHostEvent: async (e: { type: string; payload: unknown }) => { emitted.push(e); },
}));

import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { SEGMENT_ENTERED_EVENT, sweepSegmentEntries } from '../src/features/cdp/segmentEntryDaemon.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
const T0 = Date.UTC(2026, 9, 13, 9, 0, 0);
const SLOT_MS = 60_000;

beforeEach(() => {
  storage = openSqliteStorage(':memory:');
  initHostExtPersistence(storage);
  emitted.length = 0;
  members = [];
  resolveSegmentMembers.mockClear();
});
afterEach(async () => { __resetHostExtPersistence(); await storage.close(); });

describe('W35-CDP-CLAIM-1 — two instances, one slot', () => {
  it('emits segment.entered ONCE per entrant and resolves membership once', async () => {
    members = ['c1'];
    await sweepSegmentEntries(storage, T0); // seed: first observation never fires
    expect(emitted).toEqual([]);

    members = ['c1', 'c2'];
    resolveSegmentMembers.mockClear();
    const [a, b] = await Promise.all([
      sweepSegmentEntries(storage, T0 + SLOT_MS),
      sweepSegmentEntries(storage, T0 + SLOT_MS),
    ]);
    expect(a + b).toBe(1);
    expect(emitted).toEqual([expect.objectContaining({ type: SEGMENT_ENTERED_EVENT, payload: { segmentId: 'seg-1', contactId: 'c2' } })]);
    expect(resolveSegmentMembers).toHaveBeenCalledTimes(1); // the loser skips before any work
  });

  it('a NEW slot is claimable again (the lease is per slot, not forever)', async () => {
    members = ['c1', 'c2'];
    await sweepSegmentEntries(storage, T0 + 2 * SLOT_MS); // seed this case's own prior
    expect(emitted).toEqual([]);
    // The same slot again is already leased: nothing runs.
    members = ['c1', 'c2', 'c3'];
    expect(await sweepSegmentEntries(storage, T0 + 2 * SLOT_MS)).toBe(0);
    expect(emitted).toEqual([]);
    // The next slot is a new lease.
    const n = await sweepSegmentEntries(storage, T0 + 3 * SLOT_MS);
    expect(n).toBe(1);
    expect(emitted.map((e) => (e.payload as { contactId: string }).contactId)).toEqual(['c3']);
  });
});
