/**
 * Pure viewport math for pannable/zoomable canvas surfaces (ADR 0333 Phase 1).
 * ONE owner for the pan/zoom formulas: `graph/edgeRouting.ts` delegates its
 * viewport helpers here (its exports are unchanged wrappers), and
 * `useCanvasViewport`/`ViewportSurface` consume these directly. No DOM, no
 * React — jsdom returns 0-rects, so every geometry decision lives here where
 * it is unit-testable (the GraphSurface precedent).
 */

export interface ViewPt { x: number; y: number }
/** An axis-aligned box in CANVAS coordinates (pre pan/zoom). */
export interface ViewBox { x: number; y: number; w: number; h: number }
export interface ViewBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface ViewportState { pan: ViewPt; zoom: number }
/** Zoom clamp range — parametrized because consumers legitimately differ: the
 *  node graph pins [0.25, 2.5] (ADR 0323 behavior, frozen); artboard canvases
 *  magnify further. */
export interface ZoomLimits { min: number; max: number }

export const DEFAULT_ZOOM_LIMITS: ZoomLimits = { min: 0.25, max: 8 };

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function clampZoom(z: number, limits: ZoomLimits): number {
  const lo = limits.min > 0 ? limits.min : 0.01;
  const hi = Math.max(lo, limits.max);
  return Math.max(lo, Math.min(hi, Number.isFinite(z) && z > 0 ? z : 1));
}

/** Zoom about a focal point given in SURFACE-LOCAL pixels (e.g. the cursor
 *  position relative to the wrapper). The canvas point under the focal point
 *  stays fixed — the invariant the unit suite pins. Same formula as the
 *  GraphSurface wheel handler (one owner now). */
export function zoomAtPoint(state: ViewportState, factor: number, focal: ViewPt, limits: ZoomLimits): ViewportState {
  const z = state.zoom > 0 ? state.zoom : 1;
  const nz = clampZoom(z * (Number.isFinite(factor) && factor > 0 ? factor : 1), limits);
  if (nz === z) return state;
  return {
    zoom: nz,
    pan: {
      x: focal.x - ((focal.x - state.pan.x) / z) * nz,
      y: focal.y - ((focal.y - state.pan.y) / z) * nz,
    },
  };
}

/** Convert a client (screen) point to CANVAS coordinates given the surface's
 *  bounding rect + current pan/zoom. (Moved verbatim from `graph/edgeRouting`;
 *  that module re-exports it.) */
export function clientToCanvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  pan: ViewPt,
  zoom: number,
): ViewPt {
  const z = zoom > 0 ? zoom : 1;
  return { x: (clientX - rect.left - pan.x) / z, y: (clientY - rect.top - pan.y) / z };
}

/** The axis-aligned bounding box of a set of boxes (canvas coords), or null for
 *  an empty set. NaN-safe (garbage fields coerce to 0). */
export function boxBounds(boxes: Iterable<ViewBox>): ViewBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const b of boxes) {
    const x = num(b.x), y = num(b.y), w = Math.max(0, num(b.w)), h = Math.max(0, num(b.h));
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    any = true;
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

/** The pan + zoom that frames `bounds` inside a `vw`×`vh` viewport with
 *  `margin` padding, content centred, zoom clamped to `limits`. Generalized
 *  from the graph's `fitView` — the graph wrapper passes its historical
 *  [0.25, 1] clamp verbatim so its behavior stays byte-identical. */
export function fitToBounds(bounds: ViewBounds, vw: number, vh: number, margin: number, limits: ZoomLimits): ViewportState {
  const cw = Math.max(1, bounds.maxX - bounds.minX);
  const ch = Math.max(1, bounds.maxY - bounds.minY);
  const avW = Math.max(1, vw - margin * 2);
  const avH = Math.max(1, vh - margin * 2);
  const zoom = clampZoom(Math.min(avW / cw, avH / ch), limits);
  return {
    zoom,
    pan: { x: (vw - cw * zoom) / 2 - bounds.minX * zoom, y: (vh - ch * zoom) / 2 - bounds.minY * zoom },
  };
}

/** The visible rect in CANVAS coordinates for a `vw`×`vh` surface under
 *  pan/zoom, expanded by `margin` canvas units per side — the culling
 *  prefilter's input (the graph's `visibleNodeIds` delegates here). */
export function visibleCanvasRect(pan: ViewPt, zoom: number, vw: number, vh: number, margin: number): ViewBounds {
  const z = zoom > 0 ? zoom : 1;
  return {
    minX: (-pan.x) / z - margin,
    minY: (-pan.y) / z - margin,
    maxX: (vw - pan.x) / z + margin,
    maxY: (vh - pan.y) / z + margin,
  };
}

/** Box↔bounds intersection test used by culling prefilters. */
export function boxIntersectsBounds(b: ViewBox, r: ViewBounds): boolean {
  const x = num(b.x), y = num(b.y), w = Math.max(0, num(b.w)), h = Math.max(0, num(b.h));
  return x + w >= r.minX && x <= r.maxX && y + h >= r.minY && y <= r.maxY;
}

/** Convert CLIENT-coordinate bounds (screen px, e.g. from `getScreenCTM`-
 *  transformed corners) into STAGE-LOCAL bounds — the untransformed space
 *  `fitToBounds` expects — given the wrapper's rect and the CURRENT viewport
 *  (ADR 0333 Phase 2, zoom-to-selection). */
export function clientBoundsToStage(
  b: ViewBounds,
  rect: { left: number; top: number },
  state: ViewportState,
): ViewBounds {
  const z = state.zoom > 0 ? state.zoom : 1;
  return {
    minX: (b.minX - rect.left - state.pan.x) / z,
    minY: (b.minY - rect.top - state.pan.y) / z,
    maxX: (b.maxX - rect.left - state.pan.x) / z,
    maxY: (b.maxY - rect.top - state.pan.y) / z,
  };
}

/** Edge-scroll velocity for a pointer at SURFACE-LOCAL `p` in a `vw`×`vh`
 *  wrapper: 0 outside the `zone`, ramping to ±`maxSpeed` px/frame at the very
 *  edge, per axis (the tldraw spec: proximity factor + easing; ADR 0333
 *  Phase 2). The PAN moves opposite the edge (pointer at right edge → content
 *  scrolls left → pan.x decreases). */
export function edgeScrollVector(
  p: ViewPt,
  vw: number,
  vh: number,
  zone: number,
  maxSpeed: number,
): ViewPt {
  // Clamped ease: a CAPTURED pointer can travel far outside the wrapper —
  // speed saturates at maxSpeed instead of growing with distance.
  const ease = (f: number): number => { const c = Math.max(0, Math.min(1, f)); return c * c; };
  const axis = (v: number, extent: number): number => {
    if (extent <= zone * 2) return 0; // degenerate wrapper — never scroll
    if (v < zone) return ease((zone - v) / zone) * maxSpeed;        // near the low edge → positive pan
    if (v > extent - zone) return -ease((v - (extent - zone)) / zone) * maxSpeed; // near the high edge → negative pan
    return 0;
  };
  return { x: axis(p.x, vw), y: axis(p.y, vh) };
}

/**
 * The doc-space length that renders at a CONSTANT screen size regardless of the
 * viewport zoom (ADR 0333 grade pass — screen-constant selection handles). The
 * scene sits inside `scale(zoom)`, so a base doc length L appears at `L·f·zoom`
 * px (f = the constant viewBox letterbox-fit scale, which cancels); dividing the
 * base by zoom pins the on-screen size to its zoom-1 value. At zoom 1 this is a
 * no-op (returns `base`), so the fitted view is byte-identical. RENDER-only —
 * the result must never reach a persisted patch/addElements payload.
 */
export function screenConstant(base: number, zoom: number): number {
  return base / (zoom > 0 ? zoom : 1);
}
