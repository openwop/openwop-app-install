/**
 * ADR 0820 §7 — Creative briefs' READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 */
import { listBriefs, listVersions } from './creativeBriefsService.js';
import { listOrgs } from '../../host/accessControlService.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportCreativeBriefsData(tenantId: string): Promise<FeatureDataSections> {
  const briefs: unknown[] = [];
  const versions: unknown[] = [];
  for (const { orgId } of await listOrgs(tenantId)) {
    for (const b of await listBriefs(tenantId, orgId)) {
      briefs.push(b);
      versions.push(...await listVersions(tenantId, orgId, b.briefId));
    }
  }
  return { briefs, versions };
}
