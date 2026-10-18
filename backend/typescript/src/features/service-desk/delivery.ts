/**
 * ADR 0878 D3 — reply delivery. Before this, an outbound message was appended to
 * the thread and sent nowhere: the ticket held no channel address, and the
 * ADR 0422 "deliver via an event→workflow binding" plan could not be wired by any
 * operator (the event payload never carried an address).
 *
 * Invariants:
 *  - ONE entry point, `deliverOutbound`, for both outbound lanes (the member reply
 *    route and an approved agent draft). The caller passes only a message it JUST
 *    appended (`appendMessageResult().appended`), and this module re-checks the
 *    message is `outbound` — an internal note is never deliverable.
 *  - The destination is the ticket's own `replyChannel` + `requester`, captured at
 *    intake. Never caller-supplied: there is no open relay to build.
 *  - Delivery state lives in its OWN rows (`service-desk:delivery`, one per
 *    message), not in the ticket blob: the ticket's whole-row CAS gives up after 6
 *    attempts on a busy thread, and a paid send's result must not be lost to that.
 *    Every transition is a CAS on the row. A `pending` row older than
 *    `STALE_PENDING_MS` reads as `unknown` (the process died between send and
 *    record) and may be retried; the WhatsApp dispatch ledger keys the send on the
 *    message id, so a same-day retry of a send that DID land is deduped.
 *  - What is recorded is a typed `code` + the host-written message — never the
 *    provider's echo (which can quote the number).
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { resolveOne, resolveToggle } from '../../host/featureToggles/service.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { getBoundWhatsAppStorage, sendTicketReplyWhatsApp } from '../whatsapp/whatsappService.js';
import { getTicket } from './tickets.js';

const log = createLogger('service-desk.delivery');

export const DELIVERY_STATES = ['pending', 'sent', 'failed', 'visible', 'not_sent'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
/** What a reader sees: a stale `pending` is `unknown`. */
export type EffectiveDeliveryState = Exclude<DeliveryState, 'pending'> | 'pending' | 'unknown';

export interface DeliveryRow {
  key: string; // `${tenantId}:${ticketId}:${messageId}`
  tenantId: string;
  ticketId: string;
  messageId: string;
  state: DeliveryState;
  /** When the current state was written (a `pending` row's claim time). */
  at: string;
  attempts: number;
  code?: string;
  message?: string;
  providerRef?: string;
}

export interface DeliveryView {
  state: EffectiveDeliveryState;
  at: string;
  attempts: number;
  code?: string;
  message?: string;
}

export const STALE_PENDING_MS = 10 * 60_000;

export const deliveries = new DurableCollection<DeliveryRow>(
  'service-desk:delivery',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const keyOf = (tenantId: string, ticketId: string, messageId: string): string => `${tenantId}:${ticketId}:${messageId}`;

function effective(row: DeliveryRow, now = Date.now()): EffectiveDeliveryState {
  if (row.state === 'pending' && now - Date.parse(row.at) > STALE_PENDING_MS) return 'unknown';
  return row.state;
}

function view(row: DeliveryRow): DeliveryView {
  return {
    state: effective(row), at: row.at, attempts: row.attempts,
    ...(row.code ? { code: row.code } : {}),
    ...(row.message ? { message: row.message } : {}),
  };
}

/** Every delivery on one ticket, keyed by messageId (for the member thread view). */
export async function listDeliveries(tenantId: string, ticketId: string): Promise<Record<string, DeliveryView>> {
  const out: Record<string, DeliveryView> = {};
  for (const r of await deliveries.listByPrefix(`${tenantId}:${ticketId}:`)) {
    if (r.tenantId === tenantId && r.ticketId === ticketId) out[r.messageId] = view(r);
  }
  return out;
}

/** Retryable from these effective states only (a `sent`/`visible` is final; a
 *  live `pending` is someone else's send in flight). */
const RETRYABLE = new Set<EffectiveDeliveryState>(['failed', 'unknown']);

/**
 * Deliver one outbound message. `retry: false` (the append lanes) claims only an
 * ABSENT row — a second call for the same message is a no-op returning the row.
 * `retry: true` re-claims a `failed`/`unknown` row and refuses anything else (409).
 * `actor` is the replier / approver: the send is authorized as them, in the
 * ticket's org (the Connection credential resolves per org + user).
 */
export async function deliverOutbound(input: { tenantId: string; ticketId: string; messageId: string; actor?: string; retry?: boolean }): Promise<DeliveryView> {
  const { tenantId, ticketId, messageId } = input;
  const ticket = await getTicket(tenantId, ticketId);
  if (!ticket) throw new OpenwopError('not_found', 'Ticket not found.', 404, { ticketId });
  const msg = ticket.messages.find((m) => m.messageId === messageId);
  if (!msg) throw new OpenwopError('not_found', 'Message not found.', 404, { messageId });
  if (msg.direction !== 'outbound') {
    throw new OpenwopError('validation_error', 'Only a reply to the customer can be delivered — this message is not one.', 422, { messageId, direction: msg.direction });
  }

  // ── claim ──
  const key = keyOf(tenantId, ticketId, messageId);
  const now = new Date().toISOString();
  const prior = await deliveries.get(key);
  let claimed: DeliveryRow;
  if (!prior) {
    // No row: either the first attempt (the append lanes), or a retry of a reply
    // whose first attempt died before it could claim (grade-code SD2CD-4) — an
    // explicit retry may claim it too, or that reply could never be delivered.
    claimed = { key, tenantId, ticketId, messageId, state: 'pending', at: now, attempts: 1 };
    if (!(await deliveries.putIfAbsent(claimed))) {
      const raced = await deliveries.get(key);
      return raced ? view(raced) : { state: 'pending', at: now, attempts: 1 };
    }
  } else {
    if (!input.retry || !RETRYABLE.has(effective(prior))) {
      if (input.retry) throw new OpenwopError('conflict', `This reply cannot be retried (it is ${effective(prior)}).`, 409, { messageId, state: effective(prior) });
      return view(prior);
    }
    claimed = { key, tenantId, ticketId, messageId, state: 'pending', at: now, attempts: prior.attempts + 1 };
    if (!(await deliveries.compareAndSwap(prior, claimed))) {
      throw new OpenwopError('conflict', 'Another retry of this reply is already running.', 409, { messageId });
    }
  }

  // ── send ──
  const outcome = await attempt(ticket, msg.body, messageId, input.actor);
  const done: DeliveryRow = {
    key, tenantId, ticketId, messageId, attempts: claimed.attempts,
    state: outcome.state, at: new Date().toISOString(),
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
    ...(outcome.providerRef ? { providerRef: outcome.providerRef } : {}),
  };
  if (!(await deliveries.compareAndSwap(claimed, done))) {
    // Only a retry that judged our claim stale can have replaced it; its own
    // result wins and ours is logged (the send is deduped by message id).
    log.warn('delivery_result_lost_to_retry', { tenantId, ticketId, messageId, state: done.state });
    const cur = await deliveries.get(key);
    return cur ? view(cur) : view(done);
  }
  log.info('servicedesk_delivery', { tenantId, ticketId, channel: ticket.replyChannel?.kind ?? 'none', state: done.state, ...(done.code ? { code: done.code } : {}) });
  return view(done);
}

type Outcome = { state: Exclude<DeliveryState, 'pending'>; code?: string; message?: string; providerRef?: string };

async function attempt(ticket: NonNullable<Awaited<ReturnType<typeof getTicket>>>, body: string, messageId: string, actor: string | undefined): Promise<Outcome> {
  const { tenantId } = ticket;
  // A reply decided after the desk was turned off goes nowhere (pre-code review M8).
  const desk = await resolveOne('service-desk', { tenantId, ...(actor ? { userId: actor } : {}) }).catch(() => null);
  if (!desk?.enabled) return { state: 'not_sent', code: 'feature_disabled', message: 'Service desk is turned off for this workspace, so the reply was not sent.' };
  const channel = ticket.replyChannel;
  if (!channel) {
    return { state: 'not_sent', code: 'no_reply_channel', message: 'This ticket has no reply channel — contact the customer directly.' };
  }
  if (channel.kind === 'widget') {
    // The visitor reads replies on their own thread; nothing is pushed. With the
    // widget sub-toggle off, the visitor cannot reach that thread at all.
    const widget = await resolveToggle('service-desk.widget', { tenantId }).catch(() => null);
    return widget?.enabled
      ? { state: 'visible' }
      : { state: 'not_sent', code: 'widget_off', message: 'Widget ticketing is turned off, so the visitor cannot see this reply.' };
  }
  const to = ticket.requester?.phone;
  if (!to) return { state: 'failed', code: 'no_recipient', message: 'The customer\'s WhatsApp number is not on this ticket (it may have been erased).' };
  const storage = getBoundWhatsAppStorage();
  if (!storage) return { state: 'failed', code: 'wa_unavailable', message: 'The WhatsApp channel is not initialized on this host.' };
  try {
    // ADR 0878 OQ-1 — the narrow support-reply lane (in-window session reply to the
    // ticket's own sender; refused on opt-out/erasure). This is its ONLY caller.
    const result = await sendTicketReplyWhatsApp(
      {
        storage, tenantId,
        runId: `servicedesk:${ticket.ticketId}`,
        orgId: ticket.orgId,
        ...(actor ? { actingUserId: actor } : {}),
      },
      { connectionId: channel.connectionId, to, body, idempotencyKey: `${ticket.ticketId}:${messageId}` },
    );
    if (result.sent) return { state: 'sent', ...(result.providerSid ? { providerRef: result.providerSid } : {}) };
    return { state: 'failed', code: result.error, message: result.message };
  } catch (err) {
    log.warn('servicedesk_delivery_threw', { tenantId, ticketId: ticket.ticketId, error: err instanceof Error ? err.message : String(err) });
    return { state: 'failed', code: 'send_error', message: 'The reply could not be sent. Try again.' };
  }
}
