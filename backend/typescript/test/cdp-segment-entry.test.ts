/**
 * CDP-E — segment-entered trigger diff (ADR 0267). The membership-diff invariants:
 * first observation seeds (never fires for the existing population), and only
 * NEWLY-entered contacts fire (exits are not entries).
 *
 * Sabotage-witnessed (/grade-tests w38): returning `current` on first observation reds case 1;
 * dropping the `!before.has(id)` diff reds cases 2 and 3. Re-entry after an exit depends on the
 * daemon's SNAPSHOT (written each tick), which this pure diff cannot express; the former pure
 * "re-entry" case was byte-identical to case 2's first expectation and was cut (w38). The
 * snapshot seed → diff path is driven through `sweepSegmentEntries` in
 * cdp-segment-entry-fleet-claim.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { computeNewEntrants } from '../src/features/cdp/segmentEntryDaemon.js';

describe('CDP-E computeNewEntrants', () => {
  it('seeds silently on first observation (prev === null)', () => {
    expect(computeNewEntrants(null, ['a', 'b', 'c'])).toEqual([]);
  });
  it('fires only for contacts present now but not before', () => {
    expect(computeNewEntrants(['a'], ['a', 'b'])).toEqual(['b']);
    expect(computeNewEntrants(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd']);
  });
  it('does not fire for exits or unchanged membership', () => {
    expect(computeNewEntrants(['a', 'b'], ['a'])).toEqual([]); // b exited — not an entry
    expect(computeNewEntrants(['a'], ['a'])).toEqual([]);
    expect(computeNewEntrants(['a', 'b'], [])).toEqual([]);
  });
});
