/** ADR0954 P4 recovery: visitor submissions live on the contact-owner primary;
 * frozen evidence and assessments live on the grade primary. The existing
 * contact closure fences both before text is removed, including absent rows.
 * Subject erasure and hard contact deletion use this same idempotent path. */
import { onCrmRecordDeleted } from '../../../host/crmRecordLifecycle.js';
import { declarePiiFields } from '../../../host/dataClassification.js';
import { registerSubjectEraser, type SubjectEraseReport } from '../../../host/subjectErasure.js';
import { deleteAssessmentsOf } from './assessment.js';
import { closeLeadBinding, hasLeadBinding, leadOrgOf } from './leadStore.js';
import { getContact } from '../contactsService.js';
import { deleteStatedAnswers } from './statedAnswers.js';

/** Idempotent; a key that is no contact of this tenant touches nothing. */
export async function eraseLeadIntelSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const contact = await getContact(subjectKey);
  if (contact?.tenantId === tenantId || await hasLeadBinding(tenantId, subjectKey)) await closeLeadBinding(tenantId, subjectKey);
  let rowsTouched = await deleteStatedAnswers(tenantId, subjectKey);
  const orgId = await leadOrgOf(tenantId, subjectKey);
  if (orgId) rowsTouched += await deleteAssessmentsOf(tenantId, orgId, subjectKey);
  return { rowsTouched };
}

export function registerLeadIntelErasure(): void {
  registerSubjectEraser(eraseLeadIntelSubject);
  onCrmRecordDeleted('crm-lead-intel', async ({ tenantId, entity, recordId }) => {
    if (entity === 'contact') await eraseLeadIntelSubject(tenantId, recordId);
  });
  // Generic field names: mask them for these two stores only, never repo-wide.
  declarePiiFields('crm:lead-profile-of', ['statedSubmissions'], { maskGloballyByFieldName: false });
  declarePiiFields('crm:lead-grade', ['assessments', 'qualificationReads'], { maskGloballyByFieldName: false });
}
