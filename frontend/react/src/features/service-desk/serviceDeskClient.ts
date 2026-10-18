/**
 * ADR 0422 P4 — the service-desk client (queue, detail, replies, status,
 * assignment, intake config). Mirrors the biClient shape.
 */
import { config, authedHeaders, fetchOpts } from '../../client/config.js';

const orgBase = (orgId: string): string => `${config.baseUrl}/host/openwop-app/service-desk/orgs/${encodeURIComponent(orgId)}`;

export interface TicketMessage { messageId: string; direction: 'inbound' | 'outbound' | 'internal'; body: string; author: string; at: string }
/** ADR 0878 D3 — what happened to one outbound reply. `unknown` = a send that never
 *  recorded its result (retryable). */
export type DeliveryState = 'pending' | 'sent' | 'failed' | 'visible' | 'not_sent' | 'unknown';
export interface Delivery { state: DeliveryState; at: string; attempts: number; code?: string; message?: string }
export type TicketReplyChannel = { kind: 'whatsapp'; connectionId: string } | { kind: 'widget' };
export interface Ticket {
  ticketId: string;
  subject: string;
  status: 'open' | 'pending' | 'waiting_on_customer' | 'solved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  channel: string;
  contactId?: string;
  assigneeMemberId?: string;
  slaDueAt?: string;
  /** ADR 0878 D3 — absent ⇒ a reply is recorded, never sent. */
  replyChannel?: TicketReplyChannel;
  /** ADR 0878 D3 — the customer's channel identity (member read only). */
  requester?: { phone?: string; email?: string };
  messages: TicketMessage[];
  updatedAt: string;
  createdAt: string;
}
/** A ticket as the detail read returns it: plus each outbound reply's delivery. */
export type TicketDetail = Ticket & { deliveries?: Record<string, Delivery> };
export interface IntakeConfig { defaultOrgId: string; slaHoursByPriority?: Record<string, number>; publicIntakeKey?: string }
/** ADR 0878 D2 — `here` = intake files into THIS org. Configured for another org,
 *  the config itself is not returned (nor which org). */
export interface IntakeStatus { configured: boolean; here: boolean; config: IntakeConfig | null }
export type QueueView = 'all' | 'mine' | 'unassigned' | 'overdue';
export interface Assignee { subject: string; displayName: string }

/**
 * SD-G3 — same bug as the BI client: this read `error.message` from a body whose
 * `error` is a STRING code. The wire envelope is `{ error: <code>, message,
 * details }` (`ErrorEnvelope`), so the server's message was ALWAYS discarded and
 * every failure surfaced as "postTicketMessage returned 409". Agents saw status
 * codes where the backend had written a sentence.
 */
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { message?: string };
      if (typeof body.message === 'string') detail = body.message;
    } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listSupportTickets(orgId: string, status?: string, view?: QueueView): Promise<Ticket[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (view && view !== 'all') params.set('view', view);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${orgBase(orgId)}/tickets${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ tickets: Ticket[] }>(res, 'listSupportTickets')).tickets;
}

export async function getSupportTicket(orgId: string, ticketId: string): Promise<TicketDetail> {
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}`, fetchOpts({ headers: authedHeaders() }));
  const out = await asJson<{ ticket: Ticket; deliveries?: Record<string, Delivery> }>(res, 'getSupportTicket');
  return { ...out.ticket, deliveries: out.deliveries ?? {} };
}

/** Post a reply or internal note. The idempotency key makes a network retry of the
 *  SAME send land once (the server namespaces it to the caller). */
export async function postTicketMessage(orgId: string, ticketId: string, body: string, direction: 'outbound' | 'internal', idempotencyKey?: string): Promise<TicketDetail> {
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}/messages`, fetchOpts({
    method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ body, direction, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  }));
  const out = await asJson<{ ticket: Ticket; deliveries?: Record<string, Delivery> }>(res, 'postTicketMessage');
  return { ...out.ticket, deliveries: out.deliveries ?? {} };
}

/** ADR 0878 D3 — retry a `failed` / `unknown` delivery. */
export async function retryDelivery(orgId: string, ticketId: string, messageId: string): Promise<Record<string, Delivery>> {
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}/messages/${encodeURIComponent(messageId)}/retry`, fetchOpts({
    method: 'POST', headers: authedHeaders(),
  }));
  return (await asJson<{ deliveries: Record<string, Delivery> }>(res, 'retryDelivery')).deliveries;
}

export async function setTicketPriority(orgId: string, ticketId: string, priority: Ticket['priority']): Promise<Ticket> {
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}/priority`, fetchOpts({
    method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ priority }),
  }));
  return (await asJson<{ ticket: Ticket }>(res, 'setTicketPriority')).ticket;
}

/** Assign to a member (by subject), to yourself, or clear (`null`). */
export async function assignTicket(orgId: string, ticketId: string, to: { subject: string } | 'self' | null): Promise<Ticket> {
  const body = to === 'self' ? { assignToSelf: true } : to === null ? {} : { assigneeMemberId: to.subject };
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}/assign`, fetchOpts({
    method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return (await asJson<{ ticket: Ticket }>(res, 'assignTicket')).ticket;
}

/** The org's members who can work a ticket, plus the caller's own spellings. */
export async function listAssignees(orgId: string): Promise<{ assignees: Assignee[]; me: string[] }> {
  const res = await fetch(`${orgBase(orgId)}/assignees`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ assignees: Assignee[]; me: string[] }>(res, 'listAssignees');
}

export async function setTicketStatus(orgId: string, ticketId: string, status: string): Promise<Ticket> {
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}/status`, fetchOpts({
    method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  }));
  return (await asJson<{ ticket: Ticket }>(res, 'setTicketStatus')).ticket;
}

export async function getIntakeConfig(orgId: string): Promise<IntakeStatus> {
  const res = await fetch(`${orgBase(orgId)}/intake-config`, fetchOpts({ headers: authedHeaders() }));
  const out = await asJson<Partial<IntakeStatus>>(res, 'getIntakeConfig');
  return { configured: out.configured === true, here: out.here === true, config: out.config ?? null };
}

export async function setIntakeOrg(orgId: string): Promise<IntakeConfig> {
  const res = await fetch(`${orgBase(orgId)}/intake-config`, fetchOpts({ method: 'PUT', headers: { ...authedHeaders(), 'content-type': 'application/json' }, body: '{}' }));
  return (await asJson<{ config: IntakeConfig }>(res, 'setIntakeOrg')).config;
}
