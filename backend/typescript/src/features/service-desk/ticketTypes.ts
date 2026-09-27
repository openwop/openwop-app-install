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

export interface Ticket {
  ticketId: string;
  tenantId: string;
  orgId: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  channel: TicketChannel;
  contactId?: string;
  assigneeMemberId?: string;
  slaDueAt?: string;
  messages: TicketMessage[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
