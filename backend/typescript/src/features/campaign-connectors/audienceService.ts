/**
 * Audience upload builder (ADR 0217 / campaign gap plan §5C C3) — turns a CRM
 * saved segment into a suppression-safe, consent-checked, SHA-256-hashed member
 * list for ad-platform custom audiences (Meta Custom Audiences / Google
 * Customer Match — both take SHA-256 of the normalized address).
 *
 * The exclusion order is the point: no-email → marketing-consent check
 * (`consentService.isAllowed`, per contact) → suppression overlay
 * (`crm:suppression`). Only survivors are hashed; RAW ADDRESSES NEVER LEAVE
 * THIS FUNCTION — the adapter receives hashes only, and the platform dispatch
 * itself sits behind the ads-audience approval gate (default require-approval;
 * an audience upload is PII-adjacent).
 */

import { createHash } from 'node:crypto';
// Cross-feature READS (the documented precedent): segment membership + consent
// + suppression are each read through their owning service.
import { resolveSegmentMembers } from '../crm/segmentsService.js';
import { suppressionBlocksSend, normalizeEmail } from '../crm/suppressionService.js';
import { isAllowed } from '../consent/consentService.js';

export interface AudienceUpload {
  segmentId: string;
  /** SHA-256 of each surviving member's normalized (trim+lowercase) email. */
  memberHashes: string[];
  /** Stable content key: sha256 over the SORTED hash list — the approval /
   *  idempotency anchor (same members ⇒ same key, order-independent). */
  membersKey: string;
  size: number;
  excluded: {
    noEmail: number; consent: number; suppressed: number;
    /** Fold-in B5 — held back because the suppression store could not be READ, which
     *  is not the same fact as "this person asked us to stop". Reported separately so
     *  the operator-facing count never launders an outage into a consent claim. */
    unreadable: number;
    /** ADR 0657 D5 (CNWF-6) — held back because the CONSENT store could not be read. A
     *  throw from `isAllowed` used to abort the whole batch; now it excludes ONE recipient,
     *  counted apart from `consent` so an outage is never reported as a refusal. */
    consentUnreadable: number;
  };
}

export async function buildAudienceUpload(tenantId: string, segmentId: string): Promise<AudienceUpload> {
  const members = await resolveSegmentMembers(tenantId, segmentId);
  const excluded = { noEmail: 0, consent: 0, suppressed: 0, unreadable: 0, consentUnreadable: 0 };
  const hashes: string[] = [];
  for (const contact of members) {
    const email = contact.email ? normalizeEmail(contact.email) : '';
    if (!email) { excluded.noEmail += 1; continue; }
    // Deliberately the `marketing` UMBRELLA, not a `marketing.<channel>`
    // specific (ADR 0227): an ad-platform audience upload is not a channel
    // send — the contact's identity is shared for targeting across ad surfaces,
    // so the broadest marketing grant must hold; a narrower per-channel opt-in
    // (say email-only) must NOT leak the address hash to ad platforms.
    let consented: boolean;
    try { consented = await isAllowed(tenantId, contact.contactId, 'marketing'); }
    catch { excluded.consentUnreadable += 1; continue; } // D5 — per-recipient, never a batch abort
    if (!consented) { excluded.consent += 1; continue; }
    const check = await suppressionBlocksSend(tenantId, email);
    if (check !== 'clear') { excluded[check === 'suppressed' ? 'suppressed' : 'unreadable'] += 1; continue; }
    hashes.push(createHash('sha256').update(email).digest('hex'));
  }
  const unique = [...new Set(hashes)];
  const membersKey = createHash('sha256').update(JSON.stringify([...unique].sort())).digest('hex');
  return { segmentId, memberHashes: unique, membersKey, size: unique.length, excluded };
}
