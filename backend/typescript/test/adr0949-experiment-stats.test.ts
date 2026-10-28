/**
 * ADR 0949 P0 — golden tests for `host/experiments/stats.ts`.
 *
 * Every expected value comes from a published table or paper, or from an
 * independent computation recorded next to it (Python `math`, the formulas
 * transcribed from the cited paper), never from this module's own output.
 *
 *   - Normal quantiles/CDF: standard tables (Φ⁻¹(0.975) = 1.959963984540054…).
 *   - Chi-square critical values: standard tables (χ²₀.₉₅,₁ = 3.841458820694124…).
 *   - Benjamini & Hochberg (1995), §4 example: 15 p-values, q = 0.05 → 4 rejections
 *     (Bonferroni rejects 3).
 *   - mSPRT: Johari, Pekelis & Walsh (arXiv:1512.04922), Appendix E eqs. (30), (37),
 *     closed form for H = N(0, τ²); reference values computed independently.
 *   - CUPED: Deng, Xu, Kohavi & Walker (WSDM 2013) eqs. (4), (5); a 12-unit dataset
 *     computed independently from the per-unit rows.
 *   - Power: Fleiss pooled-null sample size; p 0.10 → 0.12, α 0.05, power 0.8 →
 *     3,841 per arm (the commonly published value).
 *
 * Sabotage (run 2026-10-20): flipping the confidence-sequence sign of ln α,
 * dropping the BH step-up (using p ≤ q/m), and using `observed.length` as the
 * SRM degrees of freedom each red the named case.
 */
import { describe, expect, it } from 'vitest';
import {
  alwaysValidPValue, benjaminiHochberg, chiSquareSurvival, cuped, defaultMixingVariance, minimumDetectableEffect,
  msprtDifference, msprtProportions, normalCdf, normalQuantile, sampleRatioMismatch, sampleSizePerArm,
} from '../src/host/experiments/stats.js';

describe('special functions against standard tables', () => {
  it('normal quantile', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 12);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536269514722, 12);
    expect(normalQuantile(0.99)).toBeCloseTo(2.3263478740408408, 12);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 12);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959963984540054, 12);
    expect(normalQuantile(1e-10)).toBeCloseTo(-6.361340902404056, 9);
  });
  it('normal CDF', () => {
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316300957, 14);
  });
  it('chi-square survival at tabled critical values', () => {
    expect(chiSquareSurvival(3.841458820694124, 1)).toBeCloseTo(0.05, 12);
    expect(chiSquareSurvival(5.991464547107979, 2)).toBeCloseTo(0.05, 12);
    expect(chiSquareSurvival(7.814727903251178, 3)).toBeCloseTo(0.05, 12);
    expect(chiSquareSurvival(16.918977604620448, 9)).toBeCloseTo(0.05, 12);
    expect(chiSquareSurvival(10.827566170662733, 1)).toBeCloseTo(0.001, 13);
  });
});

describe('Benjamini–Hochberg (1995) §4 example', () => {
  const P = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.3240, 0.4262, 0.5719, 0.6528, 0.7590, 1.000];
  it('rejects the four smallest at q = 0.05 (Bonferroni would reject three)', () => {
    const r = benjaminiHochberg(P, 0.05);
    expect(r.rejections).toBe(4);
    expect(r.rejected.slice(0, 5)).toEqual([true, true, true, true, false]);
    expect(P.filter((p) => p <= 0.05 / P.length)).toHaveLength(3);
  });
  it('adjusted p-values are monotone and order-independent', () => {
    const shuffled = [...P].reverse();
    const r = benjaminiHochberg(shuffled, 0.05);
    expect(r.rejections).toBe(4);
    // q-value of p = 0.0095 (rank 4): min over ranks ≥ 4 of p·15/rank = 0.035625
    expect(r.adjusted[shuffled.indexOf(0.0095)]).toBeCloseTo(0.035625, 12);
    expect(r.adjusted[shuffled.indexOf(1.0)]).toBe(1);
  });
});

describe('sample ratio mismatch', () => {
  it('a 50/50 test with 50,000 vs 51,500 is a mismatch; 50,000 vs 51,000 is not at p < 0.001', () => {
    const bad = sampleRatioMismatch([50_000, 51_500], [50, 50]);
    expect(bad?.chiSquare).toBeCloseTo(22.167487684729064, 9);
    expect(bad?.pValue).toBeCloseTo(2.4986952146786022e-6, 15);
    expect(bad?.mismatch).toBe(true);
    const ok = sampleRatioMismatch([50_000, 51_000], [1, 1]);
    expect(ok?.pValue).toBeCloseTo(0.001651898732357364, 12);
    expect(ok?.mismatch).toBe(false);
  });
  it('uses k − 1 degrees of freedom and the configured weights', () => {
    const r = sampleRatioMismatch([1000, 2000, 1000], [25, 50, 25]);
    expect(r).toMatchObject({ degreesOfFreedom: 2, chiSquare: 0, mismatch: false });
    expect(sampleRatioMismatch([10], [100])).toBeNull();
    expect(sampleRatioMismatch([0, 0], [50, 50])).toBeNull();
  });
});

describe('mSPRT (Johari et al., normal mixture)', () => {
  const opts = { tau2: defaultMixingVariance(0.01), alpha: 0.05 };
  it('matches the independent closed-form reference for two proportions', () => {
    const r = msprtProportions(500, 10_000, 560, 10_000, opts);
    expect(r?.delta).toBeCloseTo(0.006, 15);
    expect(r?.variance).toBeCloseTo(1.00364e-5, 15);
    expect(r?.likelihoodRatio).toBeCloseTo(1.5412490545040896, 12);
    expect(r?.pValue).toBeCloseTo(0.6488244045163478, 12);
    expect(r?.confidenceSequence[0]).toBeCloseTo(-0.0036235671248928663, 12);
    expect(r?.confidenceSequence[1]).toBeCloseTo(0.015623567124892863, 12);
    expect(r?.reject).toBe(false);
  });
  it('is more conservative than a peeked fixed-horizon z at the same data', () => {
    // The fixed-horizon z here is 1.89 (p ≈ 0.058); the always-valid p is far larger.
    const r = msprtProportions(500, 10_000, 560, 10_000, opts);
    expect((r?.pValue ?? 0) > 0.5).toBe(true);
  });
  it('rejects exactly when Λ crosses 1/α, and the confidence sequence then excludes 0', () => {
    const r = msprtDifference(0.02, 1e-5, opts);
    expect(r.reject).toBe(r.likelihoodRatio >= 1 / opts.alpha);
    expect(r.reject).toBe(true);
    expect(r.confidenceSequence[0]).toBeGreaterThan(0);
  });
  it('the running minimum makes the p-value monotone', () => {
    expect(alwaysValidPValue(undefined, 0.4)).toBe(0.4);
    expect(alwaysValidPValue(0.2, 0.4)).toBe(0.2);
  });
});

describe('CUPED (Deng et al. 2013)', () => {
  it('matches the independent per-unit computation', () => {
    const r = cuped([
      { n: 6, sumY: 70, sumY2: 840, sumX: 62, sumX2: 674, sumXY: 751 },
      { n: 6, sumY: 90, sumY2: 1378, sumX: 63, sumX2: 703, sumXY: 979 },
    ]);
    expect(r?.theta).toBeCloseTo(0.8240534521158128, 12);
    expect(r?.varianceReduction).toBeCloseTo(0.9899343418274374, 12);
    expect(r?.arms[0]?.adjustedMean).toBeCloseTo(11.735337787676317, 12);
    expect(r?.arms[1]?.adjustedMean).toBeCloseTo(14.931328878990348, 12);
    expect(r?.arms[0]?.adjustedVariance ?? Infinity).toBeLessThan(r?.arms[0]?.variance ?? 0);
  });
  it('returns null when the covariate cannot reduce variance', () => {
    expect(cuped([{ n: 3, sumY: 6, sumY2: 14, sumX: 3, sumX2: 3, sumXY: 6 }, { n: 3, sumY: 6, sumY2: 14, sumX: 3, sumX2: 3, sumXY: 6 }])).toBeNull();
  });
});

describe('power', () => {
  it('0.10 → 0.12 at α 0.05, power 0.8 needs 3,841 per arm', () => {
    expect(sampleSizePerArm(0.10, 0.02, { alpha: 0.05, power: 0.8 })).toBe(3841);
  });
  it('the MDE solver inverts the sample size', () => {
    expect(minimumDetectableEffect(0.10, 3841, { alpha: 0.05, power: 0.8 })).toBeCloseTo(0.02, 4);
  });
});
