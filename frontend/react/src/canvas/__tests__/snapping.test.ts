/**
 * Smart-guide snapping + align/distribute (ADR 0333 Phase 5) — pure proofs.
 */
import { describe, it, expect } from 'vitest';
import { buildGapCandidates, buildSnapCandidates, combinedSnapDelta, snapAngle, snapDelta } from '../snapping.js';
import { computeAlignPatches, type AlignItem } from '../alignOps.js';

const box = (x: number, y: number, w = 20, h = 10): { x: number; y: number; w: number; h: number } => ({ x, y, w, h });

describe('snapDelta', () => {
  const cands = buildSnapCandidates([box(100, 100, 40, 40)]); // v: 100,120,140; h: 100,120,140

  it('snaps the nearest edge within the threshold, per axis independently', () => {
    // x: left edge 97 → 100 (dx +3). y: top 137 → 140 is +3 but the middle
    // 142 → 140 is nearer (dy −2) — distinct per-axis deltas and guides.
    const r = snapDelta(box(97, 137, 20, 10), cands, 5);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(-2);
    expect(r.guides).toEqual([{ axis: 'v', pos: 100 }, { axis: 'h', pos: 140 }]);
    // An axis with nothing in range stays unsnapped.
    const xOnly = snapDelta(box(97, 200, 20, 10), cands, 5);
    expect(xOnly.dy).toBe(0);
    expect(xOnly.guides).toEqual([{ axis: 'v', pos: 100 }]);
  });
  it('snaps centers to centers', () => {
    // moved center x = 118 (x=108,w=20) → snaps to 120 (dx +2).
    const r = snapDelta(box(108, 300, 20, 10), cands, 5);
    expect(r.dx).toBe(2);
  });
  it('returns zero when nothing is close', () => {
    const r = snapDelta(box(500, 500), cands, 5);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
  });
  it('prefers the closest candidate', () => {
    // TWO hits in range, the FARTHER one tried first: left edge 103 → 100 is −3,
    // centre 118 → 120 is +2. The nearer (+2) must win, not the first found.
    const r = snapDelta(box(103, 300, 30, 10), cands, 5);
    expect(r.dx).toBe(2);
    expect(r.guides).toEqual([{ axis: 'v', pos: 120 }]);
  });
});

describe('snapAngle', () => {
  it('rounds to 15° and normalizes', () => {
    expect(snapAngle(22)).toBe(15);
    expect(snapAngle(23)).toBe(30);
    expect(snapAngle(-7)).toBe(0);
    expect(snapAngle(-38)).toBe(315);
  });
});

describe('computeAlignPatches', () => {
  const move = (el: Record<string, unknown>, dx: number, dy: number): Record<string, unknown> =>
    (dx || dy ? { x: (el.x as number) + dx, y: (el.y as number) + dy } : {});
  const item = (idx: number, x: number, y: number, extra: Record<string, unknown> = {}): AlignItem =>
    ({ idx, box: box(x, y), el: { x, y, ...extra } });

  it('aligns lefts to the leftmost edge', () => {
    const patches = computeAlignPatches([item(0, 10, 0), item(1, 50, 20)], 'left', move);
    expect(patches).toEqual([{ idx: 1, patch: { x: 10, y: 20 } }]);
  });
  it('centers on the selection midline', () => {
    const patches = computeAlignPatches([item(0, 0, 0), item(1, 80, 0)], 'centerH', move);
    // span 0..100, centre 50; boxes w=20 → both centre at x=40.
    expect(patches).toContainEqual({ idx: 0, patch: { x: 40, y: 0 } });
    expect(patches).toContainEqual({ idx: 1, patch: { x: 40, y: 0 } });
  });
  it('distributes interior boxes with equal gaps (outermost fixed)', () => {
    // Passed OUT of x order (the selection order is arbitrary): sorted 0, 30, 100.
    const patches = computeAlignPatches([item(0, 100, 0), item(1, 0, 0), item(2, 30, 0)], 'distributeH', move);
    // span 0..120, total w 60, gaps (120-60)/2 = 30 → middle box (idx 2) lands at x=50.
    expect(patches).toEqual([{ idx: 2, patch: { x: 50, y: 0 } }]);
  });
  it('skips locked/hidden and needs ≥2 usable', () => {
    expect(computeAlignPatches([item(0, 0, 0), item(1, 50, 0, { locked: true })], 'left', move)).toEqual([]);
    expect(computeAlignPatches([item(0, 0, 0), item(1, 50, 0, { hidden: true }), item(2, 90, 10)], 'left', move))
      .toEqual([{ idx: 2, patch: { x: 0, y: 10 } }]);
  });
  it('distribute needs ≥3', () => {
    expect(computeAlignPatches([item(0, 0, 0), item(1, 50, 0)], 'distributeH', move)).toEqual([]);
  });
});

describe('equal-spacing snapping (§7.4 / CV-6)', () => {
  // Two siblings on the x axis: a=[100..140], b=[160..200] → gap 20.
  const sibs = [box(100, 100, 40, 40), box(160, 100, 40, 40)];
  const gaps = buildGapCandidates(sibs, { w: 20, h: 20 });

  it('offers after-b and before-a candidates per adjacent pair', () => {
    const xs = gaps.x.map((c) => c.pos).sort((p, q) => p - q);
    // before a: 100-20-20=60; after b: 200+20=220. Centered needs inner>0
    // (160-140-20=0 here) so it is correctly absent for this width.
    expect(xs).toContain(60);
    expect(xs).toContain(220);
    expect(xs).not.toContain(140);
  });
  it('snaps to the mirrored gap and reports labeled spans', () => {
    const r = combinedSnapDelta(box(217, 300, 20, 20), null, gaps, 5);
    expect(r.dx).toBe(3); // 217 → 220
    // The pair's own gap (140→160) plus the mirrored one after b (200→220).
    expect(r.spans).toEqual([
      { dir: 'x', at: 120, from: 140, to: 160, gap: 20 },
      { dir: 'x', at: 120, from: 200, to: 220, gap: 20 },
    ]);
  });
  it('alignment wins over spacing on the same axis', () => {
    const align = buildSnapCandidates(sibs);
    // moved left edge 218 is within 5 of nothing in align set… use 198 → aligns to 200 (b right edge).
    const r = combinedSnapDelta(box(198, 300, 20, 20), align, gaps, 5);
    expect(r.guides.some((g) => g.kind === 'align')).toBe(true);
    expect(r.dx).toBe(2); // align 198→200 beats any gap candidate
    // CONTENDED: both an align hit (216, dx −1) and a gap hit (220, dx +3) are in
    // range for the same box — alignment must win and no spacing spans render.
    const contended = combinedSnapDelta(box(217, 300, 20, 20), buildSnapCandidates([...sibs, box(216, 0, 40, 40)]), gaps, 5);
    expect(contended.dx).toBe(-1);
    expect(contended.spans).toEqual([]);
  });
  it('centered candidate splits the inner gap equally when the box fits', () => {
    // With a 10-wide box the centered pos is (140+160-10)/2 = 145 with 5 each side.
    const g10 = buildGapCandidates(sibs, { w: 10, h: 10 });
    const c10 = g10.x.find((c) => Math.abs(c.pos - 145) < 1e-9);
    expect(c10).toBeDefined();
    expect(c10!.spans.every((sp) => sp.gap === 5)).toBe(true);
  });
  it('overlapping pairs offer no gap candidates', () => {
    const g = buildGapCandidates([box(0, 0, 50, 50), box(30, 0, 50, 50)], { w: 10, h: 10 });
    expect(g.x).toEqual([]);
  });
});
