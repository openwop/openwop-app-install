/**
 * Sticky multivariant bucketing (pure, deterministic — ADR §3.3).
 *
 * Generalizes myndhyve's dev-only `hashString(userId + flagName) % 100` to
 * weighted variants over a `% 10000` space (accurate 50/50, small allocations,
 * and 1%→5%→50% ramps). NO Date.now / Math.random — the same (unitId, toggleId,
 * salt, weights) always yields the same variant, which is what makes a run's
 * stamped variant replay-safe.
 */

import type { Variant } from './types.js';

/** djb2-style 32-bit string hash (matches myndhyve's featureFlags.ts). */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // force 32-bit
  }
  return Math.abs(hash);
}

/** The 0..9999 bucket a subject falls into for a given toggle. */
export function bucketOf(unitId: string, toggleId: string, salt: string): number {
  return hashString(`${unitId}:${toggleId}:${salt}`) % 10_000;
}

/**
 * Deterministically assign a variant key. Returns null when there are no
 * variants. Weights are expected to sum to 100 (enforced at write time); we
 * walk cumulative weight×100 against the 0..9999 bucket, and defensively
 * normalize if a stored config ever drifts off 100. The last variant catches
 * any rounding tail so a valid bucket always maps to a variant.
 */
export function assignVariant(unitId: string, toggleId: string, salt: string, variants: Variant[]): string | null {
  if (!variants || variants.length === 0) return null;
  const total = variants.reduce((s, v) => s + v.weight, 0);
  if (total <= 0) return null;
  const bucket = bucketOf(unitId, toggleId, salt);
  let cumulative = 0;
  for (const v of variants) {
    // ×10000/total normalizes whether or not weights sum to 100.
    cumulative += Math.round((v.weight / total) * 10_000);
    if (bucket < cumulative) return v.key;
  }
  return variants[variants.length - 1]!.key;
}
