/**
 * Pure-math proof for the shared canvas viewport (ADR 0333 Phase 1). No DOM —
 * jsdom returns 0-rects, so every geometry decision lives in `viewport.ts`
 * where it's provable here (the edgeRouting precedent).
 */
import { describe, it, expect } from 'vitest';
import {
  clampZoom, zoomAtPoint, clientToCanvasPoint, boxBounds, fitToBounds,
  visibleCanvasRect, boxIntersectsBounds, clientBoundsToStage, edgeScrollVector, screenConstant, DEFAULT_ZOOM_LIMITS,
  type ViewportState, type ZoomLimits,
} from '../viewport.js';
import { clientToCanvas, contentBounds, fitView, visibleNodeIds, type Box } from '../graph/edgeRouting.js';

const LIMITS: ZoomLimits = { min: 0.25, max: 8 };
const vp = (x: number, y: number, zoom: number): ViewportState => ({ pan: { x, y }, zoom });

describe('clampZoom', () => {
  it('clamps into the range and sanitizes garbage', () => {
    expect(clampZoom(0.01, LIMITS)).toBe(0.25);
    expect(clampZoom(99, LIMITS)).toBe(8);
    expect(clampZoom(2, LIMITS)).toBe(2);
    expect(clampZoom(NaN, LIMITS)).toBe(1);
    expect(clampZoom(-3, LIMITS)).toBe(1);
  });
  it('guards a non-positive min', () => {
    expect(clampZoom(0.001, { min: 0, max: 4 })).toBe(0.01);
  });
});

describe('zoomAtPoint', () => {
  it('keeps the canvas point under the focal point fixed (the invariant)', () => {
    const start = vp(37, -12, 1.5);
    const focal = { x: 210, y: 140 };
    const before = clientToCanvasPoint(focal.x, focal.y, { left: 0, top: 0 }, start.pan, start.zoom);
    const next = zoomAtPoint(start, 1.3, focal, LIMITS);
    const after = clientToCanvasPoint(focal.x, focal.y, { left: 0, top: 0 }, next.pan, next.zoom);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });
  it('returns the same state at the clamp boundary (no pan drift)', () => {
    const start = vp(5, 5, 8);
    expect(zoomAtPoint(start, 2, { x: 100, y: 100 }, LIMITS)).toBe(start);
  });
  it('sanitizes a zero zoom state', () => {
    const next = zoomAtPoint(vp(0, 0, 0), 1.2, { x: 0, y: 0 }, LIMITS);
    expect(next.zoom).toBeCloseTo(1.2, 10);
  });
});

describe('fitToBounds', () => {
  it('centres content and respects the margin', () => {
    const f = fitToBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 500, 300, 40, LIMITS);
    expect(f.zoom).toBeCloseTo((300 - 80) / 100, 10);
    // Content centre maps to the viewport centre.
    const cx = 50 * f.zoom + f.pan.x;
    const cy = 50 * f.zoom + f.pan.y;
    expect(cx).toBeCloseTo(250, 10);
    expect(cy).toBeCloseTo(150, 10);
  });
  it('magnifies past 1:1 when the limits allow it', () => {
    const f = fitToBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 500, 500, 0, LIMITS);
    expect(f.zoom).toBe(8); // clamped by max, not by a hardcoded 1
  });
  it('the graph wrapper keeps the historical [0.25, 1] clamp byte-identical', () => {
    const small = fitView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 500, 500);
    expect(small.zoom).toBe(1); // never magnifies past 1:1
    const huge = fitView({ minX: 0, minY: 0, maxX: 100000, maxY: 100000 }, 500, 500);
    expect(huge.zoom).toBe(0.25);
  });
});

describe('visibleCanvasRect + boxIntersectsBounds', () => {
  it('maps the viewport through pan/zoom with a margin', () => {
    const r = visibleCanvasRect({ x: -100, y: 50 }, 2, 800, 600, 10);
    expect(r).toEqual({ minX: 40, minY: -35, maxX: 460, maxY: 285 });
  });
  it('agrees with the graph cull (delegation proof)', () => {
    const boxes = new Map<string, Box>([
      ['in', { x: 100, y: 100, w: 50, h: 50 }],
      ['out', { x: 5000, y: 5000, w: 50, h: 50 }],
    ]);
    const ids = visibleNodeIds(boxes, { x: 0, y: 0 }, 1, 800, 600, 0);
    expect(ids.has('in')).toBe(true);
    expect(ids.has('out')).toBe(false);
    const r = visibleCanvasRect({ x: 0, y: 0 }, 1, 800, 600, 0);
    expect(boxIntersectsBounds(boxes.get('in')!, r)).toBe(true);
    expect(boxIntersectsBounds(boxes.get('out')!, r)).toBe(false);
  });
});

describe('boxBounds / contentBounds delegation', () => {
  it('returns null for empty and unions boxes NaN-safely', () => {
    expect(boxBounds([])).toBeNull();
    expect(contentBounds([])).toBeNull();
    const b = contentBounds([{ x: 10, y: 20, w: 30, h: 40 }, { x: NaN, y: 0, w: 5, h: Infinity }]);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 60 });
  });
});

describe('clientToCanvas delegation', () => {
  it('round-trips through the rect + pan/zoom', () => {
    const p = clientToCanvas(250, 180, { left: 50, top: 30 }, { x: 20, y: -10 }, 2);
    expect(p).toEqual({ x: 90, y: 80 });
    expect(clientToCanvasPoint(250, 180, { left: 50, top: 30 }, { x: 20, y: -10 }, 2)).toEqual(p);
  });
});

describe('DEFAULT_ZOOM_LIMITS', () => {
  it('is a magnifying range for artboard canvases', () => {
    expect(DEFAULT_ZOOM_LIMITS.min).toBeLessThan(1);
    expect(DEFAULT_ZOOM_LIMITS.max).toBeGreaterThan(1);
  });
});

describe('clientBoundsToStage (ADR 0333 Phase 2)', () => {
  it('inverts the wrapper offset + pan/zoom', () => {
    const stage = clientBoundsToStage(
      { minX: 150, minY: 130, maxX: 250, maxY: 230 },
      { left: 50, top: 30 },
      { pan: { x: 20, y: -10 }, zoom: 2 },
    );
    expect(stage).toEqual({ minX: 40, minY: 55, maxX: 90, maxY: 105 });
  });
  it('round-trips with fitToBounds: fitting the converted bounds frames them', () => {
    const client = { minX: 100, minY: 100, maxX: 200, maxY: 200 };
    const rect = { left: 0, top: 0 };
    const cur: ViewportState = { pan: { x: 0, y: 0 }, zoom: 1 };
    const stage = clientBoundsToStage(client, rect, cur);
    const fitted = fitToBounds(stage, 400, 400, 0, LIMITS);
    // The bounds' centre lands at the viewport centre.
    const cx = ((stage.minX + stage.maxX) / 2) * fitted.zoom + fitted.pan.x;
    expect(cx).toBeCloseTo(200, 10);
  });
});

describe('edgeScrollVector (ADR 0333 Phase 2)', () => {
  it('is zero in the interior and ramps at the edges', () => {
    expect(edgeScrollVector({ x: 400, y: 300 }, 800, 600, 24, 14)).toEqual({ x: 0, y: 0 });
    const atLeft = edgeScrollVector({ x: 0, y: 300 }, 800, 600, 24, 14);
    expect(atLeft.x).toBeCloseTo(14, 10); // pan grows → content slides right
    expect(atLeft.y).toBe(0);
    const nearRight = edgeScrollVector({ x: 800 - 6, y: 300 }, 800, 600, 24, 14);
    expect(nearRight.x).toBeLessThan(0);
    expect(Math.abs(nearRight.x)).toBeLessThan(14); // eased, not full speed
  });
  it('never scrolls a degenerate wrapper', () => {
    expect(edgeScrollVector({ x: 1, y: 1 }, 40, 40, 24, 14)).toEqual({ x: 0, y: 0 });
  });
  it('saturates at maxSpeed for a captured pointer far outside the wrapper', () => {
    const far = edgeScrollVector({ x: -500, y: 300 }, 800, 600, 24, 14);
    expect(far.x).toBe(14);
  });
});

// ADR 0333 grade pass — screen-constant selection-handle sizing.
describe('screenConstant', () => {
  it('is a no-op at zoom 1 (fit view byte-identical)', () => {
    expect(screenConstant(6, 1)).toBe(6);
  });
  it('halves the base at 2× and doubles it at 0.5× (on-screen size pinned to zoom-1)', () => {
    expect(screenConstant(6, 2)).toBe(3);
    expect(screenConstant(6, 0.5)).toBe(12);
  });
  it('guards a non-positive zoom (never divides by zero)', () => {
    expect(screenConstant(6, 0)).toBe(6);
  });
});
