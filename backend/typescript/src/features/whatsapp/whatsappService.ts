/**
 * WhatsApp BSP channel service (ADR 0394 Phase 1 — Twilio BSP).
 *
 * The COMPLIANCE-GATED send owner. Every WhatsApp egress — the pack node, a
 * route, anything — flows through `sendWhatsApp`, because the capability
 * firewall cannot see node calls (the strategy invariant): the gates live
 * HERE, in the service layer, ahead of the broker.
 *
 * Gate ladder (each a typed failure, never success-with-empty):
 *   1. `whatsapp` toggle on for the tenant (fail-closed);
 *   2. number binding exists (`pairConnection` — connection ↔ the tenant's
 *      WhatsApp sender number);
 *   3. consent: `marketing.whatsapp` EXPLICIT opt-in for the recipient
 *      (STRICT_EXPLICIT_OPT_IN — no umbrella fallback; Meta's per-number rule);
 *   4. the 24h customer-service window (hard Meta rule): a free-form SESSION
 *      message only within 24h of the recipient's last inbound; outside the
 *      window only a pre-approved TEMPLATE (ContentSid) may be sent;
 *   5. fork-stable idempotency (the `adsAdapter` precedent): the dispatch key
 *      is tenant+connection+recipient+content — NEVER runId — so a `:fork`
 *      replays the recorded send instead of paying for a second message.
 *
 * Egress rides the EXISTING `twilio` connection (`AccountSid:AuthToken`,
 * basic, apiHosts-pinned) via `brokeredPost` — same credential the SMS
 * adapter brokers; no second Twilio connection identity. The SMS adapter is
 * hardened to REJECT `whatsapp:` recipients so this service is the only path
 * to a WhatsApp send (no gate bypass through `ctx.messaging.sendSms`).
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { brokeredPost, type BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createLogger } from '../../observability/logger.js';
import { getPairing, unpair } from '../connections/messagingOutbound.js';
import { getConnection } from '../connections/connectionsService.js';
import { getInboundConfig } from '../connections/inboundWebhooks.js';
import { configuredInboundIngestUrl } from '../connections/oauthFlow.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { getConsent, isErasureTombstoned, isPermittedForPurpose } from '../consent/consentService.js';

const log = createLogger('features.whatsapp');

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Boot-bound storage for the workflow-surface path (`registerRoutes` binds it;
 *  the same lifecycle as `initHostExtPersistence`). Route callers pass their
 *  own `RouteDeps.storage` instead. */
let boundStorage: import('../../storage/storage.js').Storage | null = null;
export function bindWhatsAppStorage(storage: import('../../storage/storage.js').Storage): void {
  boundStorage = storage;
}
export function getBoundWhatsAppStorage(): import('../../storage/storage.js').Storage | null {
  return boundStorage;
}

/** E.164 (with or without the `whatsapp:` scheme Twilio uses). */
const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Normalize a recipient to bare E.164 (strips the `whatsapp:` scheme; accepts
 *  Meta Cloud's plus-less digits by restoring the `+`). */
export function normalizeWaNumber(raw: string): string | null {
  let bare = raw.startsWith('whatsapp:') ? raw.slice('whatsapp:'.length) : raw;
  if (/^[1-9]\d{6,14}$/.test(bare)) bare = `+${bare}`; // Meta Cloud `from` carries no '+'
  return E164_RE.test(bare) ? bare : null;
}

/** One inbound message, normalized. `id` is the provider message id (Twilio
 *  `MessageSid`, Meta `messages[].id`); `at` is the provider's own time when it
 *  sends one (Meta `timestamp`, Unix seconds), never for Twilio. */
export interface WaInboundMessage { from: string; text: string; id: string | null; at: Date | null }

/** Normalize either BSP's inbound envelope to messages — Twilio's flat
 *  form fields (always one) or EVERY message in a Meta Cloud batched delivery
 *  (GRADE-CODE 2026-07-17: reading only `messages[0]` dropped a STOP arriving
 *  as message 2+ — a compliance-relevant miss). Empty for status-only callbacks. */
export function extractWaInbound(body: Record<string, unknown>): WaInboundMessage[] {
  if (typeof body.From === 'string' && typeof body.Body === 'string') {
    return [{ from: body.From, text: body.Body, id: typeof body.MessageSid === 'string' && body.MessageSid ? body.MessageSid : null, at: null }];
  }
  const out: WaInboundMessage[] = [];
  for (const value of cloudValues(body)) {
    const messages = Array.isArray(value.messages) ? (value.messages as Record<string, unknown>[]) : [];
    for (const m of messages) {
      if (typeof m.from === 'string') {
        const text = (m.text as Record<string, unknown> | undefined)?.body;
        const secs = typeof m.timestamp === 'string' || typeof m.timestamp === 'number' ? Number(m.timestamp) : NaN;
        out.push({
          from: m.from,
          text: typeof text === 'string' ? text : '',
          id: typeof m.id === 'string' && m.id ? m.id : null,
          at: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : null,
        });
      }
    }
  }
  return out;
}

/** The `entry[].changes[].value` objects of a Meta Cloud delivery. */
function cloudValues(body: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const entry = Array.isArray(body.entry) ? (body.entry as Record<string, unknown>[]) : [];
  for (const e of entry) {
    const changes = Array.isArray(e.changes) ? (e.changes as Record<string, unknown>[]) : [];
    for (const c of changes) out.push((c.value ?? {}) as Record<string, unknown>);
  }
  return out;
}

/** Per-recipient conversation state — the 24h-window basis. Written on every
 *  verified inbound message; read pre-send. Point lookups only. */
export interface WaConversation { id: string; tenantId: string; connectionId: string; recipient: string; lastInboundAt: string }
const conversations = new DurableCollection<WaConversation>(
  'whatsapp:conversation',
  (c) => c.id,
  undefined,
  (c) => c.tenantId,
);
const convKey = (tenantId: string, connectionId: string, recipient: string): string => `${tenantId}:${connectionId}:${recipient}`;

/** ADR 1053 D6 — open/renew the window. The write never moves `lastInboundAt`
 *  backwards (a late or older delivery cannot shorten, or re-date, the window). */
export async function recordInboundMessage(tenantId: string, connectionId: string, from: string, at: Date): Promise<void> {
  const recipient = normalizeWaNumber(from);
  if (!recipient) return;
  const id = convKey(tenantId, connectionId, recipient);
  const next: WaConversation = { id, tenantId, connectionId, recipient, lastInboundAt: at.toISOString() };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const prior = await conversations.get(id);
    if (prior && Date.parse(prior.lastInboundAt) >= at.getTime()) return;
    if (await conversations.compareAndSwap(prior, next)) return;
  }
  throw new Error('whatsapp window write lost five races');
}

export async function getConversation(tenantId: string, connectionId: string, recipient: string): Promise<WaConversation | null> {
  return conversations.get(convKey(tenantId, connectionId, recipient));
}

/**
 * GRADE-DATA 2026-07-17 — GDPR subject erasure (ADR 0381 seam): a WhatsApp
 * subjectKey IS the E.164 phone number, so erasing the subject must also purge
 * the conversation-window rows and the dispatch-ledger rows that carry it.
 * Tenant-scoped list + filter (cold path, erasure only).
 *
 * ADR 1053 D8 — the dispatch ledger is read through its TENANT INDEX. Its ids are
 * bare hashes, so the `${tenantId}:` prefix scan this used before matched no
 * dispatch row ever: erasure left every number it had sent to.
 */
export async function eraseWhatsAppSubject(tenantId: string, subjectKey: string): Promise<void> {
  const recipient = normalizeWaNumber(subjectKey);
  if (!recipient) return; // not a phone-number subject — nothing here matches
  for (const c of await conversations.listForTenant(tenantId)) {
    if (c.recipient === recipient) await conversations.delete(c.id);
  }
  for (const d of await dispatched.listForTenantIndexed(tenantId)) {
    if (d.recipient !== recipient) continue;
    await dispatched.delete(d.idemKey);
    if (d.providerSid) {
      await sidIndex.delete(providerIdKey(tenantId, d.connectionId, d.providerSid));
      await parked.delete(providerIdKey(tenantId, d.connectionId, d.providerSid));
      await failures.delete(failureKey(tenantId, d.providerSid));
    }
  }
}

/**
 * GRADE-DATA 2026-07-17 — connection-revoke cleanup: drop the number binding
 * and this connection's conversation windows so a revoked channel neither
 * reports "bound" to the health read nor keeps dead per-recipient state.
 * (Dispatch-ledger rows stay — they are the paid-send idempotency record.)
 */
export async function cleanupWhatsAppConnection(tenantId: string, connectionId: string): Promise<void> {
  await unpair(connectionId);
  for (const c of await conversations.listForTenant(tenantId)) {
    if (c.connectionId === connectionId) await conversations.delete(c.id);
  }
}

/** What the provider has told us about a message (ADR 1053 D3). Written ONLY
 *  from a verified callback; `accepted` is what the send itself knows. */
export type WaDeliveryStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered';

/** Fork-stable dispatch ledger (the `ads:dispatch` shape): a duplicate send —
 *  a retry, a `:fork`, a re-run — returns the RECORDED result, never a second
 *  paid message. ADR 1053 D1: the row is CLAIMED (`pending`) before the
 *  provider call, so two concurrent sends cannot both pay. */
export interface WaDispatchRecord {
  idemKey: string;
  tenantId: string;
  connectionId: string;
  recipient: string;
  kind: 'session' | 'template';
  /** ADR 1053 D1. Absent on rows written before it: those were all accepted. */
  state?: 'pending' | 'accepted' | 'unknown';
  claimedAt?: string;
  providerSid: string | null;
  /** When the BSP accepted it (absent while pending / unknown). */
  sentAt?: string;
  deliveryStatus?: WaDeliveryStatus;
  deliveryErrorCode?: string | null;
  deliveryUpdatedAt?: string;
}
const dispatched = new DurableCollection<WaDispatchRecord>(
  'whatsapp:dispatch',
  (r) => r.idemKey,
  undefined,
  (r) => r.tenantId,
);

/** provider message id → dispatch key, inside one tenant. It records the SENDING
 *  connection: a status callback moves the row only when it arrives on that one. */
interface WaSidIndex { id: string; tenantId: string; connectionId: string; idemKey: string; at: string }
const sidIndex = new DurableCollection<WaSidIndex>('whatsapp:dispatch-sid', (r) => r.id);
// `idemKey` is sha256 over the recipient, content and day: a pseudonymous link to a
// number. Declared, and deleted with its dispatch row by eraseWhatsAppSubject.
declarePiiFields('whatsapp:dispatch-sid', ['idemKey'], { maskGloballyByFieldName: false });
/**
 * ADR 1053 D3/D4 (correction) — the ONE key for a provider message id in the
 * sid-index, parked-status and inbound-claim stores: sha256(tenant \0 connection
 * \0 id). A raw id is not safe to keep there: Meta Cloud's `wamid.…` is widely
 * reported to be base64 that encodes the counterpart's phone number (unverified
 * here), so a raw-id key would hold a number in a store the census treats as
 * signal-free. Writer, callback lookup and eraser all call this, so they agree.
 */
export function providerIdKey(tenantId: string, connectionId: string, providerId: string): string {
  return createHash('sha256').update([tenantId, connectionId, providerId].join('\u0000')).digest('hex');
}
/** The failures view is a declared PII store listed per tenant, so it keeps a tenant-prefixed id. */
const failureKey = (tenantId: string, sid: string): string => `${tenantId}:${sid}`;

/** A status that arrived before its send recorded the provider id (ADR 1053 D3:
 *  Twilio can post `sent` before the send's own write lands). */
interface WaParkedStatus { id: string; tenantId: string; status: WaDeliveryStatus; errorCode: string | null; at: string }
const parked = new DurableCollection<WaParkedStatus>('whatsapp:status-parked', (r) => r.id);

/** ADR 1053 D10 — the admin's recent-failures view. Written with the failed
 *  transition; holds the LAST FOUR digits only, never the number or the text. */
export interface WaDeliveryFailure {
  id: string; tenantId: string; connectionId: string; providerSid: string;
  status: 'failed' | 'undelivered'; errorCode: string | null; kind: 'session' | 'template'; recipientLast4: string; at: string;
}
const failures = new DurableCollection<WaDeliveryFailure>('whatsapp:delivery-failure', (r) => r.id);
// The failures view keeps the provider id and the LAST FOUR digits of the number:
// subject data, erased with the dispatch row it came from (eraseWhatsAppSubject).
declarePiiFields('whatsapp:delivery-failure', ['providerSid', 'recipientLast4'], { maskGloballyByFieldName: false });

/** ADR 1053 D4 — one claim per inbound provider message id (no number, no text).
 *  `pending` until both side effects landed, then `done`. */
interface WaInboundSeen { id: string; tenantId: string; at: string; state?: 'pending' | 'done' }
const inboundSeen = new DurableCollection<WaInboundSeen>('whatsapp:inbound-seen', (r) => r.id);

// ADR 1053 D8 — retention. The window matters for 24h; a month covers a support
// thread's lookback. The dispatch ledger and its index keep a year of delivery
// evidence plus a month; the inbound claims the same, which bounds how long a
// captured Twilio delivery (no timestamp) stays un-replayable — stated residual.
registerKvAgeOut({ id: 'whatsapp:conversation', prefix: 'hostext:whatsapp:conversation:', ttlDays: 30, timestampField: 'lastInboundAt', acceptIndexed: true });
registerKvAgeOut({
  id: 'whatsapp:dispatch', prefix: 'hostext:whatsapp:dispatch:', ttlDays: 400, timestampField: 'claimedAt', acceptIndexed: true,
  // Rows written before ADR 1053 carry `sentAt` (the exact instant they were accepted) and no claim time.
  deriveTimestamp: (row) => (typeof row.sentAt === 'string' ? row.sentAt : undefined),
});
registerKvAgeOut({ id: 'whatsapp:dispatch-sid', prefix: 'hostext:whatsapp:dispatch-sid:', ttlDays: 400, timestampField: 'at' });
registerKvAgeOut({ id: 'whatsapp:status-parked', prefix: 'hostext:whatsapp:status-parked:', ttlDays: 1, timestampField: 'at' });
registerKvAgeOut({ id: 'whatsapp:delivery-failure', prefix: 'hostext:whatsapp:delivery-failure:', ttlDays: 30, timestampField: 'at' });
registerKvAgeOut({ id: 'whatsapp:inbound-seen', prefix: 'hostext:whatsapp:inbound-seen:', ttlDays: 400, timestampField: 'at' });

/** A `pending` claim older than this is reported `send_outcome_unknown`, never re-sent. */
const STALE_PENDING_MS = 10 * 60 * 1000;

export interface WaSendArgs {
  connectionId: string;
  to: string;
  /** Free-form session message body (within the 24h window only). */
  body?: string | undefined;
  /** Pre-approved template — Twilio ContentSid, or the Meta template NAME on
   *  the whatsapp-cloud transport. The only send allowed outside the window. */
  templateId?: string | undefined;
  templateVariables?: Record<string, string> | undefined;
  /** Meta Cloud template language (default `en`); ignored on Twilio. */
  languageCode?: string | undefined;
  /** ADR 0878 D3 — a caller-owned idempotency key that REPLACES the content term
   *  of the dispatch key. The service desk passes its message id: two identical
   *  replies on one day are two sends, a retry of one reply is still one. Absent
   *  (every other caller) ⇒ the content-keyed default, unchanged. Never reachable
   *  from the generic `whatsapp.send` node (the surface does not forward it). */
  idempotencyKey?: string | undefined;
}

/** `sent: true` means the BSP ACCEPTED the message, nothing more (ADR 1053 D3):
 *  `deliveryStatus` says what is known, and only a provider callback moves it. */
export type WaSendResult =
  | { sent: true; providerSid: string | null; kind: 'session' | 'template'; deduped: boolean; deliveryStatus: WaDeliveryStatus }
  | { sent: false; error: WaSendError; message: string; detail?: Record<string, unknown> };
export type WaSendError =
  | 'feature_disabled' | 'validation_error' | 'no_binding' | 'consent_denied' | 'opted_out' | 'subject_erased'
  | 'outside_window' | 'wa_not_connected' | 'wa_request_failed' | 'wa_rejected'
  /** ADR 1053 D1 — another call holds the claim for this exact message. */
  | 'send_in_flight'
  /** ADR 1053 D1 — an earlier attempt may have reached WhatsApp; it is not re-sent. */
  | 'send_outcome_unknown';

/** Fork-stable idempotency key — tenant+connection+recipient+content+UTC-DAY,
 *  NEVER runId (the adsAdapter rule: a fork must reuse the recorded send).
 *  GRADE-CODE 2026-07-17: the day component bounds the dedup window — without
 *  it an identical legitimate re-send (a monthly "payment due" template) was
 *  deduped FOREVER and reported `sent:true` for a message never delivered.
 *  Same-day retries/forks still dedupe (the paid-double-send hazard). */
function idemKeyFor(tenantId: string, args: { connectionId: string; recipient: string; kind: string; content: string }): string {
  return createHash('sha256')
    .update([tenantId, args.connectionId, args.recipient, args.kind, args.content, todayUtc()].join('\u0000'))
    .digest('hex');
}

/** UTC calendar day — the dedup window basis (mirrors byokChatBudget). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function twilioBase(): string {
  return (process.env.OPENWOP_TWILIO_API_BASE ?? 'https://api.twilio.com').replace(/\/+$/, '');
}

function metaGraphBase(): string {
  return (process.env.OPENWOP_META_GRAPH_BASE ?? 'https://graph.facebook.com/v20.0').replace(/\/+$/, '');
}

/** Every send but one: the strict explicit-opt-in lane (ADR 0394). */
export async function sendWhatsApp(deps: BrokeredEgressDeps, args: WaSendArgs): Promise<WaSendResult> {
  return sendOnLane(deps, args, 'strict');
}

/**
 * ADR 0878 OQ-1 (decided by the user 2026-10-12, Option B) — the narrow SUPPORT-REPLY
 * lane. Meta lets a business answer a customer who wrote to it, with a free-form
 * session message, inside 24h of that customer's last message, without a marketing
 * opt-in; the strict lane required one for every send, so nearly every reply to a
 * support ticket failed `consent_denied`. This lane, and only this lane, differs:
 *  - a SESSION message only: no `templateId` field exists on this signature, and a
 *    template is refused at runtime too (never a business-initiated send);
 *  - inside the 24h window of the customer's LAST inbound, read from the window
 *    ledger the verified inbound observer writes (a server-recorded timestamp, never
 *    a caller's) for THIS connection + number — the same gate as the strict lane;
 *  - REFUSED on an explicit opt-out (`marketing.whatsapp: false` — a STOP — or a full
 *    marketing opt-out) and on an erasure tombstone. Only an ABSENT opt-in is waived.
 * Exactly ONE caller: the service desk's reply delivery, which passes the ticket's own
 * captured sender on the ticket's own connection. `adr0878-wa-service-reply-ratchet`
 * pins that set; the whatsapp surface, the node pack, chat tools and MCP never see it.
 */
export async function sendTicketReplyWhatsApp(
  deps: BrokeredEgressDeps,
  args: { connectionId: string; to: string; body: string; idempotencyKey: string },
): Promise<WaSendResult> {
  if ((args as { templateId?: unknown }).templateId !== undefined) {
    return { sent: false, error: 'validation_error', message: 'A support reply is a session message; a template is not allowed on this lane.' };
  }
  return sendOnLane(deps, { connectionId: args.connectionId, to: args.to, body: args.body, idempotencyKey: args.idempotencyKey }, 'service-reply');
}

async function sendOnLane(deps: BrokeredEgressDeps, args: WaSendArgs, lane: 'strict' | 'service-reply'): Promise<WaSendResult> {
  // 1. Toggle honesty — per-tenant, dynamic, fail-closed.
  const assignment = await resolveOne('whatsapp', { tenantId: deps.tenantId }).catch(() => null);
  if (!assignment?.enabled) {
    return { sent: false, error: 'feature_disabled', message: 'The WhatsApp channel is not enabled for this workspace.' };
  }

  const recipient = args.to ? normalizeWaNumber(args.to) : null;
  if (!recipient) return { sent: false, error: 'validation_error', message: '`to` must be an E.164 phone number (e.g. +15551234567).' };
  const isTemplate = typeof args.templateId === 'string' && args.templateId.length > 0;
  if (!isTemplate && (typeof args.body !== 'string' || args.body.trim().length === 0)) {
    return { sent: false, error: 'validation_error', message: 'Provide `body` (session message) or `templateId` (pre-approved template).' };
  }

  // 2. Number binding (admin-established; the send inherits WHERE it may go).
  //    The connection must belong to THIS tenant first — the pairing store is
  //    keyed by connectionId alone, so without this check a caller could send
  //    through another tenant's bound sender number (IDOR).
  if (!(await getConnection(deps.tenantId, args.connectionId))) {
    return { sent: false, error: 'no_binding', message: 'This connection does not exist in this workspace.' };
  }
  //    whatsapp-twilio pairs the E.164 sender number; whatsapp-cloud pairs the
  //    Meta phone-number-id (a numeric Graph id, not E.164).
  const pairing = await getPairing(args.connectionId);
  if (!pairing || (pairing.provider !== 'whatsapp-twilio' && pairing.provider !== 'whatsapp-cloud')) {
    return { sent: false, error: 'no_binding', message: 'This connection has no WhatsApp number binding — an admin must pair the sender number first.' };
  }
  const transport = pairing.provider;
  const sender = transport === 'whatsapp-twilio' ? normalizeWaNumber(pairing.channelId) : (/^\d{5,20}$/.test(pairing.channelId) ? pairing.channelId : null);
  if (!sender) {
    return { sent: false, error: 'no_binding', message: transport === 'whatsapp-twilio' ? 'The bound sender number is not a valid E.164 number — re-pair the connection.' : 'The bound sender is not a valid Meta phone-number id — re-pair the connection.' };
  }

  // 3. Consent — STRICT explicit per-number opt-in (Meta's rule; no umbrella).
  //    The support-reply lane waives only an ABSENT opt-in; an explicit opt-out or an
  //    erasure still refuses (ADR 0878 OQ-1).
  if (lane === 'strict') {
    if (!(await isPermittedForPurpose(deps.tenantId, recipient, 'marketing-whatsapp'))) {
      return { sent: false, error: 'consent_denied', message: 'The recipient has not explicitly opted in to WhatsApp messages (or has opted out).' };
    }
  } else {
    if (isTemplate) {
      return { sent: false, error: 'validation_error', message: 'A support reply is a session message; a template is not allowed on this lane.' };
    }
    if (await isErasureTombstoned(deps.tenantId, recipient)) {
      return { sent: false, error: 'subject_erased', message: 'This customer\'s data was erased; nothing can be sent to them.' };
    }
    const c = (await getConsent(deps.tenantId, recipient))?.categories;
    if (c && (c['marketing.whatsapp'] === false || (c['marketing.whatsapp'] === undefined && c.marketing === false))) {
      return { sent: false, error: 'opted_out', message: 'The customer opted out of WhatsApp messages (STOP).' };
    }
  }

  // 4. The 24h window (hard Meta rule) — session messages only while open.
  if (!isTemplate) {
    const conv = await getConversation(deps.tenantId, args.connectionId, recipient);
    const openUntil = conv ? Date.parse(conv.lastInboundAt) + SESSION_WINDOW_MS : 0;
    if (!conv || !(Date.now() < openUntil)) {
      return {
        sent: false,
        error: 'outside_window',
        message: 'The 24h customer-service window is closed for this recipient — only a pre-approved template message may be sent.',
        detail: { lastInboundAt: conv?.lastInboundAt ?? null },
      };
    }
  }

  // 5. Fork-stable idempotency — the recorded send wins over a re-execution.
  //    ADR 1053 D1: CLAIM the dispatch key before the provider call, so two
  //    concurrent sends of the same message cannot both pay.
  // A template's language is part of the message: `order_update` in en and in pt_BR are two sends.
  const content = isTemplate ? `${args.templateId}:${args.languageCode ?? ''}:${JSON.stringify(args.templateVariables ?? {})}` : args.body!.trim();
  const kind: 'session' | 'template' = isTemplate ? 'template' : 'session';
  const idemKey = idemKeyFor(deps.tenantId, { connectionId: args.connectionId, recipient, kind, content: args.idempotencyKey ? `idem:${args.idempotencyKey}` : content });
  const claim: WaDispatchRecord = { idemKey, tenantId: deps.tenantId, connectionId: args.connectionId, recipient, kind, state: 'pending', claimedAt: new Date().toISOString(), providerSid: null };
  if (!(await dispatched.compareAndSwap(null, claim))) {
    const prior = await dispatched.get(idemKey);
    return priorOutcome(prior);
  }
  // From here the claim is ours. Release it only when nothing can have reached
  // the BSP; keep it as `unknown` when something may have.
  const release = async (): Promise<void> => { await dispatched.compareAndDelete(claim).catch(() => false); };
  const markUnknown = async (): Promise<void> => {
    await dispatched.compareAndSwap(claim, { ...claim, state: 'unknown' }).catch(() => false);
  };
  const ambiguous = (message: string, detail: Record<string, unknown> = {}): WaSendResult =>
    ({ sent: false, error: 'wa_request_failed', message: `${message} WhatsApp may have accepted it, so it will not be re-sent automatically.`, detail: { ...detail, outcomeUnknown: true } });

  // ADR 1053 D2 — the credential is the BOUND connection's, through the pinned
  // lane (owner-only user rows, `connections:use` org rows, any run for a
  // workspace row). The Twilio transport rides a `twilio` connection.
  const pin = { connectionId: args.connectionId };
  let providerSid: string | null = null;
  let providerStatus: string | null = null;
  try {
    if (transport === 'whatsapp-twilio') {
      const statusCallback = await statusCallbackFor(deps.tenantId, args.connectionId);
      const form = new URLSearchParams({
        To: `whatsapp:${recipient}`,
        From: `whatsapp:${sender}`,
        ...(isTemplate
          ? { ContentSid: args.templateId!, ...(args.templateVariables ? { ContentVariables: JSON.stringify(args.templateVariables) } : {}) }
          : { Body: args.body!.trim() }),
        ...(statusCallback ? { StatusCallback: statusCallback } : {}),
      }).toString();
      const r = await brokeredPost(deps, {
        provider: 'twilio',
        ...pin,
        // Twilio's path embeds the AccountSid (the public half of the secret) —
        // the smsAdapter convention.
        url: (secret) => `${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(secret.split(':')[0]!)}/Messages.json`,
        body: form,
        contentType: 'application/x-www-form-urlencoded',
        authScheme: 'basic',
      });
      if (r.outcome === 'no_connection') { await release(); return notConnected('Twilio'); }
      if (r.outcome === 'insecure_base') { await release(); return { sent: false, error: 'wa_request_failed', message: 'The Twilio endpoint is not https.' }; }
      if (r.outcome === 'request_failed') {
        if (r.connectFailed) { await release(); return { sent: false, error: 'wa_request_failed', message: 'Twilio was not reachable.' }; }
        await markUnknown();
        return ambiguous(r.timedOut ? 'Twilio did not answer in time.' : 'The connection to Twilio failed mid-request.');
      }
      let json: { sid?: string; status?: string; message?: string; code?: number };
      try { json = (await r.res.json()) as typeof json; } catch { json = {}; }
      const status = r.res.status;
      if (status >= 400 && status < 500) {
        // A definite refusal: nothing was accepted. Provider rejection surfaces status + message — never the token.
        await release();
        return { sent: false, error: 'wa_rejected', message: `Twilio rejected the message (${status}).`, detail: { providerMessage: json.message ?? null, providerCode: json.code ?? null } };
      }
      if (!(status >= 200 && status < 300) || !json.sid) {
        await markUnknown();
        return ambiguous(`Twilio answered ${status}${json.sid ? '' : ' with no message id'}.`, { providerStatus: status });
      }
      providerSid = json.sid;
      providerStatus = json.status ?? null;
    } else {
      // Meta Cloud API direct (ADR 0394 Phase 4): JSON to
      // graph.facebook.com/<version>/<phone-number-id>/messages, bearer WABA token.
      // Status updates arrive on the app's webhook without a per-message URL.
      const payload = isTemplate
        ? {
            messaging_product: 'whatsapp', to: recipient, type: 'template',
            template: {
              name: args.templateId!,
              language: { code: args.languageCode ?? 'en' },
              ...(args.templateVariables
                ? { components: [{ type: 'body', parameters: Object.values(args.templateVariables).map((v) => ({ type: 'text', text: v })) }] }
                : {}),
            },
          }
        : { messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body: args.body!.trim() } };
      const r = await brokeredPost(deps, {
        provider: 'whatsapp-cloud',
        ...pin,
        url: `${metaGraphBase()}/${encodeURIComponent(sender)}/messages`,
        body: JSON.stringify(payload),
        contentType: 'application/json',
        authScheme: 'bearer',
      });
      if (r.outcome === 'no_connection') { await release(); return notConnected('WhatsApp Cloud API'); }
      if (r.outcome === 'insecure_base') { await release(); return { sent: false, error: 'wa_request_failed', message: 'The WhatsApp Cloud API endpoint is not https.' }; }
      if (r.outcome === 'request_failed') {
        if (r.connectFailed) { await release(); return { sent: false, error: 'wa_request_failed', message: 'The WhatsApp Cloud API was not reachable.' }; }
        await markUnknown();
        return ambiguous(r.timedOut ? 'The WhatsApp Cloud API did not answer in time.' : 'The connection to the WhatsApp Cloud API failed mid-request.');
      }
      let json: { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
      try { json = (await r.res.json()) as typeof json; } catch { json = {}; }
      const id = json.messages?.[0]?.id;
      const status = r.res.status;
      if (status >= 400 && status < 500) {
        await release();
        return { sent: false, error: 'wa_rejected', message: `The WhatsApp Cloud API rejected the message (${status}).`, detail: { providerMessage: json.error?.message ?? null, providerCode: json.error?.code ?? null } };
      }
      if (!(status >= 200 && status < 300) || !id) {
        await markUnknown();
        return ambiguous(`The WhatsApp Cloud API answered ${status}${id ? '' : ' with no message id'}.`, { providerStatus: status });
      }
      providerSid = id;
      providerStatus = 'accepted';
    }
  } catch (err) {
    // Thrown before any dial (the tenant egress firewall, a credential read): nothing was sent.
    await release();
    throw err;
  }

  // Record the acceptance on the exact claim. If the claim is gone, the number was
  // erased meanwhile (DSAR): do not write it back (ADR 1053 D1 / architect M5).
  const now = new Date().toISOString();
  const accepted: WaDispatchRecord = { ...claim, state: 'accepted', providerSid, sentAt: now, deliveryStatus: 'accepted', deliveryErrorCode: null, deliveryUpdatedAt: now };
  let deliveryStatus: WaDeliveryStatus = 'accepted';
  if (await dispatched.compareAndSwap(claim, accepted)) {
    if (providerSid) {
      await sidIndex.put({ id: providerIdKey(deps.tenantId, args.connectionId, providerSid), tenantId: deps.tenantId, connectionId: args.connectionId, idemKey, at: now });
      // A status that arrived before the index existed was parked; merge it now,
      // through the same path a live callback takes (CAS, monotonic, the event).
      const early = await parked.get(providerIdKey(deps.tenantId, args.connectionId, providerSid));
      if (early) {
        deliveryStatus = (await recordDeliveryStatus(deps.tenantId, args.connectionId, { sid: providerSid, status: early.status, errorCode: early.errorCode })) ?? deliveryStatus;
        await parked.compareAndDelete(early).catch(() => false);
      }
    }
  } else {
    log.info('whatsapp_send_claim_gone', { tenantId: deps.tenantId, connectionId: args.connectionId });
  }
  // One structured line per vendor write — counts + kind, never content/PII body.
  log.info('whatsapp_send', { tenantId: deps.tenantId, connectionId: args.connectionId, transport, kind, deduped: false, providerStatus });
  return { sent: true, providerSid, kind, deduped: false, deliveryStatus };
}

function notConnected(provider: string): WaSendResult {
  return {
    sent: false,
    error: 'wa_not_connected',
    message: `The ${provider} connection bound to this WhatsApp number is missing, inactive, or not yours to use (a personal connection sends only for its owner; a shared one needs the connections:use permission).`,
  };
}

/** The answer for a send that lost its claim to an earlier or concurrent one. */
function priorOutcome(prior: WaDispatchRecord | null): WaSendResult {
  if (!prior) {
    // The claim vanished between our CAS and this read (released by a failing
    // attempt, or erased). Treat it as in flight; the caller may retry.
    return { sent: false, error: 'send_in_flight', message: 'Another attempt to send this exact message just finished or is in progress. Try again in a moment.' };
  }
  const state = prior.state ?? 'accepted';
  if (state === 'accepted') {
    return { sent: true, providerSid: prior.providerSid, kind: prior.kind, deduped: true, deliveryStatus: prior.deliveryStatus ?? 'accepted' };
  }
  if (state === 'pending' && Date.now() - Date.parse(prior.claimedAt ?? '') < STALE_PENDING_MS) {
    return { sent: false, error: 'send_in_flight', message: 'This exact message is being sent right now by another step.' };
  }
  return {
    sent: false,
    error: 'send_outcome_unknown',
    message: 'An earlier attempt to send this exact message may have reached WhatsApp, so it is not sent again today. Check the conversation before sending it by hand.',
  };
}

/** ADR 1053 D3 — ask Twilio for status callbacks only where they will verify:
 *  the connection has an ENABLED whatsapp-twilio inbound config (same token) and
 *  the host has a CONFIGURED public base (never a request origin). */
async function statusCallbackFor(tenantId: string, connectionId: string): Promise<string | undefined> {
  const config = await getInboundConfig(tenantId, connectionId);
  if (!config || !config.enabled || config.provider !== 'whatsapp-twilio') return undefined;
  return configuredInboundIngestUrl(connectionId);
}

// ── ADR 1053 D3 — delivery status, from verified provider callbacks only ──────

const RANK: Record<WaDeliveryStatus, number> = { accepted: 0, sent: 1, failed: 2, undelivered: 2, delivered: 3, read: 4 };

/** Monotonic merge: `read` > `delivered` > `failed`/`undelivered` > `sent` > `accepted`.
 *  A failure never undoes a delivery; a replayed or late callback never moves a row
 *  backwards. Returns null when the row should not change. */
function applyStatus(row: WaDispatchRecord, status: WaDeliveryStatus, errorCode: string | null, at: string): WaDispatchRecord | null {
  const current = row.deliveryStatus ?? 'accepted';
  if (RANK[status] <= RANK[current]) return null;
  return { ...row, deliveryStatus: status, deliveryErrorCode: status === 'failed' || status === 'undelivered' ? errorCode : null, deliveryUpdatedAt: at };
}

const TWILIO_STATUS: Readonly<Record<string, WaDeliveryStatus>> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'undelivered' };
const META_STATUS: Readonly<Record<string, WaDeliveryStatus>> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

/** The status updates in a verified provider body, over a CLOSED vocabulary
 *  (`queued`, `sending`, `accepted`, `canceled` and any unknown word are ignored).
 *  Meta's `recipient_id` is never read. */
export function extractWaStatuses(body: Record<string, unknown>): Array<{ sid: string; status: WaDeliveryStatus; errorCode: string | null }> {
  if (typeof body.MessageStatus === 'string' && typeof body.MessageSid === 'string') {
    const status = TWILIO_STATUS[body.MessageStatus.toLowerCase()];
    if (!status || !body.MessageSid) return [];
    const code = typeof body.ErrorCode === 'string' && body.ErrorCode ? body.ErrorCode : null;
    return [{ sid: body.MessageSid, status, errorCode: code }];
  }
  const out: Array<{ sid: string; status: WaDeliveryStatus; errorCode: string | null }> = [];
  for (const value of cloudValues(body)) {
    const statuses = Array.isArray(value.statuses) ? (value.statuses as Record<string, unknown>[]) : [];
    for (const st of statuses) {
      const status = typeof st.status === 'string' ? META_STATUS[st.status.toLowerCase()] : undefined;
      if (!status || typeof st.id !== 'string' || !st.id) continue;
      const err = Array.isArray(st.errors) ? (st.errors[0] as { code?: unknown } | undefined) : undefined;
      out.push({ sid: st.id, status, errorCode: err && (typeof err.code === 'number' || typeof err.code === 'string') ? String(err.code) : null });
    }
  }
  return out;
}

/** Apply one verified status update for a message sent on `connectionId`. A
 *  status for an id this connection has not recorded yet is PARKED (1 day) and
 *  merged when the send records it; a status for another connection's message
 *  never matches (the index is keyed by the sending connection). Returns the
 *  new status when the row moved. */
export async function recordDeliveryStatus(
  tenantId: string, connectionId: string, update: { sid: string; status: WaDeliveryStatus; errorCode: string | null },
): Promise<WaDeliveryStatus | null> {
  const at = new Date().toISOString();
  // Keyed per connection: a callback on another connection misses this row and parks under its own key.
  const ref = await sidIndex.get(providerIdKey(tenantId, connectionId, update.sid));
  if (!ref) {
    if (parkRaceHook) await parkRaceHook();
    const key = providerIdKey(tenantId, connectionId, update.sid);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const prior = await parked.get(key);
      if (prior && RANK[update.status] <= RANK[prior.status]) return null;
      const mine: WaParkedStatus = { id: key, tenantId, status: update.status, errorCode: update.errorCode, at };
      if (await parked.compareAndSwap(prior, mine)) {
        // grade-code WA85CD-11 — the send may have written the index and checked
        // the parked row between our index read and this write. Look once more: if
        // the index exists now, merge here and drop the parked row.
        const late = await sidIndex.get(providerIdKey(tenantId, connectionId, update.sid));
        if (!late) return null;
        await parked.compareAndDelete(mine).catch(() => false);
        return recordDeliveryStatus(tenantId, connectionId, update);
      }
    }
    return null;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await dispatched.get(ref.idemKey);
    // Another connection's message is never moved from here (its inbound signer is not this one's).
    if (!row || row.tenantId !== tenantId || row.connectionId !== connectionId || row.providerSid !== update.sid) return null;
    const next = applyStatus(row, update.status, update.errorCode, at);
    if (!next) return null;
    if (await dispatched.compareAndSwap(row, next)) {
      if ((row.deliveryStatus === 'failed' || row.deliveryStatus === 'undelivered') && (next.deliveryStatus === 'delivered' || next.deliveryStatus === 'read')) {
        // grade-code WA85CD-12 — a later delivery supersedes the failure: the admin's
        // failures view must never list a message that arrived.
        await failures.delete(failureKey(tenantId, update.sid));
      }
      if (next.deliveryStatus === 'failed' || next.deliveryStatus === 'undelivered') {
        log.info('whatsapp_delivery_failed', { tenantId, connectionId, errorCode: next.deliveryErrorCode ?? null });
        await failures.put({
          id: failureKey(tenantId, update.sid), tenantId, connectionId, providerSid: update.sid, status: next.deliveryStatus,
          errorCode: next.deliveryErrorCode ?? null, kind: row.kind, recipientLast4: row.recipient.slice(-4), at,
        });
        await emitHostEvent({
          type: 'host.whatsapp.delivery.failed',
          tenantId,
          payload: { connectionId, providerSid: update.sid, status: next.deliveryStatus, errorCode: next.deliveryErrorCode ?? null },
        });
      }
      return next.deliveryStatus ?? null;
    }
  }
  throw new Error('whatsapp delivery status write lost five races');
}

/** Test-only: runs between the index miss and the parked write in
 *  `recordDeliveryStatus`, so a test can land a send exactly there (WA85CD-11). */
let parkRaceHook: (() => Promise<void>) | null = null;
export function __setParkRaceHookForTest(fn: (() => Promise<void>) | null): void {
  parkRaceHook = fn;
}

/** ADR 1053 D10 — the tenant's most recent failed deliveries, newest first. */
export async function listDeliveryFailures(tenantId: string, limit = 50): Promise<WaDeliveryFailure[]> {
  return (await failures.listForTenant(tenantId)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** The tenant's view of one sent message's delivery (ids only, never the number). */
export async function getDeliveryStatus(tenantId: string, connectionId: string, providerSid: string): Promise<{ providerSid: string; connectionId: string; kind: 'session' | 'template'; status: WaDeliveryStatus; errorCode: string | null; updatedAt: string | null } | null> {
  if (!providerSid || !connectionId) return null;
  const ref = await sidIndex.get(providerIdKey(tenantId, connectionId, providerSid));
  if (!ref || ref.tenantId !== tenantId) return null;
  const row = await dispatched.get(ref.idemKey);
  if (!row || row.tenantId !== tenantId || row.providerSid !== providerSid) return null;
  return { providerSid, connectionId: row.connectionId, kind: row.kind, status: row.deliveryStatus ?? 'accepted', errorCode: row.deliveryErrorCode ?? null, updatedAt: row.deliveryUpdatedAt ?? row.sentAt ?? null };
}

/** A `pending` inbound claim older than this belonged to a process that died
 *  mid-write; a redelivery may take it over (both side effects are idempotent). */
const STALE_INBOUND_CLAIM_MS = 2 * 60 * 1000;

/** ADR 1053 D4 — claim one inbound provider message id. `owned` → process the
 *  message, then `complete()`; a failed write calls `release()` so the BSP's
 *  redelivery is processed. A `done` claim is a replay or a redelivery: skip. A
 *  `pending` claim older than two minutes was left by a crash between the claim
 *  and its writes, and is taken over — otherwise that crash would lose a STOP
 *  for as long as the claim lives (grade-code WA85CD-1). */
export async function claimInboundMessage(tenantId: string, connectionId: string, messageId: string): Promise<{ owned: boolean; complete: () => Promise<void>; release: () => Promise<void> }> {
  const id = providerIdKey(tenantId, connectionId, messageId);
  const mine: WaInboundSeen = { id, tenantId, at: new Date().toISOString(), state: 'pending' };
  let owned = await inboundSeen.putIfAbsent(mine);
  if (!owned) {
    const prior = await inboundSeen.get(id);
    const stale = prior !== null && prior.state === 'pending' && Date.now() - Date.parse(prior.at) > STALE_INBOUND_CLAIM_MS;
    owned = stale && (await inboundSeen.compareAndSwap(prior, mine));
  }
  return {
    owned,
    complete: async () => { if (owned) await inboundSeen.compareAndSwap(mine, { ...mine, state: 'done' }); },
    release: async () => { if (owned) await inboundSeen.compareAndDelete(mine).catch(() => false); },
  };
}

/** Test-only. */
export async function __resetWhatsAppStores(): Promise<void> {
  await conversations.__clear();
  await dispatched.__clear();
  await sidIndex.__clear();
  await parked.__clear();
  await inboundSeen.__clear();
  await failures.__clear();
}
