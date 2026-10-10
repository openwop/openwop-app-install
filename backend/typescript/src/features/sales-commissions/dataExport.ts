/**
 * ADR 0820 §7 — Sales commissions' READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * Statements are listed workspace-wide (`canSeeAll`): the door is admin-class.
 */
import { listPlans } from './entities/plan.js';
import { listStatements } from './entities/statement.js';
import { collectPerOrg, type FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportSalesCommissionsData(tenantId: string): Promise<FeatureDataSections> {
  return {
    plans: await collectPerOrg(tenantId, (orgId) => listPlans(tenantId, orgId)),
    statements: await collectPerOrg(tenantId, (orgId) => listStatements(tenantId, orgId, {}, true, undefined)),
  };
}
