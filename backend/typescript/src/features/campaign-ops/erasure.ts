/**
 * Campaign ops subject erasure (ADR 0464 store ledger). Client accounts and
 * assets are the agency's configuration for a client, so they are never deleted
 * on a person's erasure. What goes is the person in them: `createdBy` becomes the
 * erased-user tombstone. Tenant-scoped only: a principal id is not
 * issuer-qualified, so it is never matched in another tenant.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { eraseClientCreators } from './clientService.js';
import { eraseAssetCreators } from './assetService.js';

export async function eraseCampaignOpsSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 }; // never an unscoped sweep
  const forms = subjectKeyForms(subjectKey).forms;
  const rowsTouched = (await eraseClientCreators(tenantId, forms, ERASED_USER_REF)) + (await eraseAssetCreators(tenantId, forms, ERASED_USER_REF));
  return { rowsTouched };
}

export function registerCampaignOpsErasure(): void {
  registerSubjectEraser(eraseCampaignOpsSubject);
}
