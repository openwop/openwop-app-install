/**
 * Unified review inbox — host-extension routes (non-normative, ADR 0068).
 *
 *   GET  /v1/host/openwop-app/reviews[?status=pending]      — the inbox
 *   GET  /v1/host/openwop-app/reviews/:reviewId             — one review
 *   POST /v1/host/openwop-app/reviews/:reviewId/actions/:action — decide
 *
 * A READ-FIRST projection over the two human-review owners (runtime interrupts +
 * pending approvals). It never owns state: the action route dispatches to the
 * SAME resolve paths the source-specific routes use — `resolveAndResume` /
 * `handleConversationResolve` for interrupts, `claimApproval` / `rejectApproval`
 * for approvals (extracted into `host/approvalDecision.ts` so there is one
 * decision owner). Visibility is source-derived: a non-visible review returns
 * 404 (never 403) so existence never leaks.
 *
 * @see host/reviewProjection.ts — the mappers + list/get
 * @see docs/adr/0068-unified-review-projection.md
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { Storage } from '../storage/storage.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import { isSuperadmin } from '../host/superadmin.js';
import { isOwnPersonalWorkspace } from '../host/requestSubject.js';
import { listReviews, getReview, type ReviewStatus, type ReviewAuthCtx } from '../host/reviewProjection.js';
import { claimApproval, rejectApproval } from '../host/approvalDecision.js';
import { requireInterruptDecider, resolveAndResume, reviewerOf, validateResumeValue } from './interrupts.js';
import { callerHoldsTenantScope } from '../features/featureRoute.js';

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

function authCtx(req: Request): ReviewAuthCtx {
  const tenantId = (req as { tenantId?: string }).tenantId ?? 'default';
  const subjectRef = req.userId ?? req.principal?.principalId;
  return {
    tenantId,
    ...(subjectRef ? { subjectRef } : {}),
    // READ gate (ADR 0862); the decide route's spelling is source-counted by assistant-decide-authority.test.ts.
    viewerExits: { isOperator: (req.principal?.tenants ?? []).includes('*'), isPersonalOwner: isOwnPersonalWorkspace(req) },
  };
}

/** ADR 0778 D8 — the caller's decide authority, resolved ONCE per request, so
 *  each review can say whether THIS caller may decide it (`canDecide`). */
async function withDecider(req: Request, ctx: ReviewAuthCtx): Promise<ReviewAuthCtx> {
  const reviewer = await reviewerOf(req);
  const holdsRespond = await callerHoldsTenantScope(req, ctx.tenantId, 'approvals:respond');
  return { ...ctx, decider: { holdsRespond, ...('subjectRef' in reviewer ? { reviewerRef: reviewer.subjectRef } : {}) } };
}

function noteOf(req: Request): string | undefined {
  const note = (req.body as { note?: unknown } | undefined)?.note;
  return typeof note === 'string' && note.trim().length > 0 ? note.trim() : undefined;
}

const REVIEW_STATUSES: readonly ReviewStatus[] = ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'resolved'];

export function registerReviewRoutes(app: Express, deps: Deps): void {
  const { storage, hostSuite } = deps;

  // The inbox. `?status=` filters; omitted ⇒ the pending inbox.
  app.get('/host/openwop-app/reviews', async (req, res, next) => {
    try {
      // An interrupt review exposes run state, so gate on runs:read (no-op unless
      // the host enforces RFC 0049 scopes); tenant isolation is in the projection.
      await requireProtocolScope(req, 'runs:read');
      const raw = String(req.query.status ?? '');
      // ADR 0778 D8 — omitted means PENDING, as this route's own comment and
      // every client docstring said. It used to fall through to the projection's
      // "no filter", which returns the tenant's whole approval history, unbounded.
      const status: ReviewStatus = (REVIEW_STATUSES as readonly string[]).includes(raw) ? (raw as ReviewStatus) : 'pending';
      const conversationId = typeof req.query.conversationId === 'string' && req.query.conversationId ? req.query.conversationId : undefined;
      const boardId = typeof req.query.boardId === 'string' && req.query.boardId ? req.query.boardId : undefined;
      const items = await listReviews(storage, await withDecider(req, authCtx(req)), { status, ...(conversationId ? { conversationId } : {}), ...(boardId ? { boardId } : {}) });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  app.get('/host/openwop-app/reviews/:reviewId', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:read');
      const review = await getReview(storage, await withDecider(req, authCtx(req)), req.params.reviewId);
      if (!review) throw new OpenwopError('not_found', 'Review not found.', 404, { reviewId: req.params.reviewId });
      res.status(200).json(review);
    } catch (err) {
      next(err);
    }
  });

  // Decide. The review must be visible (else 404, no existence leak) AND offer the
  // requested action (derived from the source record); then dispatch to the owner.
  app.post('/host/openwop-app/reviews/:reviewId/actions/:action', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:read');
      const ctx = authCtx(req);
      const review = await getReview(storage, ctx, req.params.reviewId);
      if (!review) throw new OpenwopError('not_found', 'Review not found.', 404, { reviewId: req.params.reviewId });

      const action = req.params.action;
      const offered = review.actions.find((a) => a.action === action);
      if (!offered) {
        throw new OpenwopError('validation_error', `Action '${action}' is not available for this review.`, 422, {
          available: review.actions.map((a) => a.action),
        });
      }

      if (review.source === 'approval') {
        // ADR 0795 — deciding is a MUTATION on this arm too. It checked only the
        // `runs:read` above, so a read-only key approved any approval that has
        // no eligibility check of its own (MEASURED in review: a viewer-issued
        // `runs:read` key approved a `campaign-spend`). Same scope the interrupt
        // arm below and the node route require.
        await requireProtocolScope(req, 'approvals:respond');
        // The mapper always sets approvalId for an approval-source review; guard
        // explicitly rather than assert, so a future mapper change fails loud.
        if (!review.approvalId) throw new OpenwopError('internal_error', 'review missing approvalId', 500, {});
        // ADR 0473 — `expectedDefinitionHash` is the approve-what-you-see pin a
        // composed-workflow card sends; other kinds ignore it.
        const bodyHash = (req.body as { expectedDefinitionHash?: unknown } | undefined)?.expectedDefinitionHash;
        // ADR 0862 D1 — the assistant-action sibling (a different hash over a different object).
        const contentHash = (req.body as { expectedContentHash?: unknown } | undefined)?.expectedContentHash;
        const decideCtx = { tenantId: ctx.tenantId, ...(ctx.subjectRef ? { decidedBy: ctx.subjectRef } : {}), ...(noteOf(req) !== undefined ? { note: noteOf(req) } : {}), ...(typeof bodyHash === 'string' && bodyHash.trim().length > 0 ? { expectedDefinitionHash: bodyHash.trim() } : {}), ...(typeof contentHash === 'string' && contentHash.trim().length > 0 ? { expectedContentHash: contentHash.trim() } : {}), ...(isSuperadmin(req) ? { decidedBySuperadmin: true } : {}), ...(req.principal?.tenants?.includes('*') ? { decidedByWildcardOperator: true } : {}), ...(isOwnPersonalWorkspace(req) ? { decidedByPersonalOwner: true } : {}) };
        const result = action === 'approve'
          ? await claimApproval(deps, decideCtx, review.approvalId)
          : await rejectApproval(deps, decideCtx, review.approvalId);
        res.status(200).json({ reviewId: review.reviewId, status: result.status, ...(result.runId ? { runId: result.runId } : {}), ...(result.policy ? { policy: result.policy } : {}) });
        return;
      }

      // interrupt source — resolve through the SAME validated path the interrupt
      // routes use (conversation gates are excluded from the projection, so they
      // never reach here). The resume value is either the typed `value` body
      // (action 'resolve') or `{ action }` for an allowlisted approval-gate verb.
      if (!review.interruptId) throw new OpenwopError('internal_error', 'review missing interruptId', 500, {});
      // ADR 0778 D2 — deciding a gate is a MUTATION: the scope the node route
      // requires (`approvals:respond`, ADR 0745), not the `runs:read` this route
      // checked, which let a read-only key answer any open gate. Then the
      // always-on floor for an open approval gate (key-narrowing + membership,
      // under both identity spellings).
      await requireProtocolScope(req, 'approvals:respond');
      const interrupt = await storage.getInterrupt(review.interruptId);
      if (!interrupt) throw new OpenwopError('interrupt_not_found', 'Interrupt missing on resume.', 404, {});
      if (interrupt.resolvedAt) throw new OpenwopError('interrupt_already_resolved', 'Review already resolved.', 409, {});
      await requireInterruptDecider(req, storage, interrupt);
      const bodyValue = (req.body as { value?: unknown } | undefined)?.value;
      const resumeValue = action === 'resolve'
        ? bodyValue
        : { action, ...(bodyValue && typeof bodyValue === 'object' ? (bodyValue as Record<string, unknown>) : {}) };
      validateResumeValue(interrupt, resumeValue);
      // ADR 0778 D6 — the SAME reviewer derivation as the node route. This lane
      // used `req.userId ?? principalId`, so an OIDC bearer voted as `oidc:<sub>`
      // here and as its user there (two ledger keys, one person), and an anon
      // cookie voted as `session:<sid>` on an open quorum gate.
      await resolveAndResume(storage, hostSuite, interrupt.interruptId, resumeValue, await reviewerOf(req));
      res.status(200).json({ reviewId: review.reviewId, status: 'resolved' });
    } catch (err) {
      next(err);
    }
  });
}
