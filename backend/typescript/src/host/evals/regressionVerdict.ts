/**
 * RFC 0244 §F — the paired regression verdict (ADR 0889 D4).
 *
 * Tasks are paired by `taskId` (only tasks in BOTH runs count) and compared on
 * their per-task `meanScore`. Method `sign-test`: an exact two-sided binomial
 * test over the non-zero deltas (ties are dropped), the textbook paired test
 * that needs no distributional assumption about scores bounded in [0, 1].
 *
 *   no paired task              ⇒ `inconclusive`  (nothing was compared)
 *   no non-zero delta           ⇒ `unchanged`
 *   p < alpha, more improved    ⇒ `improved`
 *   p < alpha, more regressed   ⇒ `regressed`
 *   otherwise                   ⇒ `inconclusive`  (RFC 0244: never guess)
 */
import { bigRatio, binomial } from './trialStats.js';

export type RegressionVerdict = 'improved' | 'regressed' | 'unchanged' | 'inconclusive';

export const REGRESSION_METHOD = 'sign-test';
export const DEFAULT_ALPHA = 0.05;

export interface PairedTaskScore {
  taskId: string;
  meanScore: number;
}

export interface RegressionResult {
  verdict: RegressionVerdict;
  method: typeof REGRESSION_METHOD;
  alpha: number;
  pairedTaskCount: number;
  /** `aggregateScore` delta over the PAIRED tasks only (candidate − baseline). */
  scoreDelta: number;
  /** Two-sided p-value; 1 when there is nothing to test. Host-internal, not on the wire. */
  pValue: number;
}

/** Deltas below this are ties: per-task means are float averages of trial scores. */
const TIE_EPSILON = 1e-9;

/** Exact two-sided sign-test p-value for `pos` successes out of `m` non-tied pairs. */
export function signTestPValue(pos: number, m: number): number {
  if (m === 0) return 1;
  const tail = Math.min(pos, m - pos);
  let acc = 0n;
  for (let i = 0; i <= tail; i += 1) acc += binomial(m, i);
  const oneSided = bigRatio(acc, 1n << BigInt(m));
  return Math.min(1, 2 * oneSided);
}

export function pairedRegressionVerdict(
  baseline: ReadonlyArray<PairedTaskScore>,
  candidate: ReadonlyArray<PairedTaskScore>,
  alpha: number = DEFAULT_ALPHA,
): RegressionResult {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be in (0, 1) (got ${alpha})`);
  const base = new Map(baseline.map((t) => [t.taskId, t.meanScore]));
  const pairs: Array<[number, number]> = [];
  for (const t of candidate) {
    const b = base.get(t.taskId);
    if (b !== undefined) pairs.push([b, t.meanScore]);
  }
  const deltas = pairs.map(([b, c]) => c - b);
  const nonTied = deltas.filter((d) => Math.abs(d) > TIE_EPSILON);
  const pos = nonTied.filter((d) => d > 0).length;
  const neg = nonTied.length - pos;
  const pValue = signTestPValue(pos, nonTied.length);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
  let verdict: RegressionVerdict;
  // ADR 0889 grade remediation (EVD-3) — zero pairs used to read `unchanged`: a
  // baseline that shares no task with the candidate "proved" no regression.
  if (pairs.length === 0) verdict = 'inconclusive';
  else if (nonTied.length === 0) verdict = 'unchanged';
  else if (pValue < alpha) verdict = pos > neg ? 'improved' : 'regressed';
  else verdict = 'inconclusive';
  return {
    verdict,
    method: REGRESSION_METHOD,
    alpha,
    pairedTaskCount: pairs.length,
    scoreDelta: mean(pairs.map(([, c]) => c)) - mean(pairs.map(([b]) => b)),
    pValue,
  };
}
