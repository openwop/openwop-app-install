/**
 * Approval inbox — host-extension routes (non-normative).
 *
 * The human side of the "agents propose, humans dispose" gate. A review-mode
 * roster member's heartbeat queues a PendingApproval (host/approvalService.ts)
 * instead of starting the run; these routes let a human resolve it:
 *
 *   GET  /v1/host/openwop-app/approvals[?status=pending]   — the queue
 *   POST /v1/host/openwop-app/approvals/{id}/claim          — affirmative sign-off:
 *                                                        starts the proposed run
 *   POST /v1/host/openwop-app/approvals/{id}/reject         — dismiss the proposal
 *
 * A CLAIM is the affirmative act — it starts the proposed run (via the shared
 * runStarter, so replay/fork/observability are inherited) and moves the card to
 * Working. A REJECT dismisses the proposal and parks the card in the board's
 * terminal column so the heartbeat won't re-propose it.
 *
 * @see src/host/approvalService.ts — the durable queue
 * @see src/routes/agentOps.ts — where review-mode proposals are created
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { Storage } from '../storage/storage.js';
import { resolveEffectiveAccess } from '../host/accessControlService.js';
import { isSuperadmin } from '../host/superadmin.js';
import { isOwnPersonalWorkspace } from '../host/requestSubject.js';
import { claimApproval, rejectApproval } from '../host/approvalDecision.js';
import { getApprovalSlaPolicy, setApprovalSlaPolicy, startApprovalSlaSweep } from '../host/approvalSla.js';
import { getEmailApprovalPref, setEmailApprovalPref } from '../host/emailApprovalDelivery.js';
import {
  listApprovals,
  getAssistantActionProjector,
  type ApprovalStatus,
} from '../host/approvalService.js';

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

import { mayViewApproval } from '../host/approvalAudience.js';

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

function noteOf(req: Request): string | undefined {
  const note = (req.body as { note?: unknown } | undefined)?.note;
  return typeof note === 'string' && note.trim().length > 0 ? note.trim() : undefined;
}

/** ADR 0198 — a delegate covering several principals says whose approval this is. */
function actedForOf(req: Request): string | undefined {
  const v = (req.body as { actedFor?: unknown } | undefined)?.actedFor;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** ADR 0473 — the definition hash the reviewer's card displayed when they
 *  approved a composed-workflow proposal (approve-what-you-see; ignored by
 *  every other kind). */
function expectedHashOf(req: Request): string | undefined {
  const v = (req.body as { expectedDefinitionHash?: unknown } | undefined)?.expectedDefinitionHash;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function registerApprovalRoutes(app: Express, deps: Deps): void {
  // ADR 0478 §1 — the approval SLA policy (tenant-level) + the sweep boot
  // (idempotent). The PUT below is ADMIN-gated (host:members:manage or
  // superadmin — the P5 review fold-in: rung 3 is a mass-reject primitive);
  // the GET stays member-readable.
  startApprovalSlaSweep();
  app.get('/v1/host/openwop-app/approvals/sla-policy', async (req, res, next) => {
    try {
      const p = await getApprovalSlaPolicy(tenantOf(req));
      res.json(p ?? { tenantId: tenantOf(req), enabled: false });
    } catch (err) { next(err); }
  });
  // ADR 0478 §2 — the recipient's email-delivery opt-in (their own pref only).
  app.get('/v1/host/openwop-app/approvals/email-pref', async (req, res, next) => {
    try {
      const userId = req.userId ?? req.principal?.principalId;
      if (!userId) throw new OpenwopError('unauthenticated', 'Sign in to read your email preference.', 401, {});
      const p = await getEmailApprovalPref(tenantOf(req), userId);
      res.json(p ? { email: p.email, enabled: p.enabled } : { enabled: false });
    } catch (err) { next(err); }
  });
  app.put('/v1/host/openwop-app/approvals/email-pref', async (req, res, next) => {
    try {
      const userId = req.userId ?? req.principal?.principalId;
      if (!userId) throw new OpenwopError('unauthenticated', 'Sign in to change your email preference.', 401, {});
      const b = (req.body ?? {}) as Record<string, unknown>;
      const row = await setEmailApprovalPref({
        tenantId: tenantOf(req), userId,
        email: typeof b.email === 'string' ? b.email : '',
        enabled: b.enabled === true,
      });
      res.json({ email: row.email, enabled: row.enabled });
    } catch (err) { next(err); }
  });

  app.put('/v1/host/openwop-app/approvals/sla-policy', async (req, res, next) => {
    try {
      const decider = req.userId ?? req.principal?.principalId;
      if (!decider) throw new OpenwopError('unauthenticated', 'Sign in to change the SLA policy.', 401, {});
      // ADR 0478 (review HIGH-2) — the expire rung is a tenant-wide
      // auto-reject: a non-approver setting expire=60s would mass-reject
      // approvals they could never reject directly (privilege escalation).
      // The policy write therefore requires the members-manage admin scope
      // (or superadmin) — NOT mere membership.
      if (!isSuperadmin(req)) {
        const access = await resolveEffectiveAccess(tenantOf(req), { subject: decider });
        if (!access.scopes.includes('host:members:manage')) {
          throw new OpenwopError('forbidden', 'Changing the approval SLA policy requires an admin (members-manage) role.', 403, {});
        }
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const row = await setApprovalSlaPolicy({
        tenantId: tenantOf(req),
        enabled: b.enabled === true,
        remindAfterMs: b.remindAfterMs,
        escalateAfterMs: b.escalateAfterMs,
        expireAfterMs: b.expireAfterMs,
        updatedBy: decider,
      });
      res.json(row);
    } catch (err) { next(err); }
  });

  // The queue. `?status=pending|approved|rejected` filters; default = all.
  // ADR 0313 P2 froze the picked card's title+DESCRIPTION onto `configurable`
  // for the approved dispatch. That blob is needed only server-side at claim
  // (claimApproval reads it from storage) — and card description was NOT
  // previously exposed on an approval. Strip it from every client read
  // projection so a tenant member who can list approvals but not view a private
  // agent board can't read the card's full text out of it (data minimization).
  // ADR 0473 (review F8) — `composedWorkflow.runInputs` gets the same
  // treatment as `configurable`: needed server-side at claim, not on the list
  // read (the decide surface is the reviews projection, which authz-scopes it).
  const stripInternal = <T extends { configurable?: unknown; composedWorkflow?: { runInputs?: Record<string, unknown> } }>(
    a: T,
  ): Omit<T, 'configurable'> => {
    const { configurable: _drop, ...rest } = a;
    if (rest.composedWorkflow?.runInputs) {
      const { runInputs: _r, ...cw } = rest.composedWorkflow;
      return { ...rest, composedWorkflow: cw };
    }
    return rest;
  };

  app.get('/v1/host/openwop-app/approvals', async (req, res, next) => {
    try {
      const raw = String(req.query.status ?? '');
      const status: ApprovalStatus | undefined =
        raw === 'pending' || raw === 'approved' || raw === 'rejected' ? raw : undefined;
      // SGU-1 (review finding 1) — optional `kind` + `limit` narrowing so a caller
      // that needs only one kind's recent rows (e.g. the strategy-activation
      // decided-history provenance group) does NOT pull the tenant's entire
      // all-kinds approval history to the browser to render a handful. Both are
      // pure server-side reductions of an already tenant+access-scoped read (this
      // is a non-normative /v1/host/openwop-app/* route — no wire RFC).
      const kindFilter = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : undefined;
      const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : undefined;
      const fetchedAll = await listApprovals(tenantOf(req), status);
      const all = kindFilter ? fetchedAll.filter((a) => a.kind === kindFilter) : fetchedAll;
      // ADR 0066 (review MEDIUM-2) — the queue is tenant-scoped, but a row may carry an
      // `orgId` whose DECIDE is gated on a scope IN THAT ORG. Filter those rows out of the
      // LIST too, so a member who cannot decide never even sees the row's existence.
      //
      // CORRECTED (ADR 0672 D1) — this used to end "(other kinds stay tenant-scoped as
      // before)", which was true of the code and WRONG as a rule: six kinds that
      // `/reviews` scopes were reaching every tenant member here. Which kinds are
      // tenant-scoped is now a stated table, not a leftover.
      const decider = req.userId ?? req.principal?.principalId;
      const items = (
        await Promise.all(
          all.map(async (a) => {
            // ADR 0672 D1 (`CMSAWF-18`) — this used to implement FOUR of the nine
            // per-kind audiences by hand and `return a` for the rest, so this route handed
            // any tenant principal the rows `/reviews` hides: a widget visitor's captured
            // PII (`anon-surface-write`), a coach's free-text note ABOUT a participant
            // (`kicktodo-plan-proposal`), the three field-sales kinds, and superadmin-only
            // `commerce-listing-publish`. The divergence survived because
            // `approvalVisible`'s docstring claimed this route was "the SAME check, reused".
            // One owner now; adopting it closed six previously-unfiltered kinds.
            return (await mayViewApproval(tenantOf(req), decider, a)) ? a : null;
          }),
        )
      ).filter((a): a is NonNullable<typeof a> => a !== null);
      // SGU-1 — when a `limit` is requested, return the most-recent rows
      // (resolvedAt for decided rows, else createdAt) and cap, so a bounded
      // decided-history read stays bounded end to end (payload + the enrich
      // fan-out below). No limit ⇒ unchanged full list.
      const bounded = limit
        ? [...items]
            .sort((x, y) => (y.resolvedAt ?? y.createdAt).localeCompare(x.resolvedAt ?? x.createdAt))
            .slice(0, limit)
        : items;
      // Enrich assistant-action rows with their typed PendingAction (risk tier,
      // reason, citations, recipient diff, taint, draft) so the inbox renders
      // the rich ActionCard. The projector is registered by the assistant
      // feature; core stays feature-agnostic (the handler-hook discipline).
      const projector = getAssistantActionProjector();
      const enriched = projector
        ? await Promise.all(
            bounded.map(async (a) =>
              a.actionId ? { ...a, action: await projector(tenantOf(req), a.actionId) } : a,
            ),
          )
        : bounded;
      res.status(200).json({ items: enriched.map(stripInternal) });
    } catch (err) {
      next(err);
    }
  });

  // Claim — the affirmative sign-off. The decision logic (CMS / assistant-action
  // handlers, run-proposal start + kanban, CAS, audit) lives in the shared
  // approvalDecision module so the unified /reviews surface (ADR 0068) drives the
  // SAME path — this route is a thin caller.
  app.post('/v1/host/openwop-app/approvals/:approvalId/claim', async (req, res, next) => {
    try {
      const result = await claimApproval(
        deps,
        { tenantId: tenantOf(req), decidedBy: req.userId ?? req.principal?.principalId, ...(noteOf(req) !== undefined ? { note: noteOf(req) } : {}), ...(actedForOf(req) !== undefined ? { actedFor: actedForOf(req) } : {}), ...(expectedHashOf(req) !== undefined ? { expectedDefinitionHash: expectedHashOf(req) } : {}), ...(isSuperadmin(req) ? { decidedBySuperadmin: true } : {}), ...(req.principal?.tenants?.includes('*') ? { decidedByWildcardOperator: true } : {}), ...(isOwnPersonalWorkspace(req) ? { decidedByPersonalOwner: true } : {}) },
        req.params.approvalId,
      );
      res.status(200).json({
        approvalId: result.approvalId,
        status: result.status,
        ...(result.runId ? { runId: result.runId } : {}),
        ...(result.pageId ? { pageId: result.pageId } : {}),
        ...(result.actionId ? { actionId: result.actionId } : {}),
        // ADR 0458 §2.2 (correction) — challenge-publish decisions echo what was published.
        ...(result.candidateId ? { candidateId: result.candidateId } : {}),
        ...(result.challengeId ? { challengeId: result.challengeId } : {}),
        ...(result.challengeVersion !== undefined ? { challengeVersion: result.challengeVersion } : {}),
        ...(result.policy ? { policy: result.policy } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // Reject — dismiss the proposal (shared decision path; see claim above).
  app.post('/v1/host/openwop-app/approvals/:approvalId/reject', async (req, res, next) => {
    try {
      const result = await rejectApproval(
        deps,
        { tenantId: tenantOf(req), decidedBy: req.userId ?? req.principal?.principalId, ...(noteOf(req) !== undefined ? { note: noteOf(req) } : {}), ...(actedForOf(req) !== undefined ? { actedFor: actedForOf(req) } : {}), ...(expectedHashOf(req) !== undefined ? { expectedDefinitionHash: expectedHashOf(req) } : {}), ...(isSuperadmin(req) ? { decidedBySuperadmin: true } : {}), ...(req.principal?.tenants?.includes('*') ? { decidedByWildcardOperator: true } : {}), ...(isOwnPersonalWorkspace(req) ? { decidedByPersonalOwner: true } : {}) },
        req.params.approvalId,
      );
      res.status(200).json({
        approvalId: result.approvalId,
        status: result.status,
        ...(result.pageId ? { pageId: result.pageId } : {}),
        ...(result.actionId ? { actionId: result.actionId } : {}),
        // ADR 0458 §2.2 (correction) — challenge-publish decisions echo what was published.
        ...(result.candidateId ? { candidateId: result.candidateId } : {}),
        ...(result.challengeId ? { challengeId: result.challengeId } : {}),
        ...(result.challengeVersion !== undefined ? { challengeVersion: result.challengeVersion } : {}),
        ...(result.approval ? { approval: stripInternal(result.approval) } : {}),
        ...(result.policy ? { policy: result.policy } : {}),
      });
    } catch (err) {
      next(err);
    }
  });
}
