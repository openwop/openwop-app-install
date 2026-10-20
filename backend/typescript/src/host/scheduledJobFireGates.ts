/**
 * ADR 0908 D8 — fire-time gates a feature registers for the jobs it owns, in the
 * shape of `scheduledJobReadGates.ts`. The host owns the registry and imports no
 * feature; `fireJob` consults the gate that `owns` a job right after the
 * actor-inactive check and BEFORE the agent verdict, the budget and the run, so
 * a refused slot files no approval, spends no budget and mints nothing.
 *
 * A gate answers the skip reason to record, or `null` to let the fire proceed.
 * It may close the thing it guards (goals closes a goal past its bound) but must
 * never throw a fire into an error: a throwing gate is treated as a refusal.
 */
import { createLogger } from '../observability/logger.js';
import type { ScheduledJob, ScheduleSkipReason } from './schedulingService.js';

const log = createLogger('host.scheduledJobFireGates');

export interface ScheduledJobFireGate {
  /** Does this gate own `job`? Match on a server-owned marker, never on
   *  client-writable metadata alone. */
  owns: (job: ScheduledJob) => boolean;
  gate: (job: ScheduledJob, now: number) => Promise<ScheduleSkipReason | null>;
  /** The skip recorded when `gate` throws (an error reason, not a verdict). */
  refusal: ScheduleSkipReason;
  /** A job-id prefix only the feature mints (ADR 0908 D2). The generic scheduler
   *  route refuses an explicit id under it, and treats a job under it as
   *  feature-managed: no retarget, no re-enable, no metadata rewrite. */
  reservedJobIdPrefix?: string;
}

const gates = new Map<string, ScheduledJobFireGate>();

export function registerScheduledJobFireGate(name: string, gate: ScheduledJobFireGate): void {
  gates.set(name, gate);
}

/** Is `jobId` under a prefix a feature reserved (ADR 0908 D2)? */
export function isFeatureReservedJobId(jobId: string): boolean {
  for (const g of gates.values()) {
    if (g.reservedJobIdPrefix && jobId.startsWith(g.reservedJobIdPrefix)) return true;
  }
  return false;
}

/** The skip reason a registered gate answers for `job`, or `null` to fire. */
export async function scheduledJobFireRefusal(job: ScheduledJob, now: number): Promise<ScheduleSkipReason | null> {
  for (const g of gates.values()) {
    if (!g.owns(job)) continue;
    try {
      return await g.gate(job, now);
    } catch (err) {
      // `GL2CD-4` — a gate that could not decide refuses this slot (fail closed)
      // under its own error reason, never the "closed" verdict it did not reach.
      log.warn('schedule_fire_gate_failed', { jobId: job.jobId, tenantId: job.tenantId, error: err instanceof Error ? err.message : String(err) });
      return g.refusal;
    }
  }
  return null;
}
