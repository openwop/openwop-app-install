/**
 * ADR 0820 §7 — Dealers' READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * Partner-portal tokens are capabilities and are not exported (no list returns them).
 */
import { listDealers, listOutlets } from './entities/dealer.js';
import { listRegistrations } from './entities/registration.js';
import { collectPerOrg, type FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportDealersData(tenantId: string): Promise<FeatureDataSections> {
  return {
    dealers: await collectPerOrg(tenantId, (orgId) => listDealers(tenantId, orgId)),
    outlets: await collectPerOrg(tenantId, (orgId) => listOutlets(tenantId, orgId)),
    registrations: await collectPerOrg(tenantId, (orgId) => listRegistrations(tenantId, orgId)),
  };
}
