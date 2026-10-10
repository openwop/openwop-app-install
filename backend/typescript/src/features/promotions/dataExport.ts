/**
 * ADR 0820 §7 — Promotions' READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 */
import { listPromotions } from './promotionsService.js';
import { collectPerOrg, type FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportPromotionsData(tenantId: string): Promise<FeatureDataSections> {
  return { promotions: await collectPerOrg(tenantId, (orgId) => listPromotions(tenantId, orgId)) };
}
