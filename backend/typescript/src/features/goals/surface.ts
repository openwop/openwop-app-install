/**
 * Goals workflow surface (ADR 0412 P1 — the first slice of the external
 * consumption seam ADR 0414 builds on). `ctx.features.goals` — typed, tenant-
 * bound methods a feature or `role:action` pack node calls; every method
 * enforces tenant isolation via the goals service (CTI-1: a cross-tenant id is
 * simply not found).
 *
 * ADR 0908: each method's tenant scope is the seam's `tenantMethodScopes`
 * (`access.ts`), and mutations act for the run's person (D6). Create goes
 * through the same closed-world `validateGoalInput` as the route (D9).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr, surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { hasBounds, type GoalBounds, type GoalState } from './types.js';
import {
  BoundsRequiredError,
  GoalInputError,
  RunNotFoundError,
  armContinuation,
  bindContributingRun,
  createGoal,
  evaluateGoal,
  getGoal,
  listGoals,
  transitionGoal,
} from './goalsService.js';

/** ADR 0908 D9 / D5 — a typed refusal returns `{goal: null, error}` to the node
 *  rather than throwing a 500 out of the run. */
async function orRefusal<T extends Record<string, unknown>>(f: () => Promise<T>): Promise<T | { goal: null; error: { code: string; message: string } }> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof GoalInputError || err instanceof BoundsRequiredError) return { goal: null, error: { code: 'validation_error', message: err.message } };
    if (err instanceof RunNotFoundError) return { goal: null, error: { code: 'not_found', message: err.message } };
    throw err;
  }
}

export function buildGoalsSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  // ADR 0908 D6 — the run's person. It only NARROWS here (a principal-owned goal
  // refuses any other person), so the causing member (`orgScopeSubject`) may
  // stand in for an absent actor; ownership on create is stamped from the actor
  // ALONE, because `orgScopeSubject` must never grant. No person ⇒ the ADR 0412
  // tenant-trusted system lane, as before.
  const person = scope.actingUserId ?? scope.orgScopeSubject;
  return {
    create: async (args) => orRefusal(async () => {
      const check = surfaceStr(args.check) || 'verifier';
      const mode = surfaceStr(args.mode) || 'manual';
      if (check !== 'verifier' && check !== 'host') throw new GoalInputError(`Unknown judge \`${check}\`.`, 400, 'completion.check');
      if (mode !== 'schedule' && mode !== 'manual' && mode !== 'commitment' && mode !== 'heartbeat') {
        throw new GoalInputError(`Unknown continuation \`${mode}\`.`, 400, 'continuation.mode');
      }
      const goal = await createGoal({
        objective: surfaceStr(args.objective),
        completion: { check, ...(surfaceOptStr(args.verifierRef) ? { verifierRef: surfaceOptStr(args.verifierRef) } : {}) },
        continuation: { mode, ...(surfaceOptStr(args.armRef) ? { armRef: surfaceOptStr(args.armRef) } : {}) },
        bounds: hasBounds(args.bounds) ? (args.bounds as GoalBounds) : undefined,
        owner: { tenant, ...(scope.actingUserId ? { principal: scope.actingUserId } : {}) },
      });
      return { goal };
    }),
    get: async (args) => ({ goal: await getGoal(tenant, surfaceStr(args.goalId)) }),
    list: async (args) => {
      const s = surfaceStr(args.state);
      const state =
        s === 'active' || s === 'satisfied' || s === 'escalated' || s === 'abandoned' || s === 'bound-exceeded'
          ? (s as GoalState)
          : undefined;
      return { goals: await listGoals(tenant, state) };
    },
    transition: async (args) => {
      const a = surfaceStr(args.action);
      if (a !== 'pause' && a !== 'resume' && a !== 'abandon') return { goal: null };
      return { goal: await transitionGoal(tenant, surfaceStr(args.goalId), a, person) };
    },
    arm: async (args) => ({
      goal: await armContinuation(tenant, surfaceStr(args.goalId), {
        workflowId: surfaceStr(args.workflowId),
        cronExpr: surfaceStr(args.cronExpr),
        ...(surfaceOptStr(args.timezone) ? { timezone: surfaceOptStr(args.timezone) } : {}),
        ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
      }, person),
    }),
    bindRun: async (args) => orRefusal(async () => ({
      goal: await bindContributingRun(
        tenant,
        surfaceStr(args.goalId),
        surfaceStr(args.runId),
        typeof args.costUsd === 'number' && Number.isFinite(args.costUsd) && args.costUsd >= 0 ? args.costUsd : undefined,
        person,
      ),
    })),
    // GOALS-3 (documented contract): evaluation does NOT auto-bind
    // `verdict.runId` into `progress.contributingRunIds` — the consumer binds
    // contributing runs explicitly via `bindRun` (with its spend), keeping run
    // attribution and cost accounting one deliberate call.
    evaluate: async (args) => {
      const result = await evaluateGoal(tenant, surfaceStr(args.goalId), {
        snapshotRef: surfaceStr(args.snapshotRef),
        snapshotHash: surfaceStr(args.snapshotHash),
      }, person);
      return result
        ? { goal: result.goal, verdict: result.verdict, replayed: result.replayed }
        : { goal: null };
    },
  };
}
