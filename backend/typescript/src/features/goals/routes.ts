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
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import {
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  transitionGoal,
  ensureDemoGoal,
  bindContributingRun,
  evaluateGoal,
  armContinuation,
  BoundsRequiredError,
  JudgeOnlyStateError,
  GoalNotActiveError,
  GoalBoundExceededError,
  VerifierUnavailableError,
  VerifierFailedError,
  ConcurrentGoalUpdateError,
  ContinuationModeError,
  ScheduleRegistrationError,
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
    // ADR 0412 P5 — principal/workspace ownership: a goal created by an
    // identified caller is principal-owned (mutations require the same acting
    // principal; uniform 404 otherwise). The wildcard conformance bearer has
    // no subject and keeps tenant-only semantics.
    owner: { tenant: tenantOf(req), ...(callerSubject(req) ? { principal: callerSubject(req) } : {}) },
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
      const g = await updateGoal(tenantOf(req), paramId(req), (req.body ?? {}) as Record<string, unknown>, callerSubject(req));
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
        const g = await transitionGoal(tenantOf(req), paramId(req), action, callerSubject(req));
        if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
        res.json(g);
      }),
    );
  }

  // ADR 0412 P1 — bind a contributing run (dedup append, CAS).
  app.post(
    '/v1/host/openwop-app/goals/:id/runs',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.runId !== 'string' || !ID_PATTERN.test(body.runId)) {
        throw new OpenwopError('validation_error', 'Field `runId` is required.', 400, { field: 'runId' });
      }
      if (body.costUsd !== undefined && (typeof body.costUsd !== 'number' || !Number.isFinite(body.costUsd) || body.costUsd < 0)) {
        throw new OpenwopError('validation_error', 'Field `costUsd` must be a non-negative number.', 400, { field: 'costUsd' });
      }
      try {
        const g = await bindContributingRun(tenantOf(req), paramId(req), body.runId, body.costUsd as number | undefined, callerSubject(req));
        if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
        res.json(g);
      } catch (err) {
        if (err instanceof ConcurrentGoalUpdateError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    }),
  );

  // ADR 0412 P4 — arm `schedule` continuation: ONE deterministic scheduler job
  // per goal firing the consumer-supplied checkpoint workflow. Pause/resume
  // toggle it; terminal transitions disarm it.
  app.post(
    '/v1/host/openwop-app/goals/:id/arm',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const field of ['workflowId', 'cronExpr'] as const) {
        if (typeof body[field] !== 'string' || (body[field] as string).length === 0) {
          throw new OpenwopError('validation_error', `Field \`${field}\` is required.`, 400, { field });
        }
      }
      if (body.timezone !== undefined && typeof body.timezone !== 'string') {
        throw new OpenwopError('validation_error', 'Field `timezone` must be a string.', 400, { field: 'timezone' });
      }
      try {
        const g = await armContinuation(
          tenantOf(req),
          paramId(req),
          {
            workflowId: body.workflowId as string,
            cronExpr: body.cronExpr as string,
            ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
          },
          callerSubject(req),
        );
        if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
        res.json(g);
      } catch (err) {
        if (err instanceof GoalNotActiveError) throw new OpenwopError('conflict', err.message, 409, { state: err.state });
        if (err instanceof ContinuationModeError) throw new OpenwopError('conflict', err.message, 409, { mode: err.mode });
        if (err instanceof ScheduleRegistrationError) throw new OpenwopError('validation_error', err.message, 422);
        if (err instanceof ConcurrentGoalUpdateError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    }),
  );

  // ADR 0412 P1 — the judge-write path. The caller supplies ONLY the opaque
  // immutable evidence snapshot (ref + hash); the verdict is computed server-
  // side by the registered verifier, preserving `goal-completion-judge-only`
  // (a request body cannot carry a verdict). Fail-closed: missing verifier →
  // 409, broken verifier → 502, and neither transitions the goal.
  app.post(
    '/v1/host/openwop-app/goals/:id/evaluate',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const field of ['snapshotRef', 'snapshotHash'] as const) {
        if (typeof body[field] !== 'string' || (body[field] as string).length === 0) {
          throw new OpenwopError('validation_error', `Field \`${field}\` is required.`, 400, { field });
        }
      }
      try {
        const result = await evaluateGoal(
          tenantOf(req),
          paramId(req),
          { snapshotRef: body.snapshotRef as string, snapshotHash: body.snapshotHash as string },
          callerSubject(req),
        );
        if (!result) throw new OpenwopError('not_found', 'Goal not found.', 404);
        res.json(result);
      } catch (err) {
        if (err instanceof GoalNotActiveError) throw new OpenwopError('conflict', err.message, 409, { state: err.state });
        if (err instanceof GoalBoundExceededError) throw new OpenwopError('conflict', err.message, 409, { breach: err.breach });
        if (err instanceof VerifierUnavailableError) throw new OpenwopError('conflict', err.message, 409);
        if (err instanceof VerifierFailedError) throw new OpenwopError('runner_unavailable', err.message, 502);
        if (err instanceof ConcurrentGoalUpdateError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    }),
  );
}
