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
 * CFP Phase-4 review: the write methods below are the ADR 0208 governed-WORKFLOW
 * lane — the HITL gate lives in the CHAIN (author a core.approvalGate before the
 * transition node); they do NOT mint the shared page/inbox approval row. The HTTP
 * routes are the gated interactive lane.
 */

import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { listModels, listTerritories, getActiveModelId, activateModel } from './entities/territories.js';
import { listRules, previewModel, materializeAssignments } from './entities/assignment.js';
import { listQuotas, computeAttainment, setQuota } from './entities/quota.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('territories.surface');

export function buildTerritorySurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const viewer = scope.actingUserId; // A2 — attainment is scoped to the run owner's territories
  const actor = `run:${scope.runId ?? 'unknown'}`;

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
      const model = await activateModel(tenantId, orgId, str(args.modelId), actor);
      // Best-effort re-sync — but LOG on failure (TERR-OBS-1): the REST path
      // logs this; the workflow path must not silently swallow it (stale
      // assignments until POST /reassign are otherwise invisible in prod).
      await materializeAssignments(tenantId, orgId, model.modelId).catch((err: unknown) => {
        log.error('territory materialize-on-activate (workflow surface) failed; run POST /reassign to recover', { err: String(err), modelId: model.modelId, orgId });
        return null;
      });
      return { success: true, model };
    },
    setQuota: async (args) => {
      const orgId = str(args.orgId);
      await requireScope(orgId, 'workspace:write');
      const quota = await setQuota(tenantId, orgId, str(args.modelId), str(args.territoryId), {
        period: str(args.period),
        amount: typeof args.amount === 'number' ? args.amount : Number(args.amount),
        ...(optStr(args.currency) ? { currency: str(args.currency) } : {}),
      });
      return { success: true, quota };
    },
  };
}
