/**
 * Priority Matrix scoring engine (ADR 0058) — pure unit tests for the two
 * aggregation modes + cost-direction inversion + ranking.
 */
import { describe, expect, it } from 'vitest';
import { computePriority, rankByPriority } from '../src/features/priority-matrix/scoring.js';
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

describe('rankByPriority', () => {
  it('orders items by priority descending and assigns 1-based ranks', () => {
    const set = CRITERIA_PRESETS.weighted;
    const items = [
      { id: 'lo', s: { roi: 1, 'strategic-alignment': 1, urgency: 1, 'compliance-risk': 1, cost: 10 } },
      { id: 'hi', s: { roi: 10, 'strategic-alignment': 10, urgency: 10, 'compliance-risk': 10, cost: 1 } },
    ];
    const ranked = rankByPriority(set, items, (i) => i.s);
    expect(ranked[0].item.id).toBe('hi');
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].item.id).toBe('lo');
    expect(ranked[0].priority).toBeGreaterThan(ranked[1].priority);
  });
});
