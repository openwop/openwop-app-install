/**
 * `ctx.features.territories` workflow surface (ADR 0272 P5/A5 / ADR 0014) — the
 * typed API a `role:"action"` node calls.
 *
 * READS are open to any run scoped to the tenant (attainment is viewer-scoped, A2).
 * WRITES (activate a model, set a quota — ADR 0272 A5) are governed: they enforce
 * the SAME scope the HTTP routes require, resolved against the RUN OWNER
 * (`scope.actingUserId`) — `host:territories:manage` for activation (org-wide
 * visibility change), `workspace:write` for a quota. A system run with no acting
 * user is DENIED (fail-closed) — automation can't activate a model without an
 * authorizing human. The write NODES are kept OUT of the advisory Territory
 * Planner agent's allowlist, so they ride a governed chain behind an approval gate,
 * never a direct agent tool call (the ADR 0208 §2 stance).
 *
 * `tenantId` comes from the run scope (never node args — CTI-1); `orgId` is
 * node-supplied. Every accessor is tenant+org IDOR-guarded.
 *
 * @see docs/adr/0272-sales-territory-management.md
 *
 * ADR 1034 D1 — CORRECTED. This block said the write methods were the governed-
 * WORKFLOW lane "where the HITL gate lives in the CHAIN (author a core.approvalGate
 * before the transition node)". Nothing enforced that, so `activateModel` applied an
 * org-wide visibility change with `run:<runId>` as the actor. It now SUBMITS the same
 * `territory-model-transition` review the HTTP route queues; a human with
 * `host:territories:manage` decides it in `/reviews`. `setQuota` is a direct write, held
 * to the route's bar: `host:territories:manage` on the ACTIVE model (ADR 1034 D5).
 */

import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { listModels, listTerritories, getActiveModelId, getModel } from './entities/territories.js';
import { createTerritoryTransitionApproval } from '../../host/approvalService.js';
import { transitionProposalText } from './modelTransitionApproval.js';
import { listRules, previewModel } from './entities/assignment.js';
import { listQuotas, computeAttainment, setQuota } from './entities/quota.js';

export function buildTerritorySurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const viewer = scope.actingUserId; // A2 — attainment is scoped to the run owner's territories

  /** A5 — a territory WRITE from a run enforces `scope` against the RUN OWNER.
   *  Fail-closed for system runs (no acting user). Mirrors the HTTP RBAC exactly. */
  const requireScope = async (orgId: string, scopeNeeded: Scope): Promise<void> => {
    if (!viewer) throw new OpenwopError('forbidden_scope', 'A territory write requires an acting user (system runs are denied).', 403, { requiredScope: scopeNeeded });
    const access = await resolveEffectiveAccess(tenantId, { subject: viewer, orgId });
    if (!access.scopes.includes(scopeNeeded)) throw new OpenwopError('forbidden_scope', `Missing required scope: ${scopeNeeded}`, 403, { requiredScope: scopeNeeded });
  };

  return {
    // ── Reads ──
    listModels: async (args) => ({ models: await listModels(tenantId, str(args.orgId)), activeModelId: await getActiveModelId(tenantId, str(args.orgId)) }),
    activeModel: async (args) => ({ activeModelId: await getActiveModelId(tenantId, str(args.orgId)) }),
    listTerritories: async (args) => ({ territories: await listTerritories(tenantId, str(args.orgId), str(args.modelId)) }),
    listRules: async (args) => ({ rules: await listRules(tenantId, str(args.orgId), str(args.modelId)) }),
    listQuotas: async (args) => ({ quotas: await listQuotas(tenantId, str(args.orgId), str(args.modelId), optStr(args.period)) }),
    previewModel: async (args) => ({ summary: await previewModel(tenantId, str(args.orgId), str(args.modelId)) }),
    attainment: async (args) => await computeAttainment(tenantId, str(args.orgId), str(args.modelId), optStr(args.period), viewer),

    // ── Writes (A5) — scope-checked against the run owner; chain/approval-gated ──
    activateModel: async (args) => {
      const orgId = str(args.orgId);
      await requireScope(orgId, 'host:territories:manage');
      const modelId = str(args.modelId);
      const model = await getModel(tenantId, orgId, modelId); // 404 + IDOR before queueing
      // The route's own fail-fast (`routes.ts`): never queue a review that can only fail.
      if (model.state === 'archived') throw new OpenwopError('validation_error', 'An archived model cannot be re-activated; create a new planning model instead.', 409, { modelId });
      const review = await createTerritoryTransitionApproval({ tenantId, orgId, modelId, transition: 'activate', proposal: transitionProposalText(model.name, 'activate') });
      return { success: true, submittedForReview: true, review: { approvalId: review.approvalId, status: review.status } };
    },
    setQuota: async (args) => {
      const orgId = str(args.orgId);
      const modelId = str(args.modelId);
      await requireScope(orgId, (await getActiveModelId(tenantId, orgId)) === modelId ? 'host:territories:manage' : 'workspace:write');
      const quota = await setQuota(tenantId, orgId, modelId, str(args.territoryId), {
        period: str(args.period),
        amount: typeof args.amount === 'number' ? args.amount : Number(args.amount),
        ...(optStr(args.currency) ? { currency: str(args.currency) } : {}),
        // ADR 1034 D2 — forwarded when supplied (`[]` clears); omitted keeps the stored splits.
        ...(args.repSplits !== undefined ? { repSplits: args.repSplits } : {}),
      }, { keepSplitsWhenOmitted: true });
      return { success: true, quota };
    },
  };
}
