/**
 * ADR 0820 §7 — Campaign orchestration's READ-ONLY data exporter for the
 * portability lapsed-data door (`host/featureDataExport.ts`; the CRM exporter is
 * the reference). List calls only: no write, no mutation event, no run, no model
 * call. Tenant-scoped (`${tenantId}::` prefix + the tenantId filter).
 */
import { listCampaignVersions, listCampaigns } from './campaignService.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportCampaignOrchestrationData(tenantId: string): Promise<FeatureDataSections> {
  const campaigns = (await listCampaigns(tenantId)).filter((c) => c.tenantId === tenantId);
  const versions: unknown[] = [];
  for (const c of campaigns) versions.push(...await listCampaignVersions(tenantId, c.id));
  return { campaigns, versions };
}
