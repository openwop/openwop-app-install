/**
 * ADR 0432 P3 — the verifier-sample IGNITER (chat-first-port gap G9).
 *
 * ADR 0432 promised "a DETERMINISTIC sample of goal verdicts becomes
 * `metrics-verifier-sample` approvals" so the verifier FP/FN metric has a
 * denominator. The service path (`sampleVerdict`) and the read
 * (`verifierQuality`) shipped, but NOTHING minted samples on a cadence — the
 * only caller was the manual `POST /kicktodo/metrics/verifier-sample`. So the
 * one metric that tells us whether the AUTOMATED judge is trustworthy was
 * structurally starved: no samples, no rate, forever.
 *
 * This is the missing cadence. It COMPOSES the existing sweep-daemon idiom
 * (`crm/snapshotDaemon.ts`) rather than a parallel scheduler — a jittered poll
 * loop with a per-(tenant, month) `claimOnce` slot so exactly one fleet
 * instance samples a tenant per period. It mints through the SAME
 * `sampleVerdict` service path a manual sample uses (which is itself idempotent
 * per enrollment and reads the verdict FROM THE JUDGE), so a re-fire never
 * double-samples and never fabricates a verdict.
 *
 * CADENCE is MONTHLY (the slot key is `YYYY-MM`) to match ADR 0432 OQ3's
 * "5% of verdicts, floor 20/month". Toggle honesty lives inside the pass: a
 * tenant is sampled only when it has `kicktodo-metrics` enabled — the metric is
 * that feature's surface. DESTRUCTIVE nothing / read-mostly, but net-new
 * managed work, so the START is env-gated (default OFF) at the index.ts call
 * site like the other opt-in sweep daemons.
 *
 * SCALE (stated, not hidden): one tenant-prefix enrollment scan per enabled
 * tenant per month, plus one goal read per candidate enrollment inside
 * `sampleVerdict`. Bounded and fine at Wave-1/2 scale — the same falsifiable
 * materialization trigger the ADR records for the read projections applies.
 *
 * @see src/features/crm/snapshotDaemon.ts — the daemon idiom this follows.
 * @see src/features/kicktodo-metrics/verifierSampleService.ts — the minted path.
 */

import type { Storage } from '../../storage/storage.js';
import { createLogger } from '../../observability/logger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listEnrollmentsInTenant } from '../kicktodo-core/enrollmentService.js';
import { sampleVerdict, SampleSubjectError } from './verifierSampleService.js';

const log = createLogger('kicktodo.verifierSampleDaemon');

/** Poll cadence. The sampling cadence itself is MONTHLY (the slot key), so a
 *  6-hour poll only needs to catch the month boundary promptly and re-attempt a
 *  transiently-failed tenant within the same month. */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** ADR 0432 OQ3 — sample 5% of a tenant's verdicts, with a floor so a small
 *  tenant still yields a usable signal. The floor is denominated in ENROLLMENTS
 *  scanned this pass (a conservative proxy for gradeable verdicts — an
 *  enrollment with no verdict yet is skipped and does not consume the budget). */
export const SAMPLE_RATE = 0.05;
export const SAMPLE_FLOOR = 20;

/** The synthetic principal recorded as a scheduled sample's submitter. There is
 *  no acting human on a daemon tick; this names the system so the approval's
 *  provenance is honest rather than borrowing a real user's identity. */
export const VERIFIER_SAMPLER_SUBMITTER = 'system:kicktodo-verifier-sampler';

/** UTC `YYYY-MM` — the deterministic MONTHLY slot key. One sampling pass per
 *  (tenant, month), independent of server timezone. */
export function yearMonth(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * One daemon pass: for every candidate tenant that has `kicktodo-metrics`
 * enabled, claim this month's slot and — on a WON claim — mint a deterministic
 * sample of its verdicts through `sampleVerdict`. Returns the number of samples
 * minted by THIS instance (0 when nothing was due, every slot was claimed by
 * another instance, or no tenant had a gradeable verdict). Exported pure for
 * deterministic tests — pass a fixed `now`.
 */
export async function processDueVerifierSamples(
  deps: { storage: Storage },
  listCandidateTenants: () => Promise<string[]>,
  now: number = Date.now(),
): Promise<number> {
  const period = yearMonth(now);
  const at = new Date(now).toISOString();
  let minted = 0;
  for (const tenantId of await listCandidateTenants()) {
    if (!tenantId) continue;
    // Toggle honesty: the FP/FN metric is the kicktodo-metrics surface, so a
    // tenant that has not enabled it is never sampled (the candidate list is a
    // broad roster enumeration; this is the gate).
    if (!(await resolveOne('kicktodo-metrics', { tenantId }))?.enabled) continue;
    let claim: { claimed: boolean };
    try {
      claim = await deps.storage.claimOnce(`kicktodo-verifier-sample:${tenantId}:${period}`, at);
    } catch (err) {
      log.warn('verifier_sample_claim_failed', { tenantId, period, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!claim.claimed) continue; // another instance owns this month's pass (or it already ran)
    try {
      const enrollments = await listEnrollmentsInTenant(tenantId);
      // DETERMINISTIC selection: sort by id so a re-fire converges on the SAME
      // sample. `sampleVerdict` is idempotent per enrollment (a re-mint returns
      // the existing sample), so a stable order plus the monthly slot claim make
      // the whole pass reproducible and safe to re-run.
      const ordered = [...enrollments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const target = Math.max(SAMPLE_FLOOR, Math.ceil(ordered.length * SAMPLE_RATE));
      let taken = 0;
      for (const e of ordered) {
        if (taken >= target) break;
        try {
          await sampleVerdict(tenantId, { enrollmentId: e.id, submittedBy: VERIFIER_SAMPLER_SUBMITTER });
          taken += 1;
        } catch (err) {
          // An enrollment the judge has not ruled on yet is not sampleable — it
          // has no verdict to grade. Skip it without consuming the budget.
          if (err instanceof SampleSubjectError) continue;
          throw err;
        }
      }
      minted += taken;
      if (taken > 0) log.info('verifier_samples_minted', { tenantId, period, minted: taken, target, enrollments: ordered.length });
    } catch (err) {
      log.warn('verifier_sample_tenant_failed', { tenantId, period, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return minted;
}

export interface VerifierSampleDaemon {
  stop: () => void;
}

/** Start the polling sampler (mirrors `startCrmSnapshotDaemon`: ±20% jittered
 *  self-rescheduling `.unref()` timer, in-flight re-entrancy guard). */
export function startVerifierSampleDaemon(
  deps: { storage: Storage },
  listCandidateTenants: () => Promise<string[]>,
): VerifierSampleDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await processDueVerifierSamples(deps, listCandidateTenants, Date.now());
    } catch (err) {
      log.warn('verifier_sample_daemon_tick_error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const nextDelay = (): number => POLL_INTERVAL_MS * (0.8 + Math.random() * 0.4);
  const schedule = (): void => {
    timer = setTimeout(() => {
      void tick().finally(() => {
        if (!stopped) schedule();
      });
    }, nextDelay());
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();
  log.info('verifier_sample_daemon_started', { pollIntervalMs: POLL_INTERVAL_MS, jitter: '±20%' });
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
