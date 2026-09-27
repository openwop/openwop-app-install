/**
 * Pure geometry for the canvas `graph` trait (ADR 0323) — the node-graph /
 * screen-flow surface. Port positions on a node box, the four edge-routing
 * styles (bezier / orthogonal / straight / step), and a grid auto-layout for
 * nodes that carry no position yet. No DOM, no React, so every path is
 * unit-testable in isolation while `GraphSurface` stays thin plumbing.
 *
 * Ported from the MyndHyve `core/canvas-shell/components/Connections/ConnectionPath`
 * routing (docs/research/myndhyve-app-builder-migration.md §4), re-expressed as
 * pure functions.
 */

import { boxBounds, boxIntersectsBounds, clientToCanvasPoint, fitToBounds, visibleCanvasRect } from '../viewport.js';

export type Edge = 'top' | 'right' | 'bottom' | 'left';
export type Routing = 'bezier' | 'orthogonal' | 'straight' | 'step';
export interface Pt { x: number; y: number }
/** A node's box in CANVAS coordinates (pre pan/zoom). */
export interface Box { x: number; y: number; w: number; h: number }

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The connection point at the centre of a box edge (canvas coords). */
export function portPoint(b: Box, edge: Edge): Pt {
  const x = num(b.x), y = num(b.y), w = Math.max(0, num(b.w)), h = Math.max(0, num(b.h));
  switch (edge) {
    case 'top': return { x: x + w / 2, y };
    case 'bottom': return { x: x + w / 2, y: y + h };
    case 'left': return { x, y: y + h / 2 };
    case 'right': return { x: x + w, y: y + h / 2 };
  }
}

/** The outward unit normal of an edge — the direction a path leaves the port. */
export function edgeNormal(edge: Edge): Pt {
  switch (edge) {
    case 'top': return { x: 0, y: -1 };
    case 'bottom': return { x: 0, y: 1 };
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
  }
}

/** Auto-pick the facing edges for two boxes by their centre offset — the larger
 *  axis wins, so side-by-side nodes connect right→left and stacked ones
 *  bottom→top. Used when a connector omits explicit `sourceEdge`/`targetEdge`. */
export function autoEdges(a: Box, b: Box): { sourceEdge: Edge; targetEdge: Edge } {
  const ac = portCentre(a), bc = portCentre(b);
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { sourceEdge: 'right', targetEdge: 'left' } : { sourceEdge: 'left', targetEdge: 'right' };
  }
  return dy >= 0 ? { sourceEdge: 'bottom', targetEdge: 'top' } : { sourceEdge: 'top', targetEdge: 'bottom' };
}

function portCentre(b: Box): Pt {
  return { x: num(b.x) + Math.max(0, num(b.w)) / 2, y: num(b.y) + Math.max(0, num(b.h)) / 2 };
}

const fmt = (n: number): string => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0).toString();
const M = (p: Pt): string => `M ${fmt(p.x)} ${fmt(p.y)}`;
const L = (p: Pt): string => `L ${fmt(p.x)} ${fmt(p.y)}`;

/** Straight line source→target. */
export function straightPath(s: Pt, t: Pt): string {
  return `${M(s)} ${L(t)}`;
}

/** Cubic bezier leaving each port along its outward normal. Control offset scales
 *  with the span (clamped 40–200) so short and long edges both read cleanly. */
export function bezierPath(s: Pt, t: Pt, sEdge: Edge, tEdge: Edge): string {
  const span = Math.hypot(t.x - s.x, t.y - s.y);
  const off = Math.max(40, Math.min(200, span * 0.5));
  const sn = edgeNormal(sEdge), tn = edgeNormal(tEdge);
  const c1 = { x: s.x + sn.x * off, y: s.y + sn.y * off };
  const c2 = { x: t.x + tn.x * off, y: t.y + tn.y * off };
  return `${M(s)} C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(t.x)} ${fmt(t.y)}`;
}

/** Right-angle "step": leave along the normal, split the gap, arrive along the
 *  target normal. A mid-split on the dominant axis. */
export function stepPath(s: Pt, t: Pt, sEdge: Edge): string {
  const horizontal = sEdge === 'left' || sEdge === 'right';
  if (horizontal) {
    const midX = (s.x + t.x) / 2;
    return `${M(s)} ${L({ x: midX, y: s.y })} ${L({ x: midX, y: t.y })} ${L(t)}`;
  }
  const midY = (s.y + t.y) / 2;
  return `${M(s)} ${L({ x: s.x, y: midY })} ${L({ x: t.x, y: midY })} ${L(t)}`;
}

/** Orthogonal L/Z with a fixed stub off each port so lines don't hug the node. */
export function orthogonalPath(s: Pt, t: Pt, sEdge: Edge, tEdge: Edge): string {
  const STUB = 24;
  const sn = edgeNormal(sEdge), tn = edgeNormal(tEdge);
  const s2 = { x: s.x + sn.x * STUB, y: s.y + sn.y * STUB };
  const t2 = { x: t.x + tn.x * STUB, y: t.y + tn.y * STUB };
  // Bridge s2→t2 with a single right-angle bend on the dominant axis.
  const mid = Math.abs(t2.x - s2.x) >= Math.abs(t2.y - s2.y)
    ? [{ x: (s2.x + t2.x) / 2, y: s2.y }, { x: (s2.x + t2.x) / 2, y: t2.y }]
    : [{ x: s2.x, y: (s2.y + t2.y) / 2 }, { x: t2.x, y: (s2.y + t2.y) / 2 }];
  return [M(s), L(s2), L(mid[0]!), L(mid[1]!), L(t2), L(t)].join(' ');
}

/** The SVG path `d` for an edge between two node boxes. Explicit edges win;
 *  otherwise `autoEdges` picks the facing pair. NaN-safe (boxes from AI output
 *  may carry bad coords — the class of bug MyndHyve's guards covered). */
export function edgePath(
  a: Box,
  b: Box,
  opts: { sourceEdge?: Edge; targetEdge?: Edge; routing?: Routing } = {},
): string {
  const auto = autoEdges(a, b);
  const sEdge = opts.sourceEdge ?? auto.sourceEdge;
  const tEdge = opts.targetEdge ?? auto.targetEdge;
  const s = portPoint(a, sEdge);
  const t = portPoint(b, tEdge);
  switch (opts.routing ?? 'bezier') {
    case 'straight': return straightPath(s, t);
    case 'step': return stepPath(s, t, sEdge);
    case 'orthogonal': return orthogonalPath(s, t, sEdge, tEdge);
    case 'bezier':
    default: return bezierPath(s, t, sEdge, tEdge);
  }
}

/** The midpoint of an edge (canvas coords) — where a label chip / delete affordance
 *  sits. Uses the port centres, good enough for a chip anchor across routings. */
export function edgeMidpoint(a: Box, b: Box, opts: { sourceEdge?: Edge; targetEdge?: Edge } = {}): Pt {
  const auto = autoEdges(a, b);
  const s = portPoint(a, opts.sourceEdge ?? auto.sourceEdge);
  const t = portPoint(b, opts.targetEdge ?? auto.targetEdge);
  return { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
}

/** Deterministic grid layout for nodes with no stored position — √N columns,
 *  `gap` between cells of `w`×`h`. Stable order = input order (no Math.random,
 *  which is banned in this environment anyway). */
export function gridLayout(
  ids: readonly string[],
  opts: { w: number; h: number; gap?: number; originX?: number; originY?: number } = { w: 240, h: 420 },
): Map<string, Pt> {
  const gap = opts.gap ?? 80;
  const ox = opts.originX ?? 80;
  const oy = opts.originY ?? 80;
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
  const out = new Map<string, Pt>();
  ids.forEach((id, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    out.set(id, { x: ox + col * (opts.w + gap), y: oy + row * (opts.h + gap) });
  });
  return out;
}

/** Snap a value to a grid (0 = no snap). */
export function snap(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : v;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/** The node ids whose boxes intersect the visible canvas rect (the viewport
 *  mapped through pan/zoom), expanded by `margin` canvas units on every side —
 *  the graph-virtualization cull (audit polish P3). Rect math delegates to the
 *  shared `canvas/viewport` owner (ADR 0333 Phase 1). */
export function visibleNodeIds(
  boxes: ReadonlyMap<string, Box>,
  pan: Pt,
  zoom: number,
  vw: number,
  vh: number,
  margin = 400,
): Set<string> {
  const r = visibleCanvasRect(pan, zoom, vw, vh, margin);
  const out = new Set<string>();
  for (const [id, b] of boxes) {
    if (boxIntersectsBounds(b, r)) out.add(id);
  }
  return out;
}

/** The axis-aligned bounding box of a set of node boxes (canvas coords), or null
 *  for an empty set. NaN-safe (garbage box fields coerce to 0). Delegates to
 *  `canvas/viewport` (one owner, ADR 0333 Phase 1). */
export function contentBounds(boxes: Iterable<Box>): Bounds | null {
  return boxBounds(boxes);
}

/** The pan + zoom that frames `bounds` inside a `vw`×`vh` viewport with `margin`
 *  padding — zoom clamped to [0.25, 1] (never magnifies past 1:1; the graph's
 *  HISTORICAL clamp passed verbatim so ADR 0323 behavior stays byte-identical),
 *  content centred. Delegates to `canvas/viewport` (ADR 0333 Phase 1). */
export function fitView(bounds: Bounds, vw: number, vh: number, margin = 40): { pan: Pt; zoom: number } {
  return fitToBounds(bounds, vw, vh, margin, { min: 0.25, max: 1 });
}

/** Convert a client (screen) point to CANVAS coordinates given the surface's
 *  bounding rect + current pan/zoom. Pure so the pointer math is testable
 *  without a real DOM (jsdom returns a 0-rect, so `GraphSurface` drag geometry
 *  can't be exercised there — this function is the tested seam). Delegates to
 *  `canvas/viewport` (one owner, ADR 0333 Phase 1). */
export function clientToCanvas(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  pan: Pt,
  zoom: number,
): Pt {
  return clientToCanvasPoint(clientX, clientY, rect, pan, zoom);
}
