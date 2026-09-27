/**
 * Standing goals service (RFC 0097) — host-sample, best-effort.
 *
 * Invariants:
 *   - `goal-continuation-bounded` — create REQUIRES RFC 0058 bounds when
 *     `requiresBounds` is advertised (422 otherwise).
 *   - `goal-completion-judge-only` — a client may never write a completion
 *     verdict (`state: satisfied`); only the verifier judge transitions a goal
 *     to a terminal verdict. The generic update path refuses client state writes;
 *     pause/resume/abandon are the only client-driven transitions.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerJob, setJobEnabled } from '../../host/schedulingService.js';
import { createLogger } from '../../observability/logger.js';
import { emitGoalClosed, emitGoalEvaluated } from './goalEvents.js';
import { resolveGoalVerifier } from './goalVerifiers.js';
import {
  hasBounds,
  toWireGoal,
  type Goal,
  type GoalBounds,
  type GoalEvidence,
  type GoalRow,
  type GoalState,
  type GoalVerdict,
} from './types.js';

// KT-D1 (account-deletion cascade): the tenant lives NESTED at `owner.tenant`,
// invisible to the generic purge's top-level-`tenantId` probe — `tenantOf`
// makes goals rows purge (and tenant-index) correctly on account deletion.
const goals = new DurableCollection<GoalRow>(
  'goals',
  (g) => `${g.owner.tenant}::${g.id}`,
  undefined,
  (g) => g.owner.tenant,
);

const nowIso = (): string => new Date().toISOString();

const log = createLogger('goals.service');

/** Bounded CAS retries for judge/binding writes (optimistic concurrency). */
const CAS_ATTEMPTS = 4;

/** ADR 0412 P4 — the deterministic continuation-job id for one goal. */
export function continuationJobId(tenant: string, goalId: string): string {
  return `goal:${tenant}:${goalId}:continuation`;
}

/** Best-effort disarm — a terminal/paused goal must leave NO active scheduled
 *  work under a retired identity. Never fails the transition that invoked it. */
async function disarmContinuation(tenant: string, goalId: string, jobRef?: string): Promise<void> {
  try {
    await setJobEnabled(jobRef ?? continuationJobId(tenant, goalId), false);
  } catch (err) {
    log.warn('goal_continuation_disarm_failed', { goalId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Mandatory-bounds posture (RFC 0097 §E). */
export function requiresBounds(): boolean {
  return process.env.OPENWOP_GOALS_REQUIRE_BOUNDS !== 'false';
}

/** Wire-projected list — every external consumer (routes, agent tool, surface)
 *  sees the strict `goal.schema.json` shape; host-private sidecar state never
 *  leaves the service. */
export async function listGoals(tenant: string, state?: GoalState): Promise<Goal[]> {
  const rows = await goals.listByPrefix(`${tenant}::`);
  return rows
    .filter((g) => g.owner.tenant === tenant)
    .filter((g) => (state ? g.state === state : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(toWireGoal);
}

export async function getGoal(tenant: string, id: string): Promise<Goal | null> {
  const row = await getGoalRow(tenant, id);
  return row ? toWireGoal(row) : null;
}

/** Internal row read (keeps the host sidecar) — service-private by convention. */
async function getGoalRow(tenant: string, id: string): Promise<GoalRow | null> {
  const g = await goals.get(`${tenant}::${id}`);
  return g && g.owner.tenant === tenant ? g : null;
}

/**
 * ADR 0412 P5 — principal ownership gate for MUTATIONS. A goal created with an
 * `owner.principal` is mutable only by that acting principal; the denial is
 * indistinguishable from absent (uniform 404 — no existence oracle). Reads stay
 * tenant-scoped (workspace visibility); principal-less goals (the demo row, the
 * wildcard conformance bearer) keep the prior tenant-only behavior. Run-scoped
 * surface callers are tenant-trusted (CTI-1) and pass no acting principal.
 */
function principalDenied(row: GoalRow, actingPrincipal: string | undefined): boolean {
  const owner = row.owner.principal;
  // An ABSENT acting principal is an internal tenant-trusted caller (the run
  // surface; CTI-1). HTTP routes always pass `callerSubject(req)` — an
  // unauthenticated request never reaches them — so a supplied-but-different
  // principal is the only denial.
  return typeof owner === 'string' && owner.length > 0 && actingPrincipal !== undefined && actingPrincipal !== owner;
}

/** Thrown when create is missing RFC 0058 bounds and `requiresBounds` is on (→ 422). */
export class BoundsRequiredError extends Error {
  constructor() {
    super('A standing goal MUST carry RFC 0058 bounds (maxLoopIterations / runTimeoutMs / maxCostUsd).');
  }
}

/** Thrown when a client tries to write a judge-owned completion verdict (→ 422). */
export class JudgeOnlyStateError extends Error {
  constructor(public readonly state: string) {
    super(`A client MUST NOT set goal state \`${state}\` — completion is the judge's verdict.`);
  }
}

export interface CreateGoalInput {
  objective: string;
  completion: { check: 'verifier' | 'host'; verifierRef?: string };
  continuation: { mode: 'schedule' | 'commitment' | 'heartbeat' | 'manual'; armRef?: string };
  bounds?: GoalBounds;
  owner: { tenant: string; workspace?: string; principal?: string };
}

export async function createGoal(input: CreateGoalInput): Promise<Goal> {
  if (requiresBounds() && !hasBounds(input.bounds)) throw new BoundsRequiredError();
  const goal: Goal = {
    id: `goal:${randomUUID()}`,
    objective: input.objective,
    state: 'active',
    completion: { check: input.completion.check, ...(input.completion.verifierRef ? { verifierRef: input.completion.verifierRef } : {}) },
    continuation: { mode: input.continuation.mode, ...(input.continuation.armRef ? { armRef: input.continuation.armRef } : {}) },
    bounds: input.bounds ?? {},
    progress: { iterations: 0, contributingRunIds: [] },
    owner: { tenant: input.owner.tenant, ...(input.owner.workspace ? { workspace: input.owner.workspace } : {}), ...(input.owner.principal ? { principal: input.owner.principal } : {}) },
    createdAt: nowIso(),
  };
  await goals.put(goal);
  return goal;
}

/** Judge-owned terminal states a client may never write directly. */
const JUDGE_OWNED_STATES: ReadonlySet<string> = new Set(['satisfied', 'escalated', 'bound-exceeded']);

/**
 * Generic update. Refuses any client-supplied completion verdict
 * (`goal-completion-judge-only`); a bare `state` that is judge-owned throws.
 * Non-verdict edits (objective, continuation) are accepted.
 */
export async function updateGoal(
  tenant: string,
  id: string,
  body: Record<string, unknown>,
  actingPrincipal?: string,
): Promise<Goal | null> {
  if (typeof body.state === 'string' && JUDGE_OWNED_STATES.has(body.state)) {
    throw new JudgeOnlyStateError(body.state);
  }
  // GOALS-1 (grade-gate fix): CAS, not last-write-wins — a client edit racing
  // the judge write must never clobber a just-persisted verdict/sidecar.
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const g = await getGoalRow(tenant, id);
    if (!g || principalDenied(g, actingPrincipal)) return null;
    const next: GoalRow = {
      ...g,
      ...(typeof body.objective === 'string' ? { objective: body.objective } : {}),
      updatedAt: nowIso(),
    };
    if (await goals.compareAndSwap(g, next)) return toWireGoal(next);
  }
  throw new ConcurrentGoalUpdateError(id);
}

/** Client-driven lifecycle transitions (NOT completion verdicts). */
export async function transitionGoal(
  tenant: string,
  id: string,
  action: 'pause' | 'resume' | 'abandon',
  actingPrincipal?: string,
): Promise<Goal | null> {
  // ADR 0412 P4 — pause/resume are REAL arming toggles now (the historical
  // "arming flag is a no-op" comment is retired): they enable/disable the
  // armed continuation job; abandon is the one client terminal (distinct from
  // the judge's `satisfied`/`escalated`) and disarms for good.
  // GOALS-1 (grade-gate fix): CAS, not last-write-wins.
  let g: GoalRow | null = null;
  let next: GoalRow | null = null;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    g = await getGoalRow(tenant, id);
    if (!g || principalDenied(g, actingPrincipal)) return null;
    const state: GoalState = action === 'abandon' ? 'abandoned' : 'active';
    next = { ...g, state, updatedAt: nowIso() };
    if (await goals.compareAndSwap(g, next)) break;
    next = null;
  }
  if (!g || !next) throw new ConcurrentGoalUpdateError(id);
  log.info('goal_transition', { goalId: id, action, from: g.state, to: next.state }); // GOALS-2
  if (g.host?.armedJobRef) {
    if (action === 'pause' || action === 'abandon') await disarmContinuation(tenant, id, g.host.armedJobRef);
    else if (action === 'resume' && g.state === 'active') {
      try {
        await setJobEnabled(g.host.armedJobRef, true);
      } catch (err) {
        log.warn('goal_continuation_rearm_failed', { goalId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  // ADR 0412 P3 — closing event only on a REAL transition into the terminal
  // (a repeated abandon must not re-emit).
  if (next.state === 'abandoned' && g.state === 'active') await emitGoalClosed(tenant, id, 'abandoned');
  return toWireGoal(next);
}

/** Thrown when arming is requested on a goal whose continuation mode is not
 *  `schedule` (→ 409). `manual` needs no job; `commitment`/`heartbeat` are
 *  deliberately un-wired (dropped from the advertisement at P5). */
export class ContinuationModeError extends Error {
  constructor(public readonly mode: string) {
    super(`Continuation mode \`${mode}\` cannot be armed — only \`schedule\` continuation uses the scheduler.`);
  }
}

/** Thrown when the scheduler refuses the continuation job (horizon/conflict → 422). */
export class ScheduleRegistrationError extends Error {}

/**
 * ADR 0412 P4 — arm `schedule` continuation: create/upsert the goal's ONE
 * deterministic scheduler job (`goal:<tenant>:<goalId>:continuation`) firing
 * the CONSUMER-supplied checkpoint workflow on the supplied cadence. Goals
 * owns the job lifecycle (arm/pause/resume/disarm-on-terminal); the checkpoint
 * semantics — which workflow, what cadence — belong to the consumer
 * (ADR 0414's daily loop is the first).
 */
export async function armContinuation(
  tenant: string,
  id: string,
  input: {
    workflowId: string;
    cronExpr: string;
    timezone?: string;
    inputs?: Record<string, unknown>;
    /** OPAQUE roster attribution for the continuation job, forwarded verbatim to
     *  `registerJob` (ADR 0442 P2). goals interprets nothing — a caller (e.g.
     *  KickTodo enroll) supplies its agent's `rosterId`/`agentId` so the fired
     *  daily loop shows under that agent's Schedules tab. Never re-resolved, so
     *  a fixed literal is replay/rename-safe. */
    rosterId?: string;
    agentId?: string;
  },
  actingPrincipal?: string,
): Promise<Goal | null> {
  const row = await getGoalRow(tenant, id);
  if (!row || principalDenied(row, actingPrincipal)) return null;
  if (row.state !== 'active') throw new GoalNotActiveError(row.state);
  if (row.continuation.mode !== 'schedule') throw new ContinuationModeError(row.continuation.mode);

  const jobId = continuationJobId(tenant, id);
  const res = await registerJob({
    jobId,
    tenantId: tenant,
    cronExpr: input.cronExpr,
    workflowId: input.workflowId,
    enabled: true,
    metadata: { goalId: id, purpose: 'goal-continuation' },
    // Per-fire inputs so the continuation workflow's declared variables are
    // seeded on every scheduled tick (not just when a live request supplies
    // them). Without this a `variables[]`-declaring loop runs blind.
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    // ADR 0442 P2 — opaque roster attribution (populates both the daemon's
    // `rosterId` run-metadata key and the `{kind:'agent'}` ownerScope, lighting
    // up the agent's Schedules + Activity tabs). Additive; other callers omit it.
    ...(input.rosterId !== undefined ? { rosterId: input.rosterId } : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
  });
  if (!res.ok) throw new ScheduleRegistrationError(res.error.message);

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const fresh = attempt === 0 ? row : await getGoalRow(tenant, id);
    if (!fresh) return null;
    const next: GoalRow = {
      ...fresh,
      continuation: { ...fresh.continuation, armRef: jobId },
      host: { ...fresh.host, armedJobRef: jobId },
      updatedAt: nowIso(),
    };
    if (await goals.compareAndSwap(fresh, next)) return toWireGoal(next);
  }
  throw new ConcurrentGoalUpdateError(id);
}

/** Thrown when a judge evaluation is requested on a non-active goal with NEW
 *  evidence (same-evidence re-evaluation replays the recorded verdict instead). */
export class GoalNotActiveError extends Error {
  constructor(public readonly state: GoalState) {
    super(`Goal is \`${state}\` — a judge may only evaluate an active goal.`);
  }
}

/** Thrown when `completion.verifierRef` names no registered verifier (→ 409).
 *  Fail-closed: an absent judge never completes a goal. */
export class VerifierUnavailableError extends Error {
  constructor(public readonly ref: string | undefined) {
    super(`No goal verifier is registered for ref \`${ref ?? '<unset>'}\`.`);
  }
}

/** Thrown when the verifier throws or returns a malformed verdict (→ 502).
 *  Fail-closed: a broken judge never completes a goal (typed failure, never
 *  success-with-empty). */
export class VerifierFailedError extends Error {}

/** Thrown when a CAS write loses `CAS_ATTEMPTS` races in a row (→ 409). */
export class ConcurrentGoalUpdateError extends Error {
  constructor(id: string) {
    super(`Concurrent updates on goal \`${id}\` — retry the operation.`);
  }
}

/** Thrown when an RFC 0058 bound is crossed (ADR 0412 P2) — the goal has been
 *  transitioned to `bound-exceeded` and the judge was NOT invoked (fail-closed
 *  on spend). */
export class GoalBoundExceededError extends Error {
  constructor(public readonly breach: 'iterations' | 'wallclock' | 'cost') {
    super(`Goal bound exceeded (${breach}) — the goal is now \`bound-exceeded\`.`);
  }
}

/** ADR 0412 P2 — which RFC 0058 bound (if any) `row` has crossed at `atMs`. */
function breachedBound(row: GoalRow, atMs: number): 'iterations' | 'wallclock' | 'cost' | null {
  const b = row.bounds;
  if (typeof b.maxLoopIterations === 'number' && (row.progress?.iterations ?? 0) >= b.maxLoopIterations) {
    return 'iterations';
  }
  if (typeof b.runTimeoutMs === 'number' && atMs - Date.parse(row.createdAt) > b.runTimeoutMs) {
    return 'wallclock';
  }
  if (typeof b.maxCostUsd === 'number' && (row.host?.accumulatedCostUsd ?? 0) > b.maxCostUsd) {
    return 'cost';
  }
  return null;
}

/** Transition an active row to `bound-exceeded` (CAS, best-effort retries). */
async function transitionBoundExceeded(tenant: string, id: string): Promise<void> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const fresh = await getGoalRow(tenant, id);
    if (!fresh || fresh.state !== 'active') return;
    const next: GoalRow = { ...fresh, state: 'bound-exceeded', updatedAt: nowIso() };
    if (await goals.compareAndSwap(fresh, next)) {
      await emitGoalClosed(tenant, id, 'bound-exceeded'); // ADR 0412 P3
      await disarmContinuation(tenant, id, fresh.host?.armedJobRef); // ADR 0412 P4
      return;
    }
  }
  throw new ConcurrentGoalUpdateError(id);
}

/**
 * ADR 0412 P1/P2 — bind a contributing run to a goal (dedup append, CAS), and
 * accumulate its reported spend against `bounds.maxCostUsd` (the cost-
 * accounting answer to ADR 0412 OQ2: cost attaches to the contributing run at
 * bind time; re-binding the same run never double-counts). Crossing the cost
 * bound transitions an active goal to `bound-exceeded` in the same CAS write.
 * Returns the wire goal, or null when the goal is not visible to `tenant`.
 */
export async function bindContributingRun(
  tenant: string,
  id: string,
  runId: string,
  costUsd?: number,
  actingPrincipal?: string,
): Promise<Goal | null> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await getGoalRow(tenant, id);
    if (!row || principalDenied(row, actingPrincipal)) return null;
    const ids = row.progress?.contributingRunIds ?? [];
    if (ids.includes(runId)) return toWireGoal(row); // idempotent: cost counted once
    const accumulated = (row.host?.accumulatedCostUsd ?? 0) + (costUsd ?? 0);
    const costExceeded =
      row.state === 'active' && typeof row.bounds.maxCostUsd === 'number' && accumulated > row.bounds.maxCostUsd;
    const next: GoalRow = {
      ...row,
      state: costExceeded ? 'bound-exceeded' : row.state,
      progress: { iterations: row.progress?.iterations ?? 0, contributingRunIds: [...ids, runId] },
      ...(costUsd !== undefined ? { host: { ...row.host, accumulatedCostUsd: accumulated } } : {}),
      updatedAt: nowIso(),
    };
    if (await goals.compareAndSwap(row, next)) {
      // ADR 0412 P3/P4 — a bind-time cost flip is a real closure: announce + disarm.
      if (costExceeded) {
        await emitGoalClosed(tenant, id, 'bound-exceeded');
        await disarmContinuation(tenant, id, row.host?.armedJobRef);
      }
      return toWireGoal(next);
    }
  }
  throw new ConcurrentGoalUpdateError(id);
}

export interface EvaluateGoalResult {
  goal: Goal;
  verdict: GoalVerdict;
  /** True when the recorded verdict for the SAME evidence snapshot was returned
   *  without re-invoking the verifier (replay never recomputes — ADR 0412 P3
   *  invariant, enforced from P1). */
  replayed: boolean;
}

/**
 * ADR 0412 P1 — the judge-write path. Resolves the goal's registered verifier,
 * judges the OPAQUE immutable evidence snapshot, persists `lastVerdict` (CAS),
 * and transitions `active → satisfied|escalated` per the verdict. The stored
 * row records the evidence ref+hash (host-private sidecar) as the idempotency/
 * replay key.
 *
 * (ADR 0412 correction note: the orphaned last-write-wins `putGoal` was NOT
 * reused as planned — a judge write racing a client update needs CAS; this
 * function replaces it.)
 */
export async function evaluateGoal(
  tenant: string,
  id: string,
  evidence: GoalEvidence,
  actingPrincipal?: string,
): Promise<EvaluateGoalResult | null> {
  const row = await getGoalRow(tenant, id);
  // Denial precedes the replay short-circuit: a foreign principal must not
  // read the recorded verdict either.
  if (!row || principalDenied(row, actingPrincipal)) return null;

  // Same-evidence re-evaluation (retry/replay) → recorded verdict, no re-judging.
  const recorded = row.completion.lastVerdict;
  if (recorded && row.host?.lastEvidence?.snapshotHash === evidence.snapshotHash) {
    return { goal: toWireGoal(row), verdict: recorded, replayed: true };
  }
  if (row.state !== 'active') throw new GoalNotActiveError(row.state);

  // ADR 0412 P2 — pre-judge bound check (fail-closed on spend): a goal past an
  // RFC 0058 bound transitions to `bound-exceeded` WITHOUT invoking the judge.
  const breach = breachedBound(row, Date.now());
  if (breach) {
    await transitionBoundExceeded(tenant, id);
    throw new GoalBoundExceededError(breach);
  }

  const ref = row.completion.verifierRef;
  const verifier = ref ? resolveGoalVerifier(ref) : undefined;
  if (!verifier) throw new VerifierUnavailableError(ref);

  let raw: Awaited<ReturnType<typeof verifier>>;
  try {
    raw = await verifier({ goal: toWireGoal(row), evidence });
  } catch (err) {
    throw new VerifierFailedError(
      `Goal verifier \`${ref}\` failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof raw?.satisfied !== 'boolean' ||
    typeof raw.confidence !== 'number' ||
    !Number.isFinite(raw.confidence) ||
    typeof raw.runId !== 'string' ||
    raw.runId.length === 0
  ) {
    throw new VerifierFailedError(`Goal verifier \`${ref}\` returned a malformed verdict.`);
  }
  const verdict: GoalVerdict = { satisfied: raw.satisfied, confidence: raw.confidence, runId: raw.runId };

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const fresh = attempt === 0 ? row : await getGoalRow(tenant, id);
    if (!fresh) return null;
    if (fresh.state !== 'active') throw new GoalNotActiveError(fresh.state);
    // ADR 0412 P2 — each non-replayed evaluation is one continuation iteration.
    // Exact-bound termination: an unsatisfied, non-escalated verdict that LANDS
    // on `maxLoopIterations` flips to `bound-exceeded` (the loop may not
    // continue); a satisfied verdict on the final allowed iteration still wins.
    const iterations = (fresh.progress?.iterations ?? 0) + 1;
    let nextState: GoalState = raw.satisfied ? 'satisfied' : raw.escalate === true ? 'escalated' : 'active';
    if (
      nextState === 'active' &&
      typeof fresh.bounds.maxLoopIterations === 'number' &&
      iterations >= fresh.bounds.maxLoopIterations
    ) {
      nextState = 'bound-exceeded';
    }
    const next: GoalRow = {
      ...fresh,
      state: nextState,
      completion: { ...fresh.completion, lastVerdict: verdict },
      progress: { iterations, contributingRunIds: fresh.progress?.contributingRunIds ?? [] },
      host: { ...fresh.host, lastEvidence: { ...evidence, at: nowIso() } },
      updatedAt: nowIso(),
    };
    if (await goals.compareAndSwap(fresh, next)) {
      // GOALS-2 (grade-gate fix) — structured, content-free verdict log for
      // prod debuggability (ids + verdict only; no objective/evidence bodies).
      log.info('goal_evaluated', { goalId: id, satisfied: verdict.satisfied, state: nextState, iterations });
      // ADR 0412 P3 — content-free lifecycle events, ONLY on the non-replayed
      // judge write (a replayed evaluation returns above and never re-emits).
      await emitGoalEvaluated(tenant, id, verdict, iterations);
      if (nextState !== 'active') {
        await emitGoalClosed(tenant, id, nextState);
        await disarmContinuation(tenant, id, fresh.host?.armedJobRef); // ADR 0412 P4
      }
      return { goal: toWireGoal(next), verdict, replayed: false };
    }
  }
  throw new ConcurrentGoalUpdateError(id);
}

/** Idempotently ensure a canonical demo active goal exists for `tenant`, so the
 *  `goal-standing-continuation` state-guard leg (soft-skips on empty list) is
 *  non-vacuous for whatever tenant the driver authenticates as. */
export async function ensureDemoGoal(tenant: string): Promise<void> {
  const id = 'demo-standing-goal';
  if (await getGoal(tenant, id)) return;
  await goals.put({
    id,
    objective: 'Keep the weekly digest under 5 bullets',
    state: 'active',
    completion: { check: 'verifier' },
    continuation: { mode: 'schedule' },
    bounds: { maxLoopIterations: 10, runTimeoutMs: 600_000 },
    progress: { iterations: 0, contributingRunIds: [] },
    owner: { tenant },
    createdAt: nowIso(),
  });
}

export const __test = { collection: goals };
