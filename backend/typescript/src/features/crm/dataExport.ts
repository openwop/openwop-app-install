/**
 * ADR 0820 §7 — CRM's READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`). A workspace whose plan no longer includes
 * CRM can still take its records out; every CRM write and read lane keeps
 * refusing.
 *
 * Read-only by contract: list calls only — no `crmMutated` event (unlike the
 * CSV routes, this is not a CRM-surface action and must not look like one), no
 * write, no run. Workspace-wide: the door is admin-class, so rows are listed
 * without a viewer (no territory narrowing — an admin holds
 * `host:territories:view-all` anyway). Tombstoned (merged-away) rows are
 * excluded exactly as the CSV export excludes them.
 */
import { listContacts } from './contactsService.js';
import { listActivities, listCompanies, listDeals, listTasks } from './crmEntitiesService.js';
import { listOrgs } from '../../host/accessControlService.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportCrmData(tenantId: string): Promise<FeatureDataSections> {
  const contacts = await listContacts(tenantId);
  const companies: unknown[] = [];
  const deals: unknown[] = [];
  const tasks: unknown[] = [];
  const activities: unknown[] = [];
  for (const org of await listOrgs(tenantId)) {
    companies.push(...await listCompanies(tenantId, org.orgId));
    deals.push(...await listDeals(tenantId, org.orgId));
    tasks.push(...await listTasks(tenantId, org.orgId));
    activities.push(...await listActivities(tenantId, org.orgId));
  }
  return { contacts, companies, deals, tasks, activities };
}
