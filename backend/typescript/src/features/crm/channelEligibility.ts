/**
 * ADR 0955 D2 — the ONE per-channel eligibility check: may this contact be sent this
 * message, on this channel, from this client's sender?
 *
 * It lives in `crm` because crm owns the two records it reads first (the contact and the
 * suppression overlay) and already reads consent. `campaign-journeys` (journey send steps),
 * `email` (the broadcast send, ADR 0905) and ADR 0954's outbound-contact path call it; none
 * of them may compose consent and suppression themselves. A journey cannot own it, because
 * `campaign-journeys` already imports `email`, so `email` calling into journeys would cycle.
 *
 * The reasons are a CLOSED set (D2). This file emits the first seven and, since P4,
 * `deliverability_paused` (the per-sender breaker, `senderHealth.ts`); `quiet_hours` is the
 * send window's answer (P2, `smsSend.ts`) and `frequency_cap` the send nodes'.
 *
 * A read that fails is its own reason (`consent_unreadable`, `suppression_unreadable`):
 * the send is refused, and nobody records an outage as a person's choice (fold-in B5).
 */
import { getContact } from './contactsService.js';
import { normalizeChannelAddress, suppressionCheck } from './suppressionService.js';
import { senderPaused } from './senderHealth.js';
import { isAllowed, type MarketingChannel } from '../consent/consentService.js';

export type EligibilityChannel = 'email' | 'sms';
export type EligibilityPurpose = 'marketing' | 'transactional';

export type ChannelIneligibleReason =
  | 'contact_not_found'
  | 'no_address'
  | 'consent'
  | 'consent_unreadable'
  | 'suppressed'
  | 'suppression_unreadable'
  | 'topic_opt_out'
  | 'quiet_hours'
  | 'frequency_cap'
  | 'deliverability_paused';

export const CHANNEL_INELIGIBLE_REASONS: readonly ChannelIneligibleReason[] = [
  'contact_not_found', 'no_address', 'consent', 'consent_unreadable', 'suppressed',
  'suppression_unreadable', 'topic_opt_out', 'quiet_hours', 'frequency_cap', 'deliverability_paused',
];

export type ChannelEligibility =
  | { eligible: true; channel: EligibilityChannel; address: string; name: string }
  | { eligible: false; channel: EligibilityChannel; reason: ChannelIneligibleReason };

export interface ChannelEligibilityOptions {
  /** Default `'marketing'`. Transactional mail needs no marketing consent and ignores an
   *  unsubscribe, but never a bounce, complaint or manual hold. */
  purpose?: EligibilityPurpose;
  /** ADR 0905 D7 — a subscription topic; an opt-out from it narrows consent. */
  topicId?: string;
  /** The org that owns `topicId` (ADR 0905 topics are per (tenant, org)). Defaults to `orgId`.
   *  Differs only where the sender is the workspace (`orgId:''`) but the topic was named
   *  under an org — a workspace with no clients, whose chains still name their org. */
  topicOrgId?: string;
  /** A contact row the caller already holds (the broadcast's batch), to save a point read.
   *  Used only when it is this tenant's row with this id. */
  contact?: Awaited<ReturnType<typeof getContact>>;
  /** LEGACY ONLY (ADR 0222/0227 `checkEligibility(…, channel)`): ask consent for another
   *  channel than the one sent on. Nothing new may pass it; the D2 verb asks the send channel. */
  legacyConsentChannel?: MarketingChannel;
}

/** The contact's address on a channel: `email` for email, the E.164 phone identifier for SMS. */
function addressFor(contact: { email?: string; phone?: string; identifiers?: Array<{ type: string; value: string }> }, channel: EligibilityChannel): string {
  if (channel === 'email') return contact.email ? normalizeChannelAddress('email', contact.email) : '';
  const raw = contact.phone ?? contact.identifiers?.find((i) => i.type === 'phone')?.value ?? '';
  return raw ? normalizeChannelAddress('sms', raw) : '';
}

/**
 * `orgId` names the client whose sender would send (ADR 0921). `''` means the workspace's
 * own sender, which only tenant-wide suppression rows stop. Callers bind `orgId` to their
 * run or route before calling (the journey surface refuses `wrong_client` first).
 */
export async function checkChannelEligibility(
  tenantId: string,
  orgId: string,
  contactId: string,
  channel: EligibilityChannel,
  opts: ChannelEligibilityOptions = {},
): Promise<ChannelEligibility> {
  const purpose = opts.purpose ?? 'marketing';
  const no = (reason: ChannelIneligibleReason): ChannelEligibility => ({ eligible: false, channel, reason });
  const contact = opts.contact && opts.contact.contactId === contactId && opts.contact.tenantId === tenantId ? opts.contact : await getContact(contactId);
  if (!contact || contact.tenantId !== tenantId) return no('contact_not_found');
  const address = addressFor(contact, channel);
  if (!address) return no('no_address');
  if (purpose === 'marketing') {
    const category = `marketing.${opts.legacyConsentChannel ?? channel}` as const;
    // ADR 0955 Q7 — a CLIENT's text needs that client's own grant (one evaluator decides).
    const client = channel === 'sms' && orgId && !opts.legacyConsentChannel ? { client: { orgId } } : {};
    try {
      if (!(await isAllowed(tenantId, contactId, category, client))) return no('consent');
      // Same evaluator, asked again with the topic, so the refusal names its real cause.
      const topicOrgId = opts.topicOrgId || orgId;
      if (opts.topicId && topicOrgId && !(await isAllowed(tenantId, contactId, category, { ...client, topic: { orgId: topicOrgId, topicId: opts.topicId } }))) {
        return no('topic_opt_out');
      }
    } catch {
      return no('consent_unreadable');
    }
  }
  const suppression = await suppressionCheck(tenantId, { channel, address, ...(orgId ? { senderOrgId: orgId } : {}), purpose });
  if (suppression === 'suppressed') return no('suppressed');
  if (suppression === 'unreadable') return no('suppression_unreadable');
  // ADR 0955 D7 — a sender paused by the deliverability breaker sends no MARKETING email.
  // An unreadable breaker store refuses as an unreadable overlay, never as a claim the sender
  // is paused.
  if (channel === 'email' && purpose === 'marketing' && orgId) {
    const paused = await senderPaused(tenantId, orgId);
    if (paused === 'unreadable') return no('suppression_unreadable');
    if (paused) return no('deliverability_paused');
  }
  return { eligible: true, channel, address, name: contact.name };
}
