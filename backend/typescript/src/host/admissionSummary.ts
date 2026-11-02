/**
 * ADR 0987 D6 — the superadmin run-admission summary on the Operations surface.
 *
 * Per scope family: the configured cap, refusals since boot by reason, and the
 * failure posture in effect (D5). Plus the number of runs holding a concurrency
 * slot right now, from the D2 index (bounded, never a global scan).
 *
 * What it does NOT report, and why:
 *  - No key, digest, session, IP or tenant. Denials are logged with the scope
 *    family elsewhere; this read is counts and configuration only.
 *  - No per-family holding count. The admission key is a digest of the scope, so
 *    a held run cannot be attributed to the session or the key family from the
 *    row. Encoding the family into the key would change every live key at deploy
 *    and briefly double the cap for runs already holding a slot.
 *  - The refusal counts are THIS process's since boot (`perInstance`), like the
 *    rest of the health summary. The limits are shared; the tally is not.
 */
import type { Storage } from '../storage/storage.js';
import { snapshotRateLimits } from '../middleware/rateLimit.js';
import { admissionRefusalCounts } from './admissionRefusals.js';
import { deployProfile, type DeployProfile } from './deployPosture.js';

/** The holding count stops here; a reading of this value means "at least". */
export const ADMISSION_HOLDING_COUNT_LIMIT = 1000;

export type AdmissionPosture = 'transactional' | 'closed' | 'open';

export interface AdmissionFamilySummary {
  /** `concurrency.session`, `runs.key.day`, `plan.monthly`, … */
  family: string;
  /** The configured cap; `null` when it is per tenant (the monthly plan). 0 = off. */
  cap: number | null;
  /** Window length in seconds, for the run-count windows. */
  windowS?: number;
  posture: AdmissionPosture;
  /** Refusals since boot on this instance, by reason. `null` for the two
   *  concurrency families: their refusals are counted together at the insert
   *  seam (`concurrencyRefusals`), which cannot tell them apart. */
  refusals: Record<string, number> | null;
}

export interface AdmissionSummary {
  profile: DeployProfile;
  families: AdmissionFamilySummary[];
  holding: { count: number; atLeast: boolean; limit: number };
  /** Concurrency refusals from the insert seam, not split by family (see above). */
  concurrencyRefusals: Record<string, number>;
  /** A strict-profile window counter that could not answer (a 503). */
  windowUnavailable: number;
  perInstance: true;
}

function pick(counts: Record<string, number>, reasons: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reasons) if (counts[r]) out[r] = counts[r];
  return out;
}

export async function buildAdmissionSummary(storage: Storage): Promise<AdmissionSummary> {
  const limits = snapshotRateLimits();
  const profile = deployProfile();
  const failure: AdmissionPosture = profile === 'strict' ? 'closed' : 'open';
  const refused = admissionRefusalCounts();
  const held = await storage.countAdmissionHolding(ADMISSION_HOLDING_COUNT_LIMIT);
  const windows = refused.windows;
  return {
    profile,
    families: [
      // D2: counted inside the run insert, so it shares the insert's transaction.
      { family: 'concurrency.session', cap: limits.sessionConcurrent, posture: 'transactional', refusals: null },
      { family: 'concurrency.key', cap: limits.keyConcurrent, posture: 'transactional', refusals: null },
      // D1/P3b: shared `takeShared` windows, posture per D5.
      { family: 'runs.session.minute', cap: limits.sessionRunsPerMin, windowS: 60, posture: failure, refusals: pick(windows, ['session_runs_per_min']) },
      { family: 'runs.session.day', cap: limits.sessionRunsPerDay, windowS: 86_400, posture: failure, refusals: pick(windows, ['session_runs_per_day']) },
      { family: 'runs.key.day', cap: limits.keyRunsPerDay, windowS: 86_400, posture: failure, refusals: pick(windows, ['key_runs_per_day']) },
      { family: 'runs.ip.day', cap: limits.ipRunsPerDay, windowS: 86_400, posture: failure, refusals: pick(windows, ['ip_runs_per_day']) },
      // D5 / Q2: the monthly plan limit is per tenant, from the billing plan.
      { family: 'plan.monthly', cap: null, posture: failure, refusals: { ...refused.plan } },
    ],
    holding: { count: held, atLeast: held >= ADMISSION_HOLDING_COUNT_LIMIT, limit: ADMISSION_HOLDING_COUNT_LIMIT },
    concurrencyRefusals: { ...refused.concurrency },
    windowUnavailable: windows.unavailable ?? 0,
    perInstance: true,
  };
}
