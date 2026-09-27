/**
 * QuickShape ink beautification (ADR 0333 Phase 4) — the verified Procreate
 * interaction: draw a stroke, HOLD at the end, and the raw ink snaps to the
 * nearest detected geometric shape. Pure fitting over the live spine — no DOM,
 * no React. The editor swaps the live overlay to the fitted shape and commits
 * IT (one addElements step) instead of the stroke. The second-finger
 * "regularize to the ideal form" tap is a recorded follow-up.
 *
 * Detection order: closed-ish path → circle / ellipse / triangle / rect
 * (corner count over an RDP skeleton); open path → straight line. `null`
 * (no confident fit) keeps the raw stroke — the honest default.
 */
import { rdpIndices, type Pt } from './shapeGeometry.js';

export type QuickFit =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'polygon'; points: Pt[] };

const rnd = (v: number): number => Math.round(v * 100) / 100;

/** Mean absolute deviation of the spine from the segment a→b. */
function lineDeviation(points: readonly Pt[], a: Pt, b: Pt): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len = Math.hypot(abx, aby) || 1;
  let sum = 0;
  for (const p of points) {
    sum += Math.abs(((p.x - a.x) * aby - (p.y - a.y) * abx) / len);
  }
  return sum / points.length;
}

/** Mean |dist-to-centre − r| — circularity residual. */
function radialDeviation(points: readonly Pt[], cx: number, cy: number, r: number): number {
  let sum = 0;
  for (const p of points) sum += Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
  return sum / points.length;
}

/** Fit the spine to the closest primitive, or null when nothing is confident.
 *  `scale` is the drawing's characteristic unit (tolerances scale with it). */
export function fitQuickShape(points: readonly Pt[], scale: number): QuickFit | null {
  if (points.length < 3) return null;
  const first = points[0]!, last = points[points.length - 1]!;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  const span = Math.hypot(w, h);
  if (span < scale * 2) return null; // too small to mean anything

  const closeGap = Math.hypot(last.x - first.x, last.y - first.y);
  const isClosed = closeGap < Math.max(scale * 2.5, span * 0.2);

  if (!isClosed) {
    // Open path → a straight line when the spine hugs its chord.
    if (lineDeviation(points, first, last) <= Math.max(scale * 0.9, span * 0.045)) {
      return { kind: 'line', x1: rnd(first.x), y1: rnd(first.y), x2: rnd(last.x), y2: rnd(last.y) };
    }
    return null;
  }

  // Closed-ish. Roundness first — the ELLIPSE-NORMALIZED radial residual
  // (a flattened loop fails a plain circle test but is still perfectly oval).
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rx = Math.max(1e-6, w / 2), ry = Math.max(1e-6, h / 2);
  const eRes = points.reduce((acc, p) => acc + Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1), 0) / points.length;
  if (eRes <= Math.max(0.14, scale / (Math.min(rx, ry) * 2))) {
    const aspect = w / Math.max(1e-6, h);
    if (aspect > 0.82 && aspect < 1.22) {
      const meanR = points.reduce((acc, p) => acc + Math.hypot(p.x - cx, p.y - cy), 0) / points.length;
      if (radialDeviation(points, cx, cy, meanR) <= Math.max(scale * 0.9, meanR * 0.14)) {
        return { kind: 'circle', cx: rnd(cx), cy: rnd(cy), r: rnd(meanR) };
      }
    }
    return { kind: 'ellipse', cx: rnd(cx), cy: rnd(cy), rx: rnd(rx), ry: rnd(ry) };
  }

  // Corner skeleton: RDP with a coarse epsilon; drop the duplicate closing
  // point using the same gap tolerance that judged the path closed.
  const skel = rdpIndices(points, Math.max(scale * 1.2, span * 0.05)).map((i) => points[i]!);
  const corners = skel.length >= 2 && Math.hypot(skel[skel.length - 1]!.x - skel[0]!.x, skel[skel.length - 1]!.y - skel[0]!.y) < Math.max(scale * 2.5, span * 0.2)
    ? skel.slice(0, -1)
    : skel;

  if (corners.length === 3) {
    return { kind: 'polygon', points: corners.map((p) => ({ x: rnd(p.x), y: rnd(p.y) })) };
  }
  if (corners.length === 4) {
    // Axis-aligned enough → a rect (the sides hug the bbox edges).
    const edgeTol = Math.max(scale * 1.6, span * 0.09);
    const nearBBox = corners.every((p) =>
      Math.abs(p.x - minX) < edgeTol || Math.abs(p.x - maxX) < edgeTol) && corners.every((p) =>
      Math.abs(p.y - minY) < edgeTol || Math.abs(p.y - maxY) < edgeTol);
    if (nearBBox) {
      return { kind: 'rect', x: rnd(minX), y: rnd(minY), width: rnd(w), height: rnd(h) };
    }
    return { kind: 'polygon', points: corners.map((p) => ({ x: rnd(p.x), y: rnd(p.y) })) };
  }
  return null;
}
