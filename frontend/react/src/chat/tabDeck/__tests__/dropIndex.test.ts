import { describe, it, expect } from 'vitest';
import { computeDropIndex } from '../dropIndex.js';
import { tabDeckReducer, emptyTabDeck, type TabDeckState } from '../tabDeckModel.js';

const order = ['a', 'b', 'c', 'd'];

/** Apply a computed drop through the real reducer and read back the order, so the
 *  helper is verified against the SAME semantics the model uses (not just in the
 *  abstract). */
function applyDrop(initial: string[], fromSid: string, targetSid: string, side: 'before' | 'after'): string[] {
  let s: TabDeckState = initial.reduce((acc, id) => tabDeckReducer(acc, { type: 'open', sessionId: id, maxTabs: 100 }), emptyTabDeck);
  const idx = computeDropIndex(initial, fromSid, targetSid, side);
  if (idx !== null) s = tabDeckReducer(s, { type: 'reorder', fromSessionId: fromSid, toIndex: idx });
  return s.tabs.map((t) => t.sessionId);
}

describe('computeDropIndex — drag-drop ↔ reducer reorder', () => {
  it('drops left-to-right AFTER a target (the off-by-one case)', () => {
    expect(applyDrop(order, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
  });
  it('drops left-to-right BEFORE a target', () => {
    expect(applyDrop(order, 'a', 'c', 'before')).toEqual(['b', 'a', 'c', 'd']);
  });
  it('drops right-to-left BEFORE a target', () => {
    expect(applyDrop(order, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
  });
  it('drops right-to-left AFTER a target', () => {
    expect(applyDrop(order, 'd', 'b', 'after')).toEqual(['a', 'b', 'd', 'c']);
  });
  it('drops to the very front and very end', () => {
    expect(applyDrop(order, 'c', 'a', 'before')).toEqual(['c', 'a', 'b', 'd']);
    expect(applyDrop(order, 'b', 'd', 'after')).toEqual(['a', 'c', 'd', 'b']);
  });

  it('no-ops on self, unknown id, or a non-moving drop', () => {
    expect(computeDropIndex(order, 'a', 'a', 'before')).toBeNull();
    expect(computeDropIndex(order, 'a', 'zzz', 'before')).toBeNull();
    // 'a' dropped BEFORE 'b' is already 'a's position → no movement.
    expect(computeDropIndex(order, 'a', 'b', 'before')).toBeNull();
    // 'a' dropped AFTER 'a's right neighbor 'b'... handled by 'before c' etc.; the
    // direct "after the immediately-following" is a real move:
    expect(computeDropIndex(order, 'b', 'a', 'after')).toBeNull(); // b after a == b's slot
  });
});
