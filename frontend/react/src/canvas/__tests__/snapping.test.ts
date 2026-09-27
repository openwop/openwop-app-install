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
    // moved left edge at 97 → snaps to 100 (dx +3); vertical middle at 200 → no h snap.
    const r = snapDelta(box(97, 200, 20, 10), cands, 5);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([{ axis: 'v', pos: 100 }]);
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
    // right edge at 99 (x=79,w=20): dist to 100 is 1; left edge 79 to nothing.
    const r = snapDelta(box(79, 100, 20, 40), cands, 5);
    expect(r.dx).toBe(1);
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
    const patches = computeAlignPatches([item(0, 0, 0), item(1, 30, 0), item(2, 100, 0)], 'distributeH', move);
    // span 0..120, total w 60, gaps (120-60)/2 = 30 → middle box lands at x=50.
    expect(patches).toEqual([{ idx: 1, patch: { x: 50, y: 0 } }]);
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
    expect(r.spans.length).toBeGreaterThanOrEqual(2);
    for (const sp of r.spans) { expect(sp.dir).toBe('x'); expect(sp.gap).toBe(20); }
  });
  it('alignment wins over spacing on the same axis', () => {
    const align = buildSnapCandidates(sibs);
    // moved left edge 218 is within 5 of nothing in align set… use 198 → aligns to 200 (b right edge).
    const r = combinedSnapDelta(box(198, 300, 20, 20), align, gaps, 5);
    expect(r.guides.some((g) => g.kind === 'align')).toBe(true);
    expect(r.dx).toBe(2); // align 198→200 beats any gap candidate
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
