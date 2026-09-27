/**
 * Sticky multivariant bucketing (pure, deterministic — ADR §3.3).
 *
 * The implementation now lives in `../variantAssignment.ts` (ADR 0236, D1):
 * CMS page experiments reuse the SAME weighted/sticky/salted math, so it was
 * EXTRACTED to a shared pure helper rather than forked. This module keeps the
 * toggle engine's original import surface (hashString / bucketOf /
 * assignVariant over the toggle `Variant` type) — behavior is byte-identical.
 */

import type { Variant } from './types.js';
import { assignWeightedVariant } from '../variantAssignment.js';

export { hashString, bucketOf } from '../variantAssignment.js';

/**
 * Deterministically assign a variant key for a toggle. Returns null when there
 * are no variants. See `variantAssignment.assignWeightedVariant` for the
 * bucket-walk semantics (weights expected to sum to 100; defensively
 * normalized; last variant catches the rounding tail).
 */
export function assignVariant(unitId: string, toggleId: string, salt: string, variants: Variant[]): string | null {
  return assignWeightedVariant(unitId, toggleId, salt, variants);
}
