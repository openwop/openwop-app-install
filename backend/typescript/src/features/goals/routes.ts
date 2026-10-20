/**
 * Standing-goals routes (RFC 0097) — host-sample seam under `/host/openwop-app/goals`,
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
import { resolveTenantWorkflow } from '../../host/resolveLaunchDefinition.js';
import { callerOwnerSpellings } from '../featureRoute.js';
import { GOALS_READ, GOALS_WRITE, goalActorOf, isGoalsOperator, requireGoalsScope } from './access.js';
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
  GoalInputError,
  RunNotFoundError,
  FeatureArmedContinuationError,
  goalIsMutable,
  validateGoalInput,
  type CreateGoalInput,
} from './goalsService.js';
import { resolveGoalVerifier } from './goalVerifiers.js';
import type { ContinuationMode, GoalBounds, GoalJudge, GoalState } from './types.js';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const JUDGES: ReadonlySet<string> = new Set<GoalJudge>(['verifier', 'host']);
const MODES: ReadonlySet<string> = new Set<ContinuationMode>(['schedule', 'commitment', 'heartbeat', 'manual']);
const STATES: ReadonlySet<string> = new Set<GoalState>(['active', 'satisfied', 'escalated', 'abandoned', 'bound-exceeded']);

function paramId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new OpenwopError('validation_error', 'Invalid goal id.', 400, { id });
  }
  return id;
}

function parseCreate(req: Request): CreateGoalInput {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.objective !== 'string') {
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
    bounds: body.bounds === undefined ? undefined : (body.bounds as GoalBounds),
    // ADR 0412 P5 — principal/workspace ownership: a goal created by an
    // identified caller is principal-owned (mutations require the same acting
    // principal; uniform 404 otherwise). The wildcard conformance bearer has
    // no subject and keeps tenant-only semantics. ADR 0908 D2 — a key's goal is
    // owned by the person who minted the key, not by the key.
    owner: { tenant: tenantOf(req), ...(ownerPrincipalOf(req) ? { principal: ownerPrincipalOf(req) } : {}) },
  };
}

/** Every spelling of the person acting (ADR 0908 D1 / `GL2WF-10`). A key acts as
 *  its issuer (the owner its goals were stamped with); a caller with no subject
 *  at all (the wildcard bearer) stays tenant-trusted, as before. */
async function actingSpellings(req: Request): Promise<readonly string[] | undefined> {
  if (req.principal?.auth?.kind === 'api-key') return [req.principal.auth.issuer];
  const spellings = await callerOwnerSpellings(req);
  return spellings.length > 0 ? spellings : undefined;
}

function ownerPrincipalOf(req: Request): string | undefined {
  return req.principal?.auth?.kind === 'api-key' ? req.principal.auth.issuer : callerSubject(req);
}

/** ADR 0908 D9 / D5 — the typed service refusals every route maps the same way. */
function mapInputError(err: unknown): never {
  if (err instanceof BoundsRequiredError) throw new OpenwopError('validation_error', err.message, 422);
  if (err instanceof GoalInputError) throw new OpenwopError('validation_error', err.message, err.status, { field: err.field });
  if (err instanceof RunNotFoundError) throw new OpenwopError('not_found', err.message, 404);
  throw err;
}

export function registerGoalsRoutes(deps: RouteDeps): void {
  const { app, hostSuite } = deps;
  const wrap = (h: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await h(req, res);
      } catch (err) {
        next(err);
      }
    };

  app.get(
    '/host/openwop-app/goals',
    wrap(async (req, res) => {
      await requireGoalsScope(req, GOALS_READ);
      const tenant = tenantOf(req);
      const raw = req.query.state;
      if (raw !== undefined && (typeof raw !== 'string' || !STATES.has(raw))) {
        throw new OpenwopError('validation_error', 'Query `state` must be one of: active, satisfied, escalated, abandoned, bound-exceeded.', 400, { field: 'state' });
      }
      // ADR 0908 D4 — the conformance fixture exists only for, and is shown only
      // to, an operator credential; a person's list never seeds or shows it.
      const operator = isGoalsOperator(req);
      if (operator) await ensureDemoGoal(tenant);
      res.json({ goals: await listGoals(tenant, raw as GoalState | undefined, { includeFixture: operator }) });
    }),
  );

  app.get(
    '/host/openwop-app/goals/:id',
    wrap(async (req, res) => {
      await requireGoalsScope(req, GOALS_READ);
      const g = await getGoal(tenantOf(req), paramId(req), { includeFixture: isGoalsOperator(req) });
      if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
      res.json(g);
    }),
  );

  // Create — 422 when bounds are required but absent (goal-continuation-bounded).
  app.post(
    '/host/openwop-app/goals',
    wrap(async (req, res) => {
      await requireGoalsScope(req, GOALS_WRITE);
      try {
        const input = parseCreate(req);
        // `GL2UX-4` — a verifier ref nobody registered can never judge the goal:
        // refuse it at create, not at the first evaluation. (After the closed-
        // world check, so a missing ref or an unadvertised judge answers first.)
        validateGoalInput(input);
        if (input.completion.verifierRef !== undefined && !resolveGoalVerifier(input.completion.verifierRef)) {
          throw new OpenwopError('validation_error', `Verifier \`${input.completion.verifierRef}\` is not registered on this host.`, 422, { field: 'completion.verifierRef' });
        }
        const goal = await createGoal(input);
        res.json(goal);
      } catch (err) {
        mapInputError(err);
      }
    }),
  );

  // Update — client-supplied completion verdict (`state: satisfied`) refused 422
  // (goal-completion-judge-only). Both PATCH (§11 canonical) and POST (what the
  // conformance driver uses) route here so the state-guard leg is non-vacuous.
  const update = wrap(async (req: Request, res: Response) => {
    await requireGoalsScope(req, GOALS_WRITE);
    try {
      const g = await updateGoal(tenantOf(req), paramId(req), (req.body ?? {}) as Record<string, unknown>, await actingSpellings(req));
      if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
      res.json(g);
    } catch (err) {
      if (err instanceof JudgeOnlyStateError) throw new OpenwopError('validation_error', err.message, 422, { state: err.state });
      mapInputError(err);
    }
  });
  app.patch('/host/openwop-app/goals/:id', update);
  app.post('/host/openwop-app/goals/:id', update);

  for (const action of ['pause', 'resume', 'abandon'] as const) {
    app.post(
      `/host/openwop-app/goals/:id/${action}`,
      wrap(async (req, res) => {
        await requireGoalsScope(req, GOALS_WRITE);
        try {
          const g = await transitionGoal(tenantOf(req), paramId(req), action, await actingSpellings(req));
          if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
          res.json(g);
        } catch (err) {
          if (err instanceof GoalNotActiveError) throw new OpenwopError('conflict', err.message, 409, { state: err.state });
          if (err instanceof ConcurrentGoalUpdateError) throw new OpenwopError('conflict', err.message, 409);
          throw err;
        }
      }),
    );
  }

  // ADR 0412 P1 — bind a contributing run (dedup append, CAS).
  app.post(
    '/host/openwop-app/goals/:id/runs',
    wrap(async (req, res) => {
      await requireGoalsScope(req, GOALS_WRITE);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.runId !== 'string' || !ID_PATTERN.test(body.runId)) {
        throw new OpenwopError('validation_error', 'Field `runId` is required.', 400, { field: 'runId' });
      }
      if (body.costUsd !== undefined && (typeof body.costUsd !== 'number' || !Number.isFinite(body.costUsd) || body.costUsd < 0)) {
        throw new OpenwopError('validation_error', 'Field `costUsd` must be a non-negative number.', 400, { field: 'costUsd' });
      }
      try {
        const g = await bindContributingRun(tenantOf(req), paramId(req), body.runId, body.costUsd as number | undefined, await actingSpellings(req));
        if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
        res.json(g);
      } catch (err) {
        if (err instanceof ConcurrentGoalUpdateError) throw new OpenwopError('conflict', err.message, 409);
        mapInputError(err);
      }
    }),
  );

  // ADR 0412 P4 — arm `schedule` continuation: ONE deterministic scheduler job
  // per goal firing the consumer-supplied checkpoint workflow. Pause/resume
  // toggle it; terminal transitions disarm it.
  app.post(
    '/host/openwop-app/goals/:id/arm',
    wrap(async (req, res) => {
      // ADR 0908 D2 — arming registers a scheduler job, so it asks what the
      // scheduler POST asks (ADR 0787 D3).
      await requireGoalsScope(req, GOALS_WRITE);
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const field of ['workflowId', 'cronExpr'] as const) {
        if (typeof body[field] !== 'string' || (body[field] as string).length === 0) {
          throw new OpenwopError('validation_error', `Field \`${field}\` is required.`, 400, { field });
        }
      }
      if (body.timezone !== undefined && typeof body.timezone !== 'string') {
        throw new OpenwopError('validation_error', 'Field `timezone` must be a string.', 400, { field: 'timezone' });
      }
      const tenant = tenantOf(req);
      const id = paramId(req);
      // `GL2CD-9` — visibility first: no later refusal may reveal a goal this
      // caller cannot act on (uniform 404).
      if (!(await goalIsMutable(tenant, id, await actingSpellings(req)))) throw new OpenwopError('not_found', 'Goal not found.', 404);
      // ADR 0823 — a workflow this tenant cannot run (unknown or another tenant's)
      // is refused before any job exists, with no existence oracle between the two.
      const wf = await resolveTenantWorkflow(hostSuite.workflowCatalog, tenant, body.workflowId as string);
      if (!wf) throw new OpenwopError('workflow_not_found', 'Workflow not found in this catalog.', 422, { workflowId: body.workflowId });
      try {
        // ADR 0908 D2 — the service refuses to replace a continuation a FEATURE
        // armed (FeatureArmedContinuationError → 409).
        const { actingUserId, causedBy } = goalActorOf(req);
        const g = await armContinuation(
          tenant,
          id,
          {
            workflowId: body.workflowId as string,
            cronExpr: body.cronExpr as string,
            ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
            ...(actingUserId !== undefined ? { actingUserId } : {}),
            ...(causedBy !== undefined ? { causedBy } : {}),
          },
          await actingSpellings(req),
        );
        if (!g) throw new OpenwopError('not_found', 'Goal not found.', 404);
        res.json(g);
      } catch (err) {
        if (err instanceof GoalNotActiveError) throw new OpenwopError('conflict', err.message, 409, { state: err.state });
        if (err instanceof FeatureArmedContinuationError) throw new OpenwopError('conflict', err.message, 409, { managedBy: 'feature' });
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
    '/host/openwop-app/goals/:id/evaluate',
    wrap(async (req, res) => {
      await requireGoalsScope(req, GOALS_WRITE);
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
          await actingSpellings(req),
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
