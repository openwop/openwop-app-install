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
import { hasBounds, type Goal, type GoalBounds, type GoalState } from './types.js';

const goals = new DurableCollection<Goal>('goals', (g) => `${g.owner.tenant}::${g.id}`);

const nowIso = (): string => new Date().toISOString();

/** Mandatory-bounds posture (RFC 0097 §E). */
export function requiresBounds(): boolean {
  return process.env.OPENWOP_GOALS_REQUIRE_BOUNDS !== 'false';
}

export async function listGoals(tenant: string, state?: GoalState): Promise<Goal[]> {
  const rows = await goals.listByPrefix(`${tenant}::`);
  return rows
    .filter((g) => g.owner.tenant === tenant)
    .filter((g) => (state ? g.state === state : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getGoal(tenant: string, id: string): Promise<Goal | null> {
  const g = await goals.get(`${tenant}::${id}`);
  return g && g.owner.tenant === tenant ? g : null;
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
): Promise<Goal | null> {
  if (typeof body.state === 'string' && JUDGE_OWNED_STATES.has(body.state)) {
    throw new JudgeOnlyStateError(body.state);
  }
  const g = await getGoal(tenant, id);
  if (!g) return null;
  const next: Goal = {
    ...g,
    ...(typeof body.objective === 'string' ? { objective: body.objective } : {}),
    updatedAt: nowIso(),
  };
  await goals.put(next);
  return next;
}

/** Client-driven lifecycle transitions (NOT completion verdicts). */
export async function transitionGoal(
  tenant: string,
  id: string,
  action: 'pause' | 'resume' | 'abandon',
): Promise<Goal | null> {
  const g = await getGoal(tenant, id);
  if (!g) return null;
  // pause/resume toggle an internal arming flag; abandon is the one client
  // terminal (distinct from the judge's `satisfied`/`escalated`).
  const state: GoalState = action === 'abandon' ? 'abandoned' : 'active';
  const next: Goal = { ...g, state, updatedAt: nowIso() };
  await goals.put(next);
  return next;
}

export async function putGoal(g: Goal): Promise<void> {
  await goals.put(g);
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
