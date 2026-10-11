/**
 * ADR 0667 D1 (PMXWF-7 / PMXWF-12) — the ratio lane stops ranking absence above
 * estimation, and completeness is carried rather than collapsed into the `0`
 * sentinel.
 *
 * Born red on the pre-ADR engine: leg 1 measured `partial 6.67 > complete 6.00`
 * (the partially-scored idea ranked #1), `scoreCompleteness` did not exist, and
 * `rankByPriority` took no options argument.
 *
 * Sabotage-witnessed (grade-tests w15): removing completeness segregation, the
 * majority bound, the default-OFF guard, the `> 0` scored test, the `complete`
 * predicate or the `missing` ids each red a leg. D1c (the agent tool's
 * `unscored`/`partiallyScored` projection) lives in priority-matrix-agent-tools
 * ("D1c — on a WSJF list …"), which drives the REAL tool; the local rebuild of
 * that projection here could not fail and was cut.
 */
import { describe, expect, it } from 'vitest';
import { computePriority, rankByPriority, scoreCompleteness } from '../src/host/weightedScoring.js';
import type { CriteriaSet } from '../src/host/weightedScoring.js';

const WSJF: CriteriaSet = {
  presetId: 'wsjf',
  aggregation: 'ratio',
  criteria: [
    { id: 'value', name: 'Value', weight: 1, direction: 'benefit' },
    { id: 'time', name: 'Time criticality', weight: 1, direction: 'benefit' },
    { id: 'risk', name: 'Risk reduction', weight: 1, direction: 'benefit' },
    { id: 'job-size', name: 'Job size', weight: 1, direction: 'cost' },
  ],
};
const PARTIAL = { value: 10, time: 10, 'job-size': 1 };          // 3 of 4 — risk blank
const COMPLETE = { value: 6, time: 6, risk: 6, 'job-size': 1 };  // 4 of 4

describe('ADR 0667 D1 — completeness is first-class', () => {
  it('leg 1 (PMXWF-7): a partially-scored idea NEVER outranks a fully-scored one', () => {
    // The raw priorities are unchanged by this ADR — the partial one is still the
    // larger NUMBER. What changes is that it no longer wins the ORDER.
    expect(computePriority(WSJF, PARTIAL)).toBeGreaterThan(computePriority(WSJF, COMPLETE));

    const items = [{ id: 'partial', s: PARTIAL }, { id: 'complete1', s: COMPLETE }, { id: 'complete2', s: COMPLETE }];
    const ranked = rankByPriority(WSJF, items, (i) => i.s, { completenessMajor: true });
    expect(ranked.find((r) => r.item.id === 'partial')!.rank,
      'the 3-of-4 idea must rank BELOW both complete ideas despite its higher score').toBe(3);
  });

  it('leg 2: the bound — completeness-major does NOT apply when complete items are a minority', () => {
    // CORRECTED (grade-tests w15): this leg used ONE complete item among five, which BOTH
    // guards refuse (1 < MIN_COMPLETE_COHORT, and 1 is not a majority), so removing either
    // guard alone left it green. Two complete of five passes the cohort size and fails ONLY
    // the majority test — so removing the majority clause pins them to #1/#2 and reds this.
    //
    // Ceiling, recorded for grade-code: MIN_COMPLETE_COHORT is unreachable logic. With
    // completeCount = 1 the majority test already requires a list of one, where order is
    // moot — so the cohort bound can never change an output and no fixture can witness it.
    const weak = { value: 1, time: 1, risk: 1, 'job-size': 10 };
    const items = [
      { id: 'weak-complete-1', s: weak }, { id: 'weak-complete-2', s: weak },
      { id: 'p1', s: PARTIAL }, { id: 'p2', s: PARTIAL }, { id: 'p3', s: PARTIAL },
    ];
    const ranked = rankByPriority(WSJF, items, (i) => i.s, { completenessMajor: true });
    expect(ranked.filter((r) => r.item.id.startsWith('weak-complete')).map((r) => r.rank),
      'a weak complete MINORITY stays priority-ordered (last), not pinned to the top').toEqual([4, 5]);
  });

  it('leg 3: the default is byte-identical to today, on a fixture where the bound does NOT mask it', () => {
    // CORRECTED after sabotage: the first version of this leg used 1 complete item of 2,
    // so D1b's cohort bound suppressed segregation whatever the default was — flipping the
    // default ON did NOT turn it red. A witness that cannot fail is not a witness.
    //
    // The real recommendations harm is the ANCHORED case: `catScore` is
    // `Math.min(10, (overlap(cats) + overlap(tags)) * 5)`, which is 0 for a candidate with
    // no overlap (recommendationsService.ts:416). So a zero-overlap candidate reads as
    // "incomplete" beside overlapping ones, and with a majority overlapping, a global flip
    // would demote it below ALL of them however strong its affinity and recency are.
    const SET: CriteriaSet = { aggregation: 'weighted-sum', criteria: [
      { id: 'affinity', name: 'a', weight: 1, direction: 'benefit' },
      { id: 'categoryMatch', name: 'c', weight: 1, direction: 'benefit' },
      { id: 'recency', name: 'r', weight: 1, direction: 'benefit' },
    ] };
    const items = [
      { id: 'no-overlap-strong', s: { affinity: 10, categoryMatch: 0, recency: 10 } }, // incomplete, priority 6.67
      { id: 'overlap-weak-1', s: { affinity: 2, categoryMatch: 1, recency: 2 } },      // complete,   priority 1.67
      { id: 'overlap-weak-2', s: { affinity: 2, categoryMatch: 1, recency: 2 } },      // complete,   priority 1.67
    ];
    // 2 complete of 3 satisfies MIN_COMPLETE_COHORT and the majority test, so segregation
    // WOULD engage here if the default were ON — which is exactly what makes this leg bite.
    const withDefault = rankByPriority(SET, items, (i) => i.s).map((r) => r.item.id);
    const explicitOff = rankByPriority(SET, items, (i) => i.s, { completenessMajor: false }).map((r) => r.item.id);
    expect(withDefault).toEqual(explicitOff);
    expect(withDefault[0],
      'the zero-overlap candidate keeps its earned #1 under the default; a global flip would bury it').toBe('no-overlap-strong');
    // And prove the opt-in genuinely WOULD move it — otherwise the leg above is vacuous.
    const optedIn = rankByPriority(SET, items, (i) => i.s, { completenessMajor: true }).map((r) => r.item.id);
    expect(optedIn[0]).not.toBe('no-overlap-strong');
  });

  it('leg 4 (PMXWF-12): the overloaded `0` is split — 3-of-4-scored is NOT "unscored"', () => {
    const blankCost = { value: 10, time: 10, risk: 10 };            // scored, blank job-size
    expect(computePriority(WSJF, blankCost), 'the engine still returns 0 here').toBe(0);
    expect(computePriority(WSJF, {}), 'and 0 for a never-touched idea too').toBe(0);
    // ...so the NUMBER cannot tell them apart. Completeness can:
    expect(scoreCompleteness(WSJF, blankCost)).toMatchObject({ declared: 4, scored: 3, complete: false });
    expect(scoreCompleteness(WSJF, {})).toMatchObject({ declared: 4, scored: 0, complete: false });
    expect(scoreCompleteness(WSJF, blankCost).missing).toEqual(['job-size']);
    expect(scoreCompleteness(WSJF, COMPLETE)).toMatchObject({ declared: 4, scored: 4, complete: true });
  });

  it('leg 5: `scored` means > 0 — a literal 0 is NOT a score (quadrant.ts accepts it; the engine must not)', () => {
    const SET: CriteriaSet = { aggregation: 'weighted-sum', criteria: [
      { id: 'a', name: 'a', weight: 1, direction: 'benefit' },
      { id: 'b', name: 'b', weight: 1, direction: 'benefit' },
    ] };
    expect(scoreCompleteness(SET, { a: 5, b: 0 }).scored).toBe(1);
    expect(scoreCompleteness(SET, { a: 5, b: Number.NaN }).scored).toBe(1);
    expect(scoreCompleteness(SET, { a: 5, b: -3 }).scored).toBe(1);
  });
});
