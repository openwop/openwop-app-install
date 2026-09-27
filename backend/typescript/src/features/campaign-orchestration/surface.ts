/**
 * Campaign Studio workflow surface (ADR 0158 / ADR 0014) —
 * `ctx.features['campaign-orchestration']`. Tenant-trusted reads + `finalizeFromBrief`
 * the finalize node calls. Composes the brief (ADR 0156) by reading it.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { getBrief } from '../campaign-brief/briefService.js';
import { attachCampaignAssets, getCampaign, getCampaignByBrief, listCampaigns, finalizeFromBrief } from './campaignService.js';

export function buildCampaignStudioSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listCampaigns: async (args) => ({ campaigns: await listCampaigns(tenantId, optStr(args.orgId)) }),
    getCampaign: async (args) => ({ campaign: (await getCampaign(tenantId, str(args.campaignId))) ?? null }),

    /** Finalize a brief into its campaign (upsert by briefId). The node calls this. */
    finalizeFromBrief: async (args) => {
      const brief = await getBrief(tenantId, str(args.briefId));
      if (!brief) return { found: false };
      // ADR 0356 P1 — link the spine-generated production plan (the newest plan
      // carrying this briefId), composing the production feature lazily.
      let productionPlanId: string | undefined;
      try {
        const { listPlans } = await import('../production/productionService.js');
        const plans = await listPlans(tenantId, brief.orgId);
        const mine = plans.filter((pl) => pl.briefId === brief.id).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        productionPlanId = mine[0]?.planId;
      } catch { /* production off / absent — no link */ }
      const campaign = await finalizeFromBrief(tenantId, brief, str(args.createdBy) || 'workflow', productionPlanId ? { productionPlanId } : undefined);
      return { found: true, campaign };
    },

    /** Attach media assets to a campaign — the durable campaign→asset edge
     *  (CS-DATA-5). Resolves the campaign by campaignId, else by briefId. The
     *  render-concepts node calls this after it generates concept images. */
    attachAssets: async (args) => {
      const resolved = str(args.campaignId)
        ? await getCampaign(tenantId, str(args.campaignId))
        : (str(args.briefId) ? await getCampaignByBrief(tenantId, str(args.briefId)) : null);
      if (!resolved) return { found: false };
      const assetIds = (Array.isArray(args.assetIds) ? args.assetIds : []).map(String).filter(Boolean);
      const campaign = await attachCampaignAssets(tenantId, resolved.id, assetIds);
      return { found: true, attached: assetIds.length, campaign };
    },
  };
}
