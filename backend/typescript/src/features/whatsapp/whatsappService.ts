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
import { isPermittedForPurpose } from '../consent/consentService.js';

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

/** Normalize either BSP's inbound envelope to `{from, text}[]` — Twilio's flat
 *  form fields (always one) or EVERY message in a Meta Cloud batched delivery
 *  (GRADE-CODE 2026-07-17: reading only `messages[0]` dropped a STOP arriving
 *  as message 2+ — a compliance-relevant miss). Empty for status-only callbacks. */
export function extractWaInbound(body: Record<string, unknown>): Array<{ from: string; text: string }> {
  if (typeof body.From === 'string' && typeof body.Body === 'string') {
    return [{ from: body.From, text: body.Body }];
  }
  const out: Array<{ from: string; text: string }> = [];
  const entry = Array.isArray(body.entry) ? (body.entry as Record<string, unknown>[]) : [];
  for (const e of entry) {
    const changes = Array.isArray(e.changes) ? (e.changes as Record<string, unknown>[]) : [];
    for (const c of changes) {
      const value = (c.value ?? {}) as Record<string, unknown>;
      const messages = Array.isArray(value.messages) ? (value.messages as Record<string, unknown>[]) : [];
      for (const m of messages) {
        if (typeof m.from === 'string') {
          const text = (m.text as Record<string, unknown> | undefined)?.body;
          out.push({ from: m.from, text: typeof text === 'string' ? text : '' });
        }
      }
    }
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

export async function recordInboundMessage(tenantId: string, connectionId: string, from: string, at: Date): Promise<void> {
  const recipient = normalizeWaNumber(from);
  if (!recipient) return;
  await conversations.put({ id: convKey(tenantId, connectionId, recipient), tenantId, connectionId, recipient, lastInboundAt: at.toISOString() });
}

export async function getConversation(tenantId: string, connectionId: string, recipient: string): Promise<WaConversation | null> {
  return conversations.get(convKey(tenantId, connectionId, recipient));
}

/**
 * GRADE-DATA 2026-07-17 — GDPR subject erasure (ADR 0381 seam): a WhatsApp
 * subjectKey IS the E.164 phone number, so erasing the subject must also purge
 * the conversation-window rows and the dispatch-ledger rows that carry it.
 * Tenant-scoped list + filter (cold path, erasure only).
 */
export async function eraseWhatsAppSubject(tenantId: string, subjectKey: string): Promise<void> {
  const recipient = normalizeWaNumber(subjectKey);
  if (!recipient) return; // not a phone-number subject — nothing here matches
  for (const c of await conversations.listForTenant(tenantId)) {
    if (c.recipient === recipient) await conversations.delete(c.id);
  }
  for (const d of await dispatched.listForTenant(tenantId)) {
    if (d.recipient === recipient) await dispatched.delete(d.idemKey);
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

/** Fork-stable dispatch ledger (the `ads:dispatch` shape): a duplicate send —
 *  a retry, a `:fork`, a re-run — returns the RECORDED result, never a second
 *  paid message. */
export interface WaDispatchRecord {
  idemKey: string;
  tenantId: string;
  connectionId: string;
  recipient: string;
  kind: 'session' | 'template';
  providerSid: string | null;
  sentAt: string;
}
const dispatched = new DurableCollection<WaDispatchRecord>(
  'whatsapp:dispatch',
  (r) => r.idemKey,
  undefined,
  (r) => r.tenantId,
);

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
}

export type WaSendResult =
  | { sent: true; providerSid: string | null; kind: 'session' | 'template'; deduped: boolean }
  | { sent: false; error: 'feature_disabled' | 'validation_error' | 'no_binding' | 'consent_denied' | 'outside_window' | 'wa_not_connected' | 'wa_request_failed' | 'wa_rejected'; message: string; detail?: Record<string, unknown> };

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

export async function sendWhatsApp(deps: BrokeredEgressDeps, args: WaSendArgs): Promise<WaSendResult> {
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
  if (!(await isPermittedForPurpose(deps.tenantId, recipient, 'marketing-whatsapp'))) {
    return { sent: false, error: 'consent_denied', message: 'The recipient has not explicitly opted in to WhatsApp messages (or has opted out).' };
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
  const content = isTemplate ? `${args.templateId}:${JSON.stringify(args.templateVariables ?? {})}` : args.body!.trim();
  const kind: 'session' | 'template' = isTemplate ? 'template' : 'session';
  const idemKey = idemKeyFor(deps.tenantId, { connectionId: args.connectionId, recipient, kind, content });
  const prior = await dispatched.get(idemKey);
  if (prior) {
    return { sent: true, providerSid: prior.providerSid, kind: prior.kind, deduped: true };
  }

  let providerSid: string | null = null;
  let providerStatus: string | null = null;
  if (transport === 'whatsapp-twilio') {
    const form = new URLSearchParams({
      To: `whatsapp:${recipient}`,
      From: `whatsapp:${sender}`,
      ...(isTemplate
        ? { ContentSid: args.templateId!, ...(args.templateVariables ? { ContentVariables: JSON.stringify(args.templateVariables) } : {}) }
        : { Body: args.body!.trim() }),
    }).toString();
    const r = await brokeredPost(deps, {
      provider: 'twilio',
      // Twilio's path embeds the AccountSid (the public half of the secret) —
      // the smsAdapter convention.
      url: (secret) => `${twilioBase()}/2010-04-01/Accounts/${encodeURIComponent(secret.split(':')[0]!)}/Messages.json`,
      body: form,
      contentType: 'application/x-www-form-urlencoded',
      authScheme: 'basic',
    });
    if (r.outcome === 'no_connection') return { sent: false, error: 'wa_not_connected', message: 'No Twilio connection with a granted send scope — connect it under Connections first.' };
    if (r.outcome !== 'sent') return { sent: false, error: 'wa_request_failed', message: `Twilio was not reachable (${r.outcome}).` };
    let json: { sid?: string; status?: string; message?: string; code?: number };
    try { json = (await r.res.json()) as typeof json; } catch { json = {}; }
    if (!(r.res.status >= 200 && r.res.status < 300) || !json.sid) {
      // Provider rejection surfaces status + message — never the token.
      return { sent: false, error: 'wa_rejected', message: `Twilio rejected the message (${r.res.status}).`, detail: { providerMessage: json.message ?? null, providerCode: json.code ?? null } };
    }
    providerSid = json.sid ?? null;
    providerStatus = json.status ?? null;
  } else {
    // Meta Cloud API direct (ADR 0394 Phase 4): JSON to
    // graph.facebook.com/<version>/<phone-number-id>/messages, bearer WABA token.
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
      url: `${metaGraphBase()}/${encodeURIComponent(sender)}/messages`,
      body: JSON.stringify(payload),
      contentType: 'application/json',
      authScheme: 'bearer',
    });
    if (r.outcome === 'no_connection') return { sent: false, error: 'wa_not_connected', message: 'No WhatsApp Cloud API connection — connect it under Connections first.' };
    if (r.outcome !== 'sent') return { sent: false, error: 'wa_request_failed', message: `The WhatsApp Cloud API was not reachable (${r.outcome}).` };
    let json: { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };
    try { json = (await r.res.json()) as typeof json; } catch { json = {}; }
    const id = json.messages?.[0]?.id;
    if (!(r.res.status >= 200 && r.res.status < 300) || !id) {
      return { sent: false, error: 'wa_rejected', message: `The WhatsApp Cloud API rejected the message (${r.res.status}).`, detail: { providerMessage: json.error?.message ?? null, providerCode: json.error?.code ?? null } };
    }
    providerSid = id;
    providerStatus = 'accepted';
  }

  await dispatched.put({ idemKey, tenantId: deps.tenantId, connectionId: args.connectionId, recipient, kind, providerSid, sentAt: new Date().toISOString() });
  // One structured line per vendor write — counts + kind, never content/PII body.
  log.info('whatsapp_send', { tenantId: deps.tenantId, connectionId: args.connectionId, transport, kind, deduped: false, providerStatus });
  return { sent: true, providerSid, kind, deduped: false };
}

/** Test-only. */
export async function __resetWhatsAppStores(): Promise<void> {
  await conversations.__clear();
  await dispatched.__clear();
}
