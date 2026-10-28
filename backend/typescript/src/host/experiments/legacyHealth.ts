/**
 * ADR 0949 P0 (E-1, E-4) — honesty checks for the two legacy A/B result
 * projections (CMS page experiments, ADR 0236; funnel step experiments, ADR 0294).
 *
 * Both still decide `significant` with a fixed-horizon z-test recomputed on every
 * read. That is only valid if nobody stops the test the first time the flag
 * flips (peeking), and only if the traffic split is the one configured. Until
 * ADR 0949 P2 replaces them with the engine's always-valid verdict, every legacy
 * result carries:
 *   - `srm`: a chi-square test of observed units per arm against the configured
 *     weights. At p < 0.001 the split is broken (a redirect, a bot filter, a
 *     caching layer), so the projections WITHHOLD `significant` — a corrupted
 *     split must never read as a winner.
 *   - `stopEarly`: the standing notice that the verdict is fixed-horizon.
 */
import { sampleRatioMismatch, SRM_ALPHA } from './stats.js';

export type LegacyStopEarlyNotice = 'fixed_horizon_do_not_stop_early';

export interface LegacyResultHealth {
  srm: { chiSquare: number; pValue: number; mismatch: boolean; alpha: number } | null;
  stopEarly: LegacyStopEarlyNotice;
}

/** `unitsPerArm` and `weights` are in the same (configured) arm order. */
export function legacyResultHealth(unitsPerArm: readonly number[], weights: readonly number[]): LegacyResultHealth {
  const srm = sampleRatioMismatch(unitsPerArm, weights, SRM_ALPHA);
  return {
    srm: srm ? { chiSquare: srm.chiSquare, pValue: srm.pValue, mismatch: srm.mismatch, alpha: SRM_ALPHA } : null,
    stopEarly: 'fixed_horizon_do_not_stop_early',
  };
}
