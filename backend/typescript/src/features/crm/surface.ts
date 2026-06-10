/**
 * CRM workflow surface (ADR 0014 Phase 4) — `ctx.features.crm`, the SECOND
 * reference feature surface, proving the FeatureModule pattern generalizes beyond
 * KB. A THIN read adapter over `crmEntitiesService` (the source of truth shared
 * with the REST face). Tenant comes from the run scope; `orgId` is node-supplied
 * and the SERVICE enforces the tenant+org key (CTI-1) — a cross-tenant id is not
 * found. Read-only in v1 (mutations are a follow-on); intended for `role:action`
 * pack nodes (recorded → replay-safe).
 *
 * NOTE: only CTI-1-safe org-scoped reads are exposed. `contactsService.getContact`
 * (by id, no tenant guard) is deliberately NOT surfaced.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listCompanies, getCompany, listDeals, getDeal, listTasks } from './crmEntitiesService.js';

/** Internal metadata stripped from surface outputs — a workflow node's output is
 *  recorded in the durable event log, so it carries the entity's display fields,
 *  not the host's identity/attribution columns (the KB surface already returns
 *  projected shapes). */
const INTERNAL = new Set(['tenantId', 'orgId', 'createdBy', 'updatedBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const projectOne = (o: object | null): Record<string, unknown> | null => (o ? project(o) : null);

export function buildCrmSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listCompanies: async (args) => {
      const companies = await listCompanies(tenantId, str(args.orgId), optStr(args.q));
      return { companies: companies.map(project) };
    },
    getCompany: async (args) => {
      const company = await getCompany(tenantId, str(args.orgId), str(args.companyId));
      return { company: projectOne(company) };
    },
    listDeals: async (args) => {
      const filter: { pipelineId?: string; stageId?: string; companyId?: string; q?: string } = {};
      if (optStr(args.pipelineId)) filter.pipelineId = str(args.pipelineId);
      if (optStr(args.stageId)) filter.stageId = str(args.stageId);
      if (optStr(args.companyId)) filter.companyId = str(args.companyId);
      if (optStr(args.q)) filter.q = str(args.q);
      const deals = await listDeals(tenantId, str(args.orgId), filter);
      return { deals: deals.map(project) };
    },
    getDeal: async (args) => {
      const deal = await getDeal(tenantId, str(args.orgId), str(args.dealId));
      return { deal: projectOne(deal) };
    },
    listTasks: async (args) => {
      const filter: { status?: string; dealId?: string } = {};
      if (optStr(args.status)) filter.status = str(args.status);
      if (optStr(args.dealId)) filter.dealId = str(args.dealId);
      const tasks = await listTasks(tenantId, str(args.orgId), filter);
      return { tasks: tasks.map(project) };
    },
  };
}
