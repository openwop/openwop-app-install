/**
 * Campaign Intelligence workflow surface (ADR 0160 / ADR 0014) —
 * `ctx.features['campaign-intel']`. Tenant-trusted budget + forecast reads the
 * intel nodes call. Composes the performance store (ADR 0159).
 *
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
import { optimizeBudget, forecastCampaigns } from './intelligence.js';

export function buildCampaignIntelSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    optimizeBudget: async (args) => {
      const records = await listRecords(tenantId, str(args.orgId), optStr(args.campaignId));
      return { ...optimizeBudget(records) };
    },
    forecast: async (args) => {
      const records = await listRecords(tenantId, str(args.orgId), optStr(args.campaignId));
      return { forecasts: forecastCampaigns(records) };
    },
  };
}
