/**
 * Funnels workflow surface (ADR 0294 / Funnel A) — `ctx.features.funnels`.
 * Reads: list / get / stepStats. Writes (Phase 6, the promotions precedent):
 * `create` and `setSteps` author DRAFT state only — publishing a funnel changes
 * a PUBLIC surface, so it is deliberately NOT exposed here: an agent proposes
 * the funnel, a human publishes it in the Funnels page ("agent proposes, human
 * disposes"). Step experiments are likewise human-started (they change public
 * serving for consented visitors).
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listFunnels, getFunnel, createFunnel, updateFunnel } from './funnelsService.js';
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
    // WRITE (role:'action') — agent-authored funnels are DRAFTS; publish is human.
    create: async (args) => {
      const funnel = await createFunnel({
        tenantId, orgId: str(args.orgId), createdBy: 'agent',
        name: args.name, slug: args.slug, steps: args.steps,
      });
      return { funnelId: funnel.funnelId, slug: funnel.slug, status: funnel.status, proposed: true };
    },
    setSteps: async (args) => {
      const funnel = await updateFunnel(tenantId, str(args.orgId), str(args.funnelId), { steps: args.steps });
      return funnel
        ? { funnelId: funnel.funnelId, steps: funnel.steps.length, status: funnel.status }
        : { funnelId: null };
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
