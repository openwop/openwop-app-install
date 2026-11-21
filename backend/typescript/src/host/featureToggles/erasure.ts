/**
 * ADR 0464 §9, CHAN-F19 #12 — subject erasure for the HOST feature-toggle store.
 *
 * A toggle row's `betaCohort` holds the ids a closed beta admits: tenant ids and
 * principal ids (a SAML subject can be an email address, as `audit.ts` notes). It is
 * the reason that audit records cohorts as a SIZE. An erased person stayed in every
 * cohort, and in `updatedBy` on the rows they last saved. User decision 2026-11-19:
 * on erasure, remove the person from every beta cohort (they lose closed-beta access).
 *
 * The cohort is compared with the principal id (`toggleSubjectOf` sets
 * `userId = req.principal.principalId`), while a DSAR names the app user id. So the
 * ids removed are the subject key's forms plus the principal on the User row, HOME
 * TENANT ONLY (the `actingUserIds` rule, ADR 0780 D2 correction): the principal was
 * minted under this user's own IdP there.
 *
 * SCOPE, stated: the rows are host-global, so the principal leaves every cohort, not
 * only the erasing tenant's. A principal id is not issuer-qualified (`scim:jsmith`
 * from two IdPs is one string), so a same-string principal from another IdP loses its
 * beta access too. An emptied cohort keeps `ERASED_COHORT_MEMBER`, so a closed beta
 * never becomes an open one.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../subjectErasure.js';
import { ERASED_USER_REF, subjectKeyForms } from '../subjectErasureRedaction.js';
import { getUser } from '../../features/users/usersService.js';
import { createLogger } from '../../observability/logger.js';
import { eraseToggleSubject } from './service.js';

const log = createLogger('host.featureToggles.erasure');

/** Every id a toggle row can hold for this subject in `tenantId`. */
export async function toggleSubjectIds(tenantId: string, subjectKey: string): Promise<ReadonlySet<string>> {
  const ids = new Set(subjectKeyForms(subjectKey).forms);
  try {
    if (subjectKey.startsWith('user:')) {
      const u = await getUser(subjectKey);
      if (u && u.tenantId === tenantId && u.principalId) ids.add(u.principalId);
    }
  } catch (err) {
    // The principal alias is a recovery: without it the key's own forms still match.
    log.warn('toggle_subject_principal_lookup_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return ids;
}

export async function eraseFeatureToggleSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 };
  const changed = await eraseToggleSubject(await toggleSubjectIds(tenantId, subjectKey), ERASED_USER_REF);
  return { rowsTouched: changed.length };
}

export function registerFeatureToggleErasure(): void {
  registerSubjectEraser(eraseFeatureToggleSubject);
}
