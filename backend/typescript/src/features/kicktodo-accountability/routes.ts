/**
 * kicktodo-accountability REST (ADR 0419 P1) — under the ONE KickTodo prefix;
 * joins the collision-test union. Every mutation is subject-gated; denial is
 * uniform 404. The `/conversation` route is the binding seam's HTTP face —
 * it resolves by OPAQUE circle id (the caller's ACTIVE tenant is irrelevant)
 * and never accepts a client-supplied tenant.
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { requireFeatureEnabled, requireKicktodoManage } from '../featureRoute.js';
import { scheduleSession, cancelSession, listSessions, SessionDeniedError, SessionTimeError } from './sessionService.js';
import {
  createCircle,
  getCircleFor,
  inviteToCircle,
  acceptGrant,
  revokeGrant,
  listGrants,
  listCirclesOwnedBy,
  resolveCircleConversation,
  CircleDeniedError,
  GrantError,
  GRANT_SCOPES,
  type CircleType,
  type GrantScope,
} from './circleService.js';
import { getEnrollment } from '../kicktodo-core/enrollmentService.js';
import { circleFeedFor, nudgeParticipant } from './projectionService.js';
import {
  createCohortDetail,
  getCohortDetail,
  joinCohort,
  indexGrantee,
  coachCaseload,
  proposePlanChange,
  previewProposal,
  listProposalsFor,
  resolveProposal,
  reconcileProposalCard,
  CohortError,
  CohortFullError,
  reconcileSeats,
  releaseRevokedSeat,
  dryRunProposal,
} from './cohortService.js';
import { resolveCircleByOpaqueId } from './circleService.js';

export const KICKTODO_CIRCLES_PREFIX = '/v1/host/openwop-app/kicktodo/circles';

type Handler = (req: Request, res: Response) => Promise<void>;

function subjectOf(req: Request): string {
  const s = callerSubject(req);
  if (!s) throw new OpenwopError('unauthenticated', 'An identified caller is required.', 401);
  return s;
}

async function gate(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'kicktodo-accountability', 'KickTodo Accountability');
}

const CIRCLE_TYPES: ReadonlySet<string> = new Set(['partner', 'circle', 'cohort', 'coach']);

function mapDenied(err: unknown): never {
  if (err instanceof CircleDeniedError) throw new OpenwopError('not_found', err.message, 404);
  if (err instanceof GrantError) throw new OpenwopError('validation_error', err.message, 422);
  throw err;
}

export const KICKTODO_CIRCLES_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: Handler }> = [
  {
    method: 'post',
    path: KICKTODO_CIRCLES_PREFIX,
    handler: async (req, res) => {
      await gate(req);
      const subject = subjectOf(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.enrollmentId !== 'string' || typeof b.type !== 'string' || !CIRCLE_TYPES.has(b.type)) {
        throw new OpenwopError('validation_error', 'Fields `enrollmentId` and `type` (partner|circle|cohort|coach) are required.', 400);
      }
      // The circle is anchored to the CALLER'S OWN enrollment (uniform 404 otherwise).
      const e = await getEnrollment(tenantOf(req), b.enrollmentId);
      if (!e || e.ownerSubject !== subject) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json(await createCircle({
        tenantId: tenantOf(req),
        type: b.type as CircleType,
        enrollmentId: b.enrollmentId,
        ownerSubject: subject,
        name: typeof b.name === 'string' && b.name.trim() ? b.name.slice(0, 120) : 'My circle',
      }));
    },
  },
  {
    method: 'get',
    path: KICKTODO_CIRCLES_PREFIX,
    handler: async (req, res) => {
      await gate(req);
      res.json({ circles: await listCirclesOwnedBy(tenantOf(req), subjectOf(req)) });
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id`,
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json(await getCircleFor(tenantOf(req), req.params.id, subjectOf(req)));
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    // ADR 0444 S1 — upcoming sessions (owner-or-grantee membership read).
    method: 'get',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/sessions`,
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json({ sessions: await listSessions(tenantOf(req), req.params.id, subjectOf(req)) });
      } catch (err) {
        if (err instanceof SessionDeniedError) throw new OpenwopError('not_found', 'Not found.', 404);
        throw err;
      }
    },
  },
  {
    // ADR 0444 S1/S2 — schedule a session (COACH = circle owner; idempotent;
    // notifies live grantees through the ONE notification seam).
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/sessions`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.at !== 'string') throw new OpenwopError('validation_error', 'Field `at` (ISO instant) is required.', 400);
      try {
        res.json(await scheduleSession(tenantOf(req), req.params.id, subjectOf(req), b.at, typeof b.title === 'string' ? b.title : ''));
      } catch (err) {
        if (err instanceof SessionDeniedError) throw new OpenwopError('not_found', 'Not found.', 404);
        if (err instanceof SessionTimeError) throw new OpenwopError('validation_error', err.message, 400);
        throw err;
      }
    },
  },
  {
    // ADR 0444 S1 — cancel (coach only; idempotent; history kept).
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/sessions/cancel`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.at !== 'string') throw new OpenwopError('validation_error', 'Field `at` (ISO instant) is required.', 400);
      try {
        await cancelSession(tenantOf(req), req.params.id, subjectOf(req), b.at);
        res.json({ cancelled: true });
      } catch (err) {
        if (err instanceof SessionDeniedError) throw new OpenwopError('not_found', 'Not found.', 404);
        throw err;
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/invite`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.granteeSubject !== 'string' || !Array.isArray(b.scopes)) {
        throw new OpenwopError('validation_error', 'Fields `granteeSubject` and `scopes[]` are required.', 400, {
          validScopes: GRANT_SCOPES,
        });
      }
      try {
        const grant = await inviteToCircle(tenantOf(req), req.params.id, subjectOf(req), b.granteeSubject, b.scopes as GrantScope[]);
        await indexGrantee(b.granteeSubject, req.params.id, tenantOf(req)); // P3 caseload pointer
        res.json(grant);
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    // Accept by OPAQUE circle id — the grantee may be signed into a DIFFERENT
    // active tenant; the binding resolves the owning tenant server-side.
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/accept`,
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json(await acceptGrant(req.params.id, subjectOf(req)));
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/revoke`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.granteeSubject !== 'string') {
        throw new OpenwopError('validation_error', 'Field `granteeSubject` is required.', 400);
      }
      try {
        const result = await revokeGrant(tenantOf(req), req.params.id, subjectOf(req), b.granteeSubject);
        // KTD-14 — a revoke here bypasses `releaseSeat`, so the member's seat
        // must be released too: prune the orphan ledger row and RESTATE the
        // count (a stranded `seatsTaken` wrongly refuses a new buyer). No-op for
        // a non-cohort circle. BEST-EFFORT: the revoke is the authoritative
        // action and has already committed; a transient CAS-contention failure
        // in the reconcile must not fail the revoke response — the count heals
        // on any later reconcile (the same posture as `releaseSeat`), and the
        // pre-fix state was exactly this staleness, so a miss is never worse.
        // KTD-14/16 — best-effort seat heal; `releaseRevokedSeat` swallows +
        // logs a transient reconcile failure internally, so the committed
        // revoke response is never turned into a 500.
        await releaseRevokedSeat(tenantOf(req), req.params.id, b.granteeSubject);
        res.json(result);
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/grants`,
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json({ grants: await listGrants(tenantOf(req), req.params.id, subjectOf(req)) });
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    // ADR 0419 P2 — the privacy-projected feed (allowlist per the caller's
    // LIVE grant scopes; opaque-id resolution — cross-tenant like the seam).
    method: 'get',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/feed`,
    handler: async (req, res) => {
      await gate(req);
      try {
        const circle = await resolveCircleByOpaqueId(req.params.id);
        res.json(await circleFeedFor(circle, subjectOf(req)));
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    // ADR 0419 P2 — a content-free nudge (message scope; centralized
    // notification policy applies downstream).
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/nudge`,
    handler: async (req, res) => {
      await gate(req);
      try {
        const circle = await resolveCircleByOpaqueId(req.params.id);
        await nudgeParticipant(circle, subjectOf(req));
        res.json({ nudged: true });
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    // ADR 0419 P3 — cohort detail (owner creates; pinned version + capacity).
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/cohort`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        const circle = await getCircleFor(tenantOf(req), req.params.id, subjectOf(req));
        res.json(await createCohortDetail({
          circle,
          actorSubject: subjectOf(req),
          capacity: typeof b.capacity === 'number' ? b.capacity : 0,
          startDateLocal: typeof b.startDateLocal === 'string' ? b.startDateLocal : new Date().toISOString().slice(0, 10),
        }));
      } catch (err) {
        if (err instanceof CohortError) throw new OpenwopError('validation_error', err.message, 422);
        mapDenied(err);
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/cohort`,
    handler: async (req, res) => {
      await gate(req);
      try {
        await getCircleFor(tenantOf(req), req.params.id, subjectOf(req));
        const detail = await getCohortDetail(tenantOf(req), req.params.id);
        if (!detail) throw new OpenwopError('not_found', 'No cohort detail.', 404);
        res.json(detail);
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    // Join by OPAQUE id (cross-tenant like accept) — exact CAS capacity.
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/join`,
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json(await joinCohort(req.params.id, subjectOf(req)));
      } catch (err) {
        if (err instanceof CohortFullError) throw new OpenwopError('conflict', err.message, 409);
        if (err instanceof CohortError) throw new OpenwopError('conflict', err.message, 409);
        mapDenied(err);
      }
    },
  },
  {
    // ARCH-3 (KTFULL-B12) — the operator repair entry for seat occupancy.
    // `reconcileSeats` existed and was called INTERNALLY by the expiry and
    // release paths, but a partial failure that skipped those paths entirely
    // left no way to invoke it — so "the sagas are repairable" was true of the
    // function and not of the system. B13's entitlement repair already ships
    // an operator route; this makes the seat repair reachable the same way.
    // Admin-gated: restating a capacity counter is an administrative act.
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/reconcile-seats`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-accountability', 'KickTodo Accountability');
      subjectOf(req);
      const detail = await reconcileSeats(tenantOf(req), req.params.id);
      if (!detail) throw new OpenwopError('not_found', 'Cohort not found.', 404);
      res.json({ circleId: detail.circleId, seatsTaken: detail.seatsTaken, capacity: detail.capacity });
    },
  },
  {
    // ADR 0419 P3 — the coach console (cross-workspace caseload; live grants).
    method: 'get',
    path: '/v1/host/openwop-app/kicktodo/coach/caseload',
    handler: async (req, res) => {
      await gate(req);
      res.json({ caseload: await coachCaseload(subjectOf(req)) });
    },
  },
  {
    // Coach proposes. ADR 0501 step 2 — no longer INERT: an optional `commands[]`
    // carries the EXECUTABLE change (closed-world over the three ADR 0429 lanes),
    // validated at authoring time so the coach learns immediately if their ask falls
    // outside them. Omitting it still yields a prose-only proposal, which is advice
    // and is never applyable (see PlanChangeProposal.commands).
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/proposals`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await proposePlanChange(
          req.params.id,
          subjectOf(req),
          typeof b.note === 'string' ? b.note : '',
          // `undefined` (advice-only) and `[]` are DIFFERENT and must stay different:
          // absent means nothing to execute; an explicit empty array is a coach saying
          // "no changes", which the seam treats as an honest no-op. Passing `[]` for an
          // absent field would make every legacy-shaped request look applyable.
          Array.isArray(b.commands) ? b.commands : undefined,
        ));
      } catch (err) {
        if (err instanceof CohortError) throw new OpenwopError('validation_error', err.message, 422);
        mapDenied(err);
      }
    },
  },
  {
    // ADR 0501 (console) — the coach's DRY RUN: validate + humanize a command list
    // under the same grant check as propose; persists nothing, reads no plan.
    method: 'post',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/proposals/dry-run`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await dryRunProposal(req.params.id, subjectOf(req), Array.isArray(b.commands) ? b.commands : []));
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    // The PARTICIPANT lists + resolves proposals for their own enrollment.
    method: 'get',
    path: '/v1/host/openwop-app/kicktodo/enrollments/:enrollmentId/proposals',
    handler: async (req, res) => {
      await gate(req);
      const e = await getEnrollment(tenantOf(req), req.params.enrollmentId);
      if (!e || e.ownerSubject !== subjectOf(req)) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json({ proposals: await listProposalsFor(tenantOf(req), req.params.enrollmentId) });
    },
  },
  {
    // ADR 0501 step 4 — the dry-run compare, for the participant, BEFORE deciding.
    // Safe to exist only because step 3 (#2688) landed: there is no longer such a thing
    // as a proposal that cannot execute, so a compare describes something real. Shipping
    // this earlier would have made the false promise more convincing, not less.
    method: 'get',
    path: '/v1/host/openwop-app/kicktodo/enrollments/:enrollmentId/proposals/:proposalId/preview',
    handler: async (req, res) => {
      await gate(req);
      try {
        res.json(await previewProposal(tenantOf(req), req.params.enrollmentId, req.params.proposalId, subjectOf(req)));
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    method: 'post',
    path: '/v1/host/openwop-app/kicktodo/enrollments/:enrollmentId/proposals/:proposalId',
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const action = b.action === 'apply' ? 'apply' : b.action === 'dismiss' ? 'dismiss' : null;
      if (!action) throw new OpenwopError('validation_error', 'Field `action` must be apply|dismiss.', 400);
      try {
        const resolved = await resolveProposal(tenantOf(req), req.params.enrollmentId, req.params.proposalId, subjectOf(req), action);
        // ADR 0459 grade-fix — a proposal resolved through this retained route must
        // not strand its pending approval card. Best-effort reconcile the linked card
        // to match (apply→approved, dismiss→rejected); log-and-continue internally,
        // since the proposal row is already the authoritative decision.
        await reconcileProposalCard(resolved, action);
        res.json(resolved);
      } catch (err) {
        mapDenied(err);
      }
    },
  },
  {
    // THE BINDING SEAM's HTTP face: opaque id in, {conversationId, scopes} out
    // — after a LIVE grant proof under the OWNING tenant.
    method: 'get',
    path: `${KICKTODO_CIRCLES_PREFIX}/:id/conversation`,
    handler: async (req, res) => {
      await gate(req);
      try {
        const bound = await resolveCircleConversation(req.params.id, subjectOf(req));
        // The OWNING tenant is intentionally NOT returned — the client gets a
        // conversation handle, never a tenant to replay elsewhere.
        res.json({ conversationId: bound.conversationId, scopes: bound.scopes });
      } catch (err) {
        mapDenied(err);
      }
    },
  },
];

export function registerKicktodoAccountabilityRoutes(deps: RouteDeps): void {
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_CIRCLES_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }
}
