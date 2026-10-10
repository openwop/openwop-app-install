/**
 * ADR 0820 §7 — Priority matrix' READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 */
import { listLists, listRankedIdeas, listSessions } from './priorityMatrixService.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportPriorityMatrixData(tenantId: string): Promise<FeatureDataSections> {
  const lists = await listLists(tenantId);
  const ideas: unknown[] = [];
  const sessions: unknown[] = [];
  for (const l of lists) {
    ideas.push(...(await listRankedIdeas(tenantId, l.id)).map((i) => ({ listId: l.id, ...i })));
    sessions.push(...await listSessions(tenantId, l.id));
  }
  return { lists, ideas, sessions };
}
