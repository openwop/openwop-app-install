/**
 * Present-mode navigation (ADR 0328 Phase 4) — the pure frame-order logic the
 * chassis present page, kiosk loop, and phone-remote command handler all share.
 * A frame with `skip: true` stays in the deck (and the jump grid, dimmed) but
 * is passed over by next/prev and by the kiosk auto-advance.
 */

export interface PresentableFrame { skip?: boolean }

const isSkipped = (frames: readonly PresentableFrame[], i: number): boolean => frames[i]?.skip === true;

/** The first non-skipped index (a fully-skipped deck falls back to 0). */
export function firstVisible(frames: readonly PresentableFrame[]): number {
  for (let i = 0; i < frames.length; i += 1) if (!isSkipped(frames, i)) return i;
  return 0;
}

/** The next/previous non-skipped index from `current`; clamps at the ends
 *  (or wraps when `loop`). Returns `current` when there is nowhere to go. */
export function stepVisible(frames: readonly PresentableFrame[], current: number, dir: 1 | -1, loop = false): number {
  if (frames.length === 0) return 0;
  let i = current;
  for (let hops = 0; hops < frames.length; hops += 1) {
    i += dir;
    if (i >= frames.length) { if (!loop) return current; i = 0; }
    if (i < 0) { if (!loop) return current; i = frames.length - 1; }
    if (!isSkipped(frames, i)) return i;
  }
  return current;
}

/** Jump target: `index` itself when visible, else the next visible after it. */
export function gotoVisible(frames: readonly PresentableFrame[], index: number): number {
  const clamped = Math.max(0, Math.min(frames.length - 1, index));
  return isSkipped(frames, clamped) ? stepVisible(frames, clamped, 1, true) : clamped;
}

// ── ADR 0328 Phase 5 — builds: position = (frame, step). ───────────────────
// A frame with N build steps shows step 0..N; `advance` walks steps before
// frames; `retreat` re-enters the previous frame FULLY BUILT (the Keynote
// convention — going back never replays builds).

export interface PresentPosition { frame: number; step: number }

export type StepsOf = (frameIndex: number) => number;

export function firstPosition(frames: readonly PresentableFrame[]): PresentPosition {
  return { frame: firstVisible(frames), step: 0 };
}

export function advancePosition(frames: readonly PresentableFrame[], stepsOf: StepsOf, pos: PresentPosition, loop = false): PresentPosition {
  if (pos.step < stepsOf(pos.frame)) return { frame: pos.frame, step: pos.step + 1 };
  const next = stepVisible(frames, pos.frame, 1, loop);
  return next === pos.frame ? pos : { frame: next, step: 0 };
}

export function retreatPosition(frames: readonly PresentableFrame[], stepsOf: StepsOf, pos: PresentPosition): PresentPosition {
  if (pos.step > 0) return { frame: pos.frame, step: pos.step - 1 };
  const prev = stepVisible(frames, pos.frame, -1, false);
  return prev === pos.frame ? pos : { frame: prev, step: stepsOf(prev) };
}

/** Jump lands fully built (the grid and the phone show whole slides). */
export function gotoPosition(frames: readonly PresentableFrame[], stepsOf: StepsOf, index: number): PresentPosition {
  const frame = gotoVisible(frames, index);
  return { frame, step: stepsOf(frame) };
}
