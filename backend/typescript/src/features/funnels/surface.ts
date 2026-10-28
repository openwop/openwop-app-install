/**
 * Funnels workflow surface (ADR 0294 / Funnel A) — `ctx.features.funnels`.
 * Reads: list / get / stepStats. ADR 0948 P1b: `requestPublish` queues a human
 * publish review and never publishes. Writes (Phase 6, the promotions precedent):
 * `create` and `setSteps` author DRAFT state only — publishing a funnel changes
 * a PUBLIC surface, so it is deliberately NOT exposed here: an agent proposes
 * the funnel, a human publishes it in the Funnels page ("agent proposes, human
 * disposes"). Step experiments are likewise human-started (they change public
 * serving for consented visitors).
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listFunnels, getFunnel, createFunnelReporting, updateFunnel, runFunnelId } from './funnelsService.js';
import { OpenwopError } from '../../types.js';
import { requestFunnelPublish } from './funnelPublishApproval.js';
import { runOrgScopeSubject } from '../../host/accessControlService.js';
import { getFunnelStats } from './funnelStats.js';

const INTERNAL = new Set(['tenantId', 'createdBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

export function buildFunnelsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    list: async (args) => ({
      funnels: (await listFunnels(tenantId, str(args.orgId))).map(project),
    }),
    get: async (args) => {
      const funnel = await getFunnel(tenantId, str(args.orgId), str(args.funnelId));
      return { funnel: funnel ? project(funnel) : null };
    },
    // WRITE (role:'side-effect', ADR 0948 P1) — agent-authored funnels are DRAFTS;
    // publish is human. In a run the id is DERIVED here (tenant + run + `key`),
    // never taken from args, so a re-delivered create returns the same draft and no
    // caller can name another tenant's funnel. `key` comes from the node (its node id
    // plus an optional loop key); another node in the SAME run could pass the same
    // key and get that draft back. That residual is inside one run, by design.
    create: async (args) => {
      const key = str(args.key);
      const { funnel, reused } = await createFunnelReporting({
        tenantId, orgId: str(args.orgId), createdBy: 'agent',
        ...(scope.runId && key ? { funnelId: runFunnelId(tenantId, scope.runId, key) } : {}),
        name: args.name, slug: args.slug, steps: args.steps,
        ...(args.campaignId !== undefined ? { campaignId: args.campaignId } : {}),
      });
      return { funnelId: funnel.funnelId, slug: funnel.slug, status: funnel.status, proposed: true, ...(reused ? { reused: true } : {}) };
    },
    // Draft-only, like the chat tool (`agentTools.ts`): editing a published funnel's
    // steps is publishing them, so a run never does it (ADR 0948 P1 — a branch fork
    // taken after `create` would otherwise edit a funnel a human has published since).
    setSteps: async (args) => {
      const current = await getFunnel(tenantId, str(args.orgId), str(args.funnelId));
      if (!current) return { funnelId: null };
      if (current.status !== 'draft') {
        throw new OpenwopError('conflict', 'Only a draft funnel can be edited from a workflow; edit a published funnel in the Funnels page.', 409, { code: 'funnel_not_draft', status: current.status });
      }
      const funnel = await updateFunnel(tenantId, str(args.orgId), str(args.funnelId), { steps: args.steps });
      return funnel
        ? { funnelId: funnel.funnelId, steps: funnel.steps.length, status: funnel.status }
        : { funnelId: null };
    },
    // ADR 0948 P1b — REQUEST a publish; never publishes. Queues a `funnel-publish`
    // review pinned to the funnel's content; a human's approve publishes it.
    requestPublish: async (args) => {
      // ADR 0859 D3/D4 — the run's actor is the requester; a member who merely CAUSED
      // an actorless run is recorded as a cause (narrows separation of duties only).
      const cause = scope.actingUserId ? undefined : runOrgScopeSubject(scope);
      const out = await requestFunnelPublish(tenantId, str(args.orgId), str(args.funnelId), {
        ...(scope.actingUserId ? { requestedBy: scope.actingUserId } : {}),
        ...(cause ? { causedBy: cause } : {}),
        ...(scope.runId ? { runId: scope.runId } : {}),
      });
      return out ? { status: out.status, approvalId: out.approvalId, created: out.created } : { status: 'not_found', approvalId: null };
    },
    stepStats: async (args) => {
      const days = await getFunnelStats(tenantId, str(args.orgId), str(args.funnelId));
      // totals per step — the compact projection a planning agent needs
      const totals: Record<string, { views: number; completions: number; revenue: number; orders: number }> = {};
      for (const row of days) {
        for (const [stepId, cell] of Object.entries(row.steps)) {
          const t = (totals[stepId] ??= { views: 0, completions: 0, revenue: 0, orders: 0 });
          t.views += cell.views; t.completions += cell.completions; t.revenue += cell.revenue; t.orders += cell.orders;
        }
      }
      return { steps: totals, days: days.length };
    },
  };
}
