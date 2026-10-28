/**
 * ADR 0949 P1b (E-3) — the ONE legacy A/B result projection. CMS page
 * experiments (ADR 0236) and funnel step experiments (ADR 0294 P4) each carried a
 * copy of this block; both now pass their per-arm counts here. Counts in, result
 * out, no I/O. The arm-specific fields (a CMS `versionId`, a funnel `pageId`) are
 * added back by the caller.
 *
 * Still the fixed-horizon z-test, with the P0 honesty checks; the engine's
 * always-valid verdict replaces it in P2.
 */
import { MIN_SESSIONS_PER_VARIANT, Z_95, twoProportionZ } from '../variantAssignment.js';
import { legacyResultHealth, type LegacyResultHealth } from './legacyHealth.js';

export interface LegacyArmCounts {
  key: string;
  weight: number;
  /** Distinct units exposed to this arm. */
  sessions: number;
  /** Distinct exposed units that converted. */
  conversions: number;
}

export interface LegacyArmResult extends LegacyArmCounts {
  conversionRate: number;
  /** Two-proportion z vs the FIRST arm (null on the baseline, or when undefined). */
  zScore: number | null;
  /** |z| ≥ 1.96, reported only with a sufficient sample and a defined test. */
  significant: boolean | null;
  insufficientSample: boolean;
}

/** Why every `significant` was withheld: a broken split, or a source that lost events. */
export type SignificanceWithheld = 'srm' | 'coverage';

export interface LegacyProjection {
  arms: LegacyArmResult[];
  health: LegacyResultHealth;
  significanceWithheld?: SignificanceWithheld;
}

/** `arms` in configured order; index 0 is the baseline. `coverageComplete:false`
 *  withholds every verdict (E-2: a truncated source is never a guess). */
export function projectLegacyResults(arms: readonly LegacyArmCounts[], opts: { coverageComplete?: boolean } = {}): LegacyProjection {
  const base = arms[0];
  const baseSessions = base?.sessions ?? 0;
  const baseConversions = base?.conversions ?? 0;
  const projected: LegacyArmResult[] = arms.map((a, i) => {
    const insufficientSample = a.sessions < MIN_SESSIONS_PER_VARIANT || (i > 0 && baseSessions < MIN_SESSIONS_PER_VARIANT);
    const z = i === 0 ? null : twoProportionZ(baseConversions, baseSessions, a.conversions, a.sessions);
    return {
      key: a.key, weight: a.weight, sessions: a.sessions, conversions: a.conversions,
      conversionRate: a.sessions > 0 ? a.conversions / a.sessions : 0,
      zScore: z,
      significant: i === 0 || insufficientSample || z === null ? null : Math.abs(z) >= Z_95,
      insufficientSample,
    };
  });
  const health = legacyResultHealth(arms.map((a) => a.sessions), arms.map((a) => a.weight));
  const withheld: SignificanceWithheld | undefined = health.srm?.mismatch === true ? 'srm' : opts.coverageComplete === false ? 'coverage' : undefined;
  return {
    arms: withheld ? projected.map((a) => ({ ...a, significant: null })) : projected,
    health,
    ...(withheld ? { significanceWithheld: withheld } : {}),
  };
}
