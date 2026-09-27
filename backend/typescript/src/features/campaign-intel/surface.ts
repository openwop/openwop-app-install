/**
 * Campaign Intelligence workflow surface (ADR 0160 / ADR 0014) —
 * `ctx.features['campaign-intel']`. Tenant-trusted budget + forecast reads the
 * intel nodes call. Composes the performance store (ADR 0159).
 *
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */

import { OpenwopError } from '../../types.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
import { optimizeBudget, forecastCampaigns } from './intelligence.js';
import { buildAttribution } from './attribution.js';
import { buildPacing, runPacingCheck } from './pacing.js';

export function buildCampaignIntelSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // ADR 0357 P1/P2 — deterministic goal planning + anomalies for nodes/agents.
    planBudget: async (args) => {
      const { listRecords } = await import('../campaign-connectors/performanceService.js');
      const { planBudget } = await import('./budgetPlanner.js');
      // Mirror the route's positive-finite guard: NaN/zero/negative goals must
      // not reach the money math (node args are as untrusted as HTTP bodies).
      const n = (v: unknown, field: string): number => {
        const x = Number(v);
        if (!Number.isFinite(x) || x <= 0) {
          throw new OpenwopError('validation_error', `\`${field}\` MUST be a positive number.`, 400, { field });
        }
        return Math.floor(x);
      };
      const records = await listRecords(tenantId, String(args.orgId ?? ''));
      const plan = planBudget(records, {
        totalBudgetMinor: n(args.totalBudgetMinor, 'totalBudgetMinor'),
        targetConversions: n(args.targetConversions, 'targetConversions'),
        horizonDays: n(args.horizonDays ?? 90, 'horizonDays'),
        ...(Array.isArray(args.platforms) ? { platforms: (args.platforms as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
      });
      return { plan };
    },
    anomalies: async (args) => {
      const { listRecords } = await import('../campaign-connectors/performanceService.js');
      const { detectAnomalies } = await import('./budgetPlanner.js');
      return { anomalies: detectAnomalies(await listRecords(tenantId, String(args.orgId ?? ''))) };
    },
    optimizeBudget: async (args) => {
      const records = await listRecords(tenantId, str(args.orgId), optStr(args.campaignId));
      return { ...optimizeBudget(records) };
    },
    forecast: async (args) => {
      const records = await listRecords(tenantId, str(args.orgId), optStr(args.campaignId));
      return { forecasts: forecastCampaigns(records) };
    },
    // C5 (ADR 0219) — attribution join; C7 (ADR 0220) — pacing (read + alerting check).
    attribution: async (args) => ({ ...(await buildAttribution(tenantId, str(args.orgId))) }),
    pacing: async (args) => ({ ...(await buildPacing(tenantId, str(args.orgId))) }),
    pacingCheck: async (args) => ({ ...(await runPacingCheck(tenantId, str(args.orgId))) }),
  };
}
