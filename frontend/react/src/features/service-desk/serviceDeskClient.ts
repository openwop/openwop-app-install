/**
 * ADR 0422 P4 — the service-desk client (queue, detail, replies, status,
 * assignment, intake config). Mirrors the biClient shape.
 */
import { config, authedHeaders, fetchOpts } from '../../client/config.js';

const orgBase = (orgId: string): string => `${config.baseUrl}/host/openwop-app/service-desk/orgs/${encodeURIComponent(orgId)}`;

export interface TicketMessage { messageId: string; direction: 'inbound' | 'outbound' | 'internal'; body: string; author: string; at: string }
export interface Ticket {
  ticketId: string;
  subject: string;
  status: 'open' | 'pending' | 'waiting_on_customer' | 'solved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  channel: string;
  contactId?: string;
  assigneeMemberId?: string;
  slaDueAt?: string;
  messages: TicketMessage[];
  updatedAt: string;
  createdAt: string;
}
export interface IntakeConfig { defaultOrgId: string; slaHoursByPriority?: Record<string, number> }

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

export async function listSupportTickets(orgId: string, status?: string): Promise<Ticket[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await fetch(`${orgBase(orgId)}/tickets${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ tickets: Ticket[] }>(res, 'listSupportTickets')).tickets;
}

export async function getSupportTicket(orgId: string, ticketId: string): Promise<Ticket> {
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ ticket: Ticket }>(res, 'getSupportTicket')).ticket;
}

export async function postTicketMessage(orgId: string, ticketId: string, body: string, direction: 'outbound' | 'internal'): Promise<Ticket> {
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}/messages`, fetchOpts({
    method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ body, direction }),
  }));
  return (await asJson<{ ticket: Ticket }>(res, 'postTicketMessage')).ticket;
}

export async function setTicketStatus(orgId: string, ticketId: string, status: string): Promise<Ticket> {
  const res = await fetch(`${orgBase(orgId)}/tickets/${encodeURIComponent(ticketId)}/status`, fetchOpts({
    method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  }));
  return (await asJson<{ ticket: Ticket }>(res, 'setTicketStatus')).ticket;
}

export async function getIntakeConfig(orgId: string): Promise<IntakeConfig | null> {
  const res = await fetch(`${orgBase(orgId)}/intake-config`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ config: IntakeConfig | null }>(res, 'getIntakeConfig')).config;
}

export async function setIntakeOrg(orgId: string): Promise<IntakeConfig> {
  const res = await fetch(`${orgBase(orgId)}/intake-config`, fetchOpts({ method: 'PUT', headers: authedHeaders() }));
  return (await asJson<{ config: IntakeConfig }>(res, 'setIntakeOrg')).config;
}
