/**
 * ADR 0955 D3 (J5) — what a verified inbound SMS keyword does. Registered as the
 * `twilio` inbound observer at crm boot and UNGATED by toggle or plan: an opt-out applies
 * with the feature off (the WhatsApp rule).
 *
 * Consent is one record per subject for the whole workspace, but a workspace is an agency
 * with many clients, each sending from its own number. So (architect P1 review):
 *  - STOP (and UNSUBSCRIBE, CANCEL, END, QUIT) to a client's number ⇒ a suppression row
 *    scoped to THAT client's sender, and THAT client's grant withdrawn (ADR 0955 Q7). No
 *    workspace-level write: `marketing.sms:false` would silence every client of the agency.
 *  - STOPALL ⇒ a tenant-wide SMS suppression row, and `marketing.sms:false` merged on BOTH
 *    subject keys — the number, and every contact the number resolves to — which reconciles
 *    WhatsApp's number-keyed consent with journeys' contact-keyed consent.
 *  - START / UNSTOP ⇒ lifts ONLY that sender's own keyword-written opt-out and records THAT
 *    client's grant (ADR 0955 Q7 — per-client consent; it never writes workspace consent,
 *    which would widen to every client). It never lifts a STOPALL, a complaint or a manual
 *    hold, and records no grant while a workspace-level `false` stands: a person who sent
 *    STOPALL is re-permitted only through a consent-bearing flow, never by one keyword.
 *  - HELP ⇒ nothing written.
 * A number bound to no client (or a `To` that is not E.164) takes the WORKSPACE scope, the
 * conservative reading: the STOP still lands, for every sender.
 *
 * No reply is sent here. Twilio's default opt-out handling answers STOP, START and HELP on
 * long codes and toll-free numbers; a host reply would send the person two (ADR 0955 D3
 * correction). Twilio sends no timestamp, so a captured signed request could be replayed
 * to undo a STOP: every message is applied at most once, by `MessageSid`.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { createLogger } from '../../observability/logger.js';
import { applyKeywordConsent, classifyKeyword, type KeywordKind } from '../consent/keywordLadder.js';
import { getConsent, recordClientChannelConsent } from '../consent/consentService.js';
import { addSuppression, normalizeChannelAddress, removeSuppressionIf } from './suppressionService.js';
import { resolveContactIdByIdentifier } from './contactIdentityService.js';
import { getSmsSender } from './smsSenders.js';

const log = createLogger('features.crm.sms-inbound');

/** The actor a keyword-written suppression row carries; START lifts only these. */
export const SMS_STOP_ACTOR = 'sms:keyword-stop';

interface SeenMessage { key: string; tenantId: string; at: string }
const seen = new DurableCollection<SeenMessage>('crm:sms-inbound-seen', (m) => m.key, undefined, (m) => m.tenantId);

export interface SmsKeywordOutcome { kind: KeywordKind | null; orgId?: string; duplicate?: boolean }

export async function applyInboundSmsKeyword(tenantId: string, body: Record<string, unknown>): Promise<SmsKeywordOutcome> {
  const text = typeof body.Body === 'string' ? body.Body : '';
  const kind = classifyKeyword('sms', text);
  if (!kind) return { kind: null }; // ADR 0954 D7's conversation lane owns everything else
  const number = normalizeChannelAddress('sms', typeof body.From === 'string' ? body.From : '');
  const sid = typeof body.MessageSid === 'string' ? body.MessageSid.trim() : '';
  if (!number || !sid) {
    log.warn('sms_keyword_unusable', { tenantId, kind, hasNumber: !!number, hasSid: !!sid });
    return { kind: null };
  }
  // Claim the message first (two concurrent deliveries of one SID: one applies it), and
  // RELEASE the claim if the writes fail, so a redelivery can still land the STOP.
  const seenKey = `${tenantId}::${sid}`;
  if (!(await seen.putIfAbsent({ key: seenKey, tenantId, at: new Date().toISOString() }))) {
    return { kind, duplicate: true };
  }
  try {
    return await applyClaimed(tenantId, kind, number, typeof body.To === 'string' ? body.To : '');
  } catch (err) {
    await seen.delete(seenKey).catch(() => undefined);
    throw err;
  }
}

async function applyClaimed(tenantId: string, kind: KeywordKind, number: string, to: string): Promise<SmsKeywordOutcome> {
  const binding = await getSmsSender(tenantId, to);
  const orgId = binding?.orgId;
  const scope = orgId ? { channel: 'sms' as const, senderOrgId: orgId } : { channel: 'sms' as const };
  const contactId = await resolveContactIdByIdentifier(tenantId, 'phone', number);
  const subjects = [number, ...(contactId ? [contactId] : [])];
  if (kind === 'opt-out') {
    await addSuppression(tenantId, number, 'unsubscribed', SMS_STOP_ACTOR, orgId ? `stop:${orgId}` : 'stop', scope);
    // ADR 0955 Q7 — a STOP to a client's number withdraws THAT client's grant too.
    if (orgId) await setClientGrant(tenantId, orgId, subjects, false, 'sms:keyword:opt-out');
  } else if (kind === 'opt-out-all') {
    await addSuppression(tenantId, number, 'unsubscribed', SMS_STOP_ACTOR, 'stopall', { channel: 'sms' });
    await applyKeywordConsent(tenantId, 'sms', subjects, false, 'sms:keyword:opt-out-all');
  } else if (kind === 'opt-in') {
    // Only the row a STOP to THIS sender wrote; a STOPALL row's note is 'stopall' and stays.
    await removeSuppressionIf(tenantId, number, scope, (r) => r.reason === 'unsubscribed' && r.actor === SMS_STOP_ACTOR && r.note !== 'stopall');
    // ADR 0955 Q7 — START to a client's number is an explicit opt-in to THAT client (CTIA:
    // it re-subscribes the program the person texted). Never after a STOPALL: a workspace-level
    // `false` on either subject stays until a consent-bearing flow changes it.
    if (orgId && !(await workspaceSmsRefused(tenantId, subjects))) await setClientGrant(tenantId, orgId, subjects, true, 'sms:keyword:opt-in');
  }
  log.info('sms_keyword', { tenantId, kind, scoped: !!orgId });
  await emitHostEvent({ type: `host.sms.consent.${kind}`, tenantId, payload: { channel: 'sms', kind, ...(orgId ? { orgId } : {}) } });
  return { kind, ...(orgId ? { orgId } : {}) };
}

/** A workspace-level `marketing.sms: false` on any subject key of this person (STOPALL). */
async function workspaceSmsRefused(tenantId: string, subjects: readonly string[]): Promise<boolean> {
  for (const k of subjects) if ((await getConsent(tenantId, k))?.categories['marketing.sms'] === false) return true;
  return false;
}

/** Write the client grant on every subject key; an erased subject is skipped (ADR 0657 D10). */
async function setClientGrant(tenantId: string, orgId: string, subjects: readonly string[], granted: boolean, source: string): Promise<void> {
  for (const subjectKey of subjects) {
    try { await recordClientChannelConsent({ tenantId, orgId, subjectKey, channel: 'sms', granted, source }); }
    catch (err) {
      if ((err as { code?: string }).code === 'subject_erased') { log.info('sms_keyword_client_grant_refused_erased', { tenantId }); continue; }
      throw err;
    }
  }
}
