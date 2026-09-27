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
