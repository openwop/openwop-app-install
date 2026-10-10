/**
 * ADR 0820 §7 — Territories' READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 */
import { listModels, listTerritories, listTypes } from './entities/territories.js';
import { listAssignmentsForModel, listRules } from './entities/assignment.js';
import { listQuotas } from './entities/quota.js';
import { listOrgs } from '../../host/accessControlService.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportTerritoriesData(tenantId: string): Promise<FeatureDataSections> {
  const types: unknown[] = [];
  const models: unknown[] = [];
  const territories: unknown[] = [];
  const rules: unknown[] = [];
  const assignments: unknown[] = [];
  const quotas: unknown[] = [];
  for (const { orgId } of await listOrgs(tenantId)) {
    types.push(...await listTypes(tenantId, orgId));
    for (const m of await listModels(tenantId, orgId)) {
      models.push(m);
      territories.push(...await listTerritories(tenantId, orgId, m.modelId));
      rules.push(...await listRules(tenantId, orgId, m.modelId));
      assignments.push(...await listAssignmentsForModel(tenantId, orgId, m.modelId));
      quotas.push(...await listQuotas(tenantId, orgId, m.modelId));
    }
  }
  return { types, models, territories, rules, assignments, quotas };
}
