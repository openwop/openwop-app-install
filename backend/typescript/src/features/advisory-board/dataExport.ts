/**
 * ADR 0820 §7 — Advisory board's READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * SHARED boards only: a private board is readable by its creator alone
 * (`canRead`), and an admin-class export must not widen that.
 */
import { listBoards } from './service.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportAdvisoryBoardData(tenantId: string): Promise<FeatureDataSections> {
  return { boards: await listBoards(tenantId, undefined) };
}
