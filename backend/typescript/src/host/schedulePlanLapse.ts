/**
 * ADR 0820 §7 — the schedules UI's "Paused: plan lapsed" state, COMPUTED on read.
 *
 * The daemon's lapse auto-pause is a computed skip (`scheduleDaemon.ts`
 * `planLapsedSkip`): the row stays enabled and only records
 * `lastSkipReason:'plan-lapsed'` + `lastSkipFeatureId`. That record alone goes
 * stale the moment the workspace resubscribes (it is cleared only by the next
 * fire, which for a daily job is up to a day away), so the read lane re-asks
 * the ONE access resolver (`resolveOne`, ADR 0819) and reports the lapse only
 * while the plan still refuses the feature. A legacy row paused by the earlier
 * persisted-flag shape (`planPause`) is reported the same way until the drain
 * sweep resumes it.
 */
import type { ScheduledJob } from './schedulingService.js';
import { resolveOne } from './featureToggles/service.js';

/** The feature id this job is currently paused for by the plan, or `null`. A
 *  resolution error answers `null` (the row then shows its plain skip line —
 *  the read never invents a lapse it could not confirm). */
export async function planLapsedFeature(job: ScheduledJob): Promise<string | null> {
  const featureId = job.planPause?.featureId
    ?? (job.lastSkipReason === 'plan-lapsed' ? job.lastSkipFeatureId : undefined);
  if (!featureId) return null;
  try {
    const resolved = await resolveOne(featureId, { tenantId: job.tenantId });
    return resolved?.blockedBy === 'plan' ? featureId : null;
  } catch {
    return null;
  }
}

/** The wire projection: `planLapsed: { featureId }` on a job paused by the plan
 *  right now; every other row is returned unchanged. */
export async function withPlanLapse<J extends ScheduledJob>(jobs: readonly J[]): Promise<Array<J & { planLapsed?: { featureId: string } }>> {
  return Promise.all(jobs.map(async (job) => {
    const featureId = await planLapsedFeature(job);
    return featureId ? { ...job, planLapsed: { featureId } } : job;
  }));
}
