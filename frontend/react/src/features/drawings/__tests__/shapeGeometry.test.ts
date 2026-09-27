/**
 * ADR 0310 Phase C follow-up — the pure move/resize/bbox math behind
 * direct-manipulation drawing edits. Fully deterministic (no DOM), so the
 * geometry is proven here while the interactive component stays thin plumbing.
 */
import { describe, it, expect } from 'vitest';
import { shapeMovePatch, shapeBBox, shapeHandles, shapeResizePatch, shapeVertices, vertexMovePatch, snapValue, snapPatch, boxesIntersect, boxContains, unionBox, scaleShapePatch, rotatePoint, shapeRotatePatch, groupRotatePatch } from '../shapeGeometry.js';

describe('shapeMovePatch — translation per kind', () => {
  it('moves a rect/text by its x,y', () => {
    expect(shapeMovePatch({ kind: 'rect', x: 10, y: 20 }, 5, -3)).toEqual({ x: 15, y: 17 });
    expect(shapeMovePatch({ kind: 'text', x: 0, y: 0 }, 4, 4)).toEqual({ x: 4, y: 4 });
  });
  it('moves a circle/ellipse by its center', () => {
    expect(shapeMovePatch({ kind: 'circle', cx: 50, cy: 50 }, 10, 10)).toEqual({ cx: 60, cy: 60 });
    expect(shapeMovePatch({ kind: 'ellipse', cx: 5, cy: 5 }, -5, 0)).toEqual({ cx: 0, cy: 5 });
  });
  it('moves both endpoints of a line', () => {
    expect(shapeMovePatch({ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }, 2, 3)).toEqual({ x1: 2, y1: 3, x2: 12, y2: 13 });
  });
  it('moves every point of a polyline/polygon', () => {
    expect(shapeMovePatch({ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }, 1, 1))
      .toEqual({ points: [{ x: 1, y: 1 }, { x: 11, y: 1 }] });
  });
  it('treats missing coords as 0', () => {
    expect(shapeMovePatch({ kind: 'rect' }, 5, 5)).toEqual({ x: 5, y: 5 });
  });
});

describe('shapeBBox', () => {
  it('is the rect itself', () => {
    expect(shapeBBox({ kind: 'rect', x: 1, y: 2, width: 30, height: 40 })).toEqual({ x: 1, y: 2, w: 30, h: 40 });
  });
  it('wraps a circle by its radius', () => {
    expect(shapeBBox({ kind: 'circle', cx: 50, cy: 50, r: 10 })).toEqual({ x: 40, y: 40, w: 20, h: 20 });
  });
  it('spans a line', () => {
    expect(shapeBBox({ kind: 'line', x1: 10, y1: 30, x2: 40, y2: 5 })).toEqual({ x: 10, y: 5, w: 30, h: 25 });
  });
  it('is null for an empty polygon', () => {
    expect(shapeBBox({ kind: 'polygon', points: [] })).toBeNull();
  });
});

describe('shapeHandles + shapeResizePatch', () => {
  it('rect: one SE handle, resize sets width/height clamped ≥ 1', () => {
    const s = { kind: 'rect', x: 10, y: 10, width: 40, height: 30 };
    expect(shapeHandles(s)).toEqual([{ id: 'se', x: 50, y: 40 }]);
    expect(shapeResizePatch(s, 'se', 80, 60)).toEqual({ width: 70, height: 50 });
    expect(shapeResizePatch(s, 'se', 5, 5)).toEqual({ width: 1, height: 1 }); // never collapses
  });
  it('circle: radius from distance to center', () => {
    const s = { kind: 'circle', cx: 0, cy: 0, r: 10 };
    expect(shapeHandles(s)).toEqual([{ id: 'r', x: 10, y: 0 }]);
    expect(shapeResizePatch(s, 'r', 3, 4)).toEqual({ r: 5 }); // hypot(3,4)=5
  });
  it('ellipse: rx/ry from |dx|,|dy|', () => {
    expect(shapeResizePatch({ kind: 'ellipse', cx: 100, cy: 100 }, 'se', 130, 80)).toEqual({ rx: 30, ry: 20 });
  });
  it('line: two endpoint handles set the dragged endpoint', () => {
    const s = { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 };
    expect(shapeHandles(s)).toEqual([{ id: 'p1', x: 0, y: 0 }, { id: 'p2', x: 10, y: 10 }]);
    expect(shapeResizePatch(s, 'p1', 4, 6)).toEqual({ x1: 4, y1: 6 });
    expect(shapeResizePatch(s, 'p2', 20, 25)).toEqual({ x2: 20, y2: 25 });
  });
  it('polyline/polygon expose no resize handles (they use per-vertex handles)', () => {
    expect(shapeHandles({ kind: 'polygon', points: [] })).toEqual([]);
    expect(shapeResizePatch({ kind: 'polygon' }, 'x', 1, 1)).toEqual({});
  });
});

describe('shapeVertices + vertexMovePatch — polyline/polygon editing', () => {
  const poly = { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] };
  it('exposes points for polyline/polygon, null otherwise', () => {
    expect(shapeVertices(poly)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }]);
    expect(shapeVertices({ kind: 'rect' })).toBeNull();
  });
  it('moves one vertex, leaving the others', () => {
    expect(vertexMovePatch(poly, 1, 20, 5)).toEqual({ points: [{ x: 0, y: 0 }, { x: 20, y: 5 }, { x: 5, y: 10 }] });
  });
  it('out-of-range vertex index is a no-op', () => {
    expect(vertexMovePatch(poly, 9, 1, 1)).toEqual({});
    expect(vertexMovePatch(poly, -1, 1, 1)).toEqual({});
  });
});

describe('marquee selection geometry', () => {
  it('boxesIntersect is true when the boxes overlap (intersect selection)', () => {
    expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 2, h: 2 })).toBe(true); // touch a corner
    expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
    expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false); // edge-adjacent, no overlap
  });
  it('unionBox wraps a set; null for empty', () => {
    expect(unionBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }])).toEqual({ x: 0, y: 0, w: 30, h: 15 });
    expect(unionBox([])).toBeNull();
  });
  it('boxContains requires full enclosure (Alt contain mode)', () => {
    const outer = { x: 0, y: 0, w: 100, h: 100 };
    expect(boxContains(outer, { x: 10, y: 10, w: 20, h: 20 })).toBe(true); // fully inside
    expect(boxContains(outer, { x: 90, y: 10, w: 20, h: 20 })).toBe(false); // pokes out the right
    expect(boxContains(outer, { x: 0, y: 0, w: 100, h: 100 })).toBe(true); // exact fit
    // A shape the marquee only TOUCHES is contain-excluded but intersect-included.
    const partial = { x: 95, y: 50, w: 20, h: 10 };
    expect(boxContains(outer, partial)).toBe(false);
    expect(boxesIntersect(outer, partial)).toBe(true);
  });
});

describe('scaleShapePatch — group resize (uniform scale about an origin)', () => {
  const origin = { x: 0, y: 0 };
  it('scales a rect position + size about the origin', () => {
    expect(scaleShapePatch({ kind: 'rect', x: 10, y: 20, width: 30, height: 40 }, 2, origin)).toEqual({ x: 20, y: 40, width: 60, height: 80 });
  });
  it('scales a circle uniformly (stays a circle)', () => {
    expect(scaleShapePatch({ kind: 'circle', cx: 10, cy: 10, r: 5 }, 3, origin)).toEqual({ cx: 30, cy: 30, r: 15 });
  });
  it('scales line endpoints + polygon points about a non-zero origin', () => {
    expect(scaleShapePatch({ kind: 'line', x1: 10, y1: 10, x2: 20, y2: 20 }, 2, { x: 10, y: 10 })).toEqual({ x1: 10, y1: 10, x2: 30, y2: 30 });
    expect(scaleShapePatch({ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }, 2, origin)).toEqual({ points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] });
  });
  it('clamps dimensions ≥ 1 and never inverts (factor ≤ 0 → identity factor)', () => {
    expect(scaleShapePatch({ kind: 'rect', x: 0, y: 0, width: 40, height: 30 }, 0, origin)).toMatchObject({ width: 40, height: 30 });
  });
});

describe('rotation — single + group', () => {
  it('rotatePoint rotates about a centre (90° clockwise on screen)', () => {
    const p = rotatePoint(10, 0, 0, 0, 90);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(10, 6);
  });
  it('shapeRotatePatch: knob up = 0°, right = 90°', () => {
    expect(shapeRotatePatch(100, 100, 100, 40).rotation).toBe(0);
    expect(shapeRotatePatch(100, 100, 160, 100).rotation).toBe(90);
  });
  it('groupRotatePatch spins a shape in place AND swings its centre about the group centre', () => {
    // A rect whose centre is at (30,0); rotate the group 90° about origin →
    // centre swings to (0,30) (a +30,+30 translate of a (10,-5)-anchored rect),
    // and the shape's own rotation gains 90.
    const s = { kind: 'rect', x: 10, y: -5, width: 40, height: 10, rotation: 0 };
    const patch = groupRotatePatch(s, 90, { x: 0, y: 0 }, { x: 30, y: 0 }) as { x: number; y: number; rotation: number };
    expect(patch.rotation).toBe(90);
    // centre (30,0) → (0,30): delta (-30,+30) applied to the anchor (10,-5).
    expect(patch.x).toBeCloseTo(-20, 6);
    expect(patch.y).toBeCloseTo(25, 6);
  });
  it('groupRotatePatch accumulates onto an existing rotation', () => {
    expect(groupRotatePatch({ kind: 'rect', x: 0, y: 0, width: 10, height: 10, rotation: 45 }, 90, { x: 5, y: 5 }, { x: 5, y: 5 }).rotation).toBe(135);
  });
});

describe('snap-to-grid', () => {
  it('snapValue rounds to the nearest grid multiple', () => {
    expect(snapValue(13, 10)).toBe(10);
    expect(snapValue(16, 10)).toBe(20);
    expect(snapValue(7, 0)).toBe(7); // grid 0 = no snap
  });
  it('snapPatch snaps coordinate fields + points but nothing else', () => {
    expect(snapPatch({ x: 13, y: 27, r: 8 }, 10)).toEqual({ x: 10, y: 30, r: 10 });
    expect(snapPatch({ points: [{ x: 3, y: 8 }, { x: 24, y: 11 }] }, 10)).toEqual({ points: [{ x: 0, y: 10 }, { x: 20, y: 10 }] });
    // grid 0 returns the patch untouched.
    expect(snapPatch({ x: 13 }, 0)).toEqual({ x: 13 });
  });
});

// ADR 0333 Phase 3 — ink additions: spine hit-testing, streamline smoothing,
// RDP index reduction, the stroke bbox (padded by half-width), stroke move.
import { strokeHit, streamlinePoint, rdpIndices } from '../shapeGeometry.js';

describe('stroke geometry (ADR 0333 Phase 3)', () => {
  const stroke = { kind: 'stroke', size: 4, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] };

  it('strokeHit is true within half-width + slop of the spine, false beyond', () => {
    expect(strokeHit(stroke, { x: 5, y: 1.5 })).toBe(true);
    expect(strokeHit(stroke, { x: 5, y: 6 })).toBe(false);
    expect(strokeHit(stroke, { x: 5, y: 6 }, 5)).toBe(true);
    expect(strokeHit({ kind: 'rect' }, { x: 0, y: 0 })).toBe(false);
  });

  it('shapeBBox pads the spine bounds by the ink half-width', () => {
    const b = shapeBBox(stroke)!;
    expect(b).toEqual({ x: -2, y: -2, w: 24, h: 4 });
  });

  it('shapeMovePatch translates the spine', () => {
    const p = shapeMovePatch(stroke, 3, -1) as { points: { x: number; y: number }[] };
    expect(p.points[0]).toEqual({ x: 3, y: -1 });
    expect(p.points[2]).toEqual({ x: 23, y: -1 });
  });

  it('streamlinePoint pulls toward the previous point', () => {
    const out = streamlinePoint({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5);
    expect(out.x).toBeCloseTo(5, 5);
    expect(streamlinePoint(undefined, { x: 10, y: 0 }, 0.5)).toEqual({ x: 10, y: 0 });
  });

  it('rdpIndices keeps endpoints + salient corners, drops collinear points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 0.01 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const keep = rdpIndices(pts, 0.5);
    expect(keep[0]).toBe(0);
    expect(keep[keep.length - 1]).toBe(3);
    expect(keep).toContain(2); // the corner survives
    expect(keep).not.toContain(1); // the collinear jitter is dropped
  });
});

// ADR 0333 Phase 7 — symmetry variants (pure).
import { symmetryVariants } from '../shapeGeometry.js';

describe('symmetryVariants (ADR 0333 Phase 7)', () => {
  const spine = [{ x: 10, y: 20 }, { x: 30, y: 40 }];
  const cx = 50, cy = 50;

  it('off / empty return no variants', () => {
    expect(symmetryVariants(spine, 'off', cx, cy, false)).toEqual([]);
    expect(symmetryVariants([], 'vertical', cx, cy, false)).toEqual([]);
  });
  it('vertical mirrors x about the centre', () => {
    const [v] = symmetryVariants(spine, 'vertical', cx, cy, false);
    expect(v).toEqual([{ x: 90, y: 20 }, { x: 70, y: 40 }]);
  });
  it('horizontal mirrors y about the centre', () => {
    const [v] = symmetryVariants(spine, 'horizontal', cx, cy, false);
    expect(v).toEqual([{ x: 10, y: 80 }, { x: 30, y: 60 }]);
  });
  it('quadrant yields 3 variants (V, H, both)', () => {
    const vs = symmetryVariants(spine, 'quadrant', cx, cy, false);
    expect(vs).toHaveLength(3);
    expect(vs[2]![0]).toEqual({ x: 90, y: 80 });
  });
  it('radial rotational yields 7 pure rotations (8-fold total)', () => {
    const vs = symmetryVariants(spine, 'radial', cx, cy, true);
    expect(vs).toHaveLength(7);
    // 180° rotation of (10,20) about (50,50) = (90,80).
    const r180 = vs[3]!;
    expect(r180[0]!.x).toBeCloseTo(90, 6);
    expect(r180[0]!.y).toBeCloseTo(80, 6);
  });
  it('radial kaleidoscope yields 7 variants incl. mirrored copies', () => {
    const vs = symmetryVariants(spine, 'radial', cx, cy, false);
    expect(vs).toHaveLength(7);
    // The plain mirror is present.
    expect(vs.some((v) => v[0]!.x === 90 && v[0]!.y === 20)).toBe(true);
  });
});
