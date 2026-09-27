/**
 * Email's forms submission sink (ADR 0338 §D2) — the `email-consent`
 * registrant on the ADR 0330 seam. When a form designates an explicit opt-in
 * checkbox (`emailOptInField`) and the visitor checked it, record the
 * marketing-email grant through the ONE consent service, keyed by the CRM
 * contact the `crm-contact` sink just linked (registration order = execution
 * order — ADR 0338 §D3; no contact ⇒ no subject ⇒ silent skip). CONS-3: a CAS
 * MERGE of the two categories the checkbox actually speaks to — it was a
 * latest-wins full replace that hand-preserved `analytics` (AUDIT-5) and
 * dropped every other specific, which silently granted sms + push.
 * Unchecked/absent is a silent skip, NEVER an opt-out. No marker returned.
 */

import { resolveOne } from '../../host/featureToggles/service.js';
import { createLogger } from '../../observability/logger.js';
import { registerSubmissionSink } from '../forms/submissionSinks.js';
import { mergeConsentCategories, isErasureTombstoned } from '../consent/consentService.js';

const log = createLogger('email.formsConsentSink');

/** Register the `email-consent` sink. Called once from email's boot path. */
export function registerEmailFormsConsentSink(): void {
  registerSubmissionSink({
    id: 'email-consent',
    async onSubmission(form, submission) {
      const field = form.emailOptInField;
      if (!field || submission.values[field] !== true) return undefined; // explicit grants only
      if (!submission.contactId) return undefined; // no linked contact ⇒ no consent subject
      try {
        const toggle = await resolveOne('email', { tenantId: submission.tenantId });
        if (!toggle || !toggle.enabled) return undefined;
        // ADR 0655 D7 (EMWF-11 / review S4) — an ERASED subject's checkbox on a public form
        // is not fresh consent (the same rule as the D3 preference page). Checked FIRST:
        // `clearTombstone:false` alone is inert once any record exists, because the
        // tombstone is consulted only on the no-record branch. Skip + log, never write.
        if (await isErasureTombstoned(submission.tenantId, submission.contactId)) {
          log.info('forms_consent_skipped_erased', { formId: form.formId });
          return undefined;
        }
        // CONS-3 — MERGE the two categories this checkbox actually speaks to.
        //
        // This used to be a wholesale `recordConsent` that hand-preserved
        // `analytics` and dropped everything else: a recorded
        // `marketing.sms:false` / `marketing.push:false` vanished, and
        // `isAllowed` falls back to the `marketing` umbrella when a specific is
        // ABSENT — so a person who used the preference centre to turn SMS off
        // became SMS-mailable by ticking an EMAIL checkbox. Hand-preserving one
        // field is the assertion shape that made it invisible; merging removes
        // the class rather than adding a second field to remember.
        await mergeConsentCategories({
          tenantId: submission.tenantId,
          subjectKey: submission.contactId,
          categories: { marketing: true, 'marketing.email': true },
          legalBasis: 'consent',
          source: `form-optin:${form.formId}`,
        });
      } catch (err) {
        // Fail-soft by seam contract — a consent hiccup never fails the capture.
        log.warn('email opt-in consent failed', { formId: form.formId, error: err instanceof Error ? err.message : String(err) });
      }
      return undefined;
    },
  });
}
