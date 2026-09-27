/**
 * Shared weighted-ranking engine (ADR 0058 § Scoring model; hoisted to core by ADR
 * 0534 P0) — a PURE module (no
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
 * Consumers: Priority Matrix (ideas), CRM propensity, Recommendations, and
 * work-selection (kanban cards). Nothing here is specific to any of them.
 *
 * Scores are 1..10; a criterion with no score for an item contributes 0 (an
 * unscored item ranks last). The result is rounded to 2 dp for display stability.
 */

export type Aggregation = 'weighted-sum' | 'ratio' | 'product-ratio';

/** Whether a higher 1–10 score is better (`benefit`) or worse (`cost`).
 *  Cost/effort/job-size criteria are `cost` — they drag priority DOWN. */
export type CriterionDirection = 'benefit' | 'cost';

/** A named framework a criteria set was seeded from (UX honesty: the slider model
 *  is Weighted Scoring; WSJF/RICE are ratio presets — ADR 0058 § Scoring model). */
export type PresetId = 'weighted' | 'wsjf' | 'rice' | 'ice' | 'value-effort';
export const PRESET_IDS: readonly PresetId[] = ['weighted', 'wsjf', 'rice', 'ice', 'value-effort'];

/** One weighted factor an idea is scored against. */
export interface Criterion {
  id: string;
  name: string;
  description?: string;
  /** The slider — relative importance, 1..10. */
  weight: number;
  direction: CriterionDirection;
  /** Anchor text for the 1..10 score input (reduces score-gaming, ADR 0058 UX). */
  scaleHint?: string;
}

/** The configurable, per-list weighted scoring model. */
export interface CriteriaSet {
  presetId?: PresetId;
  aggregation: Aggregation;
  criteria: Criterion[];
}


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

  // ADR 0667 D2 (PMXWF-8) — RICE. The published formula is MULTIPLICATIVE
  // ((Reach × Impact × Confidence) ÷ Effort); `ratio` computes a weighted MEAN over the
  // benefits, and that is not a scale difference — it INVERTS the ordering. MEASURED:
  // {10,10,2}/1 scored 7.33 and beat {6,6,6}/1 at 6.00, while true RICE ranks them
  // 200 < 216. Confidence is supposed to MULTIPLY; averaging lets high reach mask it.
  //
  // The `^(1/Σw)` root is a strictly monotonic transform, so ordering is exactly the
  // published formula's while the value stays in the familiar band — a raw product hits
  // 1000 on three criteria and 10^190 on a 20-criterion set, and `computedPriority`
  // reaches a KB doc that advisory boards retrieve (`.toFixed(2)`), the agenda markdown
  // and the meter. Ordering is what this feature sells; magnitude is what everything
  // downstream already assumes.
  //
  // Both products run over SCORED criteria only. Over ALL declared criteria an unscored
  // benefit would zero the numerator — re-creating as arithmetic the overloaded `0`
  // sentinel that D1 exists to un-overload — and an unscored cost would divide by zero
  // and write `null` into the durable cache via JSON.stringify. Incompleteness travels
  // on `scoreCompleteness`, never on this number.
  if (set.aggregation === 'product-ratio') {
    let benefit = 1;
    let benefitWeight = 0;
    let cost = 1;
    let costWeight = 0;
    for (const c of criteria) {
      const s = clampScore(scores[c.id]);
      if (s <= 0) continue;                       // unscored — excluded, never a zero factor
      const w = clampScore(c.weight) || 1;
      if (c.direction === 'cost') { cost *= Math.pow(s, w); costWeight += w; }
      else { benefit *= Math.pow(s, w); benefitWeight += w; }
    }
    // Nothing positive to rank on. (Scores are 1..10, so every included factor is >= 1:
    // `cost` can never be 0 and the quotient can never be non-finite.)
    if (benefitWeight <= 0) return 0;
    return round2(Math.pow(benefit / cost, 1 / (benefitWeight + costWeight)));
  }

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
    // R2 PM2-B1 — the old test was `costAgg <= 0`, which CANNOT tell "this set declares no
    // cost criterion" apart from "it declares one and nobody scored it": `clampScore` maps
    // an absent score to 0, so an unscored cost adds 0 to `cost` while its weight still
    // counts. Both landed in the same branch, which returns the raw BENEFIT aggregate —
    // so on a WSJF list an idea with three 9s and a BLANK job-size scored 9.00 and ranked
    // #1, ahead of the identical idea whose job-size of 3 gave it 9/3 = 3.00. The
    // un-estimated idea outranked the estimated one, and this file's own docstring says
    // the opposite ("an empty idea ranks last").
    //
    // The app already held the correct second opinion: the matrix view's `quadrant.ts`
    // returns `null` for that idea's cost axis and drops it into the "unscored, not
    // placed" tray. On one page, Matrix said "cannot place this" while List said "#1".
    const declaresCost = criteria.some((c) => c.direction === 'cost');
    if (declaresCost && costAgg <= 0) return 0;          // incompletely scored ⇒ ranks last
    if (costAgg <= 0) return round2(benefitAgg);         // genuinely no cost dimension
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

/**
 * ADR 0667 D1a — how completely an item is scored against a criteria set.
 *
 * A criterion counts as SCORED when its value is a finite number `> 0`. Two places
 * in this codebase already hold that reading exactly: `effectiveScore` below
 * collapses a post-clamp `0` to no contribution, and priority-matrix's validators
 * (`asWeight`, the score loop in `priorityMatrixService.ts`) enforce `1..10` so
 * "absent" and "`0`" can never collide on PM data.
 *
 * It is NOT universal, and the difference is live rather than hypothetical: the
 * frontend's `quadrant.ts` `axisValue` tests `typeof s === 'number'`, which ACCEPTS
 * `0`, and `features/recommendations` passes a literal `categoryMatch: 0` meaning
 * LOWEST — not "unscored". That is exactly why `completenessMajor` below defaults
 * OFF: this function pins the `> 0` reading into a SHARED engine, and a consumer
 * that means `0` as a real score must not silently inherit it.
 */
export interface ScoreCompleteness {
  /** How many criteria the set declares. */
  declared: number;
  /** How many of them this item actually has a score for. */
  scored: number;
  /** The ids of the criteria with no score, in declaration order. */
  missing: string[];
  /** `true` only when every declared criterion is scored. */
  complete: boolean;
}

export function scoreCompleteness(set: CriteriaSet, scores: Record<string, number>): ScoreCompleteness {
  const criteria = set.criteria ?? [];
  const missing: string[] = [];
  for (const c of criteria) {
    const raw = scores[c.id];
    const isScored = typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
    if (!isScored) missing.push(c.id);
  }
  return {
    declared: criteria.length,
    scored: criteria.length - missing.length,
    missing,
    complete: criteria.length > 0 && missing.length === 0,
  };
}

/**
 * ADR 0667 D1b — the minimum complete cohort for completeness-major ordering.
 *
 * Unbounded, "a complete item always outranks an incomplete one" is worse than
 * interleaving in the degenerate case: ONE complete idea among forty incomplete
 * ones would be pinned to #1 on completeness alone, however weak it is, and the
 * first person to score a newly-added criterion on a single idea would promote it
 * instantly. So the rule engages only when the complete cohort is at least this
 * many items AND a majority of the ranked set.
 */
const MIN_COMPLETE_COHORT = 2;

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
export interface RankOptions {
  /**
   * ADR 0667 D1b — rank fully-scored items above partially-scored ones, whatever
   * their priorities. **Defaults to `false`, and the default is load-bearing:**
   * `features/recommendations` passes a literal `0` for `categoryMatch` on every
   * anchorless placement (meaning LOWEST, not "unscored"), so flipping this on
   * globally would reorder it for a reason unrelated to data absence.
   * `features/work-selection` is structurally immune either way — its projector
   * always emits all four criteria with a floor of 1 — so priority-matrix is the
   * only caller that passes `true`.
   */
  completenessMajor?: boolean;
}

export function rankByPriority<T>(
  set: CriteriaSet,
  items: T[],
  getScores: (item: T) => Record<string, number>,
  opts?: RankOptions,
): Array<Ranked<T>> {
  const scored = items.map((item) => {
    const s = getScores(item);
    return { item, priority: computePriority(set, s), complete: scoreCompleteness(set, s).complete };
  });

  // The cohort test (D1b's bound) is computed over the WHOLE set before sorting, so
  // it is a property of the list rather than of any item's position in it.
  const completeCount = scored.reduce((n, s) => n + (s.complete ? 1 : 0), 0);
  const segregate = opts?.completenessMajor === true
    && completeCount >= MIN_COMPLETE_COHORT
    && completeCount * 2 > scored.length;

  scored.sort((a, b) => {
    if (segregate && a.complete !== b.complete) return a.complete ? -1 : 1;
    return b.priority - a.priority;
  });
  return scored.map((s, i) => ({ item: s.item, priority: s.priority, rank: i + 1 }));
}
