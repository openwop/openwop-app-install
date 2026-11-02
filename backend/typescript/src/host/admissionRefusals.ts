/**
 * ADR 0987 D6 — run-admission refusals since this process booted, by family and
 * reason. Counts only: never a session id, key digest, IP or tenant, so the
 * Operations summary can show them to a superadmin without a projection step.
 *
 * Per process, like the rest of the Operations health summary (`perInstance`):
 * Cloud Run instances do not share these counters, and a deploy resets them.
 * The limits themselves are shared (D1/D2); only this tally is local.
 *
 * Families:
 *  - `concurrency`: the run insert refused at the D2 cap (`AdmissionRefusedError`),
 *    counted at the one insert seam every lane passes (D3).
 *  - `windows`: the per-minute / per-day run windows (`takeShared`), by limiter
 *    reason, plus `unavailable` when a strict-profile counter could not answer.
 *  - `plan`: the monthly plan limit, by its `details.reason`
 *    (`plan_run_limit_reached` / `_contention` / `_unavailable`).
 */

export type AdmissionFamily = 'concurrency' | 'windows' | 'plan';

const FAMILIES: readonly AdmissionFamily[] = ['concurrency', 'windows', 'plan'];

const counts: Record<AdmissionFamily, Record<string, number>> = { concurrency: {}, windows: {}, plan: {} };

export function recordAdmissionRefusal(family: AdmissionFamily, reason: string): void {
  const bucket = counts[family];
  bucket[reason] = (bucket[reason] ?? 0) + 1;
}

/** A copy, so a caller cannot change the tally. */
export function admissionRefusalCounts(): Record<AdmissionFamily, Record<string, number>> {
  const out = {} as Record<AdmissionFamily, Record<string, number>>;
  for (const f of FAMILIES) out[f] = { ...counts[f] };
  return out;
}

export function _resetAdmissionRefusals(): void {
  for (const f of FAMILIES) for (const k of Object.keys(counts[f])) delete counts[f][k];
}
