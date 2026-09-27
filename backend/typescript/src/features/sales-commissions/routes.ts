/**
 * Sales Commissions — REST routes (ADR 0280 Phase 1: plan CRUD).
 *
 * Host-extension surface under `/v1/host/openwop-app/commissions/orgs/:orgId/*`
 * (non-normative — no OpenWOP RFC; rides Accepted RFC 0049 scopes). Every route
 * is gated by the shared `authorizeOrgScope` (toggle `sales-commissions` ON + the
 * caller's scope in the PATH org, IDOR-guarded, fail-closed). Reads need
 * `workspace:read`; plan admin needs `host:commissions:manage` (built-in
 * admin/owner only — plans set what reps get paid).
 *
 * @see docs/adr/0280-sales-commissions.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { createCommissionStatementApproval, findPendingCommissionStatementApproval, closePendingCommissionStatementApprovals, resolveApproval } from '../../host/approvalService.js';

/**
 * R2 review — COM2-B4's own remedy was inert. Both submit paths reused whatever pending
 * card `findPendingCommissionStatementApproval` returned and NEVER re-pinned it, so once
 * a statement was recomputed the card's frozen total was permanently stale: approve 409s
 * ("re-submit it"), re-submitting hands back the SAME card, and approve 409s again. The
 * only escape was reject — structurally the dead end COM2-M5 exists to close, one guard
 * over. A stale card is closed and a fresh one minted; a card that still matches is
 * reused unchanged (so an idempotent re-submit stays idempotent).
 */
async function repinOrKeep(tenantId: string, statementId: string, total: number, currency: string): Promise<Awaited<ReturnType<typeof findPendingCommissionStatementApproval>>> {
  const existing = await findPendingCommissionStatementApproval(tenantId, statementId);
  if (!existing) return null;
  const pin = existing.commissionStatement;
  if (pin && pin.total === total && pin.currency === currency) return existing;
  await resolveApproval(existing.approvalId, { status: 'rejected', note: 'Superseded: the statement was recomputed before it was approved.' });
  return null;
}
import { createPlan, listPlans, getPlan, updatePlan, deletePlan } from './entities/plan.js';
import { computeStatement, listStatements, getStatementRaw, recordStatementSubmitter, markStatementPaid, planNonDraftStatementCount, deleteDraftStatementsForPlan } from './entities/statement.js';
import { commissionMutated } from './emit.js';
import { commissionProposalText } from './proposalText.js';

const TOGGLE_ID = 'sales-commissions';
const LABEL = 'Commissions';

const authorize = (req: Request, scope: Scope) => authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, scope);

/** Does the caller hold the management scope (⇒ sees every rep's statement)? */
async function callerCanSeeAll(tenantId: string, orgId: string, subject: string): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes('host:commissions:manage');
}
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function registerCommissionRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/commissions/orgs/:orgId';

  // ── Plans ──
  app.get(`${BASE}/plans`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ plans: await listPlans(tenantId, orgId) });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/plans/:planId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json(await getPlan(tenantId, orgId, req.params.planId));
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/plans`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'host:commissions:manage');
      const plan = await createPlan(tenantId, orgId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      commissionMutated({ entity: 'plan', verb: 'created', tenantId, orgId, actor: user.userId, entityId: plan.planId });
      res.status(201).json(plan);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/plans/:planId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'host:commissions:manage');
      const plan = await updatePlan(tenantId, orgId, req.params.planId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      commissionMutated({ entity: 'plan', verb: 'updated', tenantId, orgId, actor: user.userId, entityId: plan.planId });
      res.json(plan);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/plans/:planId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'host:commissions:manage');
      // COMM-DATA-1: refuse to delete a plan that has APPROVED/PAID statements —
      // those are financial records that must stay auditable back to their plan.
      // DRAFT statements (recomputable) cascade away.
      const nonDraft = await planNonDraftStatementCount(tenantId, orgId, req.params.planId);
      if (nonDraft > 0) throw new OpenwopError('conflict', `This plan has ${nonDraft} approved/paid statement(s) and cannot be deleted (they are payout records). Archive it instead.`, 409, { statements: nonDraft });
      // R2 COM2-M5 — close the review cards for the drafts about to vanish. Leaving them
      // pending made them UNCLEARABLE: the CAS flips the card, `approveStatement` 404s on
      // the deleted row, the catch reopens it, and every retry repeats — approve is
      // impossible and only reject escapes, by rejecting a statement that no longer
      // exists. Before the delete, because the id is what finds them.
      await closePendingCommissionStatementApprovals(tenantId, orgId, req.params.planId, 'The plan and its draft statements were deleted.');
      await deleteDraftStatementsForPlan(tenantId, orgId, req.params.planId);
      await deletePlan(tenantId, orgId, req.params.planId);
      commissionMutated({ entity: 'plan', verb: 'deleted', tenantId, orgId, actor: user.userId, entityId: req.params.planId });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // ── Statements (P2) ──
  // Compute (upsert) a statement for one rep+period against a plan. Payout-affecting
  // → host:commissions:manage. Deterministic; recompute returns a fresh draft.
  app.post(`${BASE}/plans/:planId/statements/compute`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'host:commissions:manage');
      const body = (req.body ?? {}) as { subjectId?: unknown; period?: unknown };
      const subjectId = optStr(body.subjectId);
      const period = optStr(body.period);
      if (!subjectId || !period) throw new OpenwopError('validation_error', '`subjectId` and `period` are required.', 400, {});
      const statement = await computeStatement(tenantId, orgId, req.params.planId, subjectId, period);
      commissionMutated({ entity: 'statement', verb: 'computed', tenantId, orgId, actor: user.userId, entityId: statement.statementId });
      res.status(201).json(statement);
    } catch (err) {
      next(err);
    }
  });

  // List statements — subject-scoped: a rep sees only their own unless they hold
  // host:commissions:manage (mirrors ADR 0272 record visibility).
  app.get(`${BASE}/statements`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:read');
      const canSeeAll = await callerCanSeeAll(tenantId, orgId, user.userId);
      const rows = await listStatements(
        tenantId,
        orgId,
        { subjectId: optStr(req.query.subjectId), period: optStr(req.query.period), planId: optStr(req.query.planId) },
        canSeeAll,
        user.userId,
      );
      res.json({ statements: rows });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/statements/:statementId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:read');
      const statement = await getStatementRaw(tenantId, orgId, req.params.statementId);
      const canSeeAll = await callerCanSeeAll(tenantId, orgId, user.userId);
      // Fail-closed + no existence leak: a non-manager may see only their own.
      if (!statement || (!canSeeAll && statement.subjectId !== user.userId)) throw new OpenwopError('not_found', 'Statement not found.', 404, { statementId: req.params.statementId });
      res.json(statement);
    } catch (err) {
      next(err);
    }
  });

  // ── Approval + payout status (P3) — the payout-affecting transitions ──
  // CFP-1 (D9) — approving a statement COMMITS what a rep is owed (payout-affecting),
  // so it no longer flips on a naked button click. This route now SUBMITS the draft
  // for review: it queues a `commission-statement` approval on the shared reviews
  // inbox (idempotent per statement) and returns `202 { review }`; the statement
  // transitions draft→approved ONLY when a manager claims the review, whose decision
  // core dispatches to this feature's gate handler (`statementApproval.ts`). No path
  // approves a statement without the gate. The host moves NO money (ADR 0280 §8).
  app.post(`${BASE}/statements/:statementId/approve`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'host:commissions:manage');
      const statementId = req.params.statementId;
      const statement = await getStatementRaw(tenantId, orgId, statementId);
      if (!statement) throw new OpenwopError('not_found', 'Statement not found.', 404, { statementId });
      if (statement.status !== 'draft') throw new OpenwopError('conflict', `Only a draft statement can be submitted for approval (this one is ${statement.status}).`, 409, { statementId, status: statement.status });
      // R2 COM2-M4 — record WHO submitted, so the decide seam can refuse a self-approval.
      // Without it, one person could compute their own statement, submit it, approve it
      // and mark it paid: three clicks, a terminal payout record, and a code comment
      // telling the next reader that a second manager was involved.
      await recordStatementSubmitter(tenantId, orgId, statementId, user.userId);
      const existing = await repinOrKeep(tenantId, statementId, statement.total, statement.currency);
      const review = existing ?? await createCommissionStatementApproval({
        tenantId, orgId, statementId,
        subjectId: statement.subjectId, period: statement.period, total: statement.total, currency: statement.currency,
        proposal: await commissionProposalText({ tenantId, orgId, subjectId: statement.subjectId, period: statement.period, total: statement.total, currency: statement.currency }),
      });
      res.status(202).json({ review: { approvalId: review.approvalId, status: review.status } });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/statements/:statementId/pay`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'host:commissions:manage');
      const statement = await markStatementPaid(tenantId, orgId, req.params.statementId, user.userId);
      commissionMutated({ entity: 'statement', verb: 'paid', tenantId, orgId, actor: user.userId, entityId: statement.statementId });
      res.json(statement);
    } catch (err) {
      next(err);
    }
  });
}
