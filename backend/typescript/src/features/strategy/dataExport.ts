/**
 * ADR 0820 §7 — Strategy's (OKRs) READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * Archived strategies are included; key results ride inside each strategy.
 */
import { listStrategies } from './strategyService.js';
import { listCheckInsByStrategy } from './checkIns.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportStrategyData(tenantId: string): Promise<FeatureDataSections> {
  return {
    strategies: await listStrategies(tenantId, { includeArchived: true }),
    checkIns: [...(await listCheckInsByStrategy(tenantId)).values()].flat(),
  };
}
