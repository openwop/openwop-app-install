import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';

/** ADR 1034 D8 — do two subject spellings name the same person? `subjectKeyForms` covers
 *  the raw id, the `user:` scope and the `user:user:` double prefix; it never bridges a
 *  user to an IdP principal (principals are not issuer-qualified), so every form it
 *  matches is the SAME person — safe on the refuse paths (self-approval, self-pay) and on
 *  the visibility paths (own statements, own plan) alike. */
export function sameSubject(a: string, b: string): boolean {
  return subjectKeyForms(a).forms.has(b) || subjectKeyForms(b).forms.has(a);
}
