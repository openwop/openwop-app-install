/**
 * Pure spine→outline math for the `stroke` shape kind (ADR 0333 Phase 3).
 * Lives BESIDE the one safe renderer (`DrawingPreview`'s `ShapeEl` is its only
 * render-path consumer; the drawings editor imports it for live preview) — the
 * one-render-path rule wins over layer aesthetics (Phase-3 architect gate B).
 *
 * The algorithm is the perfect-freehand model (verified in the research doc):
 * a stroke is STORED as a point+pressure spine and RE-RENDERED as a closed
 * variable-width outline polygon — width becomes geometry, so the SVG needs
 * no stroke-width tricks and the doc stays restyleable. Mouse input has no
 * real pressure; `simulatePressure` synthesizes it from inter-point velocity
 * (fast = thin). No DOM, no React — unit-testable in isolation.
 */

export interface SpinePt { x: number; y: number }

export interface StrokeOutlineOpts {
  /** Base diameter in canvas units. */
  size: number;
  /** Synthesize pressure from velocity (mouse/touch without a real track). */
  simulatePressure?: boolean;
  /** Taper-in/out distances in canvas units (0 = blunt cap). */
  taperStart?: number;
  taperEnd?: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

/** Per-point radii from the pressure track (or velocity simulation) + tapers. */
export function strokeRadii(points: readonly SpinePt[], pressures: readonly number[] | undefined, opts: StrokeOutlineOpts): number[] {
  const n = points.length;
  const base = Math.max(0.25, opts.size / 2);
  const taperS = Math.max(0, opts.taperStart ?? 0);
  const taperE = Math.max(0, opts.taperEnd ?? 0);

  // Running arc length per point (for tapers).
  const arc: number[] = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dx = points[i]!.x - points[i - 1]!.x, dy = points[i]!.y - points[i - 1]!.y;
    arc[i] = arc[i - 1]! + Math.hypot(dx, dy);
  }
  const total = arc[n - 1] ?? 0;

  const out: number[] = new Array<number>(n);
  let simPrev = 0.5;
  for (let i = 0; i < n; i++) {
    let p: number;
    if (opts.simulatePressure || !pressures || pressures.length === 0) {
      // Velocity-simulated: fast segments thin out. EMA-smoothed so a single
      // jerky sample doesn't notch the outline.
      const d = i > 0 ? arc[i]! - arc[i - 1]! : 0;
      const target = clamp01(1 - d / (opts.size * 2.5));
      simPrev = simPrev + (target - simPrev) * 0.5;
      p = simPrev;
    } else {
      p = clamp01(pressures[Math.min(i, pressures.length - 1)] ?? 0.5);
    }
    // Thinning 0.5: radius spans [0.5, 1.0]×base across the pressure range.
    let r = base * (0.5 + 0.5 * p);
    if (taperS > 0 && arc[i]! < taperS) r *= clamp01(arc[i]! / taperS);
    if (taperE > 0 && total - arc[i]! < taperE) r *= clamp01((total - arc[i]!) / taperE);
    out[i] = Math.max(0.1, r);
  }
  return out;
}

/** The closed outline polygon (left side forward, right side back). */
export function strokeOutlinePoints(points: readonly SpinePt[], pressures: readonly number[] | undefined, opts: StrokeOutlineOpts): SpinePt[] {
  const n = points.length;
  if (n === 0) return [];
  const radii = strokeRadii(points, pressures, opts);
  if (n === 1) {
    // A dot: an 8-gon around the point.
    const r = radii[0]!;
    const p = points[0]!;
    return Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2;
      return { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
    });
  }
  const left: SpinePt[] = [];
  const right: SpinePt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(n - 1, i + 1)]!;
    let dx = next.x - prev.x, dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = radii[i]!;
    const p = points[i]!;
    left.push({ x: p.x - dy * r, y: p.y + dx * r });
    right.push({ x: p.x + dy * r, y: p.y - dx * r });
  }
  return [...left, ...right.reverse()];
}

/** Compact SVG path: quadratic curves through segment midpoints (smooth, no
 *  corner spikes), closed. The renderer fills it — no stroke attributes. */
export function strokeOutlinePath(points: readonly SpinePt[], pressures: readonly number[] | undefined, opts: StrokeOutlineOpts): string {
  const ring = strokeOutlinePoints(points, pressures, opts);
  if (ring.length < 3) return '';
  const first = ring[0]!;
  let d = `M ${fmt(first.x)} ${fmt(first.y)}`;
  for (let i = 1; i <= ring.length; i++) {
    const a = ring[i % ring.length]!;
    const b = ring[(i + 1) % ring.length]!;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    d += ` Q ${fmt(a.x)} ${fmt(a.y)} ${fmt(mx)} ${fmt(my)}`;
  }
  return `${d} Z`;
}
