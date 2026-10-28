/**
 * ADR 0949 D4 / P0 — the experiment statistics, as a pure deterministic service.
 *
 * Counts in, numbers out: no I/O, no clock, no randomness, so a verdict
 * recomputed on replay is the same verdict. Every routine here has a golden test
 * against a published reference value (`test/adr0949-experiment-stats.test.ts`).
 *
 *   - Always-valid sequential inference: the mixture sequential probability
 *     ratio test (mSPRT) with a normal mixture, in the two-stream CLT form of
 *     Johari, Pekelis & Walsh, "Always Valid Inference: Bringing Sequential
 *     Analysis to A/B Testing" (arXiv:1512.04922; Operations Research 70(3),
 *     2022), Appendix E eqs. (30) and (37). The p-value and the confidence
 *     sequence may be read at any time without inflating the error rate.
 *   - False discovery rate: Benjamini & Hochberg (1995), JRSS-B 57(1):289–300.
 *   - Sample ratio mismatch: Pearson chi-square goodness of fit of observed
 *     allocation against configured weights.
 *   - CUPED: Deng, Xu, Kohavi & Walker, "Improving the Sensitivity of Online
 *     Controlled Experiments by Utilizing Pre-Experiment Data", WSDM 2013,
 *     eqs. (4), (5) and (7).
 *   - Power: the two-proportion sample size with a pooled-variance null
 *     (Fleiss, Statistical Methods for Rates and Proportions, without the
 *     continuity correction).
 *
 * The special functions (normal CDF and quantile, regularized incomplete gamma)
 * are implemented here rather than imported: the backend has no numerical
 * library, and a dependency for four functions is not worth its supply chain.
 */

// ── Special functions ──────────────────────────────────────────────────────

const EPS = 1e-15;
const MAX_ITER = 500;

/** ln Γ(x), Lanczos approximation (g = 7, n = 9); |error| < 1e-15 for x > 0. */
export function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xm = x - 1;
  let a = c[0]!;
  const t = xm + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(a, x) by its series (use when x < a + 1). */
function gammaPSeries(a: number, x: number): number {
  let sum = 1 / a;
  let term = sum;
  for (let n = 1; n < MAX_ITER; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Regularized upper incomplete gamma Q(a, x) by its continued fraction
 *  (modified Lentz; use when x >= a + 1). */
function gammaQContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  return x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQContinuedFraction(a, x);
}

/** Upper tail of the chi-square distribution with `df` degrees of freedom. */
export function chiSquareSurvival(x: number, df: number): number {
  if (!(df > 0)) throw new RangeError('chiSquareSurvival: df must be positive');
  return gammaQ(df / 2, x / 2);
}

/** Standard normal CDF Φ(x), through erfc(t) = Q(1/2, t²) (full double precision). */
export function normalCdf(x: number): number {
  if (x === 0) return 0.5;
  const tail = 0.5 * gammaQ(0.5, (x * x) / 2); // P(Z > |x|)
  return x > 0 ? 1 - tail : tail;
}

/** Standard normal quantile Φ⁻¹(p): Wichura, Algorithm AS 241 (PPND16),
 *  Applied Statistics 37(3), 1988; relative accuracy about 1e-16. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('normalQuantile: p must be in (0, 1)');
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return q * (((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r
      + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r + 133.14166789178437745) * r
      + 3.387132872796366608)
      / (((((((5226.495278852545925 * r + 28729.085735721942674) * r + 39307.89580009271061) * r
      + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r + 42.313330701600911252) * r + 1);
  }
  let r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let val: number;
  if (r <= 5) {
    r -= 1.6;
    val = (((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) * r
      + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r + 4.6303378461565452959) * r
      + 1.42343711074968357734)
      / (((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r
      + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r + 2.05319162663775882187) * r + 1);
  } else {
    r -= 5;
    val = (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r
      + 0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r + 5.4637849111641143699) * r
      + 6.6579046435011037772)
      / (((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r
      + 7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r + 0.59983220655588793769) * r + 1);
  }
  return q < 0 ? -val : val;
}

// ── mSPRT: always-valid p-values and confidence sequences ──────────────────

export interface MsprtResult {
  /** Treatment minus control. */
  delta: number;
  /** The variance of `delta` the test used (eq. 30 for proportions). */
  variance: number;
  /** The mixture likelihood ratio Λ̃ₙ (eq. 37) with H = N(0, τ²). */
  likelihoodRatio: number;
  /** min(1, 1/Λ̃ₙ). Valid at THIS look; carry the running minimum across looks
   *  (`alwaysValidPValue`) for the monotone always-valid p-value of Proposition 1. */
  pValue: number;
  /** Always-valid (1 − α) confidence sequence for `delta`. */
  confidenceSequence: [number, number];
  /** Λ̃ₙ ≥ 1/α: reject H0 (no difference) at level α, at any stopping time. */
  reject: boolean;
}

export interface MsprtOptions {
  /** The mixing variance τ² of H = N(0, τ²), on the scale of `delta`. Johari et
   *  al. (Prop. 5) recommend matching it to the prior on effects; see
   *  `defaultMixingVariance`. */
  tau2: number;
  /** Type I error level α. */
  alpha: number;
}

/**
 * Normal-mixture mSPRT for a difference of two means whose estimate is
 * approximately N(δ, V). Integrating N(θ, V) against H = N(0, τ²) gives
 *   Λ̃ = sqrt(V / (V + τ²)) · exp(δ² τ² / (2 V (V + τ²))),
 * and inverting Λ̃ ≥ 1/α gives the confidence sequence half-width
 *   sqrt( V (V + τ²) / τ² · (ln((V + τ²)/V) − 2 ln α) ).
 */
export function msprtDifference(delta: number, variance: number, opts: MsprtOptions): MsprtResult {
  const { tau2, alpha } = opts;
  if (!(tau2 > 0)) throw new RangeError('msprt: tau2 must be positive');
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('msprt: alpha must be in (0, 1)');
  if (!(variance > 0)) {
    return { delta, variance, likelihoodRatio: 1, pValue: 1, confidenceSequence: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY], reject: false };
  }
  const s = variance + tau2;
  const logLambda = 0.5 * Math.log(variance / s) + (delta * delta * tau2) / (2 * variance * s);
  const likelihoodRatio = Math.exp(logLambda);
  const halfWidth = Math.sqrt(((variance * s) / tau2) * (Math.log(s / variance) - 2 * Math.log(alpha)));
  return {
    delta,
    variance,
    likelihoodRatio,
    pValue: Math.min(1, Math.exp(-logLambda)),
    confidenceSequence: [delta - halfWidth, delta + halfWidth],
    reject: logLambda >= -Math.log(alpha),
  };
}

/** mSPRT for two conversion rates (Johari et al., Appendix E, eq. 30 for V̂ₙ). */
export function msprtProportions(conversionsA: number, unitsA: number, conversionsB: number, unitsB: number, opts: MsprtOptions): MsprtResult | null {
  if (unitsA <= 0 || unitsB <= 0) return null;
  const pa = conversionsA / unitsA;
  const pb = conversionsB / unitsB;
  const variance = (pa * (1 - pa)) / unitsA + (pb * (1 - pb)) / unitsB;
  return msprtDifference(pb - pa, variance, opts);
}

/** Proposition 1's monotone always-valid p-value: the running minimum. */
export function alwaysValidPValue(previous: number | undefined, current: number): number {
  return previous === undefined ? current : Math.min(previous, current);
}

/** A mixing variance matched to the effect the test is powered for (τ = MDE). */
export function defaultMixingVariance(minimumDetectableEffect: number): number {
  if (!(minimumDetectableEffect > 0)) throw new RangeError('defaultMixingVariance: mde must be positive');
  return minimumDetectableEffect * minimumDetectableEffect;
}

// ── Benjamini–Hochberg ─────────────────────────────────────────────────────

export interface BhResult {
  /** BH-adjusted p-values (q-values), in input order. */
  adjusted: number[];
  /** Rejected at level q, in input order. */
  rejected: boolean[];
  /** How many hypotheses are rejected. */
  rejections: number;
}

/** Benjamini & Hochberg (1995) step-up procedure at FDR level `q`. */
export function benjaminiHochberg(pValues: readonly number[], q: number): BhResult {
  if (!(q > 0 && q < 1)) throw new RangeError('benjaminiHochberg: q must be in (0, 1)');
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  let k = 0;
  order.forEach((o, rank) => { if (o.p <= ((rank + 1) * q) / m) k = rank + 1; });
  const adjusted = new Array<number>(m).fill(1);
  let running = 1;
  for (let rank = m - 1; rank >= 0; rank--) {
    const o = order[rank]!;
    running = Math.min(running, (o.p * m) / (rank + 1));
    adjusted[o.i] = Math.min(1, running);
  }
  const rejected = new Array<boolean>(m).fill(false);
  for (let rank = 0; rank < k; rank++) rejected[order[rank]!.i] = true;
  return { adjusted, rejected, rejections: k };
}

// ── Sample ratio mismatch ──────────────────────────────────────────────────

/** The default SRM alarm: p < 0.001 (ADR 0949 D2). */
export const SRM_ALPHA = 0.001;

export interface SrmResult {
  chiSquare: number;
  degreesOfFreedom: number;
  pValue: number;
  expected: number[];
  /** p < `alpha`: the observed split does not match the configured weights. */
  mismatch: boolean;
}

/** Pearson chi-square test of observed counts per arm against configured
 *  weights (any positive scale). Null when there is nothing to test. */
export function sampleRatioMismatch(observed: readonly number[], weights: readonly number[], alpha = SRM_ALPHA): SrmResult | null {
  if (observed.length !== weights.length || observed.length < 2) return null;
  const total = observed.reduce((a, b) => a + b, 0);
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || !(wsum > 0) || weights.some((w) => !(w > 0))) return null;
  const expected = weights.map((w) => (total * w) / wsum);
  const chiSquare = observed.reduce((acc, o, i) => acc + ((o - expected[i]!) ** 2) / expected[i]!, 0);
  const degreesOfFreedom = observed.length - 1;
  const pValue = chiSquareSurvival(chiSquare, degreesOfFreedom);
  return { chiSquare, degreesOfFreedom, pValue, expected, mismatch: pValue < alpha };
}

// ── CUPED ──────────────────────────────────────────────────────────────────

/** Per-arm sufficient statistics over units that HAVE the pre-period covariate. */
export interface CupedArmStats {
  n: number;
  sumY: number;
  sumY2: number;
  sumX: number;
  sumX2: number;
  sumXY: number;
}

export interface CupedResult {
  /** θ = cov(Y, X) / var(X), pooled across arms (Deng et al. eq. 4). */
  theta: number;
  /** ρ² — the fraction of variance removed (eq. 5: var(Ŷcv) = var(Y)(1 − ρ²)). */
  varianceReduction: number;
  /** Per arm: the CUPED-adjusted mean Ȳ − θ(X̄ − X̄pooled) and its variance. */
  arms: Array<{ adjustedMean: number; adjustedVariance: number; mean: number; variance: number }>;
}

/**
 * CUPED with a pooled θ. Because the covariate is pre-period, E[X] is the same
 * in every arm, so subtracting θ(X̄ₐ − X̄) leaves each arm's mean unbiased and the
 * difference of adjusted means is the eq. (7) estimator. Returns null when the
 * covariate has no variance (no reduction is possible).
 */
export function cuped(arms: readonly CupedArmStats[]): CupedResult | null {
  const N = arms.reduce((a, s) => a + s.n, 0);
  if (arms.length < 2 || arms.some((s) => s.n < 2)) return null;
  const sx = arms.reduce((a, s) => a + s.sumX, 0);
  // Pooled WITHIN-arm covariance and variances (the treatment shifts Y's mean;
  // pooling around each arm's own mean keeps that shift out of θ).
  let cxy = 0; let vx = 0; let vy = 0;
  for (const s of arms) {
    cxy += s.sumXY - (s.sumX * s.sumY) / s.n;
    vx += s.sumX2 - (s.sumX * s.sumX) / s.n;
    vy += s.sumY2 - (s.sumY * s.sumY) / s.n;
  }
  if (!(vx > 0) || !(vy > 0)) return null;
  const theta = cxy / vx;
  const rho2 = (cxy * cxy) / (vx * vy);
  const meanX = sx / N;
  return {
    theta,
    varianceReduction: rho2,
    arms: arms.map((s) => {
      const mean = s.sumY / s.n;
      const variance = (s.sumY2 - (s.sumY * s.sumY) / s.n) / (s.n - 1);
      const varX = (s.sumX2 - (s.sumX * s.sumX) / s.n) / (s.n - 1);
      const covXY = (s.sumXY - (s.sumX * s.sumY) / s.n) / (s.n - 1);
      return {
        mean,
        variance,
        adjustedMean: mean - theta * (s.sumX / s.n - meanX),
        adjustedVariance: variance + theta * theta * varX - 2 * theta * covXY,
      };
    }),
  };
}

// ── Power ──────────────────────────────────────────────────────────────────

export interface PowerOptions {
  alpha: number;
  power: number;
  /** Default true. */
  twoSided?: boolean;
}

/** Units per arm to detect `baseline` → `baseline + mde` (absolute) for two
 *  proportions, pooled-variance null, no continuity correction. */
export function sampleSizePerArm(baseline: number, mde: number, opts: PowerOptions): number {
  const p1 = baseline;
  const p2 = baseline + mde;
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1) || mde === 0) throw new RangeError('sampleSizePerArm: rates must be in (0, 1) and differ');
  const za = normalQuantile(1 - (opts.twoSided === false ? opts.alpha : opts.alpha / 2));
  const zb = normalQuantile(opts.power);
  const pbar = (p1 + p2) / 2;
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (mde * mde);
  return Math.ceil(n);
}

/** The smallest absolute lift detectable with `unitsPerArm` per arm (the
 *  inverse of `sampleSizePerArm`, by bisection on the same formula). */
export function minimumDetectableEffect(baseline: number, unitsPerArm: number, opts: PowerOptions): number {
  if (!(unitsPerArm > 0)) throw new RangeError('minimumDetectableEffect: unitsPerArm must be positive');
  const za = normalQuantile(1 - (opts.twoSided === false ? opts.alpha : opts.alpha / 2));
  const zb = normalQuantile(opts.power);
  const need = (d: number): number => {
    const p2 = baseline + d;
    const pbar = baseline + d / 2;
    return (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(baseline * (1 - baseline) + p2 * (1 - p2))) ** 2 / (d * d);
  };
  let lo = 1e-9;
  let hi = 1 - baseline - 1e-9;
  if (need(hi) > unitsPerArm) return Number.NaN; // not detectable at any lift
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (need(mid) > unitsPerArm) lo = mid; else hi = mid;
  }
  return hi;
}

// ── Thompson sampling (Optimize mode, ADR 0949 D2) ─────────────────────────
//
// Beta–Bernoulli posteriors Beta(1 + successes, 1 + failures) per arm. The Monte
// Carlo draws use a SEEDED generator (mulberry32), so the same counts and seed
// give the same weights on every run, replay and fork. Gamma variates by
// Marsaglia & Tsang (2000), "A Simple Method for Generating Gamma Variables",
// ACM TOMS 26(3); normals by Box–Muller; Beta(a, b) = X / (X + Y) with
// X ~ Gamma(a), Y ~ Gamma(b).

/** mulberry32: a 32-bit seeded PRNG, uniform on [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Gamma(shape, 1) for shape ≥ 1 (all Beta posteriors here have shape ≥ 1). */
function gamma(shape: number, rand: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number; let v: number;
    do { x = normal(rand); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export interface ThompsonArm { key: string; successes: number; trials: number }

export interface ThompsonResult {
  /** Integer percentages summing to 100, each at least `floorPct`. */
  weights: Record<string, number>;
  /** Share of draws in which each arm had the highest rate (a model estimate). */
  probabilityBest: Record<string, number>;
  /** Mean over draws of (best rate − this arm's rate): what choosing it costs, in rate. */
  expectedLoss: Record<string, number>;
  draws: number;
}

/** Largest-remainder rounding of non-negative shares to integers summing to 100. */
function toPercent(shares: Record<string, number>, keys: readonly string[]): Record<string, number> {
  const total = keys.reduce((s, k) => s + shares[k]!, 0) || 1;
  const raw = keys.map((k) => ({ k, v: (shares[k]! / total) * 100 }));
  const out: Record<string, number> = Object.fromEntries(raw.map(({ k, v }) => [k, Math.floor(v)]));
  let left = 100 - Object.values(out).reduce((s, v) => s + v, 0);
  for (const { k } of [...raw].sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)) || a.k.localeCompare(b.k))) {
    if (left <= 0) break;
    out[k]! += 1; left -= 1;
  }
  return out;
}

/**
 * The next allocation: probability-best per arm, then a floor of `floorPct` for
 * every arm (so none starves and every posterior keeps learning), as integer
 * percentages summing to 100. Deterministic for a given `seed`.
 */
export function thompsonWeights(arms: readonly ThompsonArm[], opts: { floorPct: number; seed: number; draws?: number }): ThompsonResult {
  const keys = arms.map((a) => a.key);
  const n = arms.length;
  const floor = Math.max(1, Math.min(Math.floor(100 / n), Math.round(opts.floorPct)));
  const draws = opts.draws ?? 10_000;
  const rand = seededRandom(opts.seed);
  const wins: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  const loss: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  const sample = new Array<number>(n);
  for (let d = 0; d < draws; d++) {
    let best = 0;
    for (let i = 0; i < n; i++) {
      const a = arms[i]!;
      const s = Math.max(0, a.successes);
      const f = Math.max(0, a.trials - a.successes);
      const x = gamma(1 + s, rand);
      const y = gamma(1 + f, rand);
      sample[i] = x / (x + y);
      if (sample[i]! > sample[best]!) best = i;
    }
    wins[keys[best]!]! += 1;
    for (let i = 0; i < n; i++) loss[keys[i]!]! += sample[best]! - sample[i]!;
  }
  const probabilityBest = Object.fromEntries(keys.map((k) => [k, wins[k]! / draws]));
  const expectedLoss = Object.fromEntries(keys.map((k) => [k, loss[k]! / draws]));
  // Floor first, then share the remaining mass by probability-best.
  const spare = 100 - floor * n;
  const shares = Object.fromEntries(keys.map((k) => [k, floor + spare * probabilityBest[k]!]));
  return { weights: toPercent(shares, keys), probabilityBest, expectedLoss, draws };
}
