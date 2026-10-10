/**
 * ADR 0846 D1b — per-kind READ narrowing for scheduler jobs a FEATURE owns.
 *
 * `routes/scheduler.ts` decides who may read or manage a job from the job's owner
 * Subject, else from workspace membership. A feature whose job is someone ELSE's
 * business (a scheduled agent chat belongs to the conversation it posts into)
 * registers a gate here keyed on `job.metadata.kind`. A gate can only NARROW:
 * `false` makes the job unreachable (the scheduler's uniform 404); `true` leaves
 * the scheduler's own decision standing. It never grants.
 *
 * Without this, the generic scheduler routes listed, paused, deleted and fired a
 * scheduled chat bound to a private conversation for any workspace member, while
 * the feature's own routes refused the same caller.
 *
 * Core cannot import a feature, so the feature registers at module load, the
 * `registerSubjectEraser` shape.
 */
import type { ScheduledJob } from './schedulingService.js';

/** `actingUser` is `req.userId ?? principalId` — the spelling conversations and
 *  other per-user records are stamped in. */
export type ScheduledJobReadGate = (job: ScheduledJob, actingUser: string | undefined) => Promise<boolean>;

const gates = new Map<string, ScheduledJobReadGate>();

export function registerScheduledJobReadGate(kind: string, gate: ScheduledJobReadGate): void {
  gates.set(kind, gate);
}

/** `false` ⇒ the caller may not reach this job at all. No gate for the kind ⇒ `true`. */
export async function scheduledJobReadable(job: ScheduledJob, actingUser: string | undefined): Promise<boolean> {
  const kind = job.metadata?.['kind'];
  const gate = typeof kind === 'string' ? gates.get(kind) : undefined;
  return gate ? gate(job, actingUser) : true;
}
