/**
 * Weighted / sticky / salted variant assignment (pure, deterministic).
 *
 * EXTRACTED from the feature-toggle engine's bucketing (ADR §3.3 — see
 * `featureToggles/bucketing.ts`, now a re-export shim) so the toggle engine and
 * CMS page experiments (ADR 0236, D1) share ONE bucketing implementation —
 * byte-identical behavior, never a fork. NO Date.now / Math.random: the same
 * (unitId, scopeId, salt, weights) always yields the same variant, which is what
 * makes toggle assignments replay-safe and experiment assignments sticky.
 *
 * Generalizes myndhyve's dev-only `hashString(userId + flagName) % 100` to
 * weighted variants over a `% 10000` space (accurate 50/50, small allocations,
 * and 1%→5%→50% ramps).
 */

/** The minimal weighted-variant shape both consumers satisfy structurally. */
export interface WeightedVariant {
  /** Variant key, e.g. `A` / `B` / `control`. */
  key: string;
  /** Percentage weight (expected to sum to 100 across the set). */
  weight: number;
}

/** djb2-style 32-bit string hash (matches myndhyve's featureFlags.ts). */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // force 32-bit
  }
  return Math.abs(hash);
}

/** The 0..9999 bucket a subject falls into for a given scope (toggle/experiment). */
export function bucketOf(unitId: string, scopeId: string, salt: string): number {
  return hashString(`${unitId}:${scopeId}:${salt}`) % 10_000;
}

/**
 * Deterministically assign a variant key. Returns null when there are no
 * variants. Weights are expected to sum to 100 (enforced at write time); we
 * walk cumulative weight×100 against the 0..9999 bucket, and defensively
 * normalize if a stored config ever drifts off 100. The last variant catches
 * any rounding tail so a valid bucket always maps to a variant.
 */
export function assignWeightedVariant<V extends WeightedVariant>(
  unitId: string,
  scopeId: string,
  salt: string,
  variants: readonly V[],
): string | null {
  if (!variants || variants.length === 0) return null;
  const total = variants.reduce((s, v) => s + v.weight, 0);
  if (total <= 0) return null;
  const bucket = bucketOf(unitId, scopeId, salt);
  let cumulative = 0;
  for (const v of variants) {
    // ×10000/total normalizes whether or not weights sum to 100.
    cumulative += Math.round((v.weight / total) * 10_000);
    if (bucket < cumulative) return v.key;
  }
  return variants[variants.length - 1]!.key;
}

/** Honest-verdict floor shared by every experiment surface (ADR 0236/0294). */
export const MIN_SESSIONS_PER_VARIANT = 30;
/** Two-sided 95% critical value for the two-proportion z-test. */
export const Z_95 = 1.959963984540054;

/** Pure two-proportion z-test (pooled). Returns null when undefined (either
 *  sample empty, or zero pooled variance — e.g. both rates 0 or both 1).
 *  Extracted from cms/pageExperimentsService (ADR 0294 P4 — one z-test, not a
 *  fork per surface); cms re-imports it from here. */
export function twoProportionZ(conversionsA: number, sessionsA: number, conversionsB: number, sessionsB: number): number | null {
  if (sessionsA <= 0 || sessionsB <= 0) return null;
  const pooled = (conversionsA + conversionsB) / (sessionsA + sessionsB);
  const variance = pooled * (1 - pooled) * (1 / sessionsA + 1 / sessionsB);
  if (variance <= 0) return null;
  return (conversionsB / sessionsB - conversionsA / sessionsA) / Math.sqrt(variance);
}

/**
 * ADR 0950 D3 — the band layout for a promotion ramp stage, MONOTONE across
 * stages: a unit on the winner never moves off it, and no holdout unit ever
 * sees the winner.
 *
 * `assignWeightedVariant` walks cumulative bands in order, so a unit's bucket
 * picks the band. The winner keeps its LAUNCH band and grows from its own edges:
 * first away from the holdout (to the far end), then toward it, never into it.
 * The holdout is a fixed `holdoutPct` band at whichever end the winner's launch
 * band does not touch (the low end when it can). Every other unit keeps its
 * launch arm until the winner's band reaches it. The result is a list of
 * contiguous `{key, weight}` segments (a key may repeat) in bucket order.
 *
 * `launch` is the launch epoch's arms in order (integer percents summing to
 * 100); `control` is the arm the holdout sees. Throws a RangeError when the
 * stage cannot be laid out monotonically.
 */
export function rampLayout(
  launch: ReadonlyArray<{ key: string; weight: number }>,
  winner: string,
  winnerPct: number,
  holdoutPct: number,
  control: string,
): Array<{ key: string; weight: number }> {
  if (launch.reduce((s, a) => s + a.weight, 0) !== 100 || launch.some((a) => !Number.isInteger(a.weight) || a.weight < 0)) throw new RangeError('rampLayout: launch weights must be whole percents summing to 100');
  if (!Number.isInteger(winnerPct) || !Number.isInteger(holdoutPct) || holdoutPct < 0 || winnerPct + holdoutPct > 100) throw new RangeError('rampLayout: winnerPct + holdoutPct must be whole percents within 100');
  // Launch bands as [start, end) in whole percents.
  const owner: string[] = [];
  let ws = -1; let we = -1;
  for (const a of launch) {
    const start = owner.length;
    for (let i = 0; i < a.weight; i++) owner.push(a.key);
    if (a.key === winner) { ws = start; we = owner.length; }
  }
  if (ws < 0 || winner === control) throw new RangeError('rampLayout: the winner must be a non-control launch arm');
  if (winnerPct < we - ws) throw new RangeError('rampLayout: a ramp never shrinks the winner below its launch share');
  // The holdout sits at the end the winner's launch band does not touch.
  const holdoutLow = ws >= holdoutPct;
  if (!holdoutLow && we > 100 - holdoutPct) throw new RangeError('rampLayout: the holdout would overlap the winner');
  const hLo = holdoutLow ? 0 : 100 - holdoutPct;
  const hHi = holdoutLow ? holdoutPct : 100;
  // Grow away from the holdout first, then toward it, stopping at its edge.
  let lo = ws; let hi = we; let need = winnerPct - (we - ws);
  if (holdoutLow) {
    const up = Math.min(need, 100 - hi); hi += up; need -= up;
    const down = Math.min(need, lo - hHi); lo -= down; need -= down;
  } else {
    const down = Math.min(need, lo); lo -= down; need -= down;
    const up = Math.min(need, hLo - hi); hi += up; need -= up;
  }
  if (need > 0) throw new RangeError('rampLayout: winnerPct does not fit beside the holdout');
  const at = (p: number): string => (p >= lo && p < hi ? winner : p >= hLo && p < hHi ? control : owner[p]!);
  const out: Array<{ key: string; weight: number }> = [];
  for (let p = 0; p < 100; p++) {
    const key = at(p);
    const last = out[out.length - 1];
    if (last && last.key === key) last.weight += 1; else out.push({ key, weight: 1 });
  }
  return out;
}
