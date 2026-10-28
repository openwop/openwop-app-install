/**
 * Campaign playbooks subject erasure (ADR 0464 store ledger). Playbooks and installations are
 * the agency's method and configuration, so they are never deleted on a person's erasure. What
 * goes is the person in them: `updatedBy` / `publishedBy` / `installedBy` / history `by` become
 * the erased-user tombstone. Tenant-scoped only (a principal id is not issuer-qualified).
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { erasePlaybookAuthors } from './playbookStore.js';
import { eraseInstallers } from './installService.js';
import { eraseRolloutPeople } from './rolloutService.js';

export async function eraseCampaignPlaybooksSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 };
  const forms = subjectKeyForms(subjectKey).forms;
  return { rowsTouched: (await erasePlaybookAuthors(tenantId, forms, ERASED_USER_REF)) + (await eraseInstallers(tenantId, forms, ERASED_USER_REF)) + (await eraseRolloutPeople(tenantId, forms, ERASED_USER_REF)) };
}

export function registerCampaignPlaybooksErasure(): void {
  registerSubjectEraser(eraseCampaignPlaybooksSubject);
}
