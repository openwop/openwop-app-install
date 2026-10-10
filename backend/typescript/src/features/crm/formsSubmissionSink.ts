/**
 * CRM's forms submission sink (ADR 0330 §D1) — the `crm-contact` destination
 * on the forms submission-sink seam. This inverts ADR 0017's forms→crm
 * import: CRM (the integrator) now depends on Forms (the primitive) and owns
 * the values→contact mapping. Behavior is ADR 0017's, gated one step further:
 * the contact is created only when the form opted in (`createToContact`) AND
 * the submission tenant's `crm` toggle resolves on (ADR 0017's open question
 * "gate createToContact on the CRM toggle?" — resolved: yes, here). A skip is
 * silent (no marker); only a real create failure records
 * `contact_create_failed`, and unmappable values record `no_contact_fields`.
 *
 * ADR 0627 D6 — a submission from an address that already has a contact is
 * ATTACHED to that contact (the duplicate 409 names it; followed to the live
 * survivor). The attach writes NO contact fields: the submission's name/company
 * never overwrite the existing record — an anonymous form is not an authority
 * over a contact the org already keeps. Only the marker's `contactId` is set.
 */

import { resolveToggle } from '../../host/featureToggles/service.js';
import { registerSubmissionSink } from '../forms/submissionSinks.js';
import type { FormDef, Submission } from '../forms/formsService.js';
import { createHash } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { OpenwopError } from '../../types.js';
import { createContact, duplicateEmailContactIdOf, getContact, resolveContactSurvivor, subjectErasureState } from './contactsService.js';
import { createActivity } from './crmEntitiesService.js';
import { suppressionBlocksSend } from './suppressionService.js';

const log = createLogger('crm.formsSink');

function deriveContact(form: FormDef, values: Submission['values']): { name: string; email?: string; company?: string } | null {
  const emailField = form.fields.find((f) => f.type === 'email');
  const email = emailField && typeof values[emailField.key] === 'string' ? (values[emailField.key] as string) : undefined;
  const name = typeof values.name === 'string' ? (values.name as string) : email;
  if (!name) return null;
  const company = typeof values.company === 'string' ? (values.company as string) : undefined;
  return { name, ...(email ? { email } : {}), ...(company ? { company } : {}) };
}

/**
 * ADR 0860 D7 — the existing contact still learns that the form was submitted: one
 * timeline note, with the form's TITLE only (an anonymous form is not an authority
 * over the contact's record, ADR 0627 D6, so no submitted value is written).
 *
 * Architect H2 — this is an anonymous write into a store capped per org, so the id
 * is per (form, contact, UTC day): a bot replaying known emails adds at most one
 * note per form, per contact, per day, and a re-run of the sinks is idempotent.
 * Best-effort: a failure (the cap included) is logged and never fails the capture.
 */
async function noteSubmissionOnExistingContact(form: FormDef, contactId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = createHash('sha256').update(`${form.formId}\n${contactId}\n${day}`).digest('hex').slice(0, 40);
  try {
    await createActivity({
      tenantId: form.tenantId, orgId: form.orgId, kind: 'note',
      body: `Submitted the form "${form.title}".`,
      contactId,
      createdBy: `system:forms:${form.formId}`,
      activityId: `act:form-sub-${key}`,
      validators: {
        validateDeal: async () => false,
        validateCompany: async () => false,
        validateContact: async (id) => { const c = await getContact(id); return c !== null && c.tenantId === form.tenantId; },
      },
    });
  } catch (err) {
    log.warn('form_submission_activity_failed', { tenantId: form.tenantId, formId: form.formId, error: err instanceof OpenwopError ? err.code : err instanceof Error ? err.name : 'unknown' });
  }
}

/** Register the `crm-contact` sink. Called once from crm's boot path. */
export function registerCrmFormsSink(): void {
  registerSubmissionSink({
    id: 'crm-contact',
    async onSubmission(form, submission) {
      if (!form.createToContact) return undefined;
      // ADR 0819 §1 opt-out — a PUBLIC lane (tenant from the resource): ADR 0419 never paywalls a shopper/visitor on the operator's plan.
      const crm = await resolveToggle('crm', { tenantId: submission.tenantId });
      if (!crm || !crm.enabled) return undefined; // CRM off ⇒ silent skip, never an error
      const mapped = deriveContact(form, submission.values);
      if (!mapped) return { error: 'no_contact_fields' };
      // FRMWF-2 / ADR 0648 D2 — REFUSE TO RESURRECT a suppressed OR erased subject.
      //
      // CORRECTED (FRMCD-1, same day): the first cut called `isSuppressed` and
      // claimed both halves. It closed ONLY the suppression half — no erasure path
      // writes a suppression row (the DSAR fan-out merely REDACTS an existing one),
      // so a respondent who became a contact and then filed a DSAR without ever
      // unsubscribing was still re-created from an anonymous write. The predicate
      // for that case already existed: `isErasureTombstoned`, a PII-free tombstone
      // written BEFORE the fan-out for exactly this. The first witness could not see
      // the gap because it seeded suppression by hand instead of running the eraser.
      //
      // CORRECTED (FRMCD-2, same day): `isSuppressed` PROPAGATES storage errors by
      // design, and the call sat outside the try below — so a KV blip threw out of
      // the sink, the loop swallowed it, and the row carried NO marker at all,
      // indistinguishable from "CRM toggled off". `suppressionBlocksSend` is the
      // purpose-built wrapper with a third state for exactly that.
      //
      // Both stay MARKERS, not throws: sink throws are swallowed by design
      // (capture-before-effect, ADR 0017), and the submission must still land with a
      // clean 201 so neither suppression nor erasure becomes an oracle. The checks
      // live HERE, not in `createContact`: an operator re-adding a contact through
      // the authenticated route is allowed to; an anonymous form is not.
      if (mapped.email) {
        const sup = await suppressionBlocksSend(submission.tenantId, mapped.email);
        if (sup === 'unreadable') return { error: 'suppression_unreadable' };
        if (sup === 'suppressed') return { error: 'suppressed' };
        // ADR 0837 D4 — the ONE erasure predicate the unattended lanes share
        // (a tombstone read error fails closed and is logged).
        const erasure = await subjectErasureState(submission.tenantId, mapped.email);
        if (erasure === 'erased') return { error: 'erased' };
        if (erasure === 'unreadable') return { error: 'suppression_unreadable' }; // CRM2CD-4: unreadable is not "erased"
      }
      try {
        // ADR 0627 D2 — `contact.created` fires inside `createContact` (this lane emitted nothing before).
        const contact = await createContact({ tenantId: submission.tenantId, name: mapped.name, ...(mapped.email ? { email: mapped.email } : {}), ...(mapped.company ? { company: mapped.company } : {}), actor: `system:forms:${form.formId}` });
        return { contactId: contact.contactId, contactCreated: true }; // ADR 0860 D7 — the ONLY branch that may link a session
      } catch (err) {
        // ADR 0627 D6 — a repeat submission from an address that already has a
        // contact is the EXISTING contact, not a failure (the claim 409 names it).
        const existingId = duplicateEmailContactIdOf(err);
        const existing = existingId ? await resolveContactSurvivor(submission.tenantId, existingId) : null;
        if (existing) {
          await noteSubmissionOnExistingContact(form, existing.contactId);
          return { contactId: existing.contactId }; // ADR 0860 D7 — NOT `contactCreated`: no session link
        }
        return { error: 'contact_create_failed' };
      }
    },
  });
}
