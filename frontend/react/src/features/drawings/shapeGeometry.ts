/**
 * Pure geometry for direct-manipulation drawing edits (ADR 0310 Phase C
 * follow-up). Move/resize a `canvas.drawing` shape by a delta or a pointer
 * position — no DOM, no React, so the math is unit-testable in isolation while
 * the interactive component stays thin plumbing. Every result is a partial
 * patch (the fields that changed), fed to the chassis `patchElement`.
 */

export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }
export interface Handle { id: string; x: number; y: number }

type Shape = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pts = (v: unknown): Pt[] =>
  Array.isArray(v) ? v.filter((p): p is Pt => Boolean(p) && typeof p === 'object' && typeof (p as Pt).x === 'number' && typeof (p as Pt).y === 'number') : [];

/** The fields that move for a translation by (dx, dy) — kind-specific. */
export function shapeMovePatch(s: Shape, dx: number, dy: number): Record<string, unknown> {
  switch (s.kind) {
    case 'rect':
    case 'image': // ADR 0401 follow-through — rect geometry
    case 'text':
      return { x: num(s.x) + dx, y: num(s.y) + dy };
    case 'circle':
    case 'ellipse':
      return { cx: num(s.cx) + dx, cy: num(s.cy) + dy };
    case 'line':
    case 'arrow': // ADR 0333 Phase 4 — line fields
      return { x1: num(s.x1) + dx, y1: num(s.y1) + dy, x2: num(s.x2) + dx, y2: num(s.y2) + dy };
    case 'polyline':
    case 'polygon':
    case 'stroke': // ADR 0333 Phase 3 — ink moves by translating its spine
      return { points: pts(s.points).map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    default:
      return {};
  }
}

/** The axis-aligned bounding box (drawing units) for the selection outline, or
 *  null for a shape with no positioned geometry. Text is approximated from its
 *  baseline + font size (a legible outline, not a precise glyph box). */
export function shapeBBox(s: Shape): Box | null {
  switch (s.kind) {
    case 'rect':
    case 'image': // ADR 0401 follow-through — rect geometry
      return { x: num(s.x), y: num(s.y), w: Math.max(0, num(s.width)), h: Math.max(0, num(s.height)) };
    case 'circle': {
      const r = Math.max(0, num(s.r));
      return { x: num(s.cx) - r, y: num(s.cy) - r, w: 2 * r, h: 2 * r };
    }
    case 'ellipse':
      return { x: num(s.cx) - Math.max(0, num(s.rx)), y: num(s.cy) - Math.max(0, num(s.ry)), w: 2 * Math.max(0, num(s.rx)), h: 2 * Math.max(0, num(s.ry)) };
    case 'line':
    case 'arrow': { // ADR 0333 Phase 4 — line fields
      const x1 = num(s.x1), y1 = num(s.y1), x2 = num(s.x2), y2 = num(s.y2);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    case 'text': {
      const fs = Math.max(1, num(s.fontSize, 16));
      const chars = typeof s.text === 'string' ? s.text.length : 0;
      return { x: num(s.x), y: num(s.y) - fs, w: Math.max(fs, chars * fs * 0.6), h: fs * 1.3 };
    }
    case 'polyline':
    case 'polygon': {
      const ps = pts(s.points);
      if (!ps.length) return null;
      const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
    }
    case 'stroke': {
      // ADR 0333 Phase 3 — the spine's bounds padded by the ink's half-width.
      const ps = pts(s.points);
      if (!ps.length) return null;
      const pad = Math.max(0.25, num(s.size, 4) / 2);
      const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
      const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
      return { x: minX, y: minY, w: Math.max(...xs) + pad - minX, h: Math.max(...ys) + pad - minY };
    }
    default:
      return null;
  }
}

/** Squared distance from a point to the segment ab (spine hit-testing). */
function distSqToSegment(p: Pt, a: Pt, b: Pt): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq)) : 0;
  const qx = a.x + t * abx, qy = a.y + t * aby;
  return (p.x - qx) ** 2 + (p.y - qy) ** 2;
}

/** True when `p` lies on the stroke's ink (within half-width + `slop` of the
 *  spine) — the eraser/hit test (ADR 0333 Phase 3). */
export function strokeHit(s: Shape, p: Pt, slop = 0): boolean {
  if (s.kind !== 'stroke') return false;
  const ps = pts(s.points);
  if (!ps.length) return false;
  const r = Math.max(0.25, num(s.size, 4) / 2) + Math.max(0, slop);
  const rSq = r * r;
  if (ps.length === 1) return distSqToSegment(p, ps[0]!, ps[0]!) <= rSq;
  for (let i = 1; i < ps.length; i++) {
    if (distSqToSegment(p, ps[i - 1]!, ps[i]!) <= rSq) return true;
  }
  return false;
}

/** Streamline smoothing (exponential moving average toward the previous
 *  point) — the perfect-freehand `streamline` idea; applied LIVE as points
 *  arrive. `amount` 0..1 (0 = raw). */
export function streamlinePoint(prev: Pt | undefined, raw: Pt, amount: number): Pt {
  if (!prev || amount <= 0) return raw;
  const a = Math.min(0.95, amount);
  return { x: prev.x + (raw.x - prev.x) * (1 - a), y: prev.y + (raw.y - prev.y) * (1 - a) };
}

/** Ramer–Douglas–Peucker point-count reduction, run at pen-up (keeps the
 *  pressure track aligned by returning kept INDICES). */
export function rdpIndices(points: readonly Pt[], epsilon: number): number[] {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true; keep[n - 1] = true;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distSqToSegment(points[i]!, points[s]!, points[e]!);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon * epsilon && maxI > 0) {
      keep[maxI] = true;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

export type SymmetryMode = 'off' | 'vertical' | 'horizontal' | 'quadrant' | 'radial';

/** The symmetry copies of a spine about the artboard centre (ADR 0333
 *  Phase 7 — the Procreate assist, verified in the research doc). Returns the
 *  VARIANTS ONLY (the identity spine is the caller's original):
 *  vertical/horizontal = one mirror; quadrant = V + H + both; radial = the
 *  8-fold wheel — pure 45° rotations in rotational mode, the dihedral D4
 *  orbit (rotations + mirrored rotations, the kaleidoscope) otherwise.
 *  Pressure tracks copy verbatim (reflection/rotation preserves ordering). */
export function symmetryVariants(points: readonly Pt[], mode: SymmetryMode, cx: number, cy: number, rotational: boolean): Pt[][] {
  if (mode === 'off' || points.length === 0) return [];
  const mirrorV = (ps: readonly Pt[]): Pt[] => ps.map((p) => ({ x: 2 * cx - p.x, y: p.y }));
  const mirrorH = (ps: readonly Pt[]): Pt[] => ps.map((p) => ({ x: p.x, y: 2 * cy - p.y }));
  const rot = (ps: readonly Pt[], deg: number): Pt[] => ps.map((p) => rotatePoint(p.x, p.y, cx, cy, deg));
  if (mode === 'vertical') return [mirrorV(points)];
  if (mode === 'horizontal') return [mirrorH(points)];
  if (mode === 'quadrant') return [mirrorV(points), mirrorH(points), mirrorH(mirrorV(points))];
  // radial (8-fold about the centre).
  if (rotational) {
    return [1, 2, 3, 4, 5, 6, 7].map((k) => rot(points, k * 45));
  }
  const m = mirrorV(points);
  return [rot(points, 90), rot(points, 180), rot(points, 270), m, rot(m, 90), rot(m, 180), rot(m, 270)];
}

/** The resize handles (drawing units) for a shape — an empty list for kinds
 *  whose resize stays in the property panel (polyline/polygon/text edit points
 *  or content there). */
export function shapeHandles(s: Shape): Handle[] {
  switch (s.kind) {
    case 'rect':
    case 'image': // ADR 0401 follow-through — rect geometry (aspect via handle is fine; preserveAspectRatio letterboxes)
      return [{ id: 'se', x: num(s.x) + Math.max(0, num(s.width)), y: num(s.y) + Math.max(0, num(s.height)) }];
    case 'circle':
      return [{ id: 'r', x: num(s.cx) + Math.max(0, num(s.r)), y: num(s.cy) }];
    case 'ellipse':
      return [{ id: 'se', x: num(s.cx) + Math.max(0, num(s.rx)), y: num(s.cy) + Math.max(0, num(s.ry)) }];
    case 'line':
    case 'arrow': // ADR 0333 Phase 4 — endpoint handles like line
      return [
        { id: 'p1', x: num(s.x1), y: num(s.y1) },
        { id: 'p2', x: num(s.x2), y: num(s.y2) },
      ];
    default:
      return [];
  }
}

/** Do two axis-aligned boxes overlap? (Marquee = INTERSECT selection, the
 *  design-tool default — a shape is selected if the marquee touches its bbox.) */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Does `outer` fully enclose `inner`? (Marquee CONTAIN mode — Alt/Option held;
 *  a shape is selected only when the marquee wholly covers its bbox. The
 *  Sketch/Miro convention, not AutoCAD's drag-direction trick.) */
export function boxContains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** The union bounding box of several boxes (the group selection outline), or
 *  null for an empty set. */
export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The editable vertices of a shape (polyline/polygon points), or null for
 *  kinds whose points aren't directly draggable. */
export function shapeVertices(s: Shape): Pt[] | null {
  if (s.kind !== 'polyline' && s.kind !== 'polygon') return null;
  return pts(s.points);
}

/** Move vertex `index` of a polyline/polygon to (x, y) — returns the whole
 *  points array (positional; the schema validates it). Out-of-range ⇒ no change. */
export function vertexMovePatch(s: Shape, index: number, x: number, y: number): Record<string, unknown> {
  const ps = pts(s.points);
  if (index < 0 || index >= ps.length) return {};
  const next = ps.map((p, i) => (i === index ? { x, y } : p));
  return { points: next };
}

/** UNIFORMLY scale a shape's geometry by `factor` about `origin` (a group
 *  resize about the fixed opposite corner). Uniform so a circle stays a circle
 *  (the schema has no `rect`-from-`circle` path); dimensions clamp to ≥1. */
export function scaleShapePatch(s: Shape, factor: number, origin: Pt): Record<string, unknown> {
  const f = factor > 0 ? factor : 1;
  const px = (x: number): number => Math.round(origin.x + (x - origin.x) * f);
  const py = (y: number): number => Math.round(origin.y + (y - origin.y) * f);
  const dim = (v: number): number => Math.max(1, Math.round(v * f));
  switch (s.kind) {
    case 'rect':
    case 'image': // ADR 0401 follow-through — rect geometry
      return { x: px(num(s.x)), y: py(num(s.y)), width: dim(num(s.width)), height: dim(num(s.height)) };
    case 'text':
      return { x: px(num(s.x)), y: py(num(s.y)), ...(s.fontSize !== undefined ? { fontSize: dim(num(s.fontSize)) } : {}) };
    case 'circle':
      return { cx: px(num(s.cx)), cy: py(num(s.cy)), r: dim(num(s.r)) };
    case 'ellipse':
      return { cx: px(num(s.cx)), cy: py(num(s.cy)), rx: dim(num(s.rx)), ry: dim(num(s.ry)) };
    case 'line':
    case 'arrow': // ADR 0333 Phase 4
      return { x1: px(num(s.x1)), y1: py(num(s.y1)), x2: px(num(s.x2)), y2: py(num(s.y2)) };
    case 'polyline':
    case 'polygon':
      return { points: pts(s.points).map((p) => ({ x: px(p.x), y: py(p.y) })) };
    case 'stroke': {
      // ADR 0333 grade pass CODE-D6 — ink was silently omitted from group
      // resize (fell to default:{}). Scale the spine (UNROUNDED — rounding a
      // spine to integers visibly degrades ink) + the base `size`.
      const sx = (x: number): number => origin.x + (x - origin.x) * f;
      const sy = (y: number): number => origin.y + (y - origin.y) * f;
      return {
        points: pts(s.points).map((p) => ({ x: sx(p.x), y: sy(p.y) })),
        ...(s.size !== undefined ? { size: Math.max(0.5, num(s.size, 4) * f) } : {}),
      };
    }
    default:
      return {};
  }
}

/** Rotate (px,py) by `deg` degrees (clockwise, screen convention) about (cx,cy). */
export function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number): Pt {
  const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** The rotate-knob → a `rotation` in degrees. The knob rests ABOVE the shape
 *  (screen angle -90°), so pointing straight up is 0°. Normalized to [0,360). */
export function shapeRotatePatch(cx: number, cy: number, px: number, py: number): { rotation: number } {
  const deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
  return { rotation: ((Math.round(deg) % 360) + 360) % 360 };
}

/** Rotate a shape as part of a GROUP rotation about `groupCenter` by `deg`: its
 *  bbox centre (`shapeCtr`, from the renderer's `shapeCenter`) swings along the
 *  arc (a translate) AND its own `rotation` gains `deg` (it spins in place). */
export function groupRotatePatch(s: Shape, deg: number, groupCenter: Pt, shapeCtr: Pt): Record<string, unknown> {
  const nc = rotatePoint(shapeCtr.x, shapeCtr.y, groupCenter.x, groupCenter.y, deg);
  const move = shapeMovePatch(s, nc.x - shapeCtr.x, nc.y - shapeCtr.y);
  return { ...move, rotation: ((Math.round(num(s.rotation) + deg) % 360) + 360) % 360 };
}

/** Snap a single value to the grid. */
export function snapValue(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : v;
}

/** Snap the COORDINATE fields of a move/resize/vertex patch to the grid (never
 *  touches paint fields — those patches only carry geometry). Idempotent. */
const COORD_KEYS = new Set(['x', 'y', 'cx', 'cy', 'width', 'height', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2']);
export function snapPatch(patch: Record<string, unknown>, grid: number): Record<string, unknown> {
  if (grid <= 0) return patch;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'points' && Array.isArray(v)) {
      out[k] = v.map((p) => (p && typeof p === 'object' ? { x: snapValue(num((p as Pt).x), grid), y: snapValue(num((p as Pt).y), grid) } : p));
    } else if (COORD_KEYS.has(k) && typeof v === 'number') {
      out[k] = snapValue(v, grid);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** The patch for dragging `handleId` to the pointer position (px, py) in
 *  drawing units. Dimensions clamp to a 1-unit floor (never a zero/negative
 *  shape); circle radius uses distance from center so any drag direction grows
 *  it. Unknown handle ⇒ no change. */
export function shapeResizePatch(s: Shape, handleId: string, px: number, py: number): Record<string, unknown> {
  switch (s.kind) {
    case 'rect':
      return { width: Math.max(1, Math.round(px - num(s.x))), height: Math.max(1, Math.round(py - num(s.y))) };
    case 'circle':
      return { r: Math.max(1, Math.round(Math.hypot(px - num(s.cx), py - num(s.cy)))) };
    case 'ellipse':
      return { rx: Math.max(1, Math.round(Math.abs(px - num(s.cx)))), ry: Math.max(1, Math.round(Math.abs(py - num(s.cy)))) };
    case 'line':
    case 'arrow': // ADR 0333 Phase 4
      return handleId === 'p1'
        ? { x1: Math.round(px), y1: Math.round(py) }
        : { x2: Math.round(px), y2: Math.round(py) };
    default:
      return {};
  }
}
