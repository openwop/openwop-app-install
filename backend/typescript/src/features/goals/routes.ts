/**
 * Standing-goals routes (RFC 0097) — host-sample seam under `/v1/host/openwop-app/goals`,
 * per `host-sample-test-seams.md §11`.
 *
 * `goal-standing-continuation` behavioral legs: create-without-bounds → 422
 * (requiresBounds), and a client-supplied `state: satisfied` → 4xx. The
 * conformance driver POSTs to `/goals/{id}` (not PATCH) for the state-guard leg
 * and soft-skips on 404, so BOTH `POST` and `PATCH /goals/{id}` are routed to
 * the update handler to keep that leg non-vacuous.
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { tenantOf } from '../../host/requestSubject.js';
import {
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  transitionGoal,
  ensureDemoGoal,
  BoundsRequiredError,
  JudgeOnlyStateError,
  type CreateGoalInput,
} from './goalsService.js';
import type { ContinuationMode, GoalBounds, GoalJudge, GoalState } from './types.js';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const JUDGES: ReadonlySet<string> = new Set<GoalJudge>(['verifier', 'host']);
const MODES: ReadonlySet<string> = new Set<ContinuationMode>(['schedule', 'commitment', 'heartbeat', 'manual']);

function paramId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new OpenwopError('validation_error', 'Invalid goal id.', 400, { id });
  }
  return id;
}

function parseCreate(req: Request): CreateGoalInput {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.objective !== 'string' || body.objective.trim().length === 0) {
    throw new OpenwopError('validation_error', 'Field `objective` is required.', 400, { field: 'objective' });
  }
  const completion = (body.completion ?? {}) as Record<string, unknown>;
  if (typeof completion.check !== 'string' || !JUDGES.has(completion.check)) {
    throw new OpenwopError('validation_error', 'Field `completion.check` MUST be `verifier` or `host`.', 400, { field: 'completion.check' });
  }
  const continuation = (body.continuation ?? {}) as Record<string, unknown>;
  if (typeof continuation.mode !== 'string' || !MODES.has(continuation.mode)) {
    throw new OpenwopError('validation_error', 'Field `continuation.mode` is invalid.', 400, { field: 'continuation.mode' });
  }
  return {
    objective: body.objective,
    completion: { check: completion.check as GoalJudge, ...(typeof completion.verifierRef === 'string' ? { verifierRef: completion.verifierRef } : {}) },
    continuation: { mode: continuation.mode as ContinuationMode, ...(typeof continuation.armRef === 'string' ? { armRef: continuation.armRef } : {}) },
    bounds: (body.bounds && typeof body.bounds === 'object' ? (body.bounds as GoalBounds) : undefined),
    owner: { tenant: tenantOf(req) },
  };
}

export function registerGoalsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const wrap = (h: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await h(req, res);
      } catch (err) {
        next(err);
      }
    };

  app.get(
    '/v1/host/openwop-app/goals',
    wrap(async (req, res) => {
      const tenant = tenantOf(req);
      await ensureDemoGoal(tenant);
      const state = typeof req.query.state === 'string' ? (req.query.state as GoalState) : undefined;
      res.json({ goals: await listGoals(tenant, state) });
    }),
  );

  app.get(
    '/v1/host/openwop-app/goals/:id',
    wrap(async (req, res) => {
      const g = await getGoal(tenantOf(req), paramId(req));
      if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
      res.json(g);
    }),
  );

  // Create — 422 when bounds are required but absent (goal-continuation-bounded).
  app.post(
    '/v1/host/openwop-app/goals',
    wrap(async (req, res) => {
      try {
        const goal = await createGoal(parseCreate(req));
        res.json(goal);
      } catch (err) {
        if (err instanceof BoundsRequiredError) throw new OpenwopError('validation_error', err.message, 422);
        throw err;
      }
    }),
  );

  // Update — client-supplied completion verdict (`state: satisfied`) refused 422
  // (goal-completion-judge-only). Both PATCH (§11 canonical) and POST (what the
  // conformance driver uses) route here so the state-guard leg is non-vacuous.
  const update = wrap(async (req: Request, res: Response) => {
    try {
      const g = await updateGoal(tenantOf(req), paramId(req), (req.body ?? {}) as Record<string, unknown>);
      if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
      res.json(g);
    } catch (err) {
      if (err instanceof JudgeOnlyStateError) throw new OpenwopError('validation_error', err.message, 422, { state: err.state });
      throw err;
    }
  });
  app.patch('/v1/host/openwop-app/goals/:id', update);
  app.post('/v1/host/openwop-app/goals/:id', update);

  for (const action of ['pause', 'resume', 'abandon'] as const) {
    app.post(
      `/v1/host/openwop-app/goals/:id/${action}`,
      wrap(async (req, res) => {
        const g = await transitionGoal(tenantOf(req), paramId(req), action);
        if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
        res.json(g);
      }),
    );
  }
}
