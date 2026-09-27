/**
 * Touch tap-detection state machine (ADR 0333 grade-pass DRAW-R2) — the pure
 * logic behind two-finger-undo / three-finger-redo, isolated so the DRAW-D3
 * bug (a cross-finger distance check that disqualified real two-finger taps)
 * can't recur. No DOM.
 */
import { describe, it, expect } from 'vitest';
import { tapDown, tapMove, tapUp, TAP_WINDOW_MS, TAP_SLOP_PX, type TapState } from '../touchTap.js';

/** Drive a full gesture; returns the fire code at the last up. */
function gesture(steps: Array<['down' | 'up' | 'move', number, number, number, number]>): 0 | 2 | 3 {
  let s: TapState | null = null;
  let fire: 0 | 2 | 3 = 0;
  for (const [kind, id, x, y, now] of steps) {
    if (kind === 'down') s = tapDown(s, id, x, y, now);
    else if (kind === 'move') tapMove(s, id, x, y);
    else { const r = tapUp(s, id, now); s = r.state; fire = r.fire; }
  }
  return fire;
}

describe('touchTap', () => {
  it('a two-finger tap fires undo — even with the fingers 200px apart (the DRAW-D3 regression)', () => {
    expect(gesture([
      ['down', 1, 100, 100, 0],
      ['down', 2, 300, 100, 5], // 200px from finger 1 — the old check wrongly rejected this
      ['up', 2, 300, 100, 20],  // finger 2 lifts first
      ['up', 1, 100, 100, 25],
    ])).toBe(2);
  });

  it('a three-finger tap fires redo', () => {
    expect(gesture([
      ['down', 1, 0, 0, 0], ['down', 2, 50, 0, 3], ['down', 3, 100, 0, 6],
      ['up', 3, 100, 0, 20], ['up', 1, 0, 0, 22], ['up', 2, 50, 0, 24],
    ])).toBe(3);
  });

  it('fires only on the LAST finger up (not the first)', () => {
    let s: TapState | null = null;
    s = tapDown(s, 1, 0, 0, 0);
    s = tapDown(s, 2, 40, 0, 2);
    const first = tapUp(s, 2, 10); // one finger still down
    expect(first.fire).toBe(0);
    expect(first.state).not.toBeNull();
    const last = tapUp(first.state, 1, 12);
    expect(last.fire).toBe(2);
    expect(last.state).toBeNull();
  });

  it('any finger moving past the slop disqualifies (a pinch is not a tap)', () => {
    expect(gesture([
      ['down', 1, 100, 100, 0], ['down', 2, 300, 100, 3],
      ['move', 1, 100 + TAP_SLOP_PX + 1, 100, 5], // finger 1 dragged past slop
      ['up', 2, 300, 100, 20], ['up', 1, 120, 100, 22],
    ])).toBe(0);
  });

  it('sub-slop wobble does NOT disqualify', () => {
    expect(gesture([
      ['down', 1, 100, 100, 0], ['down', 2, 300, 100, 3],
      ['move', 1, 100 + TAP_SLOP_PX - 1, 100, 5],
      ['up', 2, 300, 100, 20], ['up', 1, 110, 100, 22],
    ])).toBe(2);
  });

  it('a hold longer than the window disqualifies', () => {
    expect(gesture([
      ['down', 1, 0, 0, 0], ['down', 2, 40, 0, 3],
      ['up', 2, 40, 0, TAP_WINDOW_MS + 10], ['up', 1, 0, 0, TAP_WINDOW_MS + 12],
    ])).toBe(0);
  });

  it('one finger and four+ fingers do nothing', () => {
    expect(gesture([['down', 1, 0, 0, 0], ['up', 1, 0, 0, 10]])).toBe(0);
    expect(gesture([
      ['down', 1, 0, 0, 0], ['down', 2, 20, 0, 1], ['down', 3, 40, 0, 2], ['down', 4, 60, 0, 3],
      ['up', 1, 0, 0, 10], ['up', 2, 20, 0, 11], ['up', 3, 40, 0, 12], ['up', 4, 60, 0, 13],
    ])).toBe(0);
  });

  it('a second finger arriving after the window starts a fresh gesture', () => {
    let s: TapState | null = tapDown(null, 1, 0, 0, 0);
    s = tapDown(s, 2, 40, 0, TAP_WINDOW_MS + 5); // lapsed → new single-finger gesture
    expect(s.peak).toBe(1);
    expect(tapUp(s, 2, TAP_WINDOW_MS + 10).fire).toBe(0);
  });
});
