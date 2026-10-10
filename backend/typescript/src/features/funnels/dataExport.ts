/**
 * ADR 0820 §7 — Funnels' READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * Never `listFunnelScopes` (a cross-tenant scan).
 */
import { listFunnels } from './funnelsService.js';
import { collectPerOrg, type FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportFunnelsData(tenantId: string): Promise<FeatureDataSections> {
  return { funnels: await collectPerOrg(tenantId, (orgId) => listFunnels(tenantId, orgId)) };
}
