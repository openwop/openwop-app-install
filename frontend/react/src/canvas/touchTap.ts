/**
 * Multi-finger tap detection (ADR 0333 Phase 8 · extracted for DRAW-R2). A
 * clean simultaneous N-finger TAP on the canvas maps 2→undo, 3→redo (the
 * verified Procreate convention). Pure state machine so the logic that shipped
 * the DRAW-D3 bug (a cross-finger distance check that ~always disqualified a
 * real two-finger tap) is unit-testable without a DOM.
 *
 * A tap qualifies iff: every finger came down within the window, NO finger
 * moved past `SLOP` from ITS OWN down, and the whole gesture completed within
 * `WINDOW_MS`. `peak` is the max simultaneous finger count — a 2-then-3 count.
 */

export interface TapState {
  startAt: number;
  downs: Map<number, { x: number; y: number }>;
  moved: boolean;
  peak: number;
}

export const TAP_WINDOW_MS = 250;
export const TAP_SLOP_PX = 12;

/** A new pointer down. Starts a fresh gesture if none is live or the window
 *  lapsed; otherwise joins the current one. Returns the (possibly new) state. */
export function tapDown(prev: TapState | null, pointerId: number, x: number, y: number, now: number): TapState {
  if (!prev || now - prev.startAt > TAP_WINDOW_MS) {
    return { startAt: now, downs: new Map([[pointerId, { x, y }]]), moved: false, peak: 1 };
  }
  prev.downs.set(pointerId, { x, y });
  prev.peak = Math.max(prev.peak, prev.downs.size);
  return prev;
}

/** A pointer moved — disqualify the tap if THIS finger travelled past the slop
 *  from its own down (a pinch/drag is never a tap). */
export function tapMove(state: TapState | null, pointerId: number, x: number, y: number): void {
  const d = state?.downs.get(pointerId);
  if (state && d && Math.hypot(x - d.x, y - d.y) > TAP_SLOP_PX) state.moved = true;
}

/** A pointer lifted. Returns `{ state, fire }`: `fire` is the finger count to
 *  act on (2 or 3) when the LAST finger lifts a clean tap, else 0. `state` is
 *  null once the gesture ends. */
export function tapUp(state: TapState | null, pointerId: number, now: number): { state: TapState | null; fire: 0 | 2 | 3 } {
  if (!state) return { state: null, fire: 0 };
  state.downs.delete(pointerId);
  if (state.downs.size > 0) return { state, fire: 0 }; // wait for the last finger
  const clean = !state.moved && now - state.startAt <= TAP_WINDOW_MS;
  const fire = clean && (state.peak === 2 || state.peak === 3) ? state.peak : 0;
  return { state: null, fire: fire as 0 | 2 | 3 };
}
