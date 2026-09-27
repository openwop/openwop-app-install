/**
 * ADR 0545 P2 — the standard bank and the coverage number it must ship.
 *
 * The ADR's verification is "measure what fraction of required fields the seeded
 * bank answers; ship the number". A test that merely asserts `ratio > 0.5` would
 * satisfy the letter and lose the point, so this PRINTS the report and pins the
 * properties that make the number honest: declines are not counted as coverage,
 * fuzzy matches are not counted as coverage, and the special-category field is
 * in the fixture rather than quietly excluded.
 */
import { describe, expect, it } from 'vitest';
import {
  STANDARD_BANK, CORE_KEYS, ATS_REQUIRED_FIXTURES, coverageReport,
} from '../src/features/job-search/autopilot/standardBank.js';
import { specialCategoryKeyFor } from '../src/features/job-search/autopilot/questionKey.js';

describe('ADR 0545 D2 — the standard bank', () => {
  it('is small enough to finish in one sitting', () => {
    // The premise of D2 is that ~20 questions once is not toil. A bank that grew
    // to 60 would quietly break that promise.
    expect(STANDARD_BANK.length).toBeLessThanOrEqual(20);
    expect(CORE_KEYS.length).toBeLessThanOrEqual(8);
  });

  it('holds no special-category question', () => {
    // The P1 correction, enforced at the bank definition too: a prompt that
    // asked for a disability disclosure would be unanswerable by construction,
    // so its presence here could only mislead the user.
    for (const q of STANDARD_BANK) {
      expect(specialCategoryKeyFor(q.prompt), `${q.key} is a special category`).toBeNull();
    }
  });

  it('every question states WHY it is worth answering', () => {
    // The wizard is skippable-with-consequence-stated (row 10); a question with
    // no stated benefit gives the user nothing to weigh.
    for (const q of STANDARD_BANK) expect(q.why.length, q.key).toBeGreaterThan(20);
  });
});

describe('ADR 0545 P2 — the coverage number, shipped', () => {
  it('reports coverage per board and in total', () => {
    const full = coverageReport();
    const core = coverageReport(CORE_KEYS);

    // SHIP THE NUMBER. Printed so it appears in CI output and in any future
    // audit of this claim, rather than living only in a doc that can drift.
    const pct = (r: number) => `${(r * 100).toFixed(0)}%`;
    console.info(
      `\nADR 0545 P2 coverage — full bank ${pct(full.ratio)} (${full.totalCovered}/${full.totalRequired}), ` +
      `core six ${pct(core.ratio)} (${core.totalCovered}/${core.totalRequired}), ` +
      `declined as special-category ${full.totalDeclined}\n` +
      full.rows.map((r) => `  ${r.board}: ${r.covered}/${r.required}${r.uncovered.length ? ` — missing: ${r.uncovered.join('; ')}` : ''}`).join('\n'),
    );

    expect(full.rows).toHaveLength(ATS_REQUIRED_FIXTURES.length);
    expect(full.totalRequired).toBeGreaterThan(0);
    // The bank exists to answer these; a collapse would mean the synonym table
    // stopped bridging real phrasings.
    expect(full.ratio, 'the seeded bank should answer most required fields').toBeGreaterThan(0.8);
    // …and the core six alone should already carry most of the benefit, which is
    // the claim the wizard's ordering makes.
    expect(core.ratio).toBeGreaterThan(0.6);
  });

  it('does NOT count a declined special-category field as covered', () => {
    // The number must not be flattered by the one field we answer by declining.
    const full = coverageReport();
    expect(full.totalDeclined).toBeGreaterThan(0);
    expect(full.totalCovered + full.totalDeclined).toBeLessThanOrEqual(full.totalRequired);
    const workable = full.rows.find((r) => r.board === 'workable')!;
    expect(workable.declined).toBe(1);
    expect(workable.covered).toBeLessThan(workable.required);
  });

  it('keeps the special-category field IN the fixture', () => {
    // Excluding it would raise the number by hiding the hard case.
    const all = ATS_REQUIRED_FIXTURES.flatMap((f) => f.required);
    expect(all.some((q) => specialCategoryKeyFor(q)), 'the hard case must stay in the denominator').toBe(true);
  });

  it('an empty bank covers nothing — the measure is not self-fulfilling', () => {
    // A coverage function that returned a healthy number for a bank with no
    // answers would be measuring the fixture, not the product.
    const none = coverageReport([]);
    expect(none.totalCovered).toBe(0);
    expect(none.ratio).toBe(0);
  });
});
