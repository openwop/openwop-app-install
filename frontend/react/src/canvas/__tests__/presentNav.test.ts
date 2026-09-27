/**
 * ADR 0328 Phase 4 — present-mode navigation: skip flags, clamping, kiosk
 * looping, and the jump-grid goto; plus the public remote route matcher.
 */
import { describe, it, expect } from 'vitest';
import { advancePosition, firstPosition, firstVisible, gotoPosition, gotoVisible, retreatPosition, stepVisible } from '../presentNav.js';
import { matchPresentRemoteToken } from '../presentRemoteRoute.js';

const F = (...skips: boolean[]): { skip?: boolean }[] => skips.map((skip) => (skip ? { skip } : {}));

describe('presentNav', () => {
  it('firstVisible lands on the first non-skipped frame (fully-skipped decks fall back to 0)', () => {
    expect(firstVisible(F(false, false))).toBe(0);
    expect(firstVisible(F(true, true, false))).toBe(2);
    expect(firstVisible(F(true, true))).toBe(0);
    expect(firstVisible([])).toBe(0);
  });

  it('stepVisible passes over skipped frames and clamps at the ends', () => {
    const frames = F(false, true, false, true);
    expect(stepVisible(frames, 0, 1)).toBe(2);
    expect(stepVisible(frames, 2, 1)).toBe(2); // 3 is skipped, no loop → stay
    expect(stepVisible(frames, 2, -1)).toBe(0);
    expect(stepVisible(frames, 0, -1)).toBe(0);
  });

  it('stepVisible loops for kiosk mode', () => {
    const frames = F(false, true, false);
    expect(stepVisible(frames, 2, 1, true)).toBe(0);
    expect(stepVisible(frames, 0, -1, true)).toBe(2);
  });

  it('gotoVisible jumps to the frame, or the next visible when it is skipped', () => {
    const frames = F(false, true, false);
    expect(gotoVisible(frames, 1)).toBe(2);
    expect(gotoVisible(frames, 2)).toBe(2);
    expect(gotoVisible(frames, 99)).toBe(2);
    expect(gotoVisible(frames, -5)).toBe(0);
  });
});

describe('matchPresentRemoteToken', () => {
  it('matches the dotted token path and nothing else', () => {
    expect(matchPresentRemoteToken('/present-remote/v1.abc_D-e.1234.sig')).toBe('v1.abc_D-e.1234.sig');
    expect(matchPresentRemoteToken('/present-remote/')).toBeNull();
    expect(matchPresentRemoteToken('/present-remote/a/b')).toBeNull();
    expect(matchPresentRemoteToken('/shared/tok')).toBeNull();
  });
});

// ── ADR 0328 Phase 5 — builds: the (frame, step) position model. ───────────
describe('presentNav positions (builds)', () => {
  const frames = F(false, true, false);
  const steps = (i: number): number => (i === 0 ? 2 : 0);

  it('advance walks build steps before frames; retreat re-enters fully built', () => {
    let p = { frame: 0, step: 0 };
    p = advancePosition(frames, steps, p); expect(p).toEqual({ frame: 0, step: 1 });
    p = advancePosition(frames, steps, p); expect(p).toEqual({ frame: 0, step: 2 });
    p = advancePosition(frames, steps, p); expect(p).toEqual({ frame: 2, step: 0 }); // 1 is skipped
    p = advancePosition(frames, steps, p); expect(p).toEqual({ frame: 2, step: 0 }); // end, no loop
    p = retreatPosition(frames, steps, p); expect(p).toEqual({ frame: 0, step: 2 }); // back = fully built
    p = retreatPosition(frames, steps, p); expect(p).toEqual({ frame: 0, step: 1 });
  });

  it('loops for kiosk and jumps fully built', () => {
    expect(advancePosition(frames, steps, { frame: 2, step: 0 }, true)).toEqual({ frame: 0, step: 0 });
    expect(gotoPosition(frames, steps, 0)).toEqual({ frame: 0, step: 2 });
    expect(gotoPosition(frames, steps, 1)).toEqual({ frame: 2, step: 0 });
    expect(firstPosition(frames)).toEqual({ frame: 0, step: 0 });
  });
});
