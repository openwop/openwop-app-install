/**
 * Priority Matrix scoring engine (ADR 0058 § Scoring model; engine hoisted to
 * `host/weightedScoring.ts` by ADR 0534 P0) — exact-value unit tests for the
 * weighted-sum and ratio aggregation modes.
 *
 * Guards: a `cost` criterion is inverted (11 − s) in weighted-sum, an unscored
 * criterion contributes 0 rather than 11, ratio divides benefit by cost, and a
 * ratio set with NO cost criterion degrades to the benefit aggregate.
 * Sabotage-witnessed (grade-tests w15): dropping the inversion, the `s === 0`
 * zero, the division, or the no-cost fallback in `computePriority` each red one
 * case here. (The ratio cases also back PM2-B1 in priority-matrix-honesty.)
 * Ranking order / 1-based rank is covered by priority-matrix-scoring-completeness
 * legs 1-3 (rankByPriority sort + rank sabotages red them).
 */
import { describe, expect, it } from 'vitest';
import { computePriority } from '../src/features/priority-matrix/scoring.js';
import { CRITERIA_PRESETS, type CriteriaSet } from '../src/features/priority-matrix/types.js';

describe('computePriority — weighted-sum', () => {
  const set: CriteriaSet = {
    aggregation: 'weighted-sum',
    criteria: [
      { id: 'value', name: 'Value', weight: 10, direction: 'benefit' },
      { id: 'cost', name: 'Cost', weight: 10, direction: 'cost' },
    ],
  };

  it('inverts a cost criterion (high cost lowers priority)', () => {
    // value 10 (benefit) + cost 1 (inverted → 10): both contribute 10 ⇒ 10.0
    expect(computePriority(set, { value: 10, cost: 1 })).toBe(10);
    // value 10 + cost 10 (inverted → 1): (10*10 + 1*10)/20 = 5.5
    expect(computePriority(set, { value: 10, cost: 10 })).toBe(5.5);
  });

  it('returns 0 for an unscored idea', () => {
    expect(computePriority(set, {})).toBe(0);
  });
});

describe('computePriority — ratio (WSJF/RICE family)', () => {
  it('divides the benefit aggregate by the cost aggregate', () => {
    const wsjf = CRITERIA_PRESETS.wsjf; // 3 benefit (w1) + job-size (cost, w1)
    // benefits all 9 ⇒ benefitAgg 9; job-size 3 ⇒ costAgg 3 ⇒ 9/3 = 3
    const p = computePriority(wsjf, { 'user-business-value': 9, 'time-criticality': 9, 'risk-reduction': 9, 'job-size': 3 });
    expect(p).toBe(3);
  });

  it('degrades to the benefit aggregate when there is no cost dimension', () => {
    const set: CriteriaSet = { aggregation: 'ratio', criteria: [{ id: 'v', name: 'V', weight: 1, direction: 'benefit' }] };
    expect(computePriority(set, { v: 7 })).toBe(7);
  });
});
