/**
 * `ctx.features['sales-commissions']` workflow surface (ADR 0280 P4 / ADR 0014).
 *
 * READS (listPlans, listStatements) are open to any run scoped to the tenant, but
 * statement reads are SUBJECT-SCOPED to the run owner (`scope.actingUserId`) unless
 * the owner holds `host:commissions:manage` — a rep's run sees only their own
 * statements (fail-closed; a system run with no owner sees none).
 *
 * WRITES (computeStatement, approveStatement) are GOVERNED (ADR 0272 A5 pattern):
 * they enforce `host:commissions:manage` against the RUN OWNER, and a system run
 * with no acting user is DENIED — automation can't compute/approve payouts without
 * an authorizing human. The write NODES are kept OUT of the advisory Commissions
 * Analyst agent's allowlist, so they ride a governed chain behind an approval gate
 * (ADR 0208 §2), never a direct agent tool call.
 *
 * `tenantId` comes from the run scope (never node args — CTI-1); `orgId` is
 * node-supplied and IDOR-guarded per accessor.
 *
 * @see docs/adr/0280-sales-commissions.md
 *
 * CFP Phase-4 review said the write methods were the governed-WORKFLOW lane with the
 * gate "in the CHAIN". CORRECTED by R2 COM2-M3 (and ADR 1034 for the sibling features):
 * `approveStatement` submits the shared review card; it never approves.
 */

import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { listPlans, plansVisibleTo } from './entities/plan.js';
import { listStatements, computeStatement, getStatementRaw } from './entities/statement.js';
import { submitStatementForReview } from './pin.js';

export function buildCommissionSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const viewer = scope.actingUserId;
  // R2 COM2-M3 — this used to stamp `approvedBy`. Nothing in this surface applies an
  // approval any more, so an unattributable `run:unknown` can no longer reach a payout
  // record at all; the id survives only for logging.
  void scope.runId;

  const hasManage = async (orgId: string): Promise<boolean> => {
    if (!viewer) return false;
    const access = await resolveEffectiveAccess(tenantId, { subject: viewer, orgId });
    return access.scopes.includes('host:commissions:manage');
  };
  /** A5 — a commission WRITE from a run enforces manage against the RUN OWNER;
   *  fail-closed for system runs (no acting user). */
  const requireManage = async (orgId: string): Promise<void> => {
    if (!(await hasManage(orgId))) throw new OpenwopError('forbidden_scope', 'A commission write requires an acting user with host:commissions:manage (system runs denied).', 403, { requiredScope: 'host:commissions:manage' });
  };

  return {
    // ── Reads ──
    listPlans: async (args) => {
      const orgId = str(args.orgId);
      // ADR 1034 D11 — the route's visibility (one helper): team plans + the owner's own.
      return { plans: plansVisibleTo(await listPlans(tenantId, orgId), await hasManage(orgId), viewer) };
    },
    listStatements: async (args) => {
      const orgId = str(args.orgId);
      const statements = await listStatements(
        tenantId,
        orgId,
        { subjectId: optStr(args.subjectId), period: optStr(args.period), planId: optStr(args.planId) },
        await hasManage(orgId),
        viewer,
      );
      return { statements };
    },

    // ── Governed writes (A5) — scope-checked against the run owner; chain/approval-gated ──
    computeStatement: async (args) => {
      const orgId = str(args.orgId);
      await requireManage(orgId);
      const statement = await computeStatement(tenantId, orgId, str(args.planId), str(args.subjectId), str(args.period));
      return { success: true, statement };
    },
    /**
     * R2 COM2-M3 — this used to APPLY `draft → approved` directly, so
     * `feature.sales-commissions.nodes.approve-statement` let any builder-authored chain
     * approve every draft statement in an org with no review card and no second person —
     * while `routes.ts` states, in as many words, that "no path approves a statement
     * without the gate". The gate was a CONVENTION ("author a `core.approvalGate` before
     * the transition node"), enforced by nothing. It also stamped `approvedBy` as
     * `run:${runId ?? 'unknown'}` — an unattributable approval on a payout record.
     *
     * It now SUBMITS for review, exactly as the HTTP route does, and returns the pending
     * review. A chain can still drive the process; it just cannot be the approver.
     */
    approveStatement: async (args) => {
      const orgId = str(args.orgId);
      await requireManage(orgId);
      const statementId = str(args.statementId);
      const statement = await getStatementRaw(tenantId, orgId, statementId);
      if (!statement) throw new OpenwopError('not_found', 'Statement not found.', 404, { statementId });
      if (statement.status !== 'draft') throw new OpenwopError('conflict', `Only a draft statement can be submitted for approval (this one is ${statement.status}).`, 409, { statementId, status: statement.status });
      // ADR 1034 D5 — the ONE submit path, shared with the HTTP route (`pin.ts`).
      const review = await submitStatementForReview(tenantId, orgId, statement, viewer);
      return { success: true, submittedForReview: true, review: { approvalId: review.approvalId, status: review.status } };
    },
  };
}
