/**
 * ADR 0667 D2 (PMXWF-8) — the RICE preset computes RICE.
 *
 * Born red: `rice` was `aggregation:'ratio'` (a weighted MEAN of the benefits), which
 * inverts the published ordering — {10,10,2}/1 scored 7.33 and beat {6,6,6}/1 at 6.00
 * while true RICE ranks them 200 < 216 — and `product-ratio` did not exist.
 */
import { describe, expect, it } from 'vitest';
import { computePriority, type CriteriaSet } from '../src/host/weightedScoring.js';
import { CRITERIA_PRESETS } from '../src/features/priority-matrix/types.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createList, getList, updateList } from '../src/features/priority-matrix/priorityMatrixService.js';

const RICE = CRITERIA_PRESETS.rice;
const trueRice = (s: Record<string, number>): number => (s.reach * s.impact * s.confidence) / s.effort;
const CASES: Array<Record<string, number>> = [
  { reach: 10, impact: 10, confidence: 2, effort: 1 },
  { reach: 6, impact: 6, confidence: 6, effort: 1 },
  { reach: 10, impact: 10, confidence: 10, effort: 10 },
  { reach: 5, impact: 5, confidence: 5, effort: 2 },
];
const orderOf = (score: (s: Record<string, number>) => number): number[] =>
  CASES.map((s, i) => ({ i, v: score(s) })).sort((a, b) => b.v - a.v).map((x) => x.i);

describe('ADR 0667 D2 — RICE fidelity', () => {
  it('leg 1: the preset is multiplicative and its ORDER equals published RICE', () => {
    expect(RICE.aggregation).toBe('product-ratio');
    expect(orderOf((s) => computePriority(RICE, s))).toEqual(orderOf(trueRice));
  });

  it('leg 2: the OLD mean-based model really did invert it (so leg 1 is not vacuous)', () => {
    const asRatio: CriteriaSet = { ...RICE, aggregation: 'ratio' };
    expect(orderOf((s) => computePriority(asRatio, s))).not.toEqual(orderOf(trueRice));
  });

  it('leg 3: the value stays in the familiar band — a raw product would not', () => {
    const max = computePriority(RICE, { reach: 10, impact: 10, confidence: 10, effort: 1 });
    expect(max).toBeLessThanOrEqual(10);
    expect(max).toBeGreaterThan(0);
    // A 20-criterion set at weight 10 is the pathological case the raw product blows up on
    // (10^190). `computedPriority` is rendered into a KB doc advisory boards retrieve.
    const wide: CriteriaSet = { aggregation: 'product-ratio', criteria: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: `c${i}`, weight: 10, direction: 'benefit' as const })) };
    const wideScores = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, 10]));
    expect(computePriority(wide, wideScores)).toBeLessThanOrEqual(10);
  });

  it('leg 4: degenerate inputs are finite and never the overloaded 0 sentinel', () => {
    // An unscored BENEFIT must not zero the numerator (that is D1's sentinel, as arithmetic).
    expect(computePriority(RICE, { reach: 10, impact: 10, effort: 1 })).toBeGreaterThan(0);
    // An unscored COST must not divide by zero (JSON.stringify writes Infinity as null).
    const noCost = computePriority(RICE, { reach: 10, impact: 10, confidence: 10 });
    expect(Number.isFinite(noCost)).toBe(true);
    expect(noCost).toBeGreaterThan(0);
    // Nothing scored at all is honestly 0 — there is nothing to rank on.
    expect(computePriority(RICE, {})).toBe(0);
  });

  it('leg 5: a pre-existing rice+ratio list migrates on read, and SURVIVES an edit', async () => {
    const storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    const created = await createList('tRice', 'org-1', 'u1', { name: 'R', presetId: 'rice' });
    // Simulate a list stored BEFORE this ADR: force the old aggregation onto the row.
    const rows = new DurableCollection<{ tenantId: string; id: string; criteriaSet: CriteriaSet }>('priority-matrix:list', (l) => `${l.tenantId}::${l.id}`);
    const raw = await rows.get(`tRice::${created.id}`);
    expect(raw, 'the row must exist for this leg to mean anything').toBeTruthy();
    await rows.put({ ...(raw as { tenantId: string; id: string; criteriaSet: CriteriaSet }), criteriaSet: { ...RICE, aggregation: 'ratio' } });
    expect((await rows.get(`tRice::${created.id}`))?.criteriaSet.aggregation, 'the stored row is the OLD shape').toBe('ratio');

    const read = await getList('tRice', created.id);
    expect(read?.criteriaSet.aggregation, 'reads normalise it').toBe('product-ratio');

    // The regression the binary coercion in `validateCriteriaSet` would have caused.
    // CORRECTED after sabotage: this first submitted `{ name: 'Renamed' }`, which does
    // NOT reach the coercion — `updateList` only calls `resolveCriteriaInput` when the
    // body carries `criteriaSet` or `presetId` (priorityMatrixService.ts:332), so
    // restoring the binary coercion left the leg GREEN. The settings form round-trips
    // the whole criteria set, which is the path that actually bites.
    const roundTripped = await updateList('tRice', created.id, {
      name: 'Renamed',
      criteriaSet: { ...read!.criteriaSet },
    }, 'u1');
    expect(roundTripped.criteriaSet.aggregation,
      'a settings-form round-trip must not coerce it to a DIFFERENT family').toBe('product-ratio');
    // And it must be durable, not just echoed back by the writer.
    expect((await getList('tRice', created.id))?.criteriaSet.aggregation).toBe('product-ratio');
  });
});
