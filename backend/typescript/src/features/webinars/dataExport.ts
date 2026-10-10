/**
 * ADR 0820 §7 — Webinars' READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 */
import { listMarketingEvents } from './entities/marketingEvent.js';
import { collectPerOrg, type FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportWebinarsData(tenantId: string): Promise<FeatureDataSections> {
  return { events: await collectPerOrg(tenantId, (orgId) => listMarketingEvents(tenantId, orgId)) };
}
