/**
 * Background scheduler daemon (RFC 0052 §B) — fires durable scheduled jobs on
 * their wall-clock cadence.
 *
 * The durable job store (schedulingService.ts) carries a `nextFireAt` epoch-ms
 * computed from each job's `cronExpr` (+ `timezone`) by cronSchedule.ts. This
 * daemon polls for jobs whose `nextFireAt` is due and starts their workflow via
 * the shared run-starter — the same recipe the "Run now" trigger uses, so
 * replay/fork/observability are inherited.
 *
 * MULTI-INSTANCE FIRE-ONCE (ADR 0787 D1): every instance — including a
 * superseded Cloud Run revision still running its workers (WHD-28) — runs this
 * poll loop, and there is no leader. Fire-once lives in the DATA, in three
 * layers: the per-(job, slot) `claimOnce` (an atomic insert-if-absent, pruned
 * after 10 min); the `claimDueSlot` fence (a re-read + compare-and-swap that
 * fires only while the row is still enabled, bound and due at exactly this
 * slot — the row is never pruned, so a pass that wakes after the claim prune
 * fires nothing); and a deterministic run id per (tenant, job, slot). Before
 * ADR 0787 the claim was the ONLY layer, the fire read a pass-start snapshot,
 * and the run id was random — a pass stalled past the prune fired the slot
 * twice. A revision running PRE-0787 code is not fenced by any of this and is
 * visible only through Cloud Run's own listing; `scheduleDaemonFleet` shows
 * every instance running THIS code.
 *
 * MISSED-WINDOW: when the daemon (or the whole fleet) was down, a job's
 * `nextFireAt` is in the past. It fires once now and `advanceJobSlot` advances
 * `nextFireAt` to the next FUTURE slot — collapsing the backlog to a single
 * recovery run (§B.4), never N.
 *
 * `processDueSchedules` is exported for deterministic tests (pass a fixed
 * `now`); `startScheduleDaemon` runs it on a slow poll for the live server.
 *
 * @see src/host/runDispatchSweeper.ts — the daemon pattern this follows
 * @see src/host/runStarter.ts — the shared run dispatch
 * @see RFCS/0052-scheduling-and-time-based-triggers.md §B
 */

import type { StartRunDeps } from './runStarter.js';
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import { startWorkflowRun } from './runStarter.js';
import { createHash } from 'node:crypto';
import { listJobsForDaemon, claimDueSlot, recordJobRun, recordJobSkipped, currentTick, scheduleSubject, isStalled, reviveStalledJob, jobActorIsInactive, resumeJobFromPlanPause, type ScheduledJob, type ScheduleSkipReason } from './schedulingService.js';
import { WorkflowFeatureRefusedError } from './workflowFeatureGate.js';
import { scheduledJobFireRefusal } from './scheduledJobFireGates.js';
import { autonomousDispatchVerdict, jobAgentRef } from './autonomousDispatchPolicy.js';
import { createApproval, hasPendingApprovalForJob } from './approvalService.js';
import { subjectScope } from './subject.js';
import { checkAutonomousRunBudget, pruneRunBudget } from './runBudgetService.js';
import { resolveOne } from './featureToggles/service.js';
import { getInstanceId } from './instanceId.js';
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { CALLER_LINKAGE_KEYS } from './runLinkage.js';

const log = createLogger('scheduleDaemon');

/** Poll cadence. Schedules align to minute boundaries, so a sub-minute poll
 *  keeps fire latency well under one cadence step. */
const POLL_INTERVAL_MS = 30_000;
/** Most jobs fired per pass — a backstop against a misconfiguration flooding
 *  the dispatcher; remaining due jobs fire on the next tick. */
const FIRE_BATCH = 50;
/** Per-(job, slot) claim keys are only needed for the brief concurrent-poll
 *  window; prune ones older than this each tick so the idempotency table stays
 *  bounded (an hourly job would otherwise leave a permanent row per fire). */
const CLAIM_KEY_PREFIX = 'schedule-fire:';
const CLAIM_PRUNE_AGE_MS = 10 * 60_000;

/**
 * ADR 0787 D1 — the deterministic run id of a scheduled fire: a pure function of
 * (tenant, job, slot), the kanban `stableWorkIdentity` shape. `startWorkflowRun`
 * returns the existing run for a bound id, so a second start for the same slot —
 * from anything that re-fires a slot this code already fired — collapses at the
 * run store. The TENANT is in the hash because `jobid_conflict` only protects
 * LIVE rows: another tenant may reuse a deleted job's id.
 */
export function scheduledRunId(tenantId: string, jobId: string, slot: number): string {
  const digest = createHash('sha256').update([tenantId, jobId, String(slot)].join('\u0000')).digest('hex').slice(0, 32);
  return `schedule-run-${digest}`;
}

export type FireOutcome = { runId: string } | { skipped: ScheduleSkipReason };

/**
 * ADR 0787 D5 — THE recipe for turning a job into a run, shared by the daemon and
 * the "Run now" route so the button fires exactly what the schedule fires: the
 * job's inputs, `configurable`, filtered metadata (incl. `actingUserId`) and
 * owner scope, behind the ADR 0599 owning-feature gate. Records the outcome on
 * the row (`recordJobRun` / `recordJobSkipped`) and returns it.
 *
 * `applyBudget` — the autonomous-run budget. The daemon always applies it; Run
 * now applies it when the clicker is not the job's actor, so a workspace writer
 * cannot fire a colleague's credentialed workflow without limit.
 */
export async function fireJob(
  deps: StartRunDeps,
  job: ScheduledJob,
  opts: {
    runId?: string;
    trigger: 'schedule' | 'manual';
    triggeredBy?: string;
    applyBudget: boolean;
    now?: number;
    /** ADR 0775 P3b — this fire is the APPROVED proposal a `hitl` hold filed; the
     *  hold is satisfied, every other gate still applies. */
    approvedProposalId?: string;
  },
): Promise<FireOutcome> {
  const now = opts.now ?? Date.now();
  // ADR 0599 §6 — OWNING-FEATURE gate, resolved PER TENANT at fire time.
  // Absent `featureId` ⇒ ungated (every pre-existing job). When present, the job
  // fires only while the feature is enabled for THIS job's tenant. A listener on
  // the toggle-CREATION lane is not a gate on the USE lane. Non-destructive: the
  // row survives, so re-enabling resumes. Fail-closed on a resolution error — a
  // toggle we cannot read is not a licence to fire someone's workflow.
  if (job.featureId) {
    let enabled = false;
    let planRefused = false;
    try {
      const resolved = await resolveOne(job.featureId, { tenantId: job.tenantId });
      enabled = resolved?.enabled === true;
      planRefused = resolved?.blockedBy === 'plan';
    } catch (err) {
      log.warn('schedule fire dropped — owning-feature toggle could not be resolved', {
        jobId: job.jobId, tenantId: job.tenantId, featureId: job.featureId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!enabled) {
      // ADR 0820 §7 — a PLAN refusal (the lapse) is the computed auto-pause:
      // a quiet `plan-lapsed` skip, distinct from a toggle switched off.
      if (planRefused) return planLapsedSkip(job, job.featureId, now);
      log.info('schedule fire dropped — owning feature is disabled for this tenant', {
        jobId: job.jobId, tenantId: job.tenantId, featureId: job.featureId,
      });
      return skip(job.jobId, 'feature-disabled', now);
    }
  }
  // ADR 0815 D4 — never run as a deactivated person. Non-destructive: the slot
  // is skipped and reactivating them resumes the job.
  if (await jobActorIsInactive(job)) {
    log.info('schedule fire dropped — the person it acts as is deactivated', { jobId: job.jobId, tenantId: job.tenantId });
    return skip(job.jobId, 'actor-inactive', now);
  }
  // ADR 0908 D8 — a feature's fire gate for a job it owns (a goal past its bound
  // or closed). Before the agent verdict and the budget: a refused slot files no
  // approval and spends nothing.
  const gateRefusal = await scheduledJobFireRefusal(job, now);
  if (gateRefusal !== null) {
    log.info('schedule fire dropped — its owning feature refused it', { jobId: job.jobId, tenantId: job.tenantId, skipReason: gateRefusal });
    return skip(job.jobId, gateRefusal, now);
  }
  // ADR 0775 P3 (`ARWF-7`) — never run a paused roster agent. A schedule, a
  // scheduled chat and a follow-up all fire through here; before this only the
  // heartbeat honoured the roster's switch. Non-destructive like the gates above:
  // the slot is skipped and resuming the agent resumes the job. Applies to Run now
  // too, matching "check now" on a paused agent (`routes/agentOps.ts`).
  //
  // ADR 0775 P3b — and honour the agent's EXPLICIT rules for this workflow: on
  // `permissions.never` the slot is skipped; on `hitl` it files one pending
  // approval (or finds the one already filed) instead of running, and approving
  // it fires the job through this recipe with `approvedProposalId`.
  const agentRef = jobAgentRef(job);
  if (agentRef !== undefined) {
    const verdict = await autonomousDispatchVerdict(job.tenantId, agentRef, job.workflowId);
    if (!verdict.allowed && verdict.reason === 'agent-paused') {
      log.info('schedule fire dropped — the agent it runs as is paused', { jobId: job.jobId, tenantId: job.tenantId, rosterId: verdict.rosterId });
      return skip(job.jobId, 'agent-paused', now);
    }
    if (!verdict.allowed && verdict.reason === 'policy-denied') {
      log.info("schedule fire dropped — the workflow is on the agent's never list", { jobId: job.jobId, tenantId: job.tenantId, rosterId: verdict.rosterId, workflowId: job.workflowId });
      return skip(job.jobId, 'policy-denied', now);
    }
    if (!verdict.allowed && verdict.reason === 'needs-approval' && opts.approvedProposalId === undefined) {
      if (!(await hasPendingApprovalForJob(job.tenantId, job.jobId))) {
        await createApproval({
          tenantId: job.tenantId,
          rosterId: verdict.entry.rosterId,
          persona: verdict.entry.persona,
          workflowId: job.workflowId!,
          ...(job.configurable !== undefined ? { configurable: job.configurable } : {}),
          scheduleJobId: job.jobId,
          proposal: `Run ${job.workflowId} (scheduled)`,
        });
      }
      log.info("schedule fire held for approval — the workflow is on the agent's hitl list", { jobId: job.jobId, tenantId: job.tenantId, rosterId: verdict.entry.rosterId });
      return skip(job.jobId, 'awaiting-approval', now);
    }
  }
  // Autonomous-run budget: drop (don't queue) a fire that would exceed the
  // tenant's window ceiling. The slot already advanced, so the schedule just
  // skips this slot and resumes next window — it cannot run away on cost.
  if (opts.applyBudget) {
    const budget = await checkAutonomousRunBudget(deps.storage, job.tenantId, now);
    if (!budget.allowed) {
      log.warn('schedule fire dropped — tenant over autonomous-run budget', {
        jobId: job.jobId, tenantId: job.tenantId, current: budget.current, limit: budget.limit,
      });
      return skip(job.jobId, 'budget', now);
    }
  }
  let runId: string | null;
  try {
    runId = await startWorkflowRun(deps, {
      tenantId: job.tenantId,
      workflowId: job.workflowId!,
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(job.configurable !== undefined ? { configurable: job.configurable } : {}),
      // Per-fire inputs seed the run's variable bag (`seedRunVariables`). A
      // workflow that declares `variables[]` — the KickTodo daily loop declares
      // `enrollmentId`/`ownerSubject` — runs with them UNDEFINED unless the job
      // carries them.
      ...(job.inputs !== undefined ? { inputs: job.inputs } : {}),
      // ADR 0879 D7 — a feature-created job that acts for nobody can still name the
      // human who CAUSED it (a scheduled chat's creator). It only narrows (ADR 0832
      // D3); the run-conversation write gate reads it as the poster. Host-written:
      // the scheduler route strips the key from client metadata.
      ...(typeof job.metadata?.orgScopeSubject === 'string' ? { orgScopeSubject: job.metadata.orgScopeSubject } : {}),
      ...(typeof job.metadata?.personalTenant === 'string' ? { personalTenant: job.metadata.personalTenant } : {}),
      // `ScheduledJob.metadata` is free-form attribution carried onto the run.
      // The assistant loops (ADR 0023 §12 T2) rely on it to carry
      // `actingUserId`, which the Connections resolver keys per-user credentials
      // off (ADR 0024 Phase D). SECURITY (defense in depth): the scheduler ROUTE
      // strips the attribution keys from client-supplied metadata and stamps
      // `actingUserId` from the authenticated principal; this spread additionally
      // refuses to forward the run-attribution blocks (`heartbeat`/`kanban`/
      // `approval` would outrank the `schedule` block in recordRunAttribution).
      // The schedule block spreads LAST.
      metadata: {
        ...Object.fromEntries(
          // ADR 0902 D2 — never the task-deck linkage either (a job written before
          // the scheduler route stripped it must not plant cards on each fire).
          Object.entries(job.metadata ?? {}).filter(([k]) => k !== 'heartbeat' && k !== 'kanban' && k !== 'approval' && k !== 'schedule' && !(CALLER_LINKAGE_KEYS as readonly string[]).includes(k)),
        ),
        schedule: {
          jobId: job.jobId,
          source: 'schedule',
          trigger: opts.trigger,
          ...(opts.triggeredBy !== undefined ? { triggeredBy: opts.triggeredBy } : {}),
          ...(job.rosterId !== undefined ? { rosterId: job.rosterId } : {}),
          ...(job.ownerUserId !== undefined ? { ownerUserId: job.ownerUserId } : {}),
          ...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
          // ADR 0046 — the CANONICAL owner (any Subject kind), so a project-fired
          // run isn't anonymous.
          ...((s) => (s ? { ownerScope: subjectScope(s) } : {}))(scheduleSubject(job)),
        },
      },
    });
  } catch (err) {
    // ADR 0820 §7 / G6 — the launch funnel refused the WORKFLOW's owning feature
    // (a job with no `featureId` of its own, e.g. one created before its feature
    // stamped jobs, is gated through its workflow: backfill-on-read). Same split:
    // a plan refusal is the plan-lapsed skip, anything else a quiet skip, never
    // an error.
    if (err instanceof WorkflowFeatureRefusedError) {
      if (err.blockedBy === 'plan') return planLapsedSkip(job, err.featureId, now);
      log.info('schedule fire dropped — the workflow\'s owning feature is unavailable for this tenant', {
        jobId: job.jobId, tenantId: job.tenantId, featureId: err.featureId, blockedBy: err.blockedBy,
      });
      return skip(job.jobId, 'feature-disabled', now);
    }
    // The slot already advanced, so a dispatch error can't wedge the schedule.
    log.error('schedule fire failed', { jobId: job.jobId, error: err instanceof Error ? err.message : String(err) });
    return skip(job.jobId, 'dispatch-error', now);
  }
  if (!runId) {
    log.warn('schedule due but workflow did not resolve', { jobId: job.jobId, workflowId: job.workflowId });
    return skip(job.jobId, 'workflow-unresolved', now);
  }
  // ADR 0787 D2 — a run STARTED. Losing the bookkeeping write to contention must
  // not relabel it a `dispatch-error`; it is logged on its own.
  await recordJobRun(job.jobId, runId, now).catch((err: unknown) => {
    log.warn('schedule run started but its bookkeeping write failed', {
      jobId: job.jobId, runId, error: err instanceof Error ? err.message : String(err),
    });
  });
  return { runId };
}

/**
 * ADR 0820 §7 — the lapse AUTO-PAUSE, computed at tick time. The tenant's plan
 * no longer includes the job's owning feature, so this slot is skipped with the
 * distinguishable reason `plan-lapsed` (and the feature, for the schedules UI).
 * Nothing else is written: the row stays `enabled`, its cadence, workflow,
 * inputs and metadata are untouched, and no run — failed or otherwise — is
 * created. Re-entitlement therefore resumes the job on its next tick with no
 * sweep and no manual step (`recordJobRun` clears the skip note).
 *
 * Why computed, not a persisted paused flag (the shape #4436 first shipped):
 * a flag is tenant state that must be undone exactly, and every lane that
 * touches `enabled` (a person's toggle, member removal, DSAR erasure, the
 * resume sweep's own cadence and failure modes) has to agree with it. A computed
 * skip is reversible by construction. The cost is one `resolveOne` per due slot
 * of a gated job, which `fireJob` already paid. No notification is sent per
 * tick: the skip is visible on the row, never pushed.
 */
async function planLapsedSkip(job: ScheduledJob, featureId: string, now: number): Promise<FireOutcome> {
  log.info('schedule skipped — the plan no longer includes its feature (plan-lapsed)', { jobId: job.jobId, tenantId: job.tenantId, featureId });
  await recordJobSkipped(job.jobId, 'plan-lapsed', now, featureId).catch((err: unknown) => {
    log.warn('schedule skip bookkeeping failed', { jobId: job.jobId, reason: 'plan-lapsed', error: err instanceof Error ? err.message : String(err) });
  });
  return { skipped: 'plan-lapsed' };
}

/** How often the daemon re-checks plan-paused jobs for returned access. Slow on
 *  purpose: a resume is not latency-sensitive, and each check is a toggle +
 *  entitlement read per paused job. */
export const PLAN_RESUME_INTERVAL_MS = 10 * 60_000;
let lastPlanResumeCheckAt = Number.NEGATIVE_INFINITY;

/**
 * ADR 0820 §7 — LEGACY DRAIN. Rows paused by the persisted-flag shape (#4436:
 * `enabled:false` + `planPause`) are no longer created — the lapse is now a
 * computed skip (`planLapsedSkip`) — but any already written must still come
 * back. RESUME every plan-paused job whose feature the tenant may use
 * again. Runs at most once per `PLAN_RESUME_INTERVAL_MS` from the poll (pass
 * `force` in tests). Reads the job list the pass already holds. Fail-closed: a
 * resolution error leaves the job paused for the next sweep. Returns how many
 * jobs resumed.
 */
export async function resumePlanPausedJobs(all: readonly ScheduledJob[], now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastPlanResumeCheckAt < PLAN_RESUME_INTERVAL_MS) return 0;
  lastPlanResumeCheckAt = now;
  let resumed = 0;
  for (const job of all) {
    if (job.enabled || !job.planPause) continue;
    let enabled = false;
    try {
      enabled = (await resolveOne(job.planPause.featureId, { tenantId: job.tenantId }))?.enabled === true;
    } catch {
      enabled = false;
    }
    if (!enabled) continue;
    try {
      if (await resumeJobFromPlanPause(job.jobId, now)) {
        resumed += 1;
        log.info('schedule resumed — the plan includes its feature again', { jobId: job.jobId, tenantId: job.tenantId, featureId: job.planPause.featureId });
      }
    } catch (err) {
      log.warn('schedule plan-lapse resume failed', { jobId: job.jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return resumed;
}


async function skip(jobId: string, reason: ScheduleSkipReason, now: number): Promise<FireOutcome> {
  await recordJobSkipped(jobId, reason, now).catch((err: unknown) => {
    log.warn('schedule skip bookkeeping failed', { jobId, reason, error: err instanceof Error ? err.message : String(err) });
  });
  return { skipped: reason };
}

/**
 * Fire every due scheduled job exactly once across the fleet. Returns the number
 * of runs this instance started (0 when nothing was due or every due job was
 * claimed by another instance). Exported for deterministic tests — pass a fixed
 * `now`; the running daemon passes `Date.now()`.
 *
 * ADR 0787 D1 — three layers, none of which depends on a lease expiring on time:
 *  1. the per-(job, slot) claim (stamped with the CLAIM time);
 *  2. `claimDueSlot`, the fence: a re-read + compare-and-swap that fires only
 *     while the row is still enabled, bound and due at exactly this slot — so a
 *     pass that wakes after the claim prune, or read a row since disabled,
 *     deleted or erasure-scrubbed, fires nothing;
 *  3. a deterministic run id, so a slot re-fired by anything collapses at the
 *     run store.
 * The list is only a candidate set; nothing after the fence reads it.
 */
export async function processDueSchedules(
  deps: StartRunDeps,
  now: number = Date.now(),
): Promise<number> {
  // Every tenant's jobs (the store has no cross-tenant "due" query —
  // `SCTWF-20`), but not a fresh scan on every tick (ADR 0803): the candidate
  // list is re-read only when the job set changed, a job is due, or it is stale.
  const all = await listJobsForDaemon(now);
  // ADR 0787 D6 — revive rows the pre-0787 30-day search stranded (and any
  // cadence whose next slot has since come inside the horizon, e.g. a leap-day
  // cron). A CAS per candidate; best-effort — a revival failure never fails the
  // pass. Revived rows are picked up as due on the next pass, not this one.
  for (const job of all) {
    if (!isStalled(job)) continue;
    try {
      if (await reviveStalledJob(job.jobId, now)) log.info('schedule revived — next fire recomputed for a stranded cadence', { jobId: job.jobId });
    } catch (err) {
      log.warn('schedule revival failed', { jobId: job.jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // ADR 0820 §7 — the slow resume sweep for plan-paused jobs (best-effort).
  await resumePlanPausedJobs(all, now).catch((err: unknown) => {
    log.warn('schedule plan-resume sweep failed', { error: err instanceof Error ? err.message : String(err) });
  });
  const due = all
    .filter((j) => j.enabled && j.workflowId && typeof j.nextFireAt === 'number' && j.nextFireAt <= now)
    .sort((a, b) => (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0))
    .slice(0, FIRE_BATCH);

  let fired = 0;
  for (const listed of due) {
    const slot = listed.nextFireAt!;
    const claimKey = `${CLAIM_KEY_PREFIX}${listed.jobId}:${slot}`;
    // Stamped with the CLAIM time, not the pass start: a claim minted by a pass
    // that stalled after listing must not be born already prunable.
    const claim = await deps.storage.claimOnce(claimKey, new Date().toISOString());
    if (!claim.claimed) continue;
    let job: ScheduledJob | null;
    try {
      job = await claimDueSlot(listed.jobId, slot, currentTick(), now);
    } catch (err) {
      // The claim is already taken, so later passes skip this slot until the
      // claim is pruned (~10 min): the fire is LATE, not lost (the row still says
      // it is due). Only five straight lost swaps land here (`SCTCD-6`).
      log.warn('schedule fence lost to contention — slot deferred until its claim is pruned', {
        jobId: listed.jobId, slot, error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!job) {
      log.info('schedule fire superseded — the row is no longer due at this slot', { jobId: listed.jobId, slot });
      continue;
    }
    const outcome = await fireJob(deps, job, {
      runId: scheduledRunId(job.tenantId, job.jobId, slot),
      trigger: 'schedule',
      applyBudget: true,
      now,
    });
    if ('runId' in outcome) {
      fired++;
      log.info('schedule fired', { jobId: job.jobId, workflowId: job.workflowId, runId: outcome.runId, slot });
    }
  }
  return fired;
}

/** Delete this daemon's stale per-(job, slot) claim keys so the idempotency
 *  table stays bounded. Best-effort: a prune failure must not fail the tick. */
export async function pruneStaleScheduleClaims(deps: StartRunDeps, now: number = Date.now()): Promise<number> {
  try {
    return await deps.storage.pruneOnceByPrefix(CLAIM_KEY_PREFIX, new Date(now - CLAIM_PRUNE_AGE_MS).toISOString());
  } catch (err) {
    log.warn('schedule claim prune failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

export interface ScheduleDaemon {
  stop(): void;
}

// ADR 0690 — LIVENESS, so a readiness report can say "the daemon that fires
// every reminder is actually ticking on this instance" rather than "a route
// exists" (PRD §8.2: a route existing is not enough). Module-level because
// there is one daemon per process; `ageMs` is the honest signal — a started
// daemon whose last tick is minutes old is starved (CPU throttling at
// minScale 0), which is the exact production shape this was written to expose.
let daemonStartedAt: string | null = null;
let daemonLastTickAt: string | null = null;

export interface ScheduleDaemonLiveness {
  started: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  /** ms since the last completed tick; null before the first. */
  ageMs: number | null;
  pollIntervalMs: number;
  instanceId: string;
}

export function scheduleDaemonLiveness(): ScheduleDaemonLiveness {
  return {
    started: daemonStartedAt !== null,
    startedAt: daemonStartedAt,
    lastTickAt: daemonLastTickAt,
    ageMs: daemonLastTickAt ? Math.max(0, Date.now() - Date.parse(daemonLastTickAt)) : null,
    pollIntervalMs: POLL_INTERVAL_MS,
    instanceId: getInstanceId(),
  };
}

// ADR 0787 D7 — the FLEET, durably. `scheduleDaemonLiveness` above is one
// process's view, so it cannot say what an operator most needs after a traffic
// shift: is an instance of a SUPERSEDED revision still ticking (WHD-28)? Each tick
// upserts one row per instance carrying its Cloud Run revision and build commit;
// rows older than an hour are pruned on the tick. Host-global operational rows —
// no tenant, no subject. SCOPE, stated: an instance running pre-0787 code writes
// nothing here, so it is visible only through Cloud Run's own listing.
export interface ScheduleDaemonInstance {
  instanceId: string;
  revision: string | null;
  commit: string | null;
  startedAt: string;
  lastTickAt: string;
}

const FLEET_STALE_MS = 60 * 60_000;
const fleet = new DurableCollection<ScheduleDaemonInstance>('scheduler:daemon', (r) => r.instanceId);

/** Record this instance's tick, and prune instances silent for over an hour.
 *  Best-effort: observability must never fail the tick. */
export async function noteFleetTick(nowMs: number = Date.now()): Promise<void> {
  try {
    const at = new Date(nowMs).toISOString();
    await fleet.put({
      instanceId: getInstanceId(),
      revision: process.env.K_REVISION ?? null,
      commit: process.env.OPENWOP_BUILD_COMMIT ?? null,
      startedAt: daemonStartedAt ?? at,
      lastTickAt: at,
    });
    for (const row of await fleet.list()) {
      if (nowMs - Date.parse(row.lastTickAt) > FLEET_STALE_MS) await fleet.delete(row.instanceId);
    }
  } catch (err) {
    log.warn('schedule daemon fleet heartbeat failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Every instance running this code that ticked within the last hour, newest
 *  tick first — two distinct `revision`s here means two revisions are firing. */
export async function scheduleDaemonFleet(nowMs: number = Date.now()): Promise<ScheduleDaemonInstance[]> {
  return (await fleet.list())
    .filter((r) => nowMs - Date.parse(r.lastTickAt) <= FLEET_STALE_MS)
    .sort((a, b) => b.lastTickAt.localeCompare(a.lastTickAt));
}

/** Test-only: record a start + tick without running the daemon. */
export function __noteScheduleDaemonTickForTest(): void {
  const now = new Date().toISOString();
  daemonStartedAt ??= now;
  daemonLastTickAt = now;
}

/** Test-only: forget liveness. */
export function __resetScheduleDaemonLivenessForTest(): void {
  daemonStartedAt = null;
  daemonLastTickAt = null;
}

/**
 * Start the polling scheduler daemon for the running server. One pass at a time
 * (a slow pass never overlaps the next tick). Returns a handle whose `stop()`
 * clears the timer (call on graceful shutdown).
 */
export function startScheduleDaemon(deps: StartRunDeps): ScheduleDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await processDueSchedules(deps);
      await pruneStaleScheduleClaims(deps);
      await pruneRunBudget(deps.storage);
    } catch (err) {
      log.warn('schedule daemon tick error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      daemonLastTickAt = new Date().toISOString();
      await noteFleetTick();
      running = false;
    }
  };
  daemonStartedAt = new Date().toISOString();
  const timer = setInterval(() => void runUnderWorkerContract(tick), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('schedule daemon started', { pollIntervalMs: POLL_INTERVAL_MS, instanceId: getInstanceId() });
  return { stop: () => clearInterval(timer) };
}
