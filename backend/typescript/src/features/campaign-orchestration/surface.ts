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
import { getCampaign, listCampaigns, finalizeFromBrief } from './campaignService.js';

export function buildCampaignStudioSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listCampaigns: async (args) => ({ campaigns: await listCampaigns(tenantId, optStr(args.orgId)) }),
    getCampaign: async (args) => ({ campaign: (await getCampaign(tenantId, str(args.campaignId))) ?? null }),

    /** Finalize a brief into its campaign (upsert by briefId). The node calls this. */
    finalizeFromBrief: async (args) => {
      const brief = await getBrief(tenantId, str(args.briefId));
      if (!brief) return { found: false };
      const campaign = await finalizeFromBrief(tenantId, brief, str(args.createdBy) || 'workflow');
      return { found: true, campaign };
    },
  };
}
