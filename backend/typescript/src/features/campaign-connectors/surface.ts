/**
 * Campaign Connectors workflow surface (ADR 0159 / ADR 0014) —
 * `ctx.features['campaign-connectors']`. Tenant-trusted KPI + import reads the
 * sync/import nodes call.
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { importCsv, kpiSummary } from './performanceService.js';
import { AD_PLATFORMS, type AdPlatform } from './types.js';

const asPlatform = (v: unknown): AdPlatform | undefined =>
  typeof v === 'string' && (AD_PLATFORMS as readonly string[]).includes(v) ? (v as AdPlatform) : undefined;

export function buildCampaignConnectorsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    kpiSummary: async (args) => ({ ...(await kpiSummary(tenantId, optStr(args.orgId), optStr(args.campaignId))) }),
    importCsv: async (args) => {
      const orgId = str(args.orgId);
      const csv = str(args.csv);
      const platform = asPlatform(args.defaultPlatform);
      return { ...(await importCsv(tenantId, orgId, csv, { ...(platform ? { defaultPlatform: platform } : {}), ...(optStr(args.campaignId) ? { campaignId: str(args.campaignId) } : {}) })) };
    },
  };
}
