/**
 * Brand subject erasure (ADR 0891 D8; ADR 0464 store ledger). A brand is org
 * configuration that campaigns, briefs and publishing resolve by id, so it is never
 * deleted on erasure. What goes is the person in it: `createdBy`,
 * `governance.allowedEditors`, the audit trail's `actor` (and the editor lists inside
 * its governance diffs), and a font's `attestedBy`.
 *
 * The app brand (`brand:host-app`) lives in the reserved `host:site` tenant, which no
 * subject's DSAR names, and its audit rows record the super-admin who edited it (D9).
 * So a call for a `user:` id also scrubs that tenant's brand stores. Only a `user:` id:
 * it is globally unique, while a principal id is not issuer-qualified (`oidc:<sub>`
 * from two issuers can be two people), and scrubbing another tenant's rows by one
 * would erase the attribution of someone who never asked.
 *
 * The tombstone matches no actor: the creator branch of a `partial` lock stops
 * applying, while org admins and the remaining listed editors are unaffected.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { SYSTEM_SITE_TENANT } from '../../host/systemSite.js';
import { createLogger } from '../../observability/logger.js';
import { eraseBrandStoreSubject } from './brandService.js';
import { eraseBrandFontSubject } from './brandFonts.js';

const log = createLogger('brand.erasure');

export async function eraseBrandSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 }; // never an unscoped sweep
  const forms = subjectKeyForms(subjectKey).forms;
  let rowsTouched = 0;
  const tenants = tenantId !== SYSTEM_SITE_TENANT && subjectKey.startsWith('user:') ? [tenantId, SYSTEM_SITE_TENANT] : [tenantId];
  for (const t of tenants) {
    rowsTouched += await eraseBrandStoreSubject(t, forms, ERASED_USER_REF);
    rowsTouched += await eraseBrandFontSubject(t, forms, ERASED_USER_REF);
  }
  if (rowsTouched > 0) log.info('brand_subject_erased', { tenantId, rowsTouched });
  return { rowsTouched };
}

export function registerBrandErasure(): void {
  registerSubjectEraser(eraseBrandSubject);
}
