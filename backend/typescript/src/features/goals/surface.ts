/**
 * Goals workflow surface (ADR 0412 P1 — the first slice of the external
 * consumption seam ADR 0414 builds on). `ctx.features.goals` — typed, tenant-
 * bound methods a feature or `role:action` pack node calls; every method
 * enforces tenant isolation via the goals service (CTI-1: a cross-tenant id is
 * simply not found).
 *
 * Slice scope (P1): create / get / bindRun / evaluate. Principal/workspace
 * ownership + resource authorization land at P5 and extend these methods
 * in place.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceOptStr, surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { hasBounds, type GoalBounds, type GoalState } from './types.js';
import {
  armContinuation,
  bindContributingRun,
  createGoal,
  evaluateGoal,
  getGoal,
  listGoals,
  transitionGoal,
} from './goalsService.js';

export function buildGoalsSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return {
    create: async (args) => {
      const check = surfaceStr(args.check) === 'host' ? 'host' : 'verifier';
      const modeRaw = surfaceStr(args.mode);
      const mode =
        modeRaw === 'schedule' || modeRaw === 'commitment' || modeRaw === 'heartbeat' ? modeRaw : 'manual';
      const goal = await createGoal({
        objective: surfaceStr(args.objective),
        completion: { check, ...(surfaceOptStr(args.verifierRef) ? { verifierRef: surfaceOptStr(args.verifierRef) } : {}) },
        continuation: { mode, ...(surfaceOptStr(args.armRef) ? { armRef: surfaceOptStr(args.armRef) } : {}) },
        bounds: hasBounds(args.bounds) ? (args.bounds as GoalBounds) : undefined,
        owner: { tenant },
      });
      return { goal };
    },
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
      return { goal: await transitionGoal(tenant, surfaceStr(args.goalId), a) };
    },
    arm: async (args) => ({
      goal: await armContinuation(tenant, surfaceStr(args.goalId), {
        workflowId: surfaceStr(args.workflowId),
        cronExpr: surfaceStr(args.cronExpr),
        ...(surfaceOptStr(args.timezone) ? { timezone: surfaceOptStr(args.timezone) } : {}),
      }),
    }),
    bindRun: async (args) => ({
      goal: await bindContributingRun(
        tenant,
        surfaceStr(args.goalId),
        surfaceStr(args.runId),
        typeof args.costUsd === 'number' && Number.isFinite(args.costUsd) && args.costUsd >= 0 ? args.costUsd : undefined,
      ),
    }),
    // GOALS-3 (documented contract): evaluation does NOT auto-bind
    // `verdict.runId` into `progress.contributingRunIds` — the consumer binds
    // contributing runs explicitly via `bindRun` (with its spend), keeping run
    // attribution and cost accounting one deliberate call.
    evaluate: async (args) => {
      const result = await evaluateGoal(tenant, surfaceStr(args.goalId), {
        snapshotRef: surfaceStr(args.snapshotRef),
        snapshotHash: surfaceStr(args.snapshotHash),
      });
      return result
        ? { goal: result.goal, verdict: result.verdict, replayed: result.replayed }
        : { goal: null };
    },
  };
}
