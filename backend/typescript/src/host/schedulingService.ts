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

import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import type { Subject } from './subject.js';
import { computeNextFire } from './cronSchedule.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';

/** Largest future horizon the host honors — mirrors the advertised
 *  `capabilities.scheduling.maxFutureHorizon: 'P30D'`. */
export const MAX_FUTURE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/** ADR 0309 D1 — the EXPLICIT one-shot cadence sentinel: `registerJob` takes the
 *  single fire time from `firstFireAtMs`, and the first fire spends the job.
 *  Opt-in by exact match — any other unparseable cron stays inert (GC-R2). */
export const ONE_SHOT_CRON = 'once';

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
  lastSkipReason?: 'budget' | 'workflow-unresolved' | 'dispatch-error' | 'feature-disabled';
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

const jobs = new DurableCollection<ScheduledJob>('scheduler:job', (j) => j.jobId);

export interface ScheduleHorizonError {
  /** `jobid_conflict` (ADR 0379 P2): the explicit jobId belongs to another
   *  tenant — reported with the same not-available message either way (no
   *  cross-tenant existence oracle). */
  code: 'schedule_horizon_exceeded' | 'jobid_conflict';
  message: string;
}

/** Register (or replace) a scheduled job. Rejects schedules whose first
 *  fire is beyond `maxFutureHorizon` with `schedule_horizon_exceeded`. */
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
        message: `schedule first-fire is beyond maxFutureHorizon (${MAX_FUTURE_HORIZON_MS}ms)`,
      },
    };
  }
  // ADR 0309 D1 — ONE-SHOT completion of the shape this file already
  // anticipated ("Undefined when … one-shot/spent"): the EXPLICIT `'once'`
  // sentinel takes its single fire time from `firstFireAtMs`; `markJobFired`'s
  // recompute then yields null and deletes `nextFireAt` (spent; row retained
  // for the Schedules tab + cancel). Grade-pass fix GC-R2: the sentinel is
  // OPT-IN — any other unparseable cron stays INERT exactly as before, because
  // the public scheduler route (routes/scheduler.ts) passes client-supplied
  // `firstFireAtMs` and a typo'd cadence must not become a surprise one-shot.
  // ADR 0379 P2 — cross-tenant overwrite guard: the store is jobId-keyed and
  // the public route accepts EXPLICIT jobIds, so without this a caller could
  // hijack/clobber another tenant's job by supplying its id (pre-existing
  // exposure, surfaced by the deterministic-id audit). Same-tenant re-register
  // stays the intentional upsert.
  const prior = await jobs.get(input.jobId);
  if (prior && prior.tenantId !== input.tenantId) {
    return { ok: false, error: { code: 'jobid_conflict', message: 'jobId is not available.' } };
  }
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
  await jobs.put(job);
  return { ok: true, job };
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

/** Enable/disable a job. Returns the updated job, or null when not found. */
export async function setJobEnabled(jobId: string, enabled: boolean): Promise<ScheduledJob | null> {
  return updateJob(jobId, { enabled });
}

/** Patch an editable subset of a job (cadence, bound workflow, attribution
 *  label, timezone, enabled). Lets the UI edit a schedule in place instead of
 *  delete-and-recreate. Only provided fields change. Returns the updated job,
 *  or null when not found. */
export async function updateJob(
  jobId: string,
  patch: {
    enabled?: boolean;
    cronExpr?: string;
    workflowId?: string;
    metadata?: Record<string, unknown>;
    timezone?: string;
  },
): Promise<ScheduledJob | null> {
  const job = await jobs.get(jobId);
  if (!job) return null;
  if (patch.enabled !== undefined) job.enabled = patch.enabled;
  if (patch.cronExpr !== undefined) job.cronExpr = patch.cronExpr;
  if (patch.workflowId !== undefined) job.workflowId = patch.workflowId;
  if (patch.metadata !== undefined) job.metadata = patch.metadata;
  if (patch.timezone !== undefined) job.timezone = patch.timezone;
  // Recompute the daemon's next-fire when the cadence or timezone changed.
  if (patch.cronExpr !== undefined || patch.timezone !== undefined) {
    const next = computeNextFire(job.cronExpr, Date.now(), job.timezone);
    if (next !== null) job.nextFireAt = next;
    else delete job.nextFireAt;
  }
  await jobs.put(job);
  return job;
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
 * to name. It was FALSE of the background daemon (which calls before dispatch
 * and then has three ways to bail — it now uses `advanceJobSlot`), and it was
 * equally false of that same route when a BOUND workflow failed to resolve,
 * which the route now splits off explicitly (`advanceJobSlot` +
 * `recordJobSkipped(…, 'workflow-unresolved')`).
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
  const job = await jobs.get(jobId);
  if (!job) return;
  job.lastFiredTick = tick;
  job.lastRunAt = new Date(firedAtMs).toISOString();
  if (runId !== undefined) job.lastRunId = runId;
  // Advance the daemon's next-fire strictly past this fire. computeNextFire
  // searches forward from `firedAtMs`, so a backlog accrued while the daemon was
  // down collapses to the next future slot — fire-once-on-recovery (§B.4).
  const next = computeNextFire(job.cronExpr, firedAtMs, job.timezone);
  if (next !== null) job.nextFireAt = next;
  else delete job.nextFireAt;
  await jobs.put(job);
}

/**
 * WF-COS-4 — advance a job's slot WITHOUT claiming that a run happened.
 *
 * The daemon must advance `nextFireAt` BEFORE dispatch: the claim row is
 * permanent, so advancing after dispatch would let a crash leave the slot
 * perpetually due AND un-claimable, i.e. a wedged schedule. It used to do that
 * through `markJobFired`, which also stamps `lastRunAt` — and three bail-outs
 * follow that call (over-budget, unresolved workflow, thrown dispatch), none of
 * which retracted the stamp. The row then read `lastRunAt = now` beside a
 * `lastRunId` from the PREVIOUS fire, and every consumer renders the pair
 * together: the assistant loop panel showed "last run: just now" with a
 * `/runs/<id>` link to a run from hours earlier.
 *
 * Splitting the two facts, rather than moving the advance, is what keeps the
 * anti-wedge property intact. `recordJobRun` stamps the run; `recordJobSkipped`
 * records a slot that produced nothing.
 */
export async function advanceJobSlot(jobId: string, tick: number, firedAtMs: number = Date.now()): Promise<void> {
  const job = await jobs.get(jobId);
  if (!job) return;
  job.lastFiredTick = tick;
  const next = computeNextFire(job.cronExpr, firedAtMs, job.timezone);
  if (next !== null) job.nextFireAt = next;
  else delete job.nextFireAt;
  await jobs.put(job);
}

/** Record only the most-recent run on a job (lastRunId + lastRunAt), without
 *  touching nextFireAt. The daemon advances nextFireAt BEFORE dispatch (so a
 *  crash can't wedge the schedule), then calls this once the run id is known. */
export async function recordJobRun(jobId: string, runId: string, firedAtMs: number = Date.now()): Promise<void> {
  const job = await jobs.get(jobId);
  if (!job) return;
  job.lastRunId = runId;
  job.lastRunAt = new Date(firedAtMs).toISOString();
  // A fire that produced a run clears any earlier skip note — otherwise the
  // surface would keep warning about a problem that has since resolved, which is
  // the mirror image of the defect this pair exists to fix.
  delete job.lastSkippedAt;
  delete job.lastSkipReason;
  await jobs.put(job);
}

/** WF-COS-4 — record that a fire consumed its slot and produced NO run. The
 *  counterpart to `recordJobRun`: a surface that reads `lastRunAt` without this
 *  cannot distinguish "ran an hour ago" from "has been failing to run since". */
export async function recordJobSkipped(
  jobId: string,
  reason: NonNullable<ScheduledJob['lastSkipReason']>,
  atMs: number = Date.now(),
): Promise<void> {
  const job = await jobs.get(jobId);
  if (!job) return;
  job.lastSkippedAt = new Date(atMs).toISOString();
  job.lastSkipReason = reason;
  await jobs.put(job);
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
// disabled); fail-closed on falsy input. Written via a direct `jobs.put` so no
// next-fire recompute / owner mutation side effects fire.

/** DSAR eraser — anonymize + disable every scheduled job owned by the subject. */
export async function eraseSubjectSchedules(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const job of await listJobs(tenantId)) {
    const s = scheduleSubject(job);
    // SCC-4 — a job "acts as" a user when a feature stamps `metadata.actingUserId` (the
    // assistant loops, `features/assistant/loops.ts`: AGENT-owned but firing on the
    // enabling human's behalf + credentials, ADR 0024 Phase D). That IS user-ownership
    // for DSAR: such a job MUST be disabled (it cannot keep firing as an erased person —
    // ADR 0464 §rationale) and its `actingUserId` scrubbed. Without this the agent-owned
    // carriers escape the owner gate below and leak the raw id.
    const actsAsErasedUser = typeof job.metadata?.actingUserId === 'string' && forms.has(job.metadata.actingUserId);
    const ownedByUser = (s?.kind === 'user' && forms.has(s.id)) || (job.ownerUserId !== undefined && forms.has(job.ownerUserId)) || actsAsErasedUser;
    if (!ownedByUser) continue;
    const next: ScheduledJob = { ...job, enabled: false };
    if (next.ownerUserId !== undefined) next.ownerUserId = ERASED;
    if (next.ownerSubject && next.ownerSubject.kind === 'user' && forms.has(next.ownerSubject.id)) {
      next.ownerSubject = { kind: 'user', id: ERASED };
    }
    // SCC-4 — the owner scrub above misses the raw user id that feature tools ALSO
    // stamp into `metadata.actingUserId` (scheduled-agent-chats followup/recurring,
    // `agentTools.ts`; the value flows onto each fired run per ADR 0308). Scrub it too,
    // so a DSAR leaves no raw person identifier on the job. Host-wide: any subject-owned
    // job carrying `metadata.actingUserId` for the erased subject. Only the identifier is
    // redacted (not `configurable`/task content, which is not a person id and is needed
    // for the schedule to remain a coherent, disabled record).
    if (next.metadata && typeof next.metadata.actingUserId === 'string' && forms.has(next.metadata.actingUserId)) {
      next.metadata = { ...next.metadata, actingUserId: ERASED };
    }
    await jobs.put(next);
  }
}

/** Register the scheduling DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerSchedulingErasure(): void {
  registerSubjectEraser(eraseSubjectSchedules);
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
