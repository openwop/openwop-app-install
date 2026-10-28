/**
 * Campaign intelligence subject erasure (ADR 0464 store ledger; ADRs 0952, 0956).
 * Keep client configuration, tombstone its actors. A spend cap (and a
 * reallocation plan, the client's spend record) keeps protecting a client's spend
 * after its author leaves, so it is never deleted on a person's erasure. What
 * goes is the person in it: `createdBy` becomes the erased-user tombstone.
 * Tenant-scoped only: a principal id is not issuer-qualified, so it is never
 * matched in another tenant.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { eraseSpendCapCreators } from './spendCaps.js';
import { erasePlanCreators } from './reallocation.js';
import { eraseUtmGovernanceActors } from './utmGovernance.js';
import { eraseAttributionSettingsActors } from './attributionSettings.js';

export async function eraseCampaignIntelSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 }; // never an unscoped sweep
  const { forms } = subjectKeyForms(subjectKey);
  return { rowsTouched: (await eraseSpendCapCreators(tenantId, forms, ERASED_USER_REF))
    + (await erasePlanCreators(tenantId, forms, ERASED_USER_REF))
    + (await eraseUtmGovernanceActors(tenantId, forms, ERASED_USER_REF))
    + (await eraseAttributionSettingsActors(tenantId, forms, ERASED_USER_REF)) };
}

export function registerCampaignIntelErasure(): void {
  registerSubjectEraser(eraseCampaignIntelSubject);
}
