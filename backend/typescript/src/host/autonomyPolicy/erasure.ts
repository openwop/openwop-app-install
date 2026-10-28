/**
 * ADR 0942 — subject erasure for the autonomy stores (ADR 0464 store ledger).
 * Policies and bindings are the org's configuration, so they are kept; the
 * person who saved them (`createdBy` / `updatedBy`) becomes the erased-user
 * tombstone. Tenant-scoped only: a principal id is not issuer-qualified.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../subjectErasureRedaction.js';
import { eraseAutonomyActors } from './store.js';
import { eraseDigestItemsFor } from './notify.js';
import { eraseVetoSubjects } from './veto.js';

export async function eraseAutonomyPolicySubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 };
  const forms = subjectKeyForms(subjectKey).forms;
  // The policy rows stay (actor tombstoned); the person's queued digest notices are theirs and go.
  return { rowsTouched: (await eraseAutonomyActors(tenantId, forms, ERASED_USER_REF)) + (await eraseDigestItemsFor(tenantId, forms)) + (await eraseVetoSubjects(tenantId, forms, ERASED_USER_REF)) };
}

export function registerAutonomyPolicyErasure(): void {
  registerSubjectEraser(eraseAutonomyPolicySubject);
}
