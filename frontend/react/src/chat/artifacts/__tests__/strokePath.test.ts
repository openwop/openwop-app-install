/**
 * Pure spine→outline proof (ADR 0333 Phase 3). The outline is a closed,
 * numeric-only path whose geometry brackets the spine by the pressure-scaled
 * radius — the safety-relevant property (the renderer fills exactly this).
 *
 * `DrawingPreview` passes a drawing's `points` to this module UNVALIDATED, so the
 * numeric-only guarantee is carried by the coordinate formatter (round to 2dp via
 * Math.round), not by the input's type — the "numeric-only" case feeds it a
 * string coordinate to prove that (grade-tests w45: an all-numeric fixture could
 * not tell the formatter from String()).
 */
import { describe, it, expect } from 'vitest';
import { strokeOutlinePath, strokeOutlinePoints, strokeRadii, type SpinePt } from '../strokePath.js';

const line = (n: number): { x: number; y: number }[] => Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0 }));

describe('strokeRadii', () => {
  it('maps pressure into [0.5, 1.0]× the base radius', () => {
    const r = strokeRadii(line(3), [0, 0.5, 1], { size: 8 });
    expect(r[0]).toBeCloseTo(2, 5);   // 4 × 0.5
    expect(r[1]).toBeCloseTo(3, 5);   // 4 × 0.75
    expect(r[2]).toBeCloseTo(4, 5);   // 4 × 1.0
  });
  it('simulated pressure thins with speed', () => {
    const slow = strokeRadii([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], undefined, { size: 8, simulatePressure: true });
    const fast = strokeRadii([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 0 }], undefined, { size: 8, simulatePressure: true });
    expect(fast[2]!).toBeLessThan(slow[2]!);
  });
  it('tapers the ends over the configured distances', () => {
    const r = strokeRadii(line(11), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], { size: 8, taperStart: 20, taperEnd: 20 });
    expect(r[0]).toBeCloseTo(0.1, 5); // arc 0 → fully tapered (floor)
    expect(r[5]!).toBeCloseTo(4, 5);  // mid — untapered
    expect(r[10]).toBeCloseTo(0.1, 5);
  });
});

describe('strokeOutlinePoints', () => {
  it('emits a symmetric closed ring around a straight spine', () => {
    const ring = strokeOutlinePoints(line(4), [1, 1, 1, 1], { size: 6 });
    expect(ring).toHaveLength(8); // left 4 + right 4
    // Left side at +r, right side at -r (order reversed).
    expect(ring[0]!.y).toBeCloseTo(3, 5);
    expect(ring[7]!.y).toBeCloseTo(-3, 5);
    // Forward along the left side, then BACK along the right (a closed ring).
    expect(ring.map((p) => p.x)).toEqual([0, 10, 20, 30, 30, 20, 10, 0]);
  });
  it('renders a single point as a dot polygon', () => {
    const ring = strokeOutlinePoints([{ x: 5, y: 5 }], [1], { size: 4 });
    expect(ring).toHaveLength(8);
    for (const p of ring) expect(Math.hypot(p.x - 5, p.y - 5)).toBeCloseTo(2, 5);
  });
});

describe('strokeOutlinePath', () => {
  it('is a closed, numeric-only path (no markup can ride in)', () => {
    const d = strokeOutlinePath(line(5), undefined, { size: 4, simulatePressure: true });
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith(' Z')).toBe(true);
    expect(/^[MQZ0-9 .-]+$/.test(d)).toBe(true);
    // Coordinates are rounded to 2dp: r = 2.5 × (0.5 + 0.5 × 0.27) = 1.5875 → 1.59.
    expect(strokeOutlinePath([{ x: 0, y: 0 }, { x: 10, y: 0 }], [0.27, 0.27], { size: 5 }))
      .toBe('M 0 1.59 Q 10 1.59 10 0 Q 10 -1.59 5 -1.59 Q 0 -1.59 0 0 Q 0 1.59 5 1.59 Z');
    // Untrusted input: a string coordinate (JSON from a drawing doc) must not ride into
    // the path as markup — it degrades to NaN, an inert number token.
    const hostile: SpinePt[] = JSON.parse('[{"x":"<b>x</b>","y":0},{"x":10,"y":0}]');
    const bad = strokeOutlinePath(hostile, [1, 1], { size: 4 });
    expect(bad).not.toContain('<');
    expect(/^[MQZNa0-9 .-]+$/.test(bad)).toBe(true);
  });
  it('returns empty for an empty spine', () => {
    expect(strokeOutlinePath([], undefined, { size: 4 })).toBe('');
  });
});
