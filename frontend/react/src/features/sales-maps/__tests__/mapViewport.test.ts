/**
 * Sales Maps — viewport (zoom/pan) math unit tests (ADR 0282 P5). The wheel/drag
 * handlers are thin; the anchor + clamping invariants live here and must be exact.
 *
 * Expected viewports are hand-computed literals (halfW = 1000/scale/2, halfH = 500/scale/2);
 * `pointAt` is an independent re-derivation of viewBox semantics, never the product code.
 *
 * Sabotage-witnessed (wave 52): dropping the MAX scale clamp, dropping the low cx clamp,
 * dropping zoomAtPoint's final clamp, swapping the anchor's fx for fy, inverting the pan
 * sign, ignoring scale in the pan conversion, and returning the centre instead of the
 * top-left corner from viewBoxOf each turn a case red.
 *
 * Wave 52 found the old edge case vacuous: a ZOOM-IN anchored at the top-left corner lands
 * exactly on the boundary (cx = 125 = halfW), so the clamp was a no-op. A zoom OUT from a
 * corner is the case where the unclamped answer leaves the world.
 */
import { describe, expect, it } from 'vitest';
import { MAP_W, MAP_H } from '../projection.js';
import { HOME_VIEWPORT, MIN_SCALE, MAX_SCALE, clampViewport, viewBoxOf, zoomAtPoint, panByPixels } from '../mapViewport.js';

/** The world point rendered at screen fraction (fx, fy) for a viewport. */
const pointAt = (v: { scale: number; cx: number; cy: number }, fx: number, fy: number): [number, number] => {
  const w = MAP_W / v.scale;
  const h = MAP_H / v.scale;
  return [v.cx - w / 2 + fx * w, v.cy - h / 2 + fy * h];
};

describe('sales-maps map viewport', () => {
  it('home viewport shows the whole world', () => {
    expect(viewBoxOf(HOME_VIEWPORT)).toBe(`0 0 ${MAP_W} ${MAP_H}`);
  });

  it('clamps scale to [MIN, MAX] and the centre to the world', () => {
    expect(clampViewport({ scale: 0.2, cx: 0, cy: 0 }).scale).toBe(MIN_SCALE);
    expect(clampViewport({ scale: 99, cx: 0, cy: 0 }).scale).toBe(MAX_SCALE);
    const v = clampViewport({ scale: 2, cx: -500, cy: 9999 });
    expect(v.cx).toBe(MAP_W / 4); // half of the zoomed width
    expect(v.cy).toBe(MAP_H - MAP_H / 4);
  });

  it('zoomAtPoint keeps the anchored world point under the cursor', () => {
    const v1 = zoomAtPoint(HOME_VIEWPORT, 0.25, 0.75, 2);
    // hand-computed: anchor world point (250, 375); cx = 250 + 500·0.25, cy = 375 − 250·0.25
    expect(v1).toEqual({ scale: 2, cx: 375, cy: 312.5 });
    expect(viewBoxOf(v1)).toBe('125 187.5 500 250');
    expect(pointAt(v1, 0.25, 0.75)).toEqual(pointAt(HOME_VIEWPORT, 0.25, 0.75));
    // and again from a zoomed state, unless clamping intervenes
    const v2 = zoomAtPoint(v1, 0.5, 0.5, 4);
    expect(pointAt(v2, 0.5, 0.5)).toEqual(pointAt(v1, 0.5, 0.5));
  });

  it('zoomAtPoint clamps at the world edge instead of leaving it (zooming OUT from a corner)', () => {
    // Top-left quarter at scale 4 (halfW 125, halfH 62.5), zoom out to 2 around the centre.
    // Unclamped the centre would stay at (125, 62.5) and the viewBox would start at
    // (−125, −62.5); at scale 2 the centre must be at least (halfW 250, halfH 125).
    const v = zoomAtPoint({ scale: 4, cx: 125, cy: 62.5 }, 0.5, 0.5, 2);
    expect(v).toEqual({ scale: 2, cx: 250, cy: 125 });
    expect(viewBoxOf(v)).toBe('0 0 500 250');
  });

  it('panByPixels converts screen px to world units at the current scale', () => {
    const zoomedIn = clampViewport({ scale: 4, cx: MAP_W / 2, cy: MAP_H / 2 });
    // Rendered at 1000px wide, the visible world is MAP_W/4 units → 100px = MAP_W/40 units.
    const panned = panByPixels(zoomedIn, 100, 0, 1000);
    expect(zoomedIn.cx - panned.cx).toBeCloseTo(MAP_W / 40);
    expect(panned.cy).toBe(zoomedIn.cy);
    // Panning never escapes the world.
    const slammed = panByPixels(zoomedIn, 1e6, 1e6, 1000);
    expect(slammed.cx).toBe(MAP_W / 8);
    expect(slammed.cy).toBe(MAP_H / 8);
  });

  it('zooming out from anywhere lands back on the whole world', () => {
    const wandered = panByPixels(zoomAtPoint(HOME_VIEWPORT, 0.9, 0.1, 8), 50, 80, 800);
    expect(viewBoxOf(zoomAtPoint(wandered, 0.5, 0.5, 1))).toBe(viewBoxOf(HOME_VIEWPORT));
  });
});
