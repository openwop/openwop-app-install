/**
 * RFC 0052 — scheduling & time-based triggers (host-side service).
 *
 * Two cleanly separated concerns live here:
 *
 *  1. The DETERMINISTIC TICK SEAM (`singleTick` / `missedWindow` / `currentTick`)
 *     — an in-memory, synchronous clock that backs the
 *     `POST /v1/host/openwop-app/scheduling/tick` conformance seam. It honors the
 *     two RFC 0052 §B invariants:
 *       - §B.2 fire-once-per-tick: one scheduler wake-up fires a job exactly
 *         once; no duplicate concurrent runs.
 *       - §B.4 missed-tick policy: after the scheduler was down for N ticks,
 *         recovery applies fire-once-on-recovery (collapse the backlog to ONE
 *         run), never a flood of N backlogged runs.
 *     This stays in-memory on purpose: it is a per-process test clock the
 *     conformance harness drives within one process; durability is irrelevant.
 *
 *  2. The DURABLE JOB STORE (`registerJob` / `listJobs` / `getJob` /
 *     `deleteJob` / `setJobEnabled` / `markJobFired` / `listJobsByRoster`) —
 *     the CRUD surface behind `/v1/host/openwop-app/scheduler/jobs`. Backed by the
 *     read-through per-entity `DurableCollection` (host/hostExtPersistence.ts)
 *     so jobs survive a restart AND a job created on one Cloud Run instance is
 *     visible on every other (the app scales to max=10). Jobs carry optional
 *     roster/agent attribution + a metadata block so a schedule can be scoped
 *     to a named agent (PRD §13) and a schedule-fired run can show its source.
 *
 * Schedules beyond the advertised `maxFutureHorizon` are rejected at
 * registration with `schedule_horizon_exceeded` (per `rest-endpoints.md`).
 *
 * @see RFCS/0052-scheduling-and-time-based-triggers.md §B
 * @see spec/v1/host-capabilities.md §host.scheduling
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { onWorkflowForked } from './workflowsRegistry.js';
import { casRepoint } from './forkRepoint.js';
import type { Subject } from './subject.js';
import { computeNextFire, parseCron, isValidTimeZone, MAX_FUTURE_HORIZON_DAYS, MAX_FUTURE_HORIZON_ISO, MAX_FUTURE_HORIZON_MS } from './cronSchedule.js';
import { OpenwopError } from '../types.js';
import { legacyPrincipalOf } from '../features/users/usersService.js';
import { createLogger } from '../observability/logger.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import { registerIssuerRemovedHandler } from './delegatedSubject.js';
import { membershipDefinesPresence } from './accessControlService.js';
import { isSessionAuthorityRegistered, resolveSessionSubject } from './sessionAuthority.js';

const log = createLogger('schedulingService');

/** Largest future horizon the host honors — the advertised
 *  `capabilities.scheduling.maxFutureHorizon`. ONE constant pair (ms + ISO),
 *  owned by `cronSchedule.ts` because the cadence search is bounded by the same
 *  number; discovery, the error body and the model-facing tool prose all derive
 *  from it (ADR 0787 D6). */
export { MAX_FUTURE_HORIZON_MS, MAX_FUTURE_HORIZON_ISO, MAX_FUTURE_HORIZON_DAYS };

/** ADR 0309 D1 — the EXPLICIT one-shot cadence sentinel: `registerJob` takes the
 *  single fire time from `firstFireAtMs`, and the first fire spends the job.
 *  Opt-in by exact match — any other unparseable cron stays inert (GC-R2). */
export const ONE_SHOT_CRON = 'once';

/** Why a fire consumed its slot and produced no run (WF-COS-4). `'no-next-fire'`
 *  (ADR 0787 D6) is different in kind: the fire may well have run, but the
 *  cadence has no FURTHER slot, so the row would otherwise go quiet with nothing
 *  to say why. It survives `recordJobRun` for exactly that reason. */
export type ScheduleSkipReason =
  | 'budget'
  | 'workflow-unresolved'
  | 'dispatch-error'
  | 'feature-disabled'
  /** ADR 0820 §7 — the tenant's PLAN no longer includes the job's owning feature
   *  (`resolveOne` → `blockedBy:'plan'`). The computed auto-pause: the slot is
   *  skipped quietly, the row stays enabled, and the next tick after
   *  re-entitlement fires. `lastSkipFeatureId` names the feature. */
  | 'plan-lapsed'
  /** ADR 0815 D4 — the person the job acts as is no longer active (a SCIM
   *  deprovision or an admin's deactivate). Non-destructive: reactivating them
   *  resumes it. */
  | 'actor-inactive'
  /** ADR 0775 P3 (`ARWF-7`) — the roster agent the job runs as is paused
   *  (`enabled:false`). Non-destructive: resuming the agent resumes the job. */
  | 'agent-paused'
  /** ADR 0775 P3b — the workflow is on the agent's `permissions.never` list. */
  | 'policy-denied'
  /** ADR 0775 P3b — the workflow is on the agent's `hitl` list: this slot filed
   *  (or found) a pending approval instead of running. Approving it runs the job. */
  | 'awaiting-approval'
  /** ADR 0908 D8 — the goal this continuation serves is closed, missing, or past
   *  an RFC 0058 bound (a fire gate refused it; the goal is closed by that path).
   *  Disarmed with it, so this is normally the last skip the job records. */
  | 'goal-closed'
  | 'no-next-fire';

export interface ScheduledJob {
  jobId: string;
  /** Owning tenant (RFC 0074 carry-forward) — the CRUD surface is tenant-scoped. */
  tenantId: string;
  /** Cron expression or interval label (sample does not parse it fully —
   *  the tick evaluator drives wake-ups directly). */
  cronExpr: string;
  /** Monotonic tick index this job last fired at; null until first fire. */
  lastFiredTick: number | null;
  /** workflowId a tick fires (informational for the CRUD surface). */
  workflowId?: string;
  /** Optional RFCS/0086 roster member that owns this schedule (attribution +
   *  the agent-scoped "Schedules" tab filter). */
  rosterId?: string;
  /** ADR 0025 — a human USER that owns this schedule (the user/agent symmetry).
   *  Mutually exclusive with `rosterId`; powers the profile "Schedules" tab. */
  ownerUserId?: string;
  /** ADR 0045/0046 — the GENERIC owner. The forward home for the legacy
   *  `rosterId`/`ownerUserId` discriminator (same additive move the board's
   *  `ownerSubject` made); lets a `kind:'project'` (or any new kind) own a
   *  schedule with zero new infrastructure. When set it WINS over the legacy
   *  fields in `scheduleSubject`. */
  ownerSubject?: Subject;
  /** The manifest agent the owning roster member instantiates (attribution). */
  agentId?: string;
  /** Whether the schedule is active. A disabled schedule keeps its row but its
   *  triggers are inert (mirrors the roster `enabled` posture). */
  enabled: boolean;
  /** Free-form attribution carried onto a schedule-fired run's metadata. */
  metadata?: Record<string, unknown>;
  /** Run-level `configurable` for fired runs — e.g. `connections: ['google']`,
   *  the ADR 0024 §4 / Option C credential opt-in the assistant loops use. */
  configurable?: Record<string, unknown>;
  /** Per-fire workflow INPUTS, seeded into the run's variable bag by
   *  `seedRunVariables` (so `input('x')` / `{{inputs.x}}` resolve). A workflow
   *  that declares `variables[]` but whose scheduled fires carry no inputs runs
   *  with those variables UNDEFINED — the KickTodo daily loop did exactly that
   *  until this field existed (its `input('enrollmentId')` nodes were inert on
   *  every scheduled tick). SERVER-STAMPED ONLY: the scheduler HTTP route does
   *  not read this from the client body, because seeding arbitrary variables
   *  into a scheduled run is a capability only internal callers should hold. */
  inputs?: Record<string, unknown>;
  /** runId of the most recent run this schedule fired. */
  lastRunId?: string;
  /**
   * ISO-8601 wall-clock time the most recent RUN started. Distinct from
   * `lastFiredTick` (the deterministic tick index); this is the human-facing
   * "last run …" timestamp, and it is PAIRED with `lastRunId` — the two always
   * describe the same run.
   *
   * WF-COS-4 (2026-08-19): it used to be stamped by `markJobFired`, which the
   * daemon calls BEFORE dispatch. So a fire that was then dropped for budget,
   * failed to resolve a workflow, or threw still advanced `lastRunAt` to NOW
   * while leaving `lastRunId` at the PREVIOUS fire's value — and every consumer
   * renders that pair together. The assistant loop panel said "last run: just
   * now" with a `/runs/<id>` link to a run from hours earlier: a run that never
   * happened, reported as one that did.
   *
   * PRECISELY WHAT CHANGED — and this sentence used to be wrong, which is worth
   * keeping visible. It said "`markJobFired` now stamps this ONLY when a runId
   * is supplied". It does NOT: `markJobFired`'s body is byte-identical to what
   * it always was and stamps `lastRunAt` UNCONDITIONALLY. What changed is the
   * CALLERS. The daemon no longer calls it at all — it uses `advanceJobSlot` +
   * `recordJobRun`/`recordJobSkipped` below, so the two facts are stamped
   * separately. The deterministic-tick trigger route keeps calling it for the
   * shape where a fire IS the event (a job bound to no workflow), and takes the
   * split path when a bound workflow fails to resolve. The stamp is therefore
   * honest by CALLER DISCIPLINE, not by a guard inside this function.
   */
  lastRunAt?: string;
  /** WF-COS-4 — the honest counterpart: the most recent fire that advanced the
   *  slot and produced NO run, with the reason. Absent ⇒ every fire so far
   *  produced a run. A surface that renders `lastRunAt` should render this too,
   *  or it is showing half the truth. */
  lastSkippedAt?: string;
  /** WF-COS-4 — why the last skipped fire produced no run. */
  lastSkipReason?: ScheduleSkipReason;
  /** ADR 0787 D6 — the slot a `'once'` job fired at. A re-registration of the SAME
   *  id asking for a fire at or before it is the retried call that already fired,
   *  and is answered with the prior row instead of re-arming it. */
  oneShotFiredAt?: number;
  /**
   * ADR 0599 §6 — the feature that OWNS this schedule, resolved against the
   * feature-toggle service at FIRE TIME (`scheduleDaemon`). Absent ⇒ ungated,
   * which is every pre-existing job, so this is purely additive.
   *
   * Why a fire-time gate and not a teardown listener. `insights-suite` protected
   * its schedules with a toggle-status listener that deleted every tenant's job
   * when the GLOBAL status flipped to `off`. That is backwards in both
   * directions at once: the listener fires only on a change to the global
   * `status` field, so a per-tenant `tenantOverrides[t]={status:'off'}` — the
   * only per-tenant disable that exists — tore down NOTHING and that tenant's
   * jobs kept firing; while a global flip to `off` ran a repo-global scan and
   * hard-deleted the jobs of tenants the same request had explicitly KEPT
   * enabled, with no auto-resurrect. A gate on the CREATION lane is not a gate
   * on the USE lane. Resolving the toggle for `job.tenantId` at the moment of
   * firing is per-tenant and correct in both directions, and it is
   * non-destructive: re-enabling simply resumes.
   */
  featureId?: string;
  /**
   * ADR 0820 §7 — LEGACY lapse auto-pause marker. No longer written (the lapse
   * is a computed `plan-lapsed` skip since the lapse-pause change); rows written
   * before it are drained by `resumePlanPausedJobs`. It WAS set (with `enabled:false`) by the
   * daemon when a fire is refused because the tenant's PLAN no longer includes
   * the owning feature (`blockedBy:'plan'` — never for a toggle switched off,
   * which stays a per-tick skip), so a lapsed job stops failing on every tick.
   * The daemon's slow resume sweep re-enables it once access returns. Any
   * explicit enable/disable by a person clears it (their intent wins).
   * Server-owned: no client lane writes top-level job fields. Non-destructive.
   */
  planPause?: { reason: 'plan_lapsed'; featureId: string; at: string };
  /** ADR 0820 §7 — the feature a `plan-lapsed` skip was refused for (set only
   *  with that reason; cleared with it). Bookkeeping, never config. */
  lastSkipFeatureId?: string;
  /** IANA timezone the cadence is expressed in. The background daemon
   *  (scheduleDaemon.ts) evaluates the cadence against this zone when computing
   *  `nextFireAt`; the deterministic tick seam still ignores it. */
  timezone?: string;
  /** Epoch-ms wall-clock time the background daemon should next fire this job,
   *  computed from `cronExpr` (+ `timezone`). Undefined when the cron expression
   *  doesn't parse (the daemon skips such jobs) or the schedule is one-shot/spent.
   *  Advanced past each fire in `markJobFired` (collapsing any missed backlog to
   *  the next future slot — RFC 0052 §B.4). */
  nextFireAt?: number;
  /** ISO-8601 registration timestamp (informational). */
  createdAt?: string;
}

// ── 1. Deterministic tick seam (in-memory, synchronous) ──

/** The conformance tick clock's per-job fire bookkeeping. SEPARATE from the
 *  durable CRUD store — this is the process-local test clock only. */
const tickClockJobs = new Map<string, { lastFiredTick: number | null }>();
/** Monotonic scheduler wake-up counter (the "clock" the seam advances). */
let tickIndex = 0;

/** Default job the seam drives when no explicit job is registered. */
const DEMO_JOB_ID = 'demo-cron';

export interface TickResult {
  runsFired: number;
}

function ensureClockJob(jobId: string): { lastFiredTick: number | null } {
  let job = tickClockJobs.get(jobId);
  if (!job) {
    job = { lastFiredTick: null };
    tickClockJobs.set(jobId, job);
  }
  return job;
}

/** The current monotonic tick index (read-only). */
export function currentTick(): number {
  return tickIndex;
}

/**
 * Advance the clock by one tick and fire the job. §B.2: a job fires at most
 * once per tick — calling again at the same tick yields 0.
 */
export function singleTick(jobId: string = DEMO_JOB_ID): TickResult {
  tickIndex += 1;
  const job = ensureClockJob(jobId);
  if (job.lastFiredTick === tickIndex) return { runsFired: 0 };
  job.lastFiredTick = tickIndex;
  return { runsFired: 1 };
}

/**
 * Recover from a window where the scheduler was down for `missedTicks`
 * ticks. §B.4: advance the clock past the missed window and apply
 * fire-once-on-recovery — exactly ONE run, never `missedTicks`.
 */
export function missedWindow(missedTicks: number, jobId: string = DEMO_JOB_ID): TickResult {
  const skipped = Number.isFinite(missedTicks) && missedTicks > 0 ? Math.floor(missedTicks) : 1;
  tickIndex += skipped;
  const job = ensureClockJob(jobId);
  job.lastFiredTick = tickIndex;
  return { runsFired: 1 };
}

// ── 2. Durable CRUD job store ──

// ── ADR 0803 — the daemon does not list every job on every tick ──
//
// The daemon used to call `listJobs()` — a full scan of every tenant's jobs —
// every 30 s on every live instance (`SCTWF-20`: the store has no cross-tenant
// "due" query). MEASURED 2026-10-02 (`EVID-5`): Postgres spilled a ~4.7 MB sort
// to a temp file about every 30 s per instance, all day, and one of those
// statements was the one cancelled by the statement timeout when the database
// was throttled. A job set changes rarely and is due rarely; the scan ran 2,880
// times a day per instance regardless.
//
// So: one tiny row holds a random "the job set changed" token. Every successful
// write through THIS store writes the job row FIRST and the token SECOND; the
// daemon reads the token FIRST and lists SECOND (`listJobsForDaemon`), so a
// change can never be read as "unchanged". It re-lists only when the token has
// moved, when the earliest due time it knows of has arrived, or after
// `DAEMON_LIST_MAX_STALE_MS` — the backstop for any writer that bypasses this
// store (a raw kv write, a second collection instance on the same prefix).
//
// Firing stays fenced exactly as before: the list is only a CANDIDATE set, and
// `claimDueSlot` re-reads and compare-and-swaps the row before anything fires.
// The worst a stale list can do is make a fire LATE (bounded by the backstop);
// it cannot fire a deleted, disabled or rescheduled job.
const JOBS_GENERATION_ID = 'all';
const jobsGeneration = new DurableCollection<{ id: string; token: string; at: string }>('scheduler:job-generation', (r) => r.id);

/** Most a cached candidate list may age before the daemon re-lists anyway. */
export const DAEMON_LIST_MAX_STALE_MS = 5 * 60_000;

interface DaemonListCache { token: string | null; jobs: ScheduledJob[]; earliestDueAt: number; listedAt: number }
let daemonListCache: DaemonListCache | null = null;
let daemonFullLists = 0;

async function bumpJobsGeneration(): Promise<void> {
  // This instance re-lists next tick whatever happens below; other instances
  // see the token move — or, if this write fails, their backstop.
  daemonListCache = null;
  try {
    await jobsGeneration.put({ id: JOBS_GENERATION_ID, token: randomUUID(), at: new Date().toISOString() });
  } catch (err) {
    log.warn('schedule job-set token not advanced — other instances will notice this change at their backstop', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const jobs = new DurableCollection<ScheduledJob>('scheduler:job', (j) => j.jobId);

// Every successful write through THIS store also advances the job-set token
// (row FIRST, token SECOND). Wrapped on the instance rather than subclassed so
// the store keeps its plain declaration above, which the ADR 0464 erasure
// ratchet reads to find it.
{
  const put = jobs.put.bind(jobs);
  const putIfAbsent = jobs.putIfAbsent.bind(jobs);
  const compareAndSwap = jobs.compareAndSwap.bind(jobs);
  const remove = jobs.delete.bind(jobs);
  const purgeTenantRows = jobs.purgeTenantRows.bind(jobs);
  const clear = jobs.__clear.bind(jobs);
  jobs.put = async (item) => { await put(item); await bumpJobsGeneration(); };
  jobs.putIfAbsent = async (item) => { const created = await putIfAbsent(item); if (created) await bumpJobsGeneration(); return created; };
  jobs.compareAndSwap = async (expected, next) => { const swapped = await compareAndSwap(expected, next); if (swapped) await bumpJobsGeneration(); return swapped; };
  jobs.delete = async (id) => { const removed = await remove(id); if (removed) await bumpJobsGeneration(); return removed; };
  jobs.purgeTenantRows = async (tenantId) => { const n = await purgeTenantRows(tenantId); if (n > 0) await bumpJobsGeneration(); return n; };
  jobs.__clear = async () => { await clear(); daemonListCache = null; };
}

/** The earliest moment any listed job can be due. A stalled row is not counted:
 *  its revival is a write (which moves the token), and a revival that keeps
 *  failing must not turn every tick back into a full scan — the backstop covers it. */
function earliestDueAt(all: readonly ScheduledJob[]): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const j of all) {
    if (!j.enabled || !j.workflowId || typeof j.nextFireAt !== 'number') continue;
    if (j.nextFireAt < earliest) earliest = j.nextFireAt;
  }
  return earliest;
}

/**
 * ADR 0803 — the daemon's candidate list: every job, as `listJobs()` returns it,
 * but read from the last full list while nothing has changed and nothing is due.
 * One point read per call in the steady state instead of a full scan.
 */
export async function listJobsForDaemon(nowMs: number = Date.now()): Promise<ScheduledJob[]> {
  const token = (await jobsGeneration.get(JOBS_GENERATION_ID))?.token ?? null;
  const cached = daemonListCache;
  if (cached && cached.token === token && nowMs < cached.earliestDueAt && nowMs - cached.listedAt < DAEMON_LIST_MAX_STALE_MS) {
    return cached.jobs;
  }
  const all = await listJobs();
  daemonFullLists += 1;
  daemonListCache = { token, jobs: all, earliestDueAt: earliestDueAt(all), listedAt: nowMs };
  return all;
}

/** Test seam: how many full lists `listJobsForDaemon` has made. */
export function __daemonFullListCount(): number { return daemonFullLists; }


export interface ScheduleHorizonError {
  /** `jobid_conflict` (ADR 0379 P2): the explicit jobId belongs to another
   *  tenant — reported with the same not-available message either way (no
   *  cross-tenant existence oracle). `invalid_cron` / `invalid_timezone` /
   *  `schedule_horizon_exceeded` (ADR 0787 D6): an ENABLED job whose cadence can
   *  never fire is refused at write instead of stored inert. `write_contention`
   *  (D2): the upsert lost its compare-and-swap on every retry. */
  code: 'schedule_horizon_exceeded' | 'jobid_conflict' | 'invalid_cron' | 'invalid_timezone' | 'write_contention';
  message: string;
}

/** ADR 0787 D2 — a job write lost its compare-and-swap on every bounded retry.
 *  Typed and loud, never a silent drop: a mutator that gave up quietly is how a
 *  disable used to be undone. 409 because the caller can simply retry. */
export class ScheduleWriteContention extends OpenwopError {
  constructor(jobId: string) {
    super('conflict', 'This schedule is being changed by something else right now. Try again.', 409, { jobId });
  }
}

/** ADR 0787 D3 — a DSAR-erased job cannot be re-enabled: it would fire as the
 *  sentinel, or as nobody. Re-creating it is the way forward. */
export class JobErasedError extends OpenwopError {
  constructor(jobId: string) {
    super('conflict', 'This schedule belonged to an erased account and cannot be re-enabled. Create a new one instead.', 409, { jobId });
  }
}

/** ADR 0815 D4 — the server-owned pause marker the member-removed cascade
 *  stamps. A reserved metadata key on the client lanes (`routes/scheduler.ts`). */
export const ACTING_MEMBER_REMOVED = 'acting_member_removed';

export function isPausedForRemovedMember(job: Pick<ScheduledJob, 'metadata'>): boolean {
  return job.metadata?.disabledReason === ACTING_MEMBER_REMOVED;
}

/** ADR 0815 D4 — refused: re-arming or running a job paused because the member
 *  it acts as left the workspace, without a new actor. Typed so every door that
 *  ENABLES through `updateJob`/`setJobEnabled` answers 409, not 500. (Lanes that
 *  re-REGISTER instead — assistant loops, goals, scheduled chats — keep the job
 *  paused silently: see `registerJob`.) A FEATURE-owned job keeps its actor in
 *  the feature's own rows too, so it cannot be re-owned from here at all. */
export class ActingMemberRemovedError extends OpenwopError {
  constructor(jobId: string, featureOwned = false) {
    super(
      'conflict',
      featureOwned
        ? 'This schedule was paused because the member it ran as left the workspace. Create it again from its feature.'
        : 'This schedule was paused because the member it ran as left the workspace. Resuming it makes you its owner.',
      409,
      { jobId, reason: ACTING_MEMBER_REMOVED, ...(featureOwned ? { recreate: true } : {}) },
    );
  }
}

/**
 * ADR 0815 D4 — every identity a job ACTS AS: its owner subject (a `user` kind),
 * the legacy `ownerUserId`, the `metadata.actingUserId` the Connections resolver
 * keys credentials off, and `inputs.ownerSubject` (the KickTodo loop's). Agents
 * are not people and are not listed.
 */
function jobActors(job: ScheduledJob): string[] {
  const out: string[] = [];
  if (job.ownerSubject?.kind === 'user') out.push(job.ownerSubject.id);
  if (job.ownerUserId) out.push(job.ownerUserId);
  if (typeof job.metadata?.actingUserId === 'string') out.push(job.metadata.actingUserId);
  if (typeof job.inputs?.ownerSubject === 'string') out.push(job.inputs.ownerSubject);
  return out;
}

/** Does `job` act as `subject`, in any of the forms a store spells it
 *  (`user:<id>` or the raw id — the `eraseSubjectSchedules` matching)? Exact
 *  string forms only: never an alias across issuers. */
function jobActsAs(job: ScheduledJob, subject: string): boolean {
  const { forms } = subjectKeyForms(subject);
  return jobActors(job).some((a) => forms.has(a));
}

/**
 * ADR 0815 D4 — is a PERSON this job acts as deactivated (a SCIM deprovision, an
 * admin's deactivate)? Those lanes change the account, not a membership, so the
 * removal cascade never sees them — the same reading ADR 0795 gives a key's
 * issuer. A point read per `user:` actor at fire time. "No row" is not
 * "inactive" (erasure has its own lane), and a lookup error lets the fire
 * proceed: a skip is the cheap direction, but a store blip must not silence
 * every schedule in a tenant.
 */
export async function jobActorIsInactive(job: ScheduledJob): Promise<boolean> {
  if (!isSessionAuthorityRegistered()) return false;
  for (const actor of new Set(jobActors(job).filter((a) => a.startsWith('user:')))) {
    try {
      const state = await resolveSessionSubject(actor);
      if (state !== null && state.status !== 'active') return true;
    } catch (err) {
      log.warn('schedule actor status unreadable — firing', { jobId: job.jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return false;
}

/** ADR 0787 D6 — an enabled job's cadence was refused at write. */
export class ScheduleCadenceError extends OpenwopError {
  constructor(readonly refusal: CadenceRefusal) {
    // `schedule_horizon_exceeded` is the RFC 0052 §B.3 code but not a member of
    // the normative OpenwopErrorCode union — the scheduler route renders it
    // inline (as it always has for POST); every other door gets a 400
    // `validation_error` naming the field.
    super('validation_error', refusal.message, 400, {
      field: refusal.code === 'invalid_timezone' ? 'timezone' : 'cronExpr',
      reason: refusal.code,
      ...(refusal.code === 'schedule_horizon_exceeded' ? { maxFutureHorizon: MAX_FUTURE_HORIZON_ISO } : {}),
    });
  }
}

export interface CadenceRefusal {
  code: 'invalid_cron' | 'invalid_timezone' | 'schedule_horizon_exceeded';
  message: string;
}

/**
 * ADR 0787 D6 — can this cadence ever fire? `null` = yes. The `'once'` sentinel
 * is judged by `firstFireAtMs` (the horizon check in `registerJob`), not here.
 * Every competitor refuses an unparseable cadence or unknown zone when it is
 * WRITTEN; this store used to accept both with a 201 and keep the row inert
 * forever — or, for a zone, throw a RangeError out of `Intl` as a 500.
 */
export function validateCadence(cronExpr: string, timezone: string | undefined, nowMs: number = Date.now()): CadenceRefusal | null {
  if (timezone !== undefined && !isValidTimeZone(timezone)) {
    return { code: 'invalid_timezone', message: `\`${timezone}\` is not a recognised IANA time zone.` };
  }
  if (cronExpr === ONE_SHOT_CRON) return null;
  if (!parseCron(cronExpr)) {
    return { code: 'invalid_cron', message: `\`${cronExpr}\` is not a valid 5-field cron expression (minute hour day-of-month month day-of-week).` };
  }
  if (computeNextFire(cronExpr, nowMs, timezone) === null) {
    return {
      code: 'schedule_horizon_exceeded',
      message: `\`${cronExpr}\` never fires within the next ${MAX_FUTURE_HORIZON_DAYS} days.`,
    };
  }
  return null;
}

/** Bounded retries for a lost compare-and-swap. The daemon writes a given row at
 *  most once per fire, so five losses in a row means something is wrong, not
 *  unlucky — and the caller hears about it (`ScheduleWriteContention`). */
const CAS_ATTEMPTS = 5;

/**
 * ADR 0787 D2 — THE job mutator. Read → pure `fn` on a clone → compare-and-swap
 * against exactly what was read; on a lost swap, re-read and re-apply.
 *
 * Why every mutation goes through here: the old shape was `get` then a blind
 * `put`, so the daemon's bookkeeping (which reads, awaits a dispatch, then
 * writes) could re-create a job a user had just DELETED, write `enabled:true`
 * back over a disable, and restore the raw owner over a DSAR scrub. A CAS whose
 * expected value is the row as read cannot do any of that: a missing row never
 * swaps (so a delete wins), and a row that changed underneath re-reads first.
 *
 * `fn` returns the next row, or `null` for "no change" (answered with the row
 * as read). Returns `null` when the job does not exist.
 */
async function mutateJob(jobId: string, fn: (job: ScheduledJob) => ScheduledJob | null): Promise<ScheduledJob | null> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = await jobs.get(jobId);
    if (!current) return null;
    const next = fn(structuredClone(current));
    if (next === null) return current;
    if (await jobs.compareAndSwap(current, next)) return next;
  }
  throw new ScheduleWriteContention(jobId);
}

/** The next slot, or `null`. Never throws: a stored bad zone must not wedge a
 *  job after its claim (ADR 0787 D6). */
function nextSlot(job: Pick<ScheduledJob, 'cronExpr' | 'timezone'>, afterMs: number): number | null {
  return computeNextFire(job.cronExpr, afterMs, job.timezone);
}

/** Apply "this slot is consumed" to a row: advance `nextFireAt` past `afterMs`,
 *  spend a one-shot, and say so when a recurring cadence has no further slot. */
function advancedRow(job: ScheduledJob, tick: number, slot: number | undefined, afterMs: number): ScheduledJob {
  job.lastFiredTick = tick;
  const next = nextSlot(job, afterMs);
  if (next !== null) job.nextFireAt = next;
  else delete job.nextFireAt;
  if (job.cronExpr === ONE_SHOT_CRON) {
    if (slot !== undefined) job.oneShotFiredAt = slot;
  } else if (next === null && parseCron(job.cronExpr)) {
    // ADR 0787 D6 — a PARSEABLE cadence with no further slot (a leap-day cron
    // after its fire; a stored zone that no longer resolves) used to go quiet
    // with `nextFireAt` simply gone. Say why.
    job.lastSkippedAt = new Date(afterMs).toISOString();
    job.lastSkipReason = 'no-next-fire';
    delete job.lastSkipFeatureId;
  }
  return job;
}

/** Register (or replace) a scheduled job. Rejects a first fire beyond
 *  `maxFutureHorizon` with `schedule_horizon_exceeded`, and (ADR 0787 D6) an
 *  ENABLED job whose cadence can never fire. A disabled job stays permissive —
 *  portability imports disabled rows verbatim — and is judged when enabled. */
export async function registerJob(
  input: {
    jobId: string;
    tenantId: string;
    cronExpr: string;
    firstFireAtMs?: number;
    workflowId?: string;
    rosterId?: string;
    ownerUserId?: string;
    ownerSubject?: Subject;
    agentId?: string;
    enabled?: boolean;
    metadata?: Record<string, unknown>;
    configurable?: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    featureId?: string;
    timezone?: string;
  },
  nowMs: number = Date.now(),
): Promise<{ ok: true; job: ScheduledJob } | { ok: false; error: ScheduleHorizonError }> {
  if (input.firstFireAtMs !== undefined && input.firstFireAtMs - nowMs > MAX_FUTURE_HORIZON_MS) {
    return {
      ok: false,
      error: {
        code: 'schedule_horizon_exceeded',
        message: `schedule first-fire is beyond maxFutureHorizon (${MAX_FUTURE_HORIZON_ISO})`,
      },
    };
  }
  if (input.enabled !== false) {
    const refusal = validateCadence(input.cronExpr, input.timezone, nowMs);
    if (refusal) return { ok: false, error: refusal };
  }
  // ADR 0309 D1 — ONE-SHOT completion of the shape this file already
  // anticipated ("Undefined when … one-shot/spent"): the EXPLICIT `'once'`
  // sentinel takes its single fire time from `firstFireAtMs`; the advance's
  // recompute then yields null and deletes `nextFireAt` (spent; row retained
  // for the Schedules tab + cancel). Grade-pass fix GC-R2: the sentinel is
  // OPT-IN — a typo'd cadence must not become a surprise one-shot (and since
  // ADR 0787 D6 an enabled typo is refused outright).
  const nextFireAt = computeNextFire(input.cronExpr, nowMs, input.timezone)
    ?? (input.cronExpr === ONE_SHOT_CRON ? input.firstFireAtMs ?? null : null);
  const job: ScheduledJob = {
    jobId: input.jobId,
    tenantId: input.tenantId,
    cronExpr: input.cronExpr,
    lastFiredTick: null,
    enabled: input.enabled ?? true,
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
    ...(input.rosterId !== undefined ? { rosterId: input.rosterId } : {}),
    ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
    ...(input.ownerSubject !== undefined ? { ownerSubject: input.ownerSubject } : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.configurable !== undefined ? { configurable: input.configurable } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.featureId !== undefined ? { featureId: input.featureId } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(nextFireAt !== null ? { nextFireAt } : {}),
    createdAt: new Date(nowMs).toISOString(),
  };
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    // ADR 0379 P2 — cross-tenant overwrite guard: the store is jobId-keyed and
    // the public route accepts EXPLICIT jobIds, so without this a caller could
    // hijack/clobber another tenant's job by supplying its id. Same-tenant
    // re-register stays the intentional upsert.
    const prior = await jobs.get(input.jobId);
    if (prior && prior.tenantId !== input.tenantId) {
      return { ok: false, error: { code: 'jobid_conflict', message: 'jobId is not available.' } };
    }
    // ADR 0787 D6 — a SPENT one-shot is not re-fired for the SAME slot. A retried
    // tool call re-registers the same deterministic id with the same fire time;
    // re-arming it fired the follow-up twice. A LATER fire time is a genuine
    // re-schedule (KickBot's coach/convene and the session reminder re-register
    // one id with `Date.now()` to fire again) and re-arms as before.
    if (
      prior && input.cronExpr === ONE_SHOT_CRON && prior.cronExpr === ONE_SHOT_CRON
      && prior.oneShotFiredAt !== undefined && prior.nextFireAt === undefined
      && input.firstFireAtMs !== undefined && input.firstFireAtMs <= prior.oneShotFiredAt
    ) {
      return { ok: true, job: prior };
    }
    // ADR 0815 D4 — a re-registration is a full replace, and seven feature lanes
    // re-register an existing id (assistant loops, scheduled chats, goals, …).
    // Without this it silently re-armed a job paused because its actor left the
    // workspace, as that same actor. The pause survives unless the new row acts
    // as someone else entirely.
    let next = job;
    if (prior && isPausedForRemovedMember(prior) && jobActors(prior).some((a) => jobActsAs(job, a))) {
      next = { ...job, enabled: false, metadata: { ...(job.metadata ?? {}), disabledReason: ACTING_MEMBER_REMOVED } };
    }
    // ADR 0787 D2 — swap against exactly the row this call judged, so a daemon
    // advance landing in between is re-read rather than half-overwritten.
    if (await jobs.compareAndSwap(prior, next)) return { ok: true, job: next };
  }
  return { ok: false, error: { code: 'write_contention', message: 'This schedule is being changed by something else right now. Try again.' } };
}

/** List a tenant's jobs (or every job when `tenantId` is omitted). */
export async function listJobs(tenantId?: string): Promise<ScheduledJob[]> {
  const all = await jobs.list();
  const scoped = tenantId === undefined ? all : all.filter((j) => j.tenantId === tenantId);
  return scoped.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

/** RI-9 — does the tenant have a scheduled job bound to `workflowId`? Guards the
 *  workflow-delete path (a delete must refuse while a schedule fires against the
 *  definition, mirroring the run-reference 409). Status-agnostic: a DISABLED job is a
 *  latent orphan (re-enabling fires against a gone workflow), so any bound job counts. */
export async function hasJobForWorkflow(tenantId: string, workflowId: string): Promise<boolean> {
  return (await listJobs(tenantId)).some((j) => j.workflowId === workflowId);
}

/** ADR 0045 — the job's owner as the canonical `Subject`. Prefers the generic
 *  `ownerSubject` (ADR 0046); falls back to the legacy `rosterId`/`ownerUserId`
 *  fields (`rosterId` → `{kind:'agent'}`, `ownerUserId` → `{kind:'user'}`) so
 *  existing rows surface as Subjects unchanged. */
export function scheduleSubject(job: ScheduledJob): Subject | null {
  if (job.ownerSubject) return job.ownerSubject;
  if (job.rosterId) return { kind: 'agent', id: job.rosterId };
  if (job.ownerUserId) return { kind: 'user', id: job.ownerUserId };
  return null;
}

/** ADR 0045 Phase 2 — list a SUBJECT's jobs (the canonical owner query that
 *  unifies the per-agent + per-user paths). Tenant-scoped. */
export async function listJobsForSubject(tenantId: string, subject: Subject): Promise<ScheduledJob[]> {
  return (await listJobs(tenantId)).filter((j) => {
    const s = scheduleSubject(j);
    return s !== null && s.kind === subject.kind && s.id === subject.id;
  });
}

/** List a single roster member's jobs (agent "Schedules" tab) — the agent
 *  specialization of `listJobsForSubject`. */
export async function listJobsByRoster(tenantId: string, rosterId: string): Promise<ScheduledJob[]> {
  return listJobsForSubject(tenantId, { kind: 'agent', id: rosterId });
}

/** ADR 0025 — list a single user's jobs (profile "Schedules" tab) — the user
 *  specialization of `listJobsForSubject`. */
export async function listJobsByUser(tenantId: string, ownerUserId: string): Promise<ScheduledJob[]> {
  return listJobsForSubject(tenantId, { kind: 'user', id: ownerUserId });
}

/** ADR 0025 — the deterministic id for a user-owned schedule, keyed on its
 *  defining content (tenant + owner + workflow + cadence). Lets the profile
 *  "Schedules" create be idempotent: a double-submit collapses to ONE row rather
 *  than minting a duplicate (the scheduler POST has no `Idempotency-Key`). Two
 *  genuinely different schedules (different workflow or cadence) hash apart.
 *  Mirrors the personal-board `personalBoardId` scheme. */
export function personalScheduleId(tenantId: string, ownerUserId: string, workflowId: string | undefined, cronExpr: string): string {
  const key = createHash('sha256').update(`${tenantId}:${ownerUserId}:${workflowId ?? ''}:${cronExpr}`).digest('hex').slice(0, 24);
  return `job-personal-${key}`;
}

/** Fetch a single job by id, or null when none is registered. */
export async function getJob(jobId: string): Promise<ScheduledJob | null> {
  return jobs.get(jobId);
}

/** Remove a job. Returns true when a job was actually deleted. */
export async function deleteJob(jobId: string): Promise<boolean> {
  return jobs.delete(jobId);
}

/** Is this job attributed to a DSAR-erased person? Such a row is kept (its
 *  bound workflow and the Schedules tab need it) but must never fire again. */
export function isErasedJob(job: ScheduledJob): boolean {
  return job.ownerUserId === ERASED
    || (job.ownerSubject?.kind === 'user' && job.ownerSubject.id === ERASED)
    || job.metadata?.actingUserId === ERASED;
}

/** Enable/disable a job. Returns the updated job, or null when not found.
 *  Throws `JobErasedError` for an erased job and `ScheduleCadenceError` when an
 *  enable would arm a cadence that can never fire (ADR 0787 D3/D6). */
export async function setJobEnabled(jobId: string, enabled: boolean): Promise<ScheduledJob | null> {
  return updateJob(jobId, { enabled });
}

/** Patch an editable subset of a job (cadence, bound workflow, attribution
 *  label, timezone, enabled). Lets the UI edit a schedule in place instead of
 *  delete-and-recreate. Only provided fields change. Returns the updated job,
 *  or null when not found. `metadata` REPLACES here; the public route merges
 *  before calling (ADR 0787 D3). */
export interface ScheduledJobPatch {
  enabled?: boolean;
  cronExpr?: string;
  workflowId?: string;
  metadata?: Record<string, unknown>;
  /** ADR 0787 D3 — shallow-merged over the CURRENT metadata inside the CAS, so
   *  keys the client did not name (reserved markers, `tool`) survive, and a
   *  concurrent metadata write is re-read rather than overwritten. */
  mergeMetadata?: Record<string, unknown>;
  /** ADR 0787 D3 — re-stamp who the job acts as (a retarget by the route). */
  actingUserId?: string;
  timezone?: string;
}

/** A computed patch is re-derived from the current row on every CAS retry.
 * Return null for no change; the callback must perform no external effects.
 * ADR 0862 D7 uses this existing scheduler seam for atomic health observations. */
export async function updateJob(
  jobId: string,
  requestedPatch: ScheduledJobPatch | ((job: Readonly<ScheduledJob>) => ScheduledJobPatch | null),
): Promise<ScheduledJob | null> {
  const nowMs = Date.now();
  return mutateJob(jobId, (job) => {
    const patch = typeof requestedPatch === 'function' ? requestedPatch(job) : requestedPatch;
    if (patch === null) return null;
    // ADR 0815 D4 — judged on the job AS READ, before any client metadata lands,
    // so a metadata patch cannot clear the marker first.
    const paused = isPausedForRemovedMember(job);
    const removedActors = paused ? jobActors(job) : [];
    if (patch.mergeMetadata !== undefined) job.metadata = { ...(job.metadata ?? {}), ...patch.mergeMetadata };
    // `metadata` REPLACES, so it lands BEFORE the server-stamped actor, never over it.
    if (patch.metadata !== undefined) job.metadata = patch.metadata;
    if (patch.actingUserId !== undefined) job.metadata = { ...(job.metadata ?? {}), actingUserId: patch.actingUserId };
    const enabling = patch.enabled === true && !job.enabled;
    // By VALUE (`SCTCD-4`): the panels send `cronExpr` on every edit, and treating
    // "present" as "changed" recomputed `nextFireAt` past a DUE slot on a label
    // edit — which the D1 fence then refused to fire, silently.
    const cadenceChanged = (patch.cronExpr !== undefined && patch.cronExpr !== job.cronExpr)
      || (patch.timezone !== undefined && patch.timezone !== job.timezone);
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    // ADR 0820 §7 — a person's explicit enable/disable wins over the lapse
    // auto-pause: re-enabling fires again (and re-pauses if the plan still
    // refuses); disabling must not be undone by the resume sweep.
    if (patch.enabled !== undefined) delete job.planPause;
    if (patch.cronExpr !== undefined) job.cronExpr = patch.cronExpr;
    if (patch.workflowId !== undefined) job.workflowId = patch.workflowId;
    if (patch.timezone !== undefined) job.timezone = patch.timezone;
    if (enabling && isErasedJob(job)) throw new JobErasedError(jobId);
    // ADR 0815 D4 — a job the member-removed cascade paused still names the
    // ex-member. Re-arming it must RE-OWN it (the enabler becomes every actor
    // field), never resume firing as someone who left the workspace. A
    // feature-owned job also names its actor in the feature's own rows, so only
    // that feature can recreate it.
    if (paused) {
      if (enabling) {
        if (job.featureId || patch.actingUserId === undefined) throw new ActingMemberRemovedError(jobId, Boolean(job.featureId));
        const newActor = patch.actingUserId;
        const { disabledReason: _cleared, ...rest } = job.metadata ?? {};
        job.metadata = { ...rest, actingUserId: newActor };
        if (job.ownerUserId !== undefined && removedActors.includes(job.ownerUserId)) job.ownerUserId = newActor;
        if (job.ownerSubject?.kind === 'user' && removedActors.includes(job.ownerSubject.id)) job.ownerSubject = { kind: 'user', id: newActor };
        if (typeof job.inputs?.ownerSubject === 'string' && removedActors.includes(job.inputs.ownerSubject)) {
          job.inputs = { ...job.inputs, ownerSubject: newActor };
        }
      } else {
        // Still paused: the marker is server-owned and survives any edit.
        job.metadata = { ...(job.metadata ?? {}), disabledReason: ACTING_MEMBER_REMOVED };
      }
    }
    // ADR 0787 D6 — judged where the job becomes (or stays) ARMED, on every door:
    // the scheduler route, the project schedule door, and enabling a disabled
    // portability import all land here.
    if (job.enabled && (enabling || cadenceChanged)) {
      const refusal = validateCadence(job.cronExpr, job.timezone, nowMs);
      if (refusal) throw new ScheduleCadenceError(refusal);
    }
    // Recompute the daemon's next-fire when the cadence or timezone changed.
    // Because this is a CAS against the row as read (D2), a metadata-only patch
    // racing the daemon's advance re-reads the advanced row — it can no longer
    // write the old `nextFireAt` back.
    if (cadenceChanged) {
      const next = nextSlot(job, nowMs);
      if (next !== null) job.nextFireAt = next;
      else delete job.nextFireAt;
    }
    return job;
  });
}

/**
 * Record that a job fired (durable bookkeeping for the CRUD surface) and advance
 * `nextFireAt`.
 *
 * WF-COS-4 — READ `advanceJobSlot` BELOW BEFORE CALLING THIS FROM A DISPATCH
 * PATH. This stamps `lastRunAt` UNCONDITIONALLY, which is a claim that a run
 * happened, while stamping `lastRunId` only when a runId is supplied — so
 * calling it without one leaves the two describing DIFFERENT fires, and every
 * consumer renders them together.
 *
 * That claim is true of exactly ONE shape, and its remaining caller is narrowed
 * to it: the RFC 0052 deterministic-tick trigger route firing a job bound to no
 * workflow, where `result.runsFired > 0` IS the whole event and there is no run
 * to name.
 *
 * NOTHING inside this function enforces any of that. Do not add a caller
 * without deciding which shape it is.
 */
export async function markJobFired(
  jobId: string,
  tick: number,
  runId?: string,
  firedAtMs: number = Date.now(),
): Promise<void> {
  await mutateJob(jobId, (job) => {
    job.lastRunAt = new Date(firedAtMs).toISOString();
    if (runId !== undefined) job.lastRunId = runId;
    // computeNextFire searches forward from `firedAtMs`, so a backlog accrued
    // while the daemon was down collapses to the next future slot (§B.4).
    return advancedRow(job, tick, job.nextFireAt, firedAtMs);
  });
}

/**
 * WF-COS-4 — advance a job's slot WITHOUT claiming that a run happened.
 *
 * Splitting the two facts (`recordJobRun` stamps the run; `recordJobSkipped`
 * records a slot that produced nothing), rather than moving the advance, keeps
 * the anti-wedge property intact. The daemon no longer calls this — it advances
 * through the `claimDueSlot` fence (ADR 0787 D1) — but the tick seam does.
 */
export async function advanceJobSlot(jobId: string, tick: number, firedAtMs: number = Date.now()): Promise<void> {
  await mutateJob(jobId, (job) => advancedRow(job, tick, job.nextFireAt, firedAtMs));
}

/**
 * ADR 0787 D6 — REVIVE a job the old 30-day search killed. Before 0787 a cadence
 * whose next slot was over 30 days out (a monthly `0 9 3 * *` across a 31-day
 * month — MEASURED in prod: 3 enabled jobs dead this way) got `nextFireAt`
 * DELETED by the advance, and nothing ever recomputed it. Raising the horizon
 * fixes new advances only; this restores the rows already stranded.
 *
 * Applies only to an ENABLED, workflow-bound, RECURRING (not `'once'` — a spent
 * one-shot is done, not dead), PARSEABLE cadence with no `nextFireAt`. Idempotent
 * (a revived row no longer qualifies) and a CAS (`mutateJob`), so a concurrent
 * disable/delete/erasure wins. Returns whether the row was revived.
 */
export async function reviveStalledJob(jobId: string, nowMs: number = Date.now()): Promise<boolean> {
  let revived = false;
  await mutateJob(jobId, (job) => {
    if (!isStalled(job) || isErasedJob(job)) return null;
    const next = nextSlot(job, Math.max(nowMs, Date.now()));
    if (next === null) return null;
    job.nextFireAt = next;
    // The exhausted-cadence note described a future that now exists.
    if (job.lastSkipReason === 'no-next-fire') {
      delete job.lastSkipReason;
      delete job.lastSkippedAt;
    }
    revived = true;
    return job;
  });
  return revived;
}

/** The shape `reviveStalledJob` repairs — exported so the daemon can pick
 *  candidates from its listing without a read per job. */
export function isStalled(job: ScheduledJob): boolean {
  return job.enabled && !!job.workflowId && job.nextFireAt === undefined
    && job.cronExpr !== ONE_SHOT_CRON && parseCron(job.cronExpr) !== null;
}

/**
 * ADR 0787 D1 — the FENCE. Called by the daemon after it wins the per-slot
 * claim, and the only way the daemon advances a slot.
 *
 * It re-reads the row and requires that the job still exists, is enabled, is
 * bound to a workflow, and is still due at exactly `slot`; only then does it
 * advance, by compare-and-swap. A lost swap RE-READS and re-checks — it never
 * skips on the loss alone, because the claim is already taken and a skip would
 * strand the slot until the claim is pruned (the /architect Blocker on the
 * draft). Returns the ADVANCED row the fire must use, or `null` when a
 * condition failed: the slot was already fired (a stalled pass waking after the
 * claim prune; a superseded revision running this code), or a user disabled,
 * deleted or erasure-scrubbed the job after the pass listed it.
 *
 * The fence is the ROW, which is never pruned — not the claim table, which is.
 */
export async function claimDueSlot(jobId: string, slot: number, tick: number, nowMs: number = Date.now()): Promise<ScheduledJob | null> {
  // Never mint a slot already in the past for a pass that stalled after listing.
  const afterMs = Math.max(nowMs, Date.now());
  let refused = false;
  const advanced = await mutateJob(jobId, (job) => {
    if (!job.enabled || !job.workflowId || job.nextFireAt !== slot || isErasedJob(job)) {
      refused = true;
      return null;
    }
    return advancedRow(job, tick, slot, afterMs);
  });
  return refused ? null : advanced;
}

/** ADR 0787 D5 — a "Run now" of a bound job stamps the deterministic tick it
 *  consumed and NOTHING else: it must never advance `nextFireAt` (that used to eat
 *  the next scheduled slot). The run itself is recorded by `fireJob`. */
export async function noteManualTick(jobId: string, tick: number): Promise<void> {
  await mutateJob(jobId, (job) => {
    job.lastFiredTick = tick;
    return job;
  });
}

/** Record only the most-recent run on a job (lastRunId + lastRunAt), without
 *  touching nextFireAt. The daemon advances nextFireAt BEFORE dispatch (so a
 *  crash can't wedge the schedule), then calls this once the run id is known. */
export async function recordJobRun(jobId: string, runId: string, firedAtMs: number = Date.now()): Promise<void> {
  await mutateJob(jobId, (job) => {
    job.lastRunId = runId;
    job.lastRunAt = new Date(firedAtMs).toISOString();
    // A fire that produced a run clears any earlier skip note — otherwise the
    // surface would keep warning about a problem that has since resolved, which is
    // the mirror image of the defect this pair exists to fix. EXCEPT
    // `no-next-fire` (ADR 0787 D6): that one describes the FUTURE, and this run
    // does not change it.
    if (job.lastSkipReason !== 'no-next-fire') {
      delete job.lastSkippedAt;
      delete job.lastSkipReason;
      delete job.lastSkipFeatureId;
    }
    return job;
  });
}

/** WF-COS-4 — record that a fire consumed its slot and produced NO run. The
 *  counterpart to `recordJobRun`: a surface that reads `lastRunAt` without this
 *  cannot distinguish "ran an hour ago" from "has been failing to run since". */
export async function recordJobSkipped(
  jobId: string,
  reason: ScheduleSkipReason,
  atMs: number = Date.now(),
  /** ADR 0820 §7 — only with `plan-lapsed`: the feature the plan refused. */
  featureId?: string,
): Promise<void> {
  await mutateJob(jobId, (job) => {
    job.lastSkippedAt = new Date(atMs).toISOString();
    job.lastSkipReason = reason;
    if (reason === 'plan-lapsed' && featureId) job.lastSkipFeatureId = featureId;
    else delete job.lastSkipFeatureId;
    return job;
  });
}

/**
 * ADR 0820 §7 — RESUME a job the lapse auto-pause disabled, once access is back.
 * Only a row still carrying `planPause` and still disabled is touched (a person
 * who enabled or disabled it since cleared the marker). The next fire is the
 * next FUTURE slot: the slots missed while paused are not replayed. Returns
 * whether the row was resumed.
 */
export async function resumeJobFromPlanPause(jobId: string, nowMs: number = Date.now()): Promise<boolean> {
  let resumed = false;
  await mutateJob(jobId, (job) => {
    if (!job.planPause || job.enabled || isErasedJob(job) || isPausedForRemovedMember(job)) return null;
    delete job.planPause;
    job.enabled = true;
    const next = nextSlot(job, Math.max(nowMs, Date.now()));
    if (next !== null) job.nextFireAt = next;
    else delete job.nextFireAt;
    if (job.lastSkipReason === 'feature-disabled' || job.lastSkipReason === 'plan-lapsed') {
      delete job.lastSkipReason;
      delete job.lastSkippedAt;
      delete job.lastSkipFeatureId;
    }
    resumed = true;
    return job;
  });
  return resumed;
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A scheduled job is a structurally-needed row (deleting it would strand its
// bound workflow / break the Schedules tab), so a DSAR ANONYMIZES the owning
// subject in place rather than deleting the row — AND disables it. A job that
// acts AS the erased person must not keep firing on their behalf after they're
// gone, so `enabled` is forced false; the person's `ownerUserId` / user-kind
// `ownerSubject` are overwritten with the sentinel. Agent/roster attribution
// (`rosterId`/`agentId`) is not a person and is preserved. Jobs the subject does
// not own are untouched. Idempotent (a re-run finds the sentinel, already
// disabled); fail-closed on falsy input. Written through `mutateJob` (a CAS, ADR
// 0787 D2) with no next-fire recompute. The legacy `oidc:<sub>` spelling of the
// same person is matched too, derived from their own User row in their home tenant
// (ADR 0787 D4) — for THIS eraser only.

/** DSAR eraser — anonymize + disable every scheduled job owned by the subject. */
export async function eraseSubjectSchedules(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const forms = new Set(subjectKeyForms(subjectKey).forms);
  // ADR 0787 D4 (`SCTWF-6`) — a schedule enabled before ADR 0003 carries the
  // person's LEGACY principal (`oidc:<sub>`) as its actor forever; erasing
  // `user:X` matched only `user:X`/`X`, so X's loop kept firing as X. The alias is
  // derived from X's OWN User row, only in X's home tenant, and refused when that
  // principal is claimed by more than one User row there (see `legacyPrincipalOf`).
  const legacy = await legacyPrincipalOf(tenantId, subjectKey);
  if (legacy && 'ambiguous' in legacy) {
    log.warn('schedule erasure: legacy principal claimed by more than one user — not aliased; rows left for manual review', { tenantId });
  } else if (legacy) {
    forms.add(legacy.principalId);
  }
  for (const listed of await listJobs(tenantId)) {
    // ADR 0787 D2 — a CAS per job, so the daemon's bookkeeping (which reads, awaits
    // a dispatch, then writes) can no longer put the raw owner and `enabled:true`
    // back over this scrub. The judgement re-runs on every re-read.
    await mutateJob(listed.jobId, (job) => {
      const s = scheduleSubject(job);
      // SCC-4 — a job "acts as" a user when a feature stamps `metadata.actingUserId`
      // (the assistant loops: AGENT-owned but firing on the enabling human's behalf +
      // credentials, ADR 0024 Phase D). That IS user-ownership for DSAR: such a job
      // MUST be disabled and its `actingUserId` scrubbed.
      const actsAsErasedUser = typeof job.metadata?.actingUserId === 'string' && forms.has(job.metadata.actingUserId);
      // ADR 0879 D7 — a feature job that fires FOR a person (a scheduled chat's
      // creator, `metadata.orgScopeSubject`) is theirs for DSAR too.
      const firesForErasedUser = typeof job.metadata?.orgScopeSubject === 'string' && forms.has(job.metadata.orgScopeSubject);
      const ownedByUser = (s?.kind === 'user' && forms.has(s.id)) || (job.ownerUserId !== undefined && forms.has(job.ownerUserId)) || actsAsErasedUser || firesForErasedUser;
      if (!ownedByUser) return null;
      job.enabled = false;
      delete job.planPause; // ADR 0820 §7 — an erased person's job never auto-resumes
      if (job.ownerUserId !== undefined && forms.has(job.ownerUserId)) job.ownerUserId = ERASED;
      if (job.ownerSubject && job.ownerSubject.kind === 'user' && forms.has(job.ownerSubject.id)) {
        job.ownerSubject = { kind: 'user', id: ERASED };
      }
      // SCC-4 — also the raw id feature tools stamp into `metadata.actingUserId`.
      // Only the identifier is redacted (not `configurable`/task content, which is
      // not a person id and is needed for the row to remain a coherent record).
      if (job.metadata && typeof job.metadata.actingUserId === 'string' && forms.has(job.metadata.actingUserId)) {
        job.metadata = { ...job.metadata, actingUserId: ERASED };
      }
      if (job.metadata && typeof job.metadata.orgScopeSubject === 'string' && forms.has(job.metadata.orgScopeSubject)) {
        job.metadata = { ...job.metadata, orgScopeSubject: ERASED };
      }
      return job;
    });
  }
}

/** Register the scheduling DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
/**
 * ADR 0815 D4 — `subject` has LEFT `tenantId` (ADR 0795's issuer-removed signal:
 * the root row in a shared workspace, the last membership elsewhere, or the org
 * deleted). DISABLE — never erase — every enabled job there that acts as them,
 * and stamp why. Nothing re-checked the actor's membership at fire time, so a
 * removed member's loop kept running in the workspace as them (MEASURED). The row,
 * its owner and its history stay for an admin to review, re-own or delete: a
 * membership change is not a DSAR. Only where membership is how one is present
 * at all (`membershipDefinesPresence`). Same CAS as every other mutator.
 */
export async function disableSchedulesActingAs(tenantId: string, subject: string): Promise<number> {
  if (!tenantId || !subject || !membershipDefinesPresence(tenantId)) return 0;
  let n = 0;
  for (const listed of await listJobs(tenantId)) {
    // ADR 0820 §7 — a plan-PAUSED job is still armed in effect (the resume sweep
    // re-enables it), so it is paused for the removed member too.
    if ((!listed.enabled && !listed.planPause) || !jobActsAs(listed, subject)) continue;
    const out = await mutateJob(listed.jobId, (job) => {
      if (job.tenantId !== tenantId || (!job.enabled && !job.planPause) || !jobActsAs(job, subject)) return null;
      job.enabled = false;
      delete job.planPause;
      job.metadata = { ...(job.metadata ?? {}), disabledReason: ACTING_MEMBER_REMOVED };
      return job;
    });
    if (out && !out.enabled && isPausedForRemovedMember(out)) n += 1;
  }
  if (n > 0) log.info('schedules_paused_acting_member_removed', { tenantId, count: n });
  return n;
}

/** One stable reference, so a repeated boot registration stays deduped. */
async function pauseSchedulesOfRemovedIssuer(tenantId: string, subject: string): Promise<void> {
  await disableSchedulesActingAs(tenantId, subject);
}

export function registerSchedulingErasure(): void {
  registerSubjectEraser(eraseSubjectSchedules);
  // ADR 0815 D4 — booted from the same explicit list (host/hostSubjectErasers.ts).
  registerIssuerRemovedHandler(pauseSchedulesOfRemovedIssuer);
}

/** Reset all scheduler state (test teardown). Resets the in-memory tick clock
 *  synchronously, then awaits the durable job store clear so a caller that
 *  awaits gets full isolation (e.g. a future count-based assertion). Callers
 *  that don't await still get a correct tick-seam reset. */
export async function resetScheduling(): Promise<void> {
  tickClockJobs.clear();
  tickIndex = 0;
  await jobs.__clear();
}

// ADR 0789 — a schedule this tenant pointed at a SHARED workflow follows the
// tenant's fork: the user edited the workflow, so the schedule runs the edit.
// Only this tenant's jobs; every other tenant still owns the shared id.
onWorkflowForked('scheduler:job', async (tenantId, from, to) => {
  let n = 0;
  for (const job of await listJobs(tenantId)) {
    if (job.workflowId !== from) continue;
    if (await casRepoint(jobs, job.jobId, (j) => (j.workflowId === from && j.tenantId === tenantId ? { ...j, workflowId: to } : null))) n += 1;
  }
  return n;
});
