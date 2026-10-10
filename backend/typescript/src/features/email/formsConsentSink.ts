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

import { resolveToggle } from '../../host/featureToggles/service.js';
import { createLogger } from '../../observability/logger.js';
import { registerSubmissionSink } from '../forms/submissionSinks.js';
import { mergeConsentCategories, isErasureTombstoned, getConsent } from '../consent/consentService.js';
import type { FormDef, Submission } from '../forms/formsService.js';

const log = createLogger('email.formsConsentSink');

/**
 * ADR 0850 D2 — the opt-in this submission's tick speaks to, as the visitor saw
 * it. The capture-time snapshot governs; a row written before the snapshot
 * existed falls back to the live form ONLY at capture (when the live form IS what
 * the visitor saw), and records nothing on a later release. A REQUIRED opt-in is
 * never consent: it was a condition of submitting (GDPR Art. 7(4)).
 */
function optInOf(form: FormDef, submission: Submission): { field: string; required: boolean } | null {
  if (submission.optIn) return submission.optIn;
  if (submission.releasedAt || !form.emailOptInField) return null;
  const f = form.fields.find((x) => x.key === form.emailOptInField);
  return f ? { field: f.key, required: f.required } : null;
}

/** Register the `email-consent` sink. Called once from email's boot path. */
export function registerEmailFormsConsentSink(): void {
  registerSubmissionSink({
    id: 'email-consent',
    async onSubmission(form, submission) {
      const optIn = optInOf(form, submission);
      if (!optIn || submission.values[optIn.field] !== true) return undefined; // explicit grants only
      if (optIn.required) {
        log.info('forms_consent_skipped_required', { formId: form.formId });
        return undefined;
      }
      if (!submission.contactId) return undefined; // no linked contact ⇒ no consent subject
      try {
        // ADR 0819 §1 opt-out — a PUBLIC lane (tenant from the resource): ADR 0419 never paywalls a shopper/visitor on the operator's plan.
        const toggle = await resolveToggle('email', { tenantId: submission.tenantId });
        if (!toggle || !toggle.enabled) return undefined;
        // ADR 0655 D7 (EMWF-11 / review S4) — an ERASED subject's checkbox on a public form
        // is not fresh consent (the same rule as the D3 preference page). Checked FIRST:
        // `clearTombstone:false` alone is inert once any record exists, because the
        // tombstone is consulted only on the no-record branch. Skip + log, never write.
        if (await isErasureTombstoned(submission.tenantId, submission.contactId)) {
          log.info('forms_consent_skipped_erased', { formId: form.formId });
          return undefined;
        }
        // ADR 0850 D2 — no re-grant over a later change. A record written after the
        // tick (an unsubscribe, a preference-centre change) is newer evidence of what
        // this person wants; a tick replayed later — a released held row — must not
        // overwrite it.
        const current = await getConsent(submission.tenantId, submission.contactId);
        if (current && current.ts > submission.createdAt) {
          log.info('forms_consent_skipped_newer_record', { formId: form.formId });
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
          // ADR 0849 D7 (architect H5) — an EMAIL checkbox grants EMAIL. It also used to
          // set the `marketing` umbrella, and `isAllowed` falls back to the umbrella for
          // any channel without a recorded specific — so ticking it opened SMS, push and
          // ad-audience targeting too. The specific alone governs email.
          categories: { 'marketing.email': true },
          legalBasis: 'consent',
          // ADR 0850 D2 — the receipt names the submission: its `createdAt` and its
          // `optIn` snapshot are the time and the wording of the tick.
          source: `form-optin:${form.formId}:${submission.submissionId}`,
        });
      } catch (err) {
        // Fail-soft by seam contract — a consent hiccup never fails the capture.
        log.warn('email opt-in consent failed', { formId: form.formId, error: err instanceof Error ? err.message : String(err) });
      }
      return undefined;
    },
  });
}
