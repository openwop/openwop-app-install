/**
 * QuickShape fitting (ADR 0333 Phase 4) — pure proof: confident spines snap
 * to their primitive; sloppy ones stay raw ink (null = the honest default).
 */
import { describe, it, expect } from 'vitest';
import { fitQuickShape } from '../quickShape.js';

const UNIT = 4;
const circle = (cx: number, cy: number, r: number, n = 40, closeTo = 2 * Math.PI): { x: number; y: number }[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / (n - 1)) * closeTo;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });

describe('fitQuickShape', () => {
  it('fits a near-straight open spine to a line', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i * 8, y: i * 0.4 + (i % 2 ? 0.6 : -0.6) }));
    // The chord endpoints, exactly (first + last sample, 2dp) — not just the kind.
    expect(fitQuickShape(pts, UNIT)).toEqual({ kind: 'line', x1: 0, y1: -0.6, x2: 152, y2: 8.2 });
  });
  it('leaves a curved open spine as raw ink', () => {
    const arc = circle(50, 50, 40, 30, Math.PI); // half circle — open, curved
    expect(fitQuickShape(arc, UNIT)).toBeNull();
  });
  it('fits a closed round spine to a circle', () => {
    // bbox centre + mean radius at 2dp; cx is 80.06 (not 80) because the 40-sample
    // spine's leftmost sample misses the true extreme — the exact fit of THIS spine.
    expect(fitQuickShape(circle(80, 80, 40), UNIT)).toEqual({ kind: 'circle', cx: 80.06, cy: 80, r: 40 });
  });
  it('fits a flattened loop to an ellipse', () => {
    const pts = circle(0, 0, 1, 48).map((p) => ({ x: 100 + p.x * 60, y: 60 + p.y * 25 }));
    // bbox-derived (sampled extremes, 2dp) — ≈ the true (100,60) / 60×25 oval.
    expect(fitQuickShape(pts, UNIT)).toEqual({ kind: 'ellipse', cx: 100.07, cy: 60, rx: 59.93, ry: 24.99 });
  });
  it('fits a boxy closed spine to a rect', () => {
    const edge = (x1: number, y1: number, x2: number, y2: number, n = 10): { x: number; y: number }[] =>
      Array.from({ length: n }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n }));
    const pts = [...edge(0, 0, 120, 0), ...edge(120, 0, 120, 80), ...edge(120, 80, 0, 80), ...edge(0, 80, 0, 2)];
    // The spine's bbox, exactly — x/y/width/height not swapped or dropped.
    expect(fitQuickShape(pts, UNIT)).toEqual({ kind: 'rect', x: 0, y: 0, width: 120, height: 80 });
  });
  it('fits a closed three-corner spine to a triangle polygon', () => {
    const edge = (x1: number, y1: number, x2: number, y2: number, n = 12): { x: number; y: number }[] =>
      Array.from({ length: n }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n }));
    const pts = [...edge(60, 10, 110, 100), ...edge(110, 100, 10, 100), ...edge(10, 100, 60, 12)];
    // The three RDP corners, in spine order.
    expect(fitQuickShape(pts, UNIT)).toEqual({ kind: 'polygon', points: [{ x: 60, y: 10 }, { x: 110, y: 100 }, { x: 10, y: 100 }] });
  });
  it('returns null for tiny scribbles', () => {
    expect(fitQuickShape([{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 2 }], UNIT)).toBeNull();
  });
});
