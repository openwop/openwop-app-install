/**
 * Smart-guide snapping engine (ADR 0333 Phase 5) — pure, type-agnostic canvas
 * infrastructure (the C7 core ruling: drawings adopts now; the app-builder
 * graph and CAD are recorded adopters). Candidates come from SIBLING bounding
 * boxes (edges + centers, both axes), built ONCE at gesture start; each move
 * then snaps the dragged box's edges/center to the nearest candidate within a
 * threshold and reports the matched guide lines for the overlay.
 *
 * Distinct from the graph's scalar `snap()` (grid rounding) — that concern
 * stays where it is. Gap-snapping (equal spacing) is a recorded follow-up.
 */
import type { ViewBox } from './viewport.js';

export interface SnapCandidates {
  /** X positions of vertical candidate lines (left/center/right of siblings). */
  v: number[];
  /** Y positions of horizontal candidate lines (top/middle/bottom). */
  h: number[];
}

export interface SnapGuide {
  axis: 'v' | 'h';
  pos: number;
  /** 'align' (edge/center — `--guide-align`) vs 'space' (equal spacing —
   *  `--guide-space`, DESIGN.md §7.4 / CV-6). Absent = 'align' so pre-CV-6
   *  call sites keep compiling unchanged (architect ruling P1-4). */
  kind?: 'align' | 'space';
}

export interface SnapResult { dx: number; dy: number; guides: SnapGuide[] }

/** A rendered equal-spacing hint: a segment along `dir` at cross-position
 *  `at`, from `from` to `to`, labeled with the shared `gap` (canvas units). */
export interface SpaceSpan { dir: 'x' | 'y'; at: number; from: number; to: number; gap: number }

/** One equal-spacing snap position for the dragged box on an axis, plus the
 *  spans the overlay draws when it wins. */
export interface GapCandidate { pos: number; spans: SpaceSpan[] }
export interface GapCandidates { x: GapCandidate[]; y: GapCandidate[] }

/** Candidate lines from sibling boxes — call once at gesture start. */
export function buildSnapCandidates(siblings: readonly ViewBox[]): SnapCandidates {
  const v: number[] = [];
  const h: number[] = [];
  for (const b of siblings) {
    v.push(b.x, b.x + b.w / 2, b.x + b.w);
    h.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { v, h };
}

/** The snap adjustment for a box being dragged: tries the box's own
 *  left/center/right (and top/middle/bottom) against the candidates; the
 *  nearest hit within `threshold` per axis wins. Returns zero deltas and no
 *  guides when nothing is close (or on bypass — the caller checks Ctrl/⌘). */
export function snapDelta(moved: ViewBox, candidates: SnapCandidates, threshold: number): SnapResult {
  const edgesV = [moved.x, moved.x + moved.w / 2, moved.x + moved.w];
  const edgesH = [moved.y, moved.y + moved.h / 2, moved.y + moved.h];

  const best = (edges: number[], cands: number[]): { d: number; pos: number } | null => {
    let out: { d: number; pos: number } | null = null;
    for (const e of edges) {
      for (const c of cands) {
        const d = c - e;
        if (Math.abs(d) <= threshold && (!out || Math.abs(d) < Math.abs(out.d))) out = { d, pos: c };
      }
    }
    return out;
  };

  const bv = best(edgesV, candidates.v);
  const bh = best(edgesH, candidates.h);
  return {
    dx: bv ? bv.d : 0,
    dy: bh ? bh.d : 0,
    guides: [
      ...(bv ? [{ axis: 'v' as const, pos: bv.pos }] : []),
      ...(bh ? [{ axis: 'h' as const, pos: bh.pos }] : []),
    ],
  };
}

/** Snap an angle to `step`-degree increments (Shift-rotate; 15° = the
 *  vector-app grammar). Normalizes into [0, 360). */
export function snapAngle(deg: number, step = 15): number {
  const snapped = Math.round(deg / step) * step;
  return ((snapped % 360) + 360) % 360;
}

// ---- Equal-spacing (gap) snapping — DESIGN.md §7.4 / CV-6 ------------------
// The recorded follow-up of the ADR 0333 Phase 5 engine. Candidates come from
// ADJACENT sibling pairs per axis (sorted order, n-1 pairs — the "distribute"
// semantics), built ONCE at gesture start like the align candidates. Three
// positions per pair (a,b) with gap g: after b at gap g, before a at gap g,
// and centered between them (equal gap each side). Spans are the overlay's
// `--guide-space` segments + mono badges.

const mid = (lo: number, hi: number): number => (lo + hi) / 2;

/** Build equal-spacing candidates for a dragged box of size `moved` against
 *  sibling boxes. Call once at gesture start (the moved size is constant for
 *  the gesture). Pure; O(n log n). */
export function buildGapCandidates(siblings: readonly ViewBox[], moved: { w: number; h: number }): GapCandidates {
  const axis = (
    lo: (b: ViewBox) => number, hi: (b: ViewBox) => number,
    crossMid: (b: ViewBox) => number, size: number, dir: 'x' | 'y',
  ): GapCandidate[] => {
    const sorted = [...siblings].sort((p, q) => lo(p) - lo(q));
    const out: GapCandidate[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!, b = sorted[i + 1]!;
      const g = lo(b) - hi(a);
      if (g <= 0) continue; // overlapping pair — no gap to mirror
      const pairSpan: SpaceSpan = { dir, at: mid(crossMid(a), crossMid(b)), from: hi(a), to: lo(b), gap: g };
      // After b, mirroring the pair's gap.
      out.push({ pos: hi(b) + g, spans: [pairSpan, { dir, at: crossMid(b), from: hi(b), to: hi(b) + g, gap: g }] });
      // Before a, mirroring the pair's gap.
      out.push({ pos: lo(a) - g - size, spans: [pairSpan, { dir, at: crossMid(a), from: lo(a) - g, to: lo(a), gap: g }] });
      // Centered between a and b (equal gap each side), when the box fits.
      const inner = lo(b) - hi(a) - size;
      if (inner > 0) {
        const each = inner / 2;
        const pos = hi(a) + each;
        out.push({
          pos,
          spans: [
            { dir, at: mid(crossMid(a), crossMid(b)), from: hi(a), to: pos, gap: each },
            { dir, at: mid(crossMid(a), crossMid(b)), from: pos + size, to: lo(b), gap: each },
          ],
        });
      }
    }
    return out;
  };
  return {
    x: axis((b) => b.x, (b) => b.x + b.w, (b) => b.y + b.h / 2, moved.w, 'x'),
    y: axis((b) => b.y, (b) => b.y + b.h, (b) => b.x + b.w / 2, moved.h, 'y'),
  };
}

export interface CombinedSnapResult { dx: number; dy: number; guides: SnapGuide[]; spans: SpaceSpan[] }

/** Alignment + equal-spacing snap in one call (the ONE entry point CV-6
 *  consumers use): per axis, the nearest ALIGN hit wins; a GAP hit fills only
 *  axes alignment missed. Zero deltas + empty overlays on bypass (the caller
 *  checks Ctrl/⌘, unchanged). */
export function combinedSnapDelta(
  moved: ViewBox,
  align: SnapCandidates | null,
  gaps: GapCandidates | null,
  threshold: number,
): CombinedSnapResult {
  const a = align ? snapDelta(moved, align, threshold) : { dx: 0, dy: 0, guides: [] as SnapGuide[] };
  const alignedX = a.guides.some((g) => g.axis === 'v');
  const alignedY = a.guides.some((g) => g.axis === 'h');
  const spans: SpaceSpan[] = [];
  let { dx, dy } = a;
  const guides: SnapGuide[] = a.guides.map((g) => ({ ...g, kind: 'align' as const }));
  const nearest = (cands: GapCandidate[], cur: number): GapCandidate | null => {
    let best: GapCandidate | null = null;
    for (const c of cands) {
      const d = Math.abs(c.pos - cur);
      if (d <= threshold && (!best || d < Math.abs(best.pos - cur))) best = c;
    }
    return best;
  };
  // A space hit renders as SPANS (segments + badges), not as an edge line —
  // a guide line at the snapped box edge would be visual noise (Figma/Canva
  // draw only the spacing segments).
  if (gaps && !alignedX) {
    const hit = nearest(gaps.x, moved.x);
    if (hit) { dx = hit.pos - moved.x; spans.push(...hit.spans); }
  }
  if (gaps && !alignedY) {
    const hit = nearest(gaps.y, moved.y);
    if (hit) { dy = hit.pos - moved.y; spans.push(...hit.spans); }
  }
  return { dx, dy, guides, spans };
}
