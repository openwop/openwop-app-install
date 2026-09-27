/**
 * ADR 0655 D1 — the email feature's recipient egress guard, registered on the host
 * seam (`host/recipientEgressGuard.ts`) at boot, toggle-independent: it is a refusal
 * FLOOR, not a feature capability. Consulted by `makeEmailAdapter` for every recipient
 * of every send on every lane (chain node, campaign route, invites, receipts,
 * approval notices). Order: erasure tombstone → suppression → consent.
 *
 * Stated residuals (ADR 0655 D1): consent is contactId-keyed, so an address the CRM
 * has never seen is not consent-checked (the route lane only ever sent to contacts —
 * the same posture, now explicit); a pre-index legacy contact reads as "no contact";
 * with the `consent` feature OFF (the shipped default) `isAllowed` is permissive and
 * the floor is the first two legs.
 */
import { registerRecipientEgressGuard } from '../../host/recipientEgressGuard.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { createLogger } from '../../observability/logger.js';
import { normalizeEmail, suppressionBlocksSend } from '../crm/suppressionService.js';
import { resolveContactIdByIdentifier } from '../crm/contactIdentityService.js';
import { resolveContactSurvivor } from '../crm/contactsService.js';
import { isAllowed, isErasureTombstoned } from '../consent/consentService.js';

const log = createLogger('email.egressGuard');

export function registerEmailEgressGuard(): void {
  registerRecipientEgressGuard('email', async ({ tenantId, address, purpose }) => {
    const folded = normalizeEmail(address);
    // Leg 1 — erasure tombstone, on every key form a DSAR could have used for this
    // address (raw, folded, and the scoped forms): one witness per arm (it.8 FRMCD-1).
    const keys = new Set<string>([address, folded, ...subjectKeyForms(folded).forms]);
    for (const k of keys) {
      if (k && (await isErasureTombstoned(tenantId, k))) return { ok: false, code: 'email_recipient_erased' };
    }
    // Leg 2 — suppression (bounce / complaint / unsubscribe / manual), every purpose.
    // v1 does not relax `unsubscribed` for transactional sends — the kind is not
    // exposed by `suppressionBlocksSend` (EMWF-18).
    const sup = await suppressionBlocksSend(tenantId, folded || address);
    if (sup === 'suppressed') return { ok: false, code: 'email_recipient_suppressed' };
    if (sup === 'unreadable') return { ok: false, code: 'email_suppression_unreadable' };
    // Leg 3 — consent, when a contact resolves through the INDEX (never a tenant scan).
    if (purpose === 'marketing') {
      const contactId = await resolveContactIdByIdentifier(tenantId, 'email', folded || address);
      const contact = contactId ? await resolveContactSurvivor(tenantId, contactId) : null;
      if (contact) {
        if (!(await isAllowed(tenantId, contact.contactId, 'marketing.email'))) {
          return { ok: false, code: 'email_recipient_no_consent' };
        }
      } else {
        log.debug('email egress: consent unresolvable (no contact for address)', { tenantId, purpose });
      }
    }
    return { ok: true };
  });
}
