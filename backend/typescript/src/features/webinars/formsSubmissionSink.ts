/**
 * Webinar registration sink (ADR 0404 §a) — rides the forms submission-sink seam
 * (`registerSubmissionSink`). When a submitted form is BOUND to a webinar event
 * (a webinars-owned binding, so FormDef stays unmodified), this records the
 * `registered` webinar activity + ensures the CRM contact, and best-effort pushes
 * the registrant to the provider.
 *
 * NOTE: a public form submit has NO acting user, so the broker fail-closes on the
 * org connection — the provider PUSH here is best-effort (no-ops without a
 * resolvable credential). The authoritative registrant push is the operator-driven
 * `webinar.register` node (which runs with an identity the broker can resolve).
 * The LOCAL registration (CRM contact + activity) is always recorded.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §a
 */

import { createLogger } from '../../observability/logger.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { registerSubmissionSink } from '../forms/submissionSinks.js';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { ownerPublicRuntimeLapsed } from '../../host/publicLapse.js';
import { getFormBinding, getMarketingEvent } from './entities/marketingEvent.js';
import { ingestWebinarEvent } from './webinarProcessor.js';
import { makeWebinarAdapter } from './host/webinarAdapter.js';
import { enqueuePendingPush } from './pendingPush.js';

const log = createLogger('webinars.sink');

/** Pull an email + optional name from a submission's values (best-effort). */
function pickContact(values: Record<string, unknown>): { email: string; name?: string } | null {
  let email = '';
  let name = '';
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== 'string') continue;
    const key = k.toLowerCase();
    if (!email && (key.includes('email') || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) email = v.trim();
    if (!name && (key.includes('name') || key === 'full_name')) name = v.trim();
  }
  return email ? { email, ...(name ? { name } : {}) } : null;
}

export function registerWebinarFormsSink(): void {
  registerSubmissionSink({
    id: 'webinar-registration',
    async onSubmission(form, submission) {
      try {
        const binding = await getFormBinding(form.tenantId, form.formId);
        if (!binding) return undefined; // form not bound to a webinar — not our concern
        // ADR 0819 §1 opt-out — a PUBLIC lane (tenant from the resource): ADR 0419 never paywalls a shopper/visitor on the operator's plan.
        const toggled = await resolveToggle('webinars', { tenantId: form.tenantId });
        if (!toggled || !toggled.enabled) return undefined;
        // ADR 0820 §7 — the owner-lapse policy (off unless the grace knob is set). Only the
        // WEBINAR registration is skipped; the form submission itself (and any consent it
        // carries) is recorded by the forms feature regardless.
        if (await ownerPublicRuntimeLapsed('webinars', form.tenantId)) return undefined;
        const event = await getMarketingEvent(form.tenantId, binding.orgId, binding.eventId);
        // R2 WB-SP-12 — a binding whose event row is gone means the submission
        // is DROPPED for webinar purposes; that must at least be visible in the
        // logs (the delete path is currently unreachable, but unguarded).
        if (!event) { log.warn('webinar sink — binding points at a missing event, submission not registered', { formId: form.formId, eventId: binding.eventId }); return undefined; }
        const contact = pickContact((submission.values ?? {}) as Record<string, unknown>);
        if (!contact) return undefined;

        // Record the LOCAL registration (contact + activity) — always.
        await ingestWebinarEvent(form.tenantId, binding.orgId, event.connectionId, {
          provider: event.provider, providerEventId: event.providerEventId, phase: 'registered',
          participantEmail: contact.email, ...(contact.name ? { participantName: contact.name } : {}),
          ...(event.title ? { title: event.title } : {}),
        });

        // Best-effort provider push (no-ops without a resolvable credential — see header).
        // R2 WB-SP-2 — a skipped/failed push is QUEUED, not just logged: the sink
        // has no acting user, so the org-connection gate fail-closes the push on
        // every submission — registrants never got a join link, silently. The
        // operator drains the queue from the page with a real acting user.
        try {
          const deps = { storage: hostExtStorage(), tenantId: form.tenantId, runId: `hostext:webinar-sink:${form.formId}`, orgId: binding.orgId };
          const [first, ...rest] = (contact.name ?? '').split(' ');
          const push = await makeWebinarAdapter(deps).registerRegistrant(event.providerEventId, { email: contact.email, ...(first ? { firstName: first } : {}), ...(rest.length ? { lastName: rest.join(' ') } : {}) });
          if (!push.ok) {
            log.info('webinar registrant push skipped — queued for operator dispatch', { formId: form.formId, reason: push.error });
            await enqueuePendingPush({ tenantId: form.tenantId, orgId: binding.orgId, eventId: binding.eventId, providerEventId: event.providerEventId, email: contact.email, ...(contact.name ? { name: contact.name } : {}) });
          }
        } catch (err) {
          log.info('webinar registrant push errored — queued for operator dispatch', { error: err instanceof Error ? err.message : String(err) });
          await enqueuePendingPush({ tenantId: form.tenantId, orgId: binding.orgId, eventId: binding.eventId, providerEventId: event.providerEventId, email: contact.email, ...(contact.name ? { name: contact.name } : {}) }).catch(() => undefined);
        }

        return undefined; // the CRM sink (if present) owns the returned contactId
      } catch (err) {
        log.warn('webinar registration sink failed', { formId: form.formId, error: err instanceof Error ? err.message : String(err) });
        return { error: 'webinar_sink_failed' };
      }
    },
  });
}
