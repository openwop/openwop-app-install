/**
 * RFC 0244 §B — repeated-trial statistics (ADR 0889 D4).
 *
 * The formulas are NORMATIVE on the wire so that two hosts report the same
 * number for the same trials, so this module computes them exactly:
 *
 *   passAtK  = 1 − C(n−c, k) / C(n, k)   (Chen et al. 2021, unbiased pass@k)
 *   passHatK = C(c, k) / C(n, k)         (τ-bench pass^k)
 *   scoreStderr = sd(per-task meanScore) / √T   (clustered by task; T ≥ 2)
 *
 * Binomials are computed in BigInt and divided once, so a large `n` neither
 * overflows nor accumulates floating-point error the way a running product of
 * ratios would.
 */

/** n choose k as an exact BigInt; 0 when k > n or k < 0. */
export function binomial(n: number, k: number): bigint {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || n < 0 || k > n) return 0n;
  const kk = Math.min(k, n - k);
  let num = 1n;
  let den = 1n;
  for (let i = 0; i < kk; i += 1) {
    num *= BigInt(n - i);
    den *= BigInt(i + 1);
  }
  return num / den;
}

/**
 * a / b for non-negative BigInts as a double with full relative precision —
 * including results far below 1e-15 and operands past Number.MAX_VALUE. Both
 * are shifted down together until the divisor fits comfortably in a double.
 */
export function bigRatio(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  const shift = Math.max(0, b.toString(2).length - 1000);
  const s = BigInt(shift);
  return Number(a >> s) / Number(b >> s);
}

function checkArgs(n: number, c: number, k: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`trial count n must be an integer >= 1 (got ${n})`);
  if (!Number.isInteger(c) || c < 0 || c > n) throw new RangeError(`passed count c must be an integer in [0, n] (got ${c})`);
  if (!Number.isInteger(k) || k < 1 || k > n) throw new RangeError(`k must be an integer in [1, n] (got ${k})`);
}

/** pass@k: the probability that at least one of k trials drawn from n passes. */
export function passAtK(n: number, c: number, k: number): number {
  checkArgs(n, c, k);
  if (c === 0) return 0;
  return 1 - bigRatio(binomial(n - c, k), binomial(n, k));
}

/** pass^k: the probability that all k trials drawn from n pass. */
export function passHatK(n: number, c: number, k: number): number {
  checkArgs(n, c, k);
  if (c < k) return 0;
  return bigRatio(binomial(c, k), binomial(n, k));
}

export type PassRule = 'all' | 'any' | 'mean';

export interface TaskTrials {
  n: number;
  passedCount: number;
  meanScore: number;
  passAtK: number;
  passHatK: number;
}

/** Per-task trial block from the per-trial scores and pass flags. */
export function summarizeTrials(trials: ReadonlyArray<{ score: number; passed: boolean }>, k: number): TaskTrials {
  const n = trials.length;
  const c = trials.filter((t) => t.passed).length;
  const meanScore = n ? trials.reduce((s, t) => s + t.score, 0) / n : 0;
  return { n, passedCount: c, meanScore, passAtK: passAtK(n, c, k), passHatK: passHatK(n, c, k) };
}

/** RFC 0244 §B — the task's `passed` under its suite's `passRule`. */
/**
 * `gatedScore` is the RFC 0246 §A task gating score: under `mean` the task passes
 * on it, not on `meanScore` (§B), so trials that failed their trajectory cannot
 * carry the task. Omitted, it is `meanScore` (no trial can gate).
 */
export function taskPassed(t: TaskTrials, rule: PassRule, passScore: number | undefined, gatedScore = t.meanScore): boolean {
  switch (rule) {
    case 'all': return t.passedCount === t.n;
    case 'any': return t.passedCount >= 1;
    case 'mean': return gatedScore >= (passScore ?? 1);
  }
}

export interface SuiteTrialStats {
  k: number;
  passAtK: number;
  passHatK: number;
  /** Omitted when fewer than two tasks — a standard error of one cluster is undefined. */
  scoreStderr?: number;
}

/** Suite-level `trialStats`: the mean of the per-task estimates + the clustered stderr. */
export function suiteTrialStats(tasks: ReadonlyArray<TaskTrials>, k: number): SuiteTrialStats {
  const T = tasks.length;
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const out: SuiteTrialStats = {
    k,
    passAtK: mean(tasks.map((t) => t.passAtK)),
    passHatK: mean(tasks.map((t) => t.passHatK)),
  };
  if (T >= 2) {
    const means = tasks.map((t) => t.meanScore);
    const m = mean(means);
    const variance = means.reduce((s, x) => s + (x - m) ** 2, 0) / (T - 1); // sample variance
    out.scoreStderr = Math.sqrt(variance) / Math.sqrt(T);
  }
  return out;
}
