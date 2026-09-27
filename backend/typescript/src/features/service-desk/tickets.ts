/**
 * ADR 0422 P1 — the ticket service over the kernel adapter. Invariants:
 *  - the ticket is a `servicedesk.ticket` system entity (queryable scalars +
 *    the full record incl. the message thread in ext.ticket; neverPublic);
 *    writes go ONLY through this service (the generic entities API refuses
 *    system writes — assertNotSystemWrite);
 *  - message appends are IDEMPOTENT by messageId (channel-deterministic ids —
 *    a replayed webhook never duplicates a thread entry) and CAS-guarded
 *    against concurrent appends;
 *  - status transitions are CAS-guarded (no lost updates between two agents);
 *  - every mutation emits `host.servicedesk.ticket.*` (ids-only payload) so
 *    operators bind automation via the existing event→workflow seam.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { mintSystemType, type EntityRecord } from '../entities/entitiesService.js';
import { makeKernelAdapter } from '../entities/kernelAdapter.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED } from '../../host/subjectErasureRedaction.js';
import { armSlaTimer, settleSlaTimer, slaDueAtFor } from './sla.js';
import {
  MAX_MESSAGES_PER_TICKET, TICKET_CHANNELS, TICKET_PRIORITIES, TICKET_STATUSES,
  type Ticket, type TicketChannel, type TicketMessage, type TicketPriority, type TicketStatus,
} from './ticketTypes.js';

export const TICKET_TYPE = 'servicedesk.ticket';

const TICKET_SCALARS = [
  { key: 'org_id', label: 'Org', type: 'string' as const, required: true },
  { key: 'subject', label: 'Subject', type: 'string' as const, required: true },
  { key: 'ticket_status', label: 'Status', type: 'string' as const, required: true },
  { key: 'priority', label: 'Priority', type: 'string' as const, required: true },
  { key: 'channel', label: 'Channel', type: 'string' as const, required: true },
  { key: 'contact_id', label: 'Contact', type: 'string' as const, required: false },
  { key: 'assignee_member_id', label: 'Assignee', type: 'string' as const, required: false },
  { key: 'sla_due_at', label: 'SLA due', type: 'string' as const, required: false },
];

async function ensureTicketType(tenantId: string): Promise<void> {
  await mintSystemType({ tenantId, name: TICKET_TYPE, displayName: 'Support ticket', fields: TICKET_SCALARS, neverPublic: true, actor: 'system:service-desk' });
}

function ticketToKernel(t: Ticket): { values: Record<string, unknown>; ext: Record<string, unknown> } {
  return {
    values: {
      org_id: t.orgId, subject: t.subject, ticket_status: t.status, priority: t.priority, channel: t.channel,
      ...(t.contactId !== undefined ? { contact_id: t.contactId } : {}),
      ...(t.assigneeMemberId !== undefined ? { assignee_member_id: t.assigneeMemberId } : {}),
      ...(t.slaDueAt !== undefined ? { sla_due_at: t.slaDueAt } : {}),
    },
    ext: { ticket: t },
  };
}
const kernelToTicket = (rec: EntityRecord): Ticket => (rec.ext?.ticket as Ticket);
// No pre-kernel rows exist (this feature is born on the kernel) — the legacy
// seam is an empty collection so `migrate()` is a structural no-op.
const legacyTickets = new DurableCollection<Ticket>('service-desk:legacy-none', (t) => t.ticketId, undefined, (t) => t.tenantId);

export const ticketStore = makeKernelAdapter<Ticket>({
  typeName: TICKET_TYPE,
  ensureType: ensureTicketType,
  toKernel: ticketToKernel,
  fromKernel: kernelToTicket,
  idOf: (t) => t.ticketId,
  tenantOf: (t) => t.tenantId,
  orgOf: (t) => t.orgId,
  actorOf: (t) => t.createdBy,
  updatedAtOf: (t) => t.updatedAt,
  legacy: legacyTickets,
});

/** Emit + fan out one ticket mutation (ids-only payload — receivers re-fetch
 *  under authz; the territories emit discipline). */
function ticketMutated(verb: 'created' | 'message-appended' | 'status-changed' | 'assigned', t: Ticket, extra: Record<string, unknown> = {}): void {
  void emitHostEvent({
    type: `host.servicedesk.ticket.${verb}`,
    tenantId: t.tenantId,
    payload: { ticketId: t.ticketId, orgId: t.orgId, status: t.status, channel: t.channel, ...extra },
  });
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const inSet = <T extends string>(set: readonly T[], v: unknown, field: string, fallback?: T): T => {
  const s = str(v);
  if ((set as readonly string[]).includes(s)) return s as T;
  if (fallback !== undefined && !s) return fallback;
  throw new OpenwopError('validation_error', `Field \`${field}\` must be one of: ${set.join(', ')}.`, 422, { field });
};

export interface CreateTicketInput {
  tenantId: string;
  orgId: string;
  subject: string;
  channel: TicketChannel | string;
  priority?: TicketPriority | string;
  contactId?: string;
  /** Deterministic external key (e.g. `wa:<sender>:<sessionDay>`) — the SAME
   *  key resolves the SAME ticket (find-or-create; a webhook retry or fold
   *  never mints a duplicate). Omitted ⇒ a fresh manual ticket. */
  externalKey?: string;
  firstMessage?: { messageId: string; body: string; author: string; direction?: string };
  /** Optional per-priority SLA-hours override (the intake config's table). */
  slaHoursByPriority?: Partial<Record<TicketPriority, number>>;
  createdBy: string;
}

export function ticketIdFor(tenantId: string, externalKey: string): string {
  return `tkt-${createHash('sha256').update(`${tenantId}|${externalKey}`).digest('hex').slice(0, 20)}`;
}

export async function createTicket(input: CreateTicketInput): Promise<{ ticket: Ticket; created: boolean }> {
  const subject = input.subject.trim().slice(0, 300);
  if (!subject) throw new OpenwopError('validation_error', 'Field `subject` is required.', 422, { field: 'subject' });
  if (!input.orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 422, { field: 'orgId' });
  const channel = inSet(TICKET_CHANNELS, input.channel, 'channel');
  const priority = inSet(TICKET_PRIORITIES, input.priority ?? 'normal', 'priority', 'normal');

  const ticketId = input.externalKey
    ? ticketIdFor(input.tenantId, input.externalKey)
    : `tkt-${createHash('sha256').update(`${input.tenantId}|manual|${input.orgId}|${subject}|${input.createdBy}|${Date.now()}`).digest('hex').slice(0, 20)}`;

  const existing = await ticketStore.get(input.tenantId, ticketId);
  if (existing) {
    // Find-or-create: an inbound retry (or session continuation) appends
    // rather than duplicating. The first message rides the idempotent append.
    if (input.firstMessage) {
      const t = await appendMessage(input.tenantId, ticketId, { ...input.firstMessage, direction: input.firstMessage.direction ?? 'inbound' });
      return { ticket: t, created: false };
    }
    return { ticket: existing, created: false };
  }

  const now = new Date().toISOString();
  const slaDueAt = slaDueAtFor(priority, input.slaHoursByPriority, new Date(now));
  const ticket: Ticket = {
    ticketId, tenantId: input.tenantId, orgId: input.orgId, subject,
    status: 'open', priority, channel,
    ...(slaDueAt ? { slaDueAt } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    messages: input.firstMessage
      ? [{ messageId: str(input.firstMessage.messageId) || 'm-1', direction: (input.firstMessage.direction === 'internal' || input.firstMessage.direction === 'outbound' ? input.firstMessage.direction : 'inbound'), body: str(input.firstMessage.body).slice(0, 8000), author: str(input.firstMessage.author) || 'unknown', at: now }]
      : [],
    createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await ticketStore.put(ticket);
  await armSlaTimer(ticket);
  ticketMutated('created', ticket);
  return { ticket, created: true };
}

/** CAS-guarded, messageId-idempotent thread append. */
export async function appendMessage(tenantId: string, ticketId: string, msg: { messageId: string; body: string; author: string; direction?: string }): Promise<Ticket> {
  const messageId = str(msg.messageId);
  if (!messageId) throw new OpenwopError('validation_error', 'Field `messageId` is required (channel-deterministic idempotency id).', 422, { field: 'messageId' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const cur = await ticketStore.get(tenantId, ticketId);
    if (!cur) throw new OpenwopError('not_found', 'Ticket not found.', 404, { ticketId });
    if (cur.messages.some((m) => m.messageId === messageId)) return cur; // idempotent no-op
    if (cur.messages.length >= MAX_MESSAGES_PER_TICKET) {
      throw new OpenwopError('conflict', `Ticket thread cap reached (${MAX_MESSAGES_PER_TICKET}).`, 409, { ticketId });
    }
    const entry: TicketMessage = {
      messageId,
      direction: (msg.direction === 'outbound' || msg.direction === 'internal') ? msg.direction : 'inbound',
      body: str(msg.body).slice(0, 8000),
      author: str(msg.author) || 'unknown',
      at: new Date().toISOString(),
    };
    // An inbound customer reply on a solved/closed ticket re-opens it —
    // pending state machines that silently swallow replies lose customers.
    const reopened: TicketStatus = entry.direction === 'inbound' && (cur.status === 'solved' || cur.status === 'closed') ? 'open' : cur.status;
    const next: Ticket = { ...cur, status: reopened, messages: [...cur.messages, entry], updatedAt: entry.at };
    if (await ticketStore.cas(cur, next)) {
      ticketMutated('message-appended', next, { messageId, direction: entry.direction });
      return next;
    }
  }
  throw new OpenwopError('conflict', 'Concurrent thread update — retry.', 409, { ticketId });
}

export async function setStatus(tenantId: string, ticketId: string, status: TicketStatus | string, actor: string): Promise<Ticket> {
  const nextStatus = inSet(TICKET_STATUSES, status, 'status');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const cur = await ticketStore.get(tenantId, ticketId);
    if (!cur) throw new OpenwopError('not_found', 'Ticket not found.', 404, { ticketId });
    if (cur.status === nextStatus) return cur;
    const next: Ticket = { ...cur, status: nextStatus, updatedAt: new Date().toISOString() };
    if (await ticketStore.cas(cur, next)) {
      if (nextStatus === 'solved' || nextStatus === 'closed') await settleSlaTimer(tenantId, ticketId);
      else if ((cur.status === 'solved' || cur.status === 'closed') && next.slaDueAt) await armSlaTimer(next);
      ticketMutated('status-changed', next, { from: cur.status, actor });
      return next;
    }
  }
  throw new OpenwopError('conflict', 'Concurrent status update — retry.', 409, { ticketId });
}

export async function assignTicket(tenantId: string, ticketId: string, assigneeMemberId: string | undefined, actor: string): Promise<Ticket> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const cur = await ticketStore.get(tenantId, ticketId);
    if (!cur) throw new OpenwopError('not_found', 'Ticket not found.', 404, { ticketId });
    const next: Ticket = { ...cur, updatedAt: new Date().toISOString() };
    if (assigneeMemberId) next.assigneeMemberId = assigneeMemberId;
    else delete next.assigneeMemberId;
    if (await ticketStore.cas(cur, next)) {
      ticketMutated('assigned', next, { assigneeMemberId: assigneeMemberId ?? null, actor });
      return next;
    }
  }
  throw new OpenwopError('conflict', 'Concurrent assignment — retry.', 409, { ticketId });
}

export async function getTicket(tenantId: string, ticketId: string): Promise<Ticket | null> {
  return ticketStore.get(tenantId, ticketId);
}

export async function listTickets(tenantId: string, orgId: string, filter?: { status?: string }): Promise<Ticket[]> {
  const all = (await ticketStore.listForTenant(tenantId)).filter((t) => t.orgId === orgId);
  const filtered = filter?.status ? all.filter((t) => t.status === filter.status) : all;
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── ADR 0464 / D8 (chat-first port) — subject erasure ──
//
// A support ticket carries requester/customer PII: the message THREAD free-text
// (`messages[].body` — the customer's own words) and the actor refs on it
// (`messages[].author`, `createdBy`). A DSAR REDACTS that PII IN PLACE — the
// ticket, its status history, and the SLA/queue structure survive (an operator
// still needs the record), but the erased person's words and identifiers become
// the `[erased]` sentinel. It is never a whole-ticket delete.
//
// The eraser matches BOTH subject-key forms (`subjectKeyForms`, the ADR 0464 rule),
// so it does the right thing whichever way it's keyed:
//  - a staff subject (`user:`/`agent:`) → their authored messages + `createdBy`;
//  - a CRM-resolved REQUESTER: when the ticket's `contact_id` is the erased subject
//    (reached when a resolver links the principal to that contactId, or the erasure
//    is keyed on the contact form directly), the inbound customer side of the thread
//    and the `contactId` reference are scrubbed too;
//  - a FIRST-CONTACT requester with NO golden contact (intake.ts: a WhatsApp sender
//    whose phone never resolved a contact carries author `wa:<phone>`, contactId
//    absent): when the erased subject's key forms include that channel identity —
//    the raw phone OR the `wa:<phone>` ref itself — the inbound side is scrubbed even
//    though no `contact_id` was ever attached (the DATA-2 gap; a bare `visitor` author
//    carries no identity to match, so an anonymous form thread is left untouched).
// Idempotent: a re-run matches the sentinel, not an id, so it no-ops.

/** Preserve a tagged author ref's SHAPE while dropping its id (`contact:x` →
 *  `contact:[erased]`); a bare tag like `visitor` (no id) is left as-is. */
function redactAuthorRef(author: string): string {
  const i = author.indexOf(':');
  return i > 0 ? `${author.slice(0, i)}:${ERASED}` : author;
}

/** A first-contact ticket (no golden contact) whose inbound WhatsApp author
 *  `wa:<phone>` names the erased subject — matched on either the full ref or the
 *  bare phone appearing in the subject's key forms. This is what lets a DSAR keyed
 *  on a phone (or `wa:<phone>`) reach a thread that never resolved a `contact_id`. */
function firstContactRequesterErased(t: Ticket, forms: ReadonlySet<string>): boolean {
  return t.messages.some((m) => {
    if (m.direction !== 'inbound' || !m.author.startsWith('wa:')) return false;
    return forms.has(m.author) || forms.has(m.author.slice('wa:'.length));
  });
}

/** DSAR eraser — redact the erased subject's PII across every ticket in the tenant
 *  (authored message bodies + author/creator refs; the requester side when the
 *  ticket's contact is the subject). Tenant-scoped; fail-closed on falsy input; no
 *  notifications (the seam invokes it once per linked key). */
export async function eraseSubjectTickets(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const t of await ticketStore.listForTenant(tenantId)) {
    // The requester side is erased when the ticket's golden contact is the subject
    // (CRM-resolved) OR — for a first-contact ticket that never resolved one — when
    // the subject's key forms name the inbound channel identity (a `wa:<phone>`).
    const contactRequesterErased = !!t.contactId && forms.has(t.contactId);
    const requesterErased = contactRequesterErased || firstContactRequesterErased(t, forms);
    let changed = false;
    const messages = t.messages.map((m) => {
      // A message is the subject's when THEY authored it, or when the erased
      // requester sent it inbound (author `contact:<id>` / `visitor`).
      if (!forms.has(m.author) && !(requesterErased && m.direction === 'inbound')) return m;
      changed = true;
      return { ...m, body: ERASED, author: redactAuthorRef(m.author) };
    });
    const createdBy = forms.has(t.createdBy) ? ERASED : t.createdBy;
    if (!changed && createdBy === t.createdBy && !requesterErased) continue;
    await ticketStore.put({
      ...t,
      messages,
      createdBy,
      // Only redact an EXISTING contact ref — a first-contact ticket has none, so
      // never invent a `contactId` field on it.
      ...(contactRequesterErased ? { contactId: ERASED } : {}),
      updatedAt: new Date().toISOString(),
    });
  }
}

/** Register the service-desk DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from `feature.ts` `registerRoutes` (runs for every feature
 *  regardless of toggle, so a tenant that used the desk then turned it off is
 *  still erasable). */
export function registerServiceDeskErasure(): void {
  registerSubjectEraser(eraseSubjectTickets);
}
