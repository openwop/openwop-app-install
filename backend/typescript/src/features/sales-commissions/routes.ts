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
import { closePendingCommissionStatementApprovals, listApprovals } from '../../host/approvalService.js';

import { createPlan, listPlans, getPlan, updatePlan, deletePlan, plansVisibleTo } from './entities/plan.js';
import { computeStatement, listStatements, getStatementRaw, markStatementPaid, planNonDraftStatementCount, deleteDraftStatementsForPlan, sameSubject } from './entities/statement.js';
import { commissionMutated } from './emit.js';
import { submitStatementForReview } from './pin.js';
import { DEAL_CONFLICT_NOTE } from './statementApproval.js';

const TOGGLE_ID = 'sales-commissions';
const LABEL = 'Commissions';

const authorize = (req: Request, scope: Scope) => authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, scope);

/** Does the caller hold the management scope (⇒ sees every rep's statement)? */
async function callerCanSeeAll(tenantId: string, orgId: string, subject: string): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes('host:commissions:manage');
}
/**
 * ADR 1034 (grade-ux H5) — each statement's LATEST review card, so the console can say
 * "In review" (and not offer Submit again), and say when a review was closed as superseded
 * because some deals were already paid (and offer Recompute instead of a Submit that would
 * be superseded again). One tenant listing per request; the card's note is host text with no
 * ids in it.
 */
async function withReviewState<T extends { statementId: string; computedAt: string }>(tenantId: string, orgId: string, rows: T[]): Promise<Array<T & { review?: { status: string; superseded: boolean } }>> {
  const wanted = new Set(rows.map((r) => r.statementId));
  const latest = new Map<string, { status: string; note?: string; createdAt: string; resolvedAt?: string }>();
  // Only the two statuses the console reads (closing grade-code I5): approved cards pile up
  // with the tenant's whole history and say nothing a statement's own status does not.
  const cards = [...await listApprovals(tenantId, 'pending'), ...await listApprovals(tenantId, 'rejected')];
  for (const a of cards) {
    const id = a.commissionStatement?.statementId;
    if (a.kind !== 'commission-statement' || a.orgId !== orgId || !id || !wanted.has(id)) continue;
    const prev = latest.get(id);
    if (!prev || a.createdAt > prev.createdAt) latest.set(id, { status: a.status, ...(a.note !== undefined ? { note: a.note } : {}), createdAt: a.createdAt, ...(a.resolvedAt !== undefined ? { resolvedAt: a.resolvedAt } : {}) });
  }
  return rows.map((r) => {
    const card = latest.get(r.statementId);
    if (!card) return r;
    // A superseded card stops mattering once the statement is RECOMPUTED after it was
    // closed (closing-pass Blocker: recompute mints no card, so this used to stay true and
    // Submit never came back). Same for any rejection older than the current figures.
    // A PENDING card older than the current figures is stale too: its decide will 409, and
    // the console must offer Submit (which re-pins) rather than "In review" forever.
    // (A same-millisecond tie reads as "recomputed after the close" for a rejection, and as
    // "submitted after the compute" for a pending card — the likelier order in each case.)
    if (card.status === 'pending' ? r.computedAt > card.createdAt : r.computedAt >= (card.resolvedAt ?? card.createdAt)) return r;
    return { ...r, review: { status: card.status, superseded: card.status === 'rejected' && card.note === DEAL_CONFLICT_NOTE } };
  });
}

const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function registerCommissionRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/commissions/orgs/:orgId';

  // ── Plans ──
  app.get(`${BASE}/plans`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:read');
      // ADR 1034 D11 — a rep sees team plans and their own; `canManage` lets the console
      // show manager controls only to the people the server lets use them.
      const canManage = await callerCanSeeAll(tenantId, orgId, user.userId);
      res.json({ plans: plansVisibleTo(await listPlans(tenantId, orgId), canManage, user.userId), canManage });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/plans/:planId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:read');
      const plan = await getPlan(tenantId, orgId, req.params.planId);
      // Same visibility as the list; a hidden plan is the same 404 as a missing one.
      if (plansVisibleTo([plan], await callerCanSeeAll(tenantId, orgId, user.userId), user.userId).length === 0) {
        throw new OpenwopError('not_found', 'Commission plan not found.', 404, { planId: req.params.planId });
      }
      res.json(plan);
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
      res.json({ statements: await withReviewState(tenantId, orgId, rows) });
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
      if (!statement || (!canSeeAll && !sameSubject(statement.subjectId, user.userId))) throw new OpenwopError('not_found', 'Statement not found.', 404, { statementId: req.params.statementId });
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
      // ADR 1034 D5 — the ONE submit path (`pin.ts`), shared with the workflow surface: it
      // stamps the submitter, closes a card whose pin no longer matches, and pins the new
      // card to the total, the attainment and the lines.
      const review = await submitStatementForReview(tenantId, orgId, statement, user.userId);
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
