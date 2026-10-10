/**
 * ADR 0820 §7 — Twin recall's READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 */
import { listGrantsForTenant } from '../../host/twinService.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportTwinRecallData(tenantId: string): Promise<FeatureDataSections> {
  return { grants: await listGrantsForTenant(tenantId) };
}
