/**
 * ADR 0946 P0 — campaign-orchestration subject erasure (ADR 0464 store
 * ledger). A variant set is the org's creative record that reviews and
 * experiments name by hash, and a campaign is org marketing state, so neither
 * is deleted on erasure: `createdBy` is tombstoned on every variant-set version
 * and every campaign (the `brand` eraser precedent). This took
 * `campaign-orchestration:campaign` off the actor-attribution debt ledger.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../../host/subjectErasureRedaction.js';
import { eraseVariantSetAuthor } from './variantSetService.js';
import { eraseCampaignAuthor } from '../campaignService.js';

export async function eraseCampaignVariantSetSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 }; // never an unscoped sweep
  const forms = subjectKeyForms(subjectKey).forms;
  const rowsTouched = (await eraseVariantSetAuthor(tenantId, forms, ERASED_USER_REF)) + (await eraseCampaignAuthor(tenantId, forms, ERASED_USER_REF));
  return { rowsTouched };
}

export function registerVariantSetErasure(): void {
  registerSubjectEraser(eraseCampaignVariantSetSubject);
}
