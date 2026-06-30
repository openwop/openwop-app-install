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
import type { HostAdapterSuite } from '../host/index.js';
import type { Storage } from '../storage/storage.js';
import { resolveEffectiveAccess } from '../host/accessControlService.js';
import { claimApproval, rejectApproval } from '../host/approvalDecision.js';
import {
  listApprovals,
  getAssistantActionProjector,
  type ApprovalStatus,
} from '../host/approvalService.js';

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

function noteOf(req: Request): string | undefined {
  const note = (req.body as { note?: unknown } | undefined)?.note;
  return typeof note === 'string' && note.trim().length > 0 ? note.trim() : undefined;
}

export function registerApprovalRoutes(app: Express, deps: Deps): void {
  // The queue. `?status=pending|approved|rejected` filters; default = all.
  app.get('/v1/host/openwop-app/approvals', async (req, res, next) => {
    try {
      const raw = String(req.query.status ?? '');
      const status: ApprovalStatus | undefined =
        raw === 'pending' || raw === 'approved' || raw === 'rejected' ? raw : undefined;
      const all = await listApprovals(tenantOf(req), status);
      // ADR 0066 (review MEDIUM-2) — the queue is tenant-scoped, but a
      // content-publish row carries an `orgId` and the DECIDE is gated on
      // `host:members:manage` in that org. Org-filter those rows out of the LIST
      // too, so a tenant member who can't manage the org never even sees the
      // page title / existence (other kinds stay tenant-scoped as before).
      const decider = req.userId ?? req.principal?.principalId;
      const items = (
        await Promise.all(
          all.map(async (a) => {
            if (a.kind !== 'content-publish') return a;
            if (!decider || !a.orgId) return null;
            const access = await resolveEffectiveAccess(tenantOf(req), { subject: decider, orgId: a.orgId });
            return access.scopes.includes('host:members:manage') ? a : null;
          }),
        )
      ).filter((a): a is NonNullable<typeof a> => a !== null);
      // Enrich assistant-action rows with their typed PendingAction (risk tier,
      // reason, citations, recipient diff, taint, draft) so the inbox renders
      // the rich ActionCard. The projector is registered by the assistant
      // feature; core stays feature-agnostic (the handler-hook discipline).
      const projector = getAssistantActionProjector();
      const enriched = projector
        ? await Promise.all(
            items.map(async (a) =>
              a.actionId ? { ...a, action: await projector(tenantOf(req), a.actionId) } : a,
            ),
          )
        : items;
      res.status(200).json({ items: enriched });
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
        { tenantId: tenantOf(req), decidedBy: req.userId ?? req.principal?.principalId, ...(noteOf(req) !== undefined ? { note: noteOf(req) } : {}) },
        req.params.approvalId,
      );
      res.status(200).json({
        approvalId: result.approvalId,
        status: result.status,
        ...(result.runId ? { runId: result.runId } : {}),
        ...(result.pageId ? { pageId: result.pageId } : {}),
        ...(result.actionId ? { actionId: result.actionId } : {}),
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
        { tenantId: tenantOf(req), decidedBy: req.userId ?? req.principal?.principalId, ...(noteOf(req) !== undefined ? { note: noteOf(req) } : {}) },
        req.params.approvalId,
      );
      res.status(200).json({
        approvalId: result.approvalId,
        status: result.status,
        ...(result.pageId ? { pageId: result.pageId } : {}),
        ...(result.actionId ? { actionId: result.actionId } : {}),
        ...(result.approval ? { approval: result.approval } : {}),
        ...(result.policy ? { policy: result.policy } : {}),
      });
    } catch (err) {
      next(err);
    }
  });
}
