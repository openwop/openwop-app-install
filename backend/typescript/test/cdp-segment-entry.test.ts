/**
 * CDP-E — segment-entered trigger diff (ADR 0267). The membership-diff invariants:
 * first observation seeds (never fires for the existing population), and only
 * NEWLY-entered contacts fire (exits are not entries).
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
  it('fires again for a re-entry after an exit was observed', () => {
    // prev snapshot had only 'a' (b had exited and been recorded gone); b re-enters
    expect(computeNewEntrants(['a'], ['a', 'b'])).toEqual(['b']);
  });
});
