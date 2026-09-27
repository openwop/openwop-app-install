/**
 * ADR 0657 D1 (CNWF-1 / CNWF-2) — the consent feature's OWN `SubjectEraser`.
 *
 * `deleteSubject` tombstones + deletes the consent record for the REQUESTED key only,
 * then hands off to `eraseSubject`, where ADR 0381 resolution happens — and nothing
 * revisited the RESOLVED keys: erase `alice@x.test`, the CRM resolver yields `crm:c123`,
 * the CRM rows go, and the `consent:record` keyed `crm:c123` (`marketing:true`, the raw
 * key, region, purposes) survived untombstoned, so an audience upload read the stale
 * grant. The users erase door (`DELETE /users/:id`) called `eraseSubject` directly with
 * no consent participation at all. This eraser makes the same pair — delete the record,
 * write the tombstone — land on EVERY key the fan-out visits, from both doors.
 *
 * Contract: `rowsTouched` counts consent RECORDS deleted only — a tombstone write is not
 * a row found (or `foundNothing` — `reporting > 0 && rowsTouched === 0`, the wrong-tenant
 * tell — could never fire again). Every tombstone it writes carries the current DSAR's
 * group id (`currentErasureRequest()`), so `readmitSubject` can reverse the whole group —
 * the resolvers cannot recover the resolved keys once the ident rows are gone.
 * Idempotent: a second DSAR deletes nothing and re-stamps the same tombstone. It never
 * calls `eraseSubject` (no recursion), and reads no consent verdict, so eraser order does
 * not change behaviour.
 */
import { registerSubjectEraser, currentErasureRequest, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { deleteConsentRecordForErasure, writeErasureTombstone, tombstoneId } from './consentService.js';

export async function consentSubjectEraser(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  const req = currentErasureRequest();
  const dsarHash = tombstoneId(tenantId, req?.requestedKey ?? subjectKey);
  await writeErasureTombstone(tenantId, subjectKey, dsarHash);
  const deleted = await deleteConsentRecordForErasure(tenantId, subjectKey);
  return { rowsTouched: deleted ? 1 : 0 };
}

/** Registered from `consentFeature.registerRoutes`, toggle-independently (the ADR 0655 D1
 *  precedent): erasure is a floor, not a capability a tenant buys. Idempotent. */
export function registerConsentErasure(): void {
  registerSubjectEraser(consentSubjectEraser);
}
