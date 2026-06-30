/**
 * Priority Matrix scoring engine (ADR 0058 § Scoring model) — a PURE module (no
 * I/O, no store) so it is trivially unit-testable and replay-deterministic.
 *
 * Two aggregation modes, industry-best-practice grounded:
 *   - `weighted-sum` (default — Weighted Scoring, what the 1–10 sliders mechanically
 *     are): Σ(effScore_i × weight_i) / Σ(weight_i), normalized to the 1..10 band.
 *     A `cost`-direction criterion is inverted (11 − score) so "higher = worse".
 *   - `ratio` (WSJF / RICE / Value-Effort): benefitAggregate / costAggregate, the
 *     "divide by size/effort" family. Falls back to the benefit aggregate when a
 *     set declares no cost criterion (avoids divide-by-zero).
 *
 * Scores are 1..10; a criterion with no score for an idea contributes 0 (an
 * unscored idea ranks last). The result is rounded to 2 dp for display stability.
 */

import type { Criterion, CriteriaSet } from './types.js';

const clampScore = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v < 0 ? 0 : v > 10 ? 10 : v;
};

/** The score a criterion contributes, after applying its direction. A `cost`
 *  criterion is inverted on the 1..10 scale (10 → 1, 1 → 10) so a high cost
 *  lowers priority. An unscored criterion (0) contributes 0 either way. */
function effectiveScore(criterion: Criterion, raw: number): number {
  const s = clampScore(raw);
  if (s === 0) return 0;
  return criterion.direction === 'cost' ? 11 - s : s;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Compute one idea's priority from its per-criterion scores. Returns 0 when there
 * are no criteria or no scores (an empty idea ranks last). Never throws.
 */
export function computePriority(set: CriteriaSet, scores: Record<string, number>): number {
  const criteria = set.criteria ?? [];
  if (criteria.length === 0) return 0;

  if (set.aggregation === 'ratio') {
    let benefit = 0;
    let benefitWeight = 0;
    let cost = 0;
    let costWeight = 0;
    for (const c of criteria) {
      const s = clampScore(scores[c.id]);
      const w = clampScore(c.weight) || 1;
      if (c.direction === 'cost') { cost += s * w; costWeight += w; }
      else { benefit += s * w; benefitWeight += w; }
    }
    const benefitAgg = benefitWeight > 0 ? benefit / benefitWeight : 0;
    const costAgg = costWeight > 0 ? cost / costWeight : 0;
    // No cost dimension ⇒ degrade to the benefit aggregate (not a ratio).
    if (costAgg <= 0) return round2(benefitAgg);
    return round2(benefitAgg / costAgg);
  }

  // weighted-sum (default): normalized Σ(effScore × weight) / Σ(weight).
  let weighted = 0;
  let totalWeight = 0;
  for (const c of criteria) {
    const w = clampScore(c.weight) || 1;
    weighted += effectiveScore(c, scores[c.id]) * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? round2(weighted / totalWeight) : 0;
}

/** A ranked entry — the idea's card id, its priority, and its 1-based rank. */
export interface Ranked<T> {
  item: T;
  priority: number;
  rank: number;
}

/**
 * Rank items by computed priority, descending. `getScores` returns the per-idea
 * score map for an item. Ties keep input order (stable sort), then rank is
 * assigned 1-based. Pure — caller owns I/O.
 */
export function rankByPriority<T>(
  set: CriteriaSet,
  items: T[],
  getScores: (item: T) => Record<string, number>,
): Array<Ranked<T>> {
  const scored = items.map((item) => ({ item, priority: computePriority(set, getScores(item)) }));
  scored.sort((a, b) => b.priority - a.priority);
  return scored.map((s, i) => ({ item: s.item, priority: s.priority, rank: i + 1 }));
}
