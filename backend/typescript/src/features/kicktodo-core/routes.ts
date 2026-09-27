/**
 * kicktodo-core REST (ADR 0414 P1) — host-extension routes under the ONE
 * collision-resistant owner `/v1/host/openwop-app/kicktodo/*` (PRD §9.4).
 *
 * ROUTE TABLE AS DATA: every route is declared in `KICKTODO_ROUTES` and
 * registered from it, so `test/kicktodo-route-collision.test.ts` can prove the
 * prefix has no intra-KickTodo method/path collision (the ADR's registration
 * invariant) against the same single source the app mounts.
 *
 * Every handler: feature-toggle gate (`requireFeatureEnabled`) → tenant scope
 * (`tenantOf`) → acting subject (`callerSubject`) with uniform-404 denial on
 * foreign resources (PRD §10.1).
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { publicChallengeCatalog } from './publicCatalogService.js';
import { PUBLIC_EMBED_PREFIX } from '../../middleware/cors.js';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { listExceptions } from '../../host/exceptionProjection.js';
import { listChain, AUDIT_KIND_GOVERNANCE_DECISION } from '../../host/auditChainService.js';
import { requireKicktodoManage, requireFeatureEnabled, hasKicktodoEnrollmentAuthority } from '../featureRoute.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { buildKicktodoReadiness } from './readinessService.js';
import {
  createDraft,
  getChallenge,
  listPublished,
  listPublishedForLocale,
  publishChallenge,
  retireChallenge,
  ChallengeValidationError,
  ChallengeImmutableError,
} from './challengeService.js';
import {
  enroll,
  getEnrollment,
  listEnrollmentsFor,
  applyPlanRevision,
  abandonEnrollment,
  setSchedulePreference,
  InvalidDaysOfWeekError,
  materializeOccurrences,
  ChallengeNotEnrollableError,
  EnrollDeniedError,
  substituteOccurrence,
  SubstitutionDeniedError,
} from './enrollmentService.js';
import { acceptRecovery, submitCheckIn, todayFor, journalFor, planFor, CheckInDeniedError, EvidenceRequiredError } from './todayService.js';
import { ensureKickBot } from './kickbotService.js';
import { recommendedChallengesFor, DEFAULT_RECOMMENDATION_LIMIT } from './recommendationService.js';
import { evaluateEnrollment, progressFor, setEnrollmentSnooze, EnrollmentNotEvaluableError, type ProgressView } from './progressService.js';
import { applyRevisionCommands, previewRevisionCommands } from './replanService.js';
import { mintInvite, revokeInvite, InviteDeniedError } from './inviteService.js';
import type { ChallengeActivity } from './types.js';

export const KICKTODO_PREFIX = '/v1/host/openwop-app/kicktodo';

type Handler = (req: Request, res: Response) => Promise<void>;

/** Acting subject — required on every kicktodo route (consumer product: an
 *  unidentified caller has no Today, no enrollments, no check-ins). */
function subjectOf(req: Request): string {
  const s = callerSubject(req);
  if (!s) throw new OpenwopError('unauthenticated', 'An identified caller is required.', 401);
  return s;
}

async function gate(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'kicktodo-core', 'KickTodo');
}

/** ADR 0434 (KTFULL-B1) — AUTHORING authority. Creating, reading a draft,
 *  publishing and retiring a challenge decide what real participants are told
 *  to do, so they are admin-class acts. Participant routes below keep the
 *  ordinary `gate()`; only the authoring family is privileged. */
async function authoringGate(req: Request): Promise<void> {
  await requireKicktodoManage(req, 'kicktodo-core', 'KickTodo');
}

const EVIDENCE_POLICIES = new Set(['attestation', 'note', 'photo', 'measurement']);

function parseActivities(raw: unknown): ChallengeActivity[] {
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', 'Field `activities` must be an array.', 400);
  return raw.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    if (typeof o.stableActivityId !== 'string' || typeof o.title !== 'string' || typeof o.day !== 'number') {
      throw new OpenwopError('validation_error', 'Each activity needs `stableActivityId`, `title`, `day`.', 400);
    }
    const evidencePolicy = typeof o.evidencePolicy === 'string' && EVIDENCE_POLICIES.has(o.evidencePolicy)
      ? (o.evidencePolicy as ChallengeActivity['evidencePolicy'])
      : 'attestation';
    return {
      stableActivityId: o.stableActivityId,
      day: o.day,
      title: o.title,
      instructions: typeof o.instructions === 'string' ? o.instructions : '',
      ...(typeof o.estimatedMinutes === 'number' ? { estimatedMinutes: o.estimatedMinutes } : {}),
      evidencePolicy,
    };
  });
}

/** THE single route source (method+path uniqueness is test-enforced). */
export const KICKTODO_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: Handler }> = [
  {
    method: 'get',
    path: `${KICKTODO_PREFIX}/challenges`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ challenges: await listPublished(tenantOf(req)) });
    },
  },
  {
    // ADR 0692 — "what next" for THIS participant: deterministic, self-data only
    // (their enrollments + the depth facet), reasons rendered verbatim. Registered
    // beside the catalog read and BEFORE any `/challenges/:id/…` family so the
    // literal segment is never read as an id.
    method: 'get',
    path: `${KICKTODO_PREFIX}/challenges/recommended`,
    handler: async (req, res) => {
      await gate(req);
      const raw = Number(req.query['limit']);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 10) : DEFAULT_RECOMMENDATION_LIMIT;
      res.json({ recommendations: await recommendedChallengesFor(tenantOf(req), subjectOf(req), limit) });
    },
  },
  {
    // ADR 0460 Phase 2 — the admin Exception Ledger read: the host
    // exception-projection composed over the registered KickTodo sources
    // (approvals / monitor / payouts / review-flags). Manage-gated; a down
    // source is reported degraded in `sources[]`, never silently dropped.
    method: 'get',
    path: `${KICKTODO_PREFIX}/admin/exceptions`,
    handler: async (req, res) => {
      await authoringGate(req);
      res.json(await listExceptions(tenantOf(req)));
    },
  },
  {
    // SCREEN_POLISH admin residue (ADR 0301) — the chain SLICE behind one
    // approval-backed ledger row: this tenant's GOVERNANCE_DECISION entries
    // for the approvalId, newest-capped. Actor→before→after ride the payload
    // (enriched at resolveApproval); an empty slice is an honest "not decided
    // yet / predates enrichment", never an error. Tenant-scoped by listChain;
    // on-demand per expander click (never a page-load fan-out).
    method: 'get',
    path: `${KICKTODO_PREFIX}/admin/exceptions/audit`,
    handler: async (req, res) => {
      await authoringGate(req);
      const approvalId = typeof req.query['approvalId'] === 'string' ? req.query['approvalId'] : '';
      if (!approvalId) throw new OpenwopError('validation_error', 'Query `approvalId` is required.', 400);
      const entries = (await listChain(tenantOf(req)))
        .filter((e) => e.kind === AUDIT_KIND_GOVERNANCE_DECISION
          && (e.payload as { approvalId?: unknown }).approvalId === approvalId)
        .slice(-20)
        .map((e) => ({ seq: e.seq, at: e.at, payload: e.payload }));
      res.json({ entries });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/challenges`,
    handler: async (req, res) => {
      await authoringGate(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const draft = await createDraft({
          tenantId: tenantOf(req),
          authorSubject: subjectOf(req),
          title: typeof body.title === 'string' ? body.title : '',
          summary: typeof body.summary === 'string' ? body.summary : '',
          outcome: typeof body.outcome === 'string' ? body.outcome : '',
          durationDays: typeof body.durationDays === 'number' ? body.durationDays : 0,
          activities: parseActivities(body.activities),
        });
        res.json(draft);
      } catch (err) {
        if (err instanceof ChallengeValidationError) throw new OpenwopError('validation_error', err.message, 422);
        throw err;
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_PREFIX}/challenges/:id/versions/:version`,
    handler: async (req, res) => {
      // A specific VERSION read can expose an unpublished draft, so it takes
      // authoring authority; the published catalog stays open to participants.
      await authoringGate(req);
      const c = await getChallenge(tenantOf(req), req.params.id, Number(req.params.version));
      if (!c) throw new OpenwopError('not_found', 'Challenge not found.', 404);
      res.json(c);
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/challenges/:id/versions/:version/publish`,
    handler: async (req, res) => {
      await authoringGate(req);
      try {
        const c = await publishChallenge(tenantOf(req), req.params.id, Number(req.params.version));
        if (!c) throw new OpenwopError('not_found', 'Challenge not found.', 404);
        res.json(c);
      } catch (err) {
        if (err instanceof ChallengeImmutableError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/challenges/:id/versions/:version/retire`,
    handler: async (req, res) => {
      await authoringGate(req);
      const c = await retireChallenge(tenantOf(req), req.params.id, Number(req.params.version));
      if (!c) throw new OpenwopError('not_found', 'Challenge not found.', 404);
      res.json(c);
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_PREFIX}/enrollments`,
    handler: async (req, res) => {
      await gate(req);
      const enrollments = await listEnrollmentsFor(tenantOf(req), subjectOf(req));
      if (req.query['include'] !== 'progress') {
        res.json({ enrollments });
        return;
      }
      // KTX-3 — the batch progress read: Progress fanned out one
      // GET /enrollments/:id/progress per enrollment, a per-IP rate-limit
      // hazard. Same projection, one request; authority is the list itself
      // (progressFor only ever sees the caller's own enrollment ids).
      const progress: Record<string, ProgressView> = {};
      for (const e of enrollments) {
        const p = await progressFor(tenantOf(req), e.id);
        if (p) progress[e.id] = p;
      }
      res.json({ enrollments, progress });
    },
  },
  {
    // ADR 0444 I1 — mint (or re-mint, revoking the prior) the CALLER's invite
    // link token for a published challenge. Deliberately NOT under /challenges/*
    // (that path family is the privileged authoring lane, enforced by the
    // adversarial authz test): the invite is the participant's own resource.
    // One live token per (inviter, challenge) — an inherent mint cap.
    method: 'post',
    path: `${KICKTODO_PREFIX}/invites`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.challengeId !== 'string') {
        throw new OpenwopError('validation_error', 'Field `challengeId` is required.', 400);
      }
      try {
        res.json({ token: await mintInvite(tenantOf(req), b.challengeId, subjectOf(req)) });
      } catch (err) {
        if (err instanceof InviteDeniedError) throw new OpenwopError('not_found', 'Not found.', 404);
        throw err;
      }
    },
  },
  {
    // ADR 0444 I1 — revoke the caller's live invite token (uniform no-op).
    method: 'post',
    path: `${KICKTODO_PREFIX}/invites/revoke`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.challengeId !== 'string') {
        throw new OpenwopError('validation_error', 'Field `challengeId` is required.', 400);
      }
      await revokeInvite(tenantOf(req), b.challengeId, subjectOf(req));
      res.json({ revoked: true });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments`,
    handler: async (req, res) => {
      await gate(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.challengeId !== 'string' || typeof body.challengeVersion !== 'number') {
        throw new OpenwopError('validation_error', 'Fields `challengeId` and `challengeVersion` are required.', 400);
      }
      try {
        const result = await enroll({
          tenantId: tenantOf(req),
          ownerSubject: subjectOf(req),
          challengeId: body.challengeId,
          challengeVersion: body.challengeVersion,
          ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
          // ADR 0443 R2 — enroll-time-only allowed weekdays (validated in the saga).
          ...(Array.isArray(body.daysOfWeek) ? { daysOfWeek: body.daysOfWeek as number[] } : {}),
          // ADR 0444 I1 — attribution only; invalid tokens are silently ignored.
          ...(typeof body.inviteToken === 'string' ? { inviteToken: body.inviteToken } : {}),
        });
        res.json(result.enrollment);
      } catch (err) {
        if (err instanceof ChallengeNotEnrollableError) {
          if (err.reason === 'not-found') throw new OpenwopError('not_found', err.message, 404);
          throw new OpenwopError('conflict', err.message, 409);
        }
        if (err instanceof InvalidDaysOfWeekError) throw new OpenwopError('validation_error', err.message, 400);
        // ADR 0420 P1 — an enroll-guard denial (entitlement/capacity) is a 402:
        // the actionable "payment required" refusal, not a generic conflict.
        if (err instanceof EnrollDeniedError) throw new OpenwopError('forbidden', err.message, 402);
        throw err;
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_PREFIX}/enrollments/:id`,
    handler: async (req, res) => {
      await gate(req);
      // ADR 0459 P1 — the SHARED enrollment-authority predicate (the replan tool
      // calls the same one, so route and tool cannot drift). Uniform 404: a foreign
      // participant's enrollment is indistinguishable from absent (PRD §10.1).
      if (!(await hasKicktodoEnrollmentAuthority(tenantOf(req), req.params.id, subjectOf(req)))) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json(await getEnrollment(tenantOf(req), req.params.id));
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/replan`,
    handler: async (req, res) => {
      await gate(req);
      if (!(await hasKicktodoEnrollmentAuthority(tenantOf(req), req.params.id, subjectOf(req)))) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      const next = await applyPlanRevision(tenantOf(req), req.params.id);
      res.json(next);
    },
  },
  {
    // ADR 0496 D2 — the closed-world revision-command APPLY over the ADR 0429
    // lanes (incl. the D1 move). Shares `applyRevisionCommands` with the chat
    // surface op — one implementation. Non-owner → 404 (the sibling
    // no-existence-leak posture; the service's own 403 stays for the op lane).
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/revision-commands`,
    handler: async (req, res) => {
      await gate(req);
      if (!(await hasKicktodoEnrollmentAuthority(tenantOf(req), req.params.id, subjectOf(req)))) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      const commands = (req.body ?? {}) as { commands?: unknown };
      res.json(await applyRevisionCommands(tenantOf(req), {
        enrollmentId: req.params.id,
        subject: subjectOf(req),
        commands: Array.isArray(commands.commands) ? commands.commands : [],
      }));
    },
  },
  {
    // ADR 0496 D2 — the PURE dry-run preview behind the §5.5 compare. Same
    // validator + move guards as apply (one shared path), zero writes.
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/revision-preview`,
    handler: async (req, res) => {
      await gate(req);
      if (!(await hasKicktodoEnrollmentAuthority(tenantOf(req), req.params.id, subjectOf(req)))) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      const commands = (req.body ?? {}) as { commands?: unknown };
      res.json(await previewRevisionCommands(tenantOf(req), {
        enrollmentId: req.params.id,
        subject: subjectOf(req),
        commands: Array.isArray(commands.commands) ? commands.commands : [],
      }));
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/abandon`,
    handler: async (req, res) => {
      await gate(req);
      const e = await abandonEnrollment(tenantOf(req), req.params.id, subjectOf(req));
      if (!e) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json(e);
    },
  },
  {
    // ADR 0443 R1 — the participant's opt-in reminder daypart. Owner-only;
    // `daypart: null` clears the preference and disables the reminder job.
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/schedule`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const daypart = b.daypart;
      if (daypart !== null && daypart !== 'morning' && daypart !== 'afternoon' && daypart !== 'evening') {
        throw new OpenwopError('validation_error', 'Field `daypart` must be morning|afternoon|evening|null.', 400);
      }
      const e = await setSchedulePreference(tenantOf(req), req.params.id, subjectOf(req), daypart);
      if (!e) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json(e);
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/materialize`,
    handler: async (req, res) => {
      // The scheduled/repair materialization entry (PRD §8.4 — the daily
      // trigger); owner-invoked here, the C4 built-in workflow drives it live.
      await gate(req);
      if (!(await hasKicktodoEnrollmentAuthority(tenantOf(req), req.params.id, subjectOf(req)))) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json({ occurrences: await materializeOccurrences(tenantOf(req), req.params.id) });
    },
  },
  {
    // ADR 0414 P3 — the rebuildable progress projection.
    method: 'get',
    path: `${KICKTODO_PREFIX}/enrollments/:id/progress`,
    handler: async (req, res) => {
      await gate(req);
      if (!(await hasKicktodoEnrollmentAuthority(tenantOf(req), req.params.id, subjectOf(req)))) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json(await progressFor(tenantOf(req), req.params.id));
    },
  },
  {
    // ADR 0414 P3 — freeze evidence, judge through the ADR 0412 goal owner,
    // project the verdict (completed/escalated) back onto the enrollment.
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/evaluate`,
    handler: async (req, res) => {
      await gate(req);
      try {
        const result = await evaluateEnrollment(tenantOf(req), req.params.id, subjectOf(req));
        if (!result) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
        res.json(result);
      } catch (err) {
        if (err instanceof EnrollmentNotEvaluableError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/snooze`,
    handler: async (req, res) => {
      await gate(req);
      const e = await setEnrollmentSnooze(tenantOf(req), req.params.id, subjectOf(req), true);
      if (!e) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json(e);
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/enrollments/:id/resume`,
    handler: async (req, res) => {
      await gate(req);
      const e = await setEnrollmentSnooze(tenantOf(req), req.params.id, subjectOf(req), false);
      if (!e) throw new OpenwopError('not_found', 'Enrollment not found.', 404);
      res.json(e);
    },
  },
  {
    // ADR 0414 P2 — the caller's KickBot instance (lazy idempotent provision).
    method: 'get',
    path: `${KICKTODO_PREFIX}/kickbot`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req); // consumer surface: identified callers only
      res.json(await ensureKickBot(tenantOf(req)));
    },
  },
  {
    // ADR 0430 P2 — Discover with CONTENT-locale negotiation. The requested
    // locale is an explicit query parameter, INDEPENDENT of the UI locale
    // (the PRD's separation rule); absent ⇒ the caller's UI locale, then `en`.
    method: 'get',
    path: `${KICKTODO_PREFIX}/catalog`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const q = req.query.contentLocale;
      const requested = typeof q === 'string' && q.trim() ? q.trim() : 'en';
      res.json({ requestedLocale: requested, challenges: await listPublishedForLocale(tenantOf(req), requested) });
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_PREFIX}/today`,
    handler: async (req, res) => {
      await gate(req);
      res.json(await todayFor(tenantOf(req), subjectOf(req)));
    },
  },
  {
    // ADR 0443 R3 — the cross-challenge Plan view: a derived, bounded read over
    // the ONE R2 mapping (window ≤ 31 days; self-data only).
    method: 'get',
    path: `${KICKTODO_PREFIX}/plan`,
    handler: async (req, res) => {
      await gate(req);
      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw new OpenwopError('validation_error', 'Query `from` and `to` must be YYYY-MM-DD.', 400);
      }
      res.json({ items: await planFor(tenantOf(req), subjectOf(req), from, to) });
    },
  },
  {
    // ADR 0443 R5 — the participant's own journal (their check-in notes +
    // measurements across enrollments, newest first). Self-data only.
    method: 'get',
    path: `${KICKTODO_PREFIX}/journal`,
    handler: async (req, res) => {
      await gate(req);
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200;
      res.json({ entries: await journalFor(tenantOf(req), subjectOf(req), Number.isFinite(limit) ? limit : 200) });
    },
  },
  {
    // ADR 0429 P1 — apply a PUBLISHER-DECLARED substitution to today's action.
    method: 'post',
    path: `${KICKTODO_PREFIX}/today/substitute`,
    handler: async (req, res) => {
      await gate(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.cardId !== 'string' || !body.cardId) {
        throw new OpenwopError('validation_error', 'Field `cardId` is required.', 400);
      }
      if (typeof body.alternativeId !== 'string' || !body.alternativeId) {
        throw new OpenwopError('validation_error', 'Field `alternativeId` is required.', 400);
      }
      try {
        res.json(await substituteOccurrence(tenantOf(req), subjectOf(req), body.cardId, body.alternativeId));
      } catch (err) {
        if (err instanceof SubstitutionDeniedError) {
          if (err.reason === 'superseded') throw new OpenwopError('conflict', err.message, 409);
          // Every other reason is a UNIFORM 404 — no existence leak, no probe
          // oracle for which alternatives a foreign challenge declares.
          throw new OpenwopError('not_found', err.message, 404);
        }
        throw err;
      }
    },
  },
  {
    // ADR 0429 P2 — the participant accepts recovery after an `ask` prompt.
    method: 'post',
    path: `${KICKTODO_PREFIX}/today/recover`,
    handler: async (req, res) => {
      await gate(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.enrollmentId !== 'string' || !body.enrollmentId) {
        throw new OpenwopError('validation_error', 'Field `enrollmentId` is required.', 400);
      }
      try {
        res.json({ occurrence: await acceptRecovery(tenantOf(req), subjectOf(req), body.enrollmentId) });
      } catch (err) {
        if (err instanceof CheckInDeniedError) throw new OpenwopError('not_found', err.message, 404);
        throw err;
      }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_PREFIX}/check-ins`,
    handler: async (req, res) => {
      await gate(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.cardId !== 'string' || body.cardId.length === 0) {
        throw new OpenwopError('validation_error', 'Field `cardId` is required.', 400);
      }
      try {
        const ci = await submitCheckIn(tenantOf(req), subjectOf(req), body.cardId, {
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
          ...(typeof body.measuredValue === 'number' ? { measuredValue: body.measuredValue } : {}),
        });
        res.json(ci);
      } catch (err) {
        // ADR 0434 (KTFULL-B6) — a missing-evidence refusal is a 422, not a
        // 404: the action exists and is yours, the submission is incomplete.
        if (err instanceof EvidenceRequiredError) throw new OpenwopError('validation_error', err.message, 422);
        if (err instanceof CheckInDeniedError) {
          if (err.reason === 'superseded') throw new OpenwopError('conflict', err.message, 409);
          throw new OpenwopError('not_found', err.message, 404);
        }
        throw err;
      }
    },
  },
];

export function registerKicktodoCoreRoutes(deps: RouteDeps): void {
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }

  // ADR 0690 / PRD §8.2 — the KickTodo READINESS report: a host-private operator
  // route (never an OpenWOP capability) that says whether THIS deployment can
  // run the participant loop and the Factory — feature toggles where the default
  // workspace lives, pinned packs present, the default workspace provisioned AND
  // enterable, the managed provider funded, web search configured, durable blob,
  // the schedule daemon ticking. Superadmin-gated and NOT toggle-gated: a report
  // that 404s when the feature is off cannot report that the feature is off.
  // Same envelope on 200 and 503 (the /readiness precedent) so a smoke script
  // reads `blockers` off both.
  app.get(`${KICKTODO_PREFIX}/readiness`, async (req, res, next) => {
    try {
      requireSuperadmin(req, 'The KickTodo readiness report');
      const report = await buildKicktodoReadiness({ tenantId: tenantOf(req), storage: deps.storage });
      res.status(report.status === 'ready' ? 200 : 503).json(report);
    } catch (err) {
      next(err);
    }
  });

  // ADR 0641 phase 3 — the anonymous challenge catalog, registered onto the
  // EXISTING ADR 0012 public family rather than a new namespace. The prefix
  // already carries the anonymous carve-out (`auth.ts` PUBLIC_PATH_PREFIXES),
  // the CORS embed allowance (`cors.ts` PUBLIC_EMBED_PREFIX), the CSRF
  // carve-out, and custom-domain org mapping. Registering elsewhere would mean
  // teaching four middlewares about a second public surface.
  //
  // No auth middleware and no org-scope guard by design: there is no credential.
  // The org is a path segment, its tenant is resolved server-side, and the read
  // is published-only + toggle-gated on that resolved tenant.
  app.get(`${PUBLIC_EMBED_PREFIX}:orgId/challenges`, async (req, res, next) => {
    try {
      const catalog = await publicChallengeCatalog(req.params.orgId, req.headers['accept-language']);
      // Cacheable: the document carries no member state (ADR 0641 decision 9 —
      // cache the shell, never the authenticated data). Enrollment state is a
      // separate client-side fetch, so this response is identical for every
      // visitor of the org and safe for a shared cache.
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      res.setHeader('Vary', 'Accept-Language');
      res.json(catalog);
    } catch (err) { next(err); }
  });
}
