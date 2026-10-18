/**
 * ADR 0422 P1 — the ticket domain types + closed vocabularies. The ticket is a
 * kernel-backed system entity (`servicedesk.ticket`, ADR 0409/0410 pattern):
 * queryable scalars in `values`, the full record (incl. the customer message
 * THREAD — the ADR's central decision: the thread lives ON the ticket, not in
 * the conversation primitive) in `ext.ticket`. `neverPublic` — a support
 * thread must never reach any public-read lane.
 */

export const TICKET_STATUSES = ['open', 'pending', 'waiting_on_customer', 'solved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CHANNELS = ['widget', 'whatsapp', 'form', 'manual'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** Per-ticket thread cap — a runaway channel loop cannot grow a row unboundedly. */
export const MAX_MESSAGES_PER_TICKET = 500;

export interface TicketMessage {
  /** Caller-supplied idempotency id (channel-deterministic — e.g. the WhatsApp
   *  message SID); a replayed append with the same id is a no-op. */
  messageId: string;
  direction: MessageDirection;
  body: string;
  /** Opaque author ref: `contact:<id>` | `user:<id>` | `agent:<id>` | `visitor`. */
  author: string;
  at: string;
}

/** ADR 0878 D3 — where a reply to this ticket goes. Routing only — never PII
 *  (the address lives in `requester`). Absent ⇒ the ticket has no reply channel
 *  (a form or manual ticket): a reply is recorded, never sent. */
export type TicketReplyChannel = { kind: 'whatsapp'; connectionId: string } | { kind: 'widget' };

/** ADR 0878 D3/D4 — the customer's channel identity, captured at intake and never
 *  caller-supplied. PII: erased under DSAR (D4) and projected out of every
 *  surface except the member HTTP read (`projectTicketForAgent`). */
export interface TicketRequester {
  /** E.164 (`normalizeWaNumber`) — never Twilio's raw `whatsapp:+E164`. */
  phone?: string;
  /** Lower-cased. */
  email?: string;
}

export interface Ticket {
  ticketId: string;
  tenantId: string;
  orgId: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  channel: TicketChannel;
  contactId?: string;
  /** ADR 0878 D5 — an org MEMBER ROW's `subject` holding `workspace:write` in `orgId`. */
  assigneeMemberId?: string;
  replyChannel?: TicketReplyChannel;
  requester?: TicketRequester;
  slaDueAt?: string;
  messages: TicketMessage[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
