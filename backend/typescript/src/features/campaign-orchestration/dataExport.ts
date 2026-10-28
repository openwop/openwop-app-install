/**
 * ADR 0820 §7 — Campaign orchestration's READ-ONLY data exporter for the
 * portability lapsed-data door (`host/featureDataExport.ts`; the CRM exporter is
 * the reference). List calls only: no write, no mutation event, no run, no model
 * call. Tenant-scoped (`${tenantId}::` prefix + the tenantId filter).
 */
import { listCampaignVersions, listCampaigns } from './campaignService.js';
import { listVariantSetVersions, listVariantSets } from './variants/variantSetService.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportCampaignOrchestrationData(tenantId: string): Promise<FeatureDataSections> {
  const campaigns = (await listCampaigns(tenantId)).filter((c) => c.tenantId === tenantId);
  const versions: unknown[] = [];
  const variantSets: unknown[] = [];
  for (const c of campaigns) {
    versions.push(...await listCampaignVersions(tenantId, c.id));
    // ADR 0946 — every immutable version of every variant set.
    for (const s of await listVariantSets(tenantId, c.id)) variantSets.push(...await listVariantSetVersions(tenantId, c.id, s.setId));
  }
  return { campaigns, versions, variantSets };
}
