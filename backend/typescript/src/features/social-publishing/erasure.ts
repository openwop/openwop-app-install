/**
 * Social publishing subject erasure (ADR 0464 store ledger). A post is the
 * client's content, so it is kept; the person in it (`createdBy`,
 * `approval.decidedBy`) becomes the erased-user tombstone. Tenant-scoped only: a
 * principal id is not issuer-qualified, so it is never matched in another tenant.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { eraseSocialPostSubjects } from './postService.js';

export async function eraseSocialPublishingSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 }; // never an unscoped sweep
  return { rowsTouched: await eraseSocialPostSubjects(tenantId, subjectKeyForms(subjectKey).forms, ERASED_USER_REF) };
}

export function registerSocialPublishingErasure(): void {
  registerSubjectEraser(eraseSocialPublishingSubject);
}
