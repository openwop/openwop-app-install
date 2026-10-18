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
import { normalizeWaNumber } from '../whatsapp/whatsappService.js';
import {
  MAX_MESSAGES_PER_TICKET, TICKET_CHANNELS, TICKET_PRIORITIES, TICKET_STATUSES,
  type Ticket, type TicketChannel, type TicketMessage, type TicketPriority, type TicketReplyChannel,
  type TicketRequester, type TicketStatus,
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
function ticketMutated(verb: 'created' | 'message-appended' | 'status-changed' | 'priority-changed' | 'assigned', t: Ticket, extra: Record<string, unknown> = {}): void {
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
  /** ADR 0878 D3 — captured at intake, never from a caller. On an EXISTING
   *  ticket that lacks them (a thread opened before ADR 0878) they are backfilled
   *  by the append, so a continuing WhatsApp thread becomes repliable. */
  replyChannel?: TicketReplyChannel;
  requester?: TicketRequester;
  createdBy: string;
}

/** ADR 0878 D3/D4 — a requester as stored: E.164 phone, lower-cased email, no
 *  empty keys. Returns undefined when nothing usable remains. */
export function normalizeRequester(r: TicketRequester | undefined): TicketRequester | undefined {
  if (!r) return undefined;
  const phone = r.phone ? normalizeWaNumber(r.phone) ?? undefined : undefined;
  const email = r.email && /^[^\s@]+@[^\s@]+$/.test(r.email.trim()) ? r.email.trim().toLowerCase() : undefined;
  if (!phone && !email) return undefined;
  return { ...(phone ? { phone } : {}), ...(email ? { email } : {}) };
}

/** A member's author ref. A canonical user id is already `user:<hash>`; prefixing it
 *  again wrote `user:user:<hash>`, a form no DSAR key ever takes (grade-code
 *  SD2CD-2), so a staff erasure missed every message the member wrote. */
export function userAuthorRef(userId: string): string {
  return userId.startsWith('user:') ? userId : `user:${userId}`;
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

  const requester = normalizeRequester(input.requester);
  const backfill = {
    ...(input.replyChannel ? { replyChannel: input.replyChannel } : {}),
    ...(requester ? { requester } : {}),
  };
  const existing = await ticketStore.get(input.tenantId, ticketId);
  if (existing) {
    // Find-or-create: an inbound retry (or session continuation) appends
    // rather than duplicating. The first message rides the idempotent append.
    if (input.firstMessage) {
      const { ticket: t } = await appendMessageResult(input.tenantId, ticketId, { ...input.firstMessage, direction: input.firstMessage.direction ?? 'inbound' }, { backfill });
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
    ...backfill,
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
  return (await appendMessageResult(tenantId, ticketId, msg)).ticket;
}

/**
 * The append, reporting whether THIS call wrote the message. ADR 0878 D3 (pre-code
 * Blocker 2): delivery runs only for `appended: true` — an id that already exists
 * returns the ticket unchanged, and delivering "whatever holds that id" would send
 * an internal note or another agent's reply to the customer.
 */
export async function appendMessageResult(
  tenantId: string,
  ticketId: string,
  msg: { messageId: string; body: string; author: string; direction?: string },
  opts: { backfill?: Partial<Pick<Ticket, 'replyChannel' | 'requester'>> } = {},
): Promise<{ ticket: Ticket; appended: boolean }> {
  const messageId = str(msg.messageId);
  if (!messageId) throw new OpenwopError('validation_error', 'Field `messageId` is required (channel-deterministic idempotency id).', 422, { field: 'messageId' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const cur = await ticketStore.get(tenantId, ticketId);
    if (!cur) throw new OpenwopError('not_found', 'Ticket not found.', 404, { ticketId });
    if (cur.messages.some((m) => m.messageId === messageId)) return { ticket: cur, appended: false }; // idempotent no-op
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
    const next: Ticket = {
      ...cur,
      // Backfill only what is missing — an intake never overwrites a channel or a
      // requester the ticket already holds (D4 may have erased it on purpose).
      ...(opts.backfill?.replyChannel && !cur.replyChannel ? { replyChannel: opts.backfill.replyChannel } : {}),
      ...(opts.backfill?.requester && !cur.requester ? { requester: opts.backfill.requester } : {}),
      status: reopened, messages: [...cur.messages, entry], updatedAt: entry.at,
    };
    if (await ticketStore.cas(cur, next)) {
      ticketMutated('message-appended', next, { messageId, direction: entry.direction });
      return { ticket: next, appended: true };
    }
  }
  throw new OpenwopError('conflict', 'Concurrent thread update — retry.', 409, { ticketId });
}

/** ADR 0878 D7 — set the priority and re-derive the SLA due time from the stored
 *  table (the clock restarts from NOW at the new level: a re-prioritised ticket is
 *  promised a response at the new level's speed, not retro-dated). */
export async function setPriority(tenantId: string, ticketId: string, priority: TicketPriority | string, actor: string, slaHoursByPriority?: Partial<Record<TicketPriority, number>>): Promise<Ticket> {
  const nextPriority = inSet(TICKET_PRIORITIES, priority, 'priority');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const cur = await ticketStore.get(tenantId, ticketId);
    if (!cur) throw new OpenwopError('not_found', 'Ticket not found.', 404, { ticketId });
    if (cur.priority === nextPriority) return cur;
    const now = new Date();
    const slaDueAt = slaDueAtFor(nextPriority, slaHoursByPriority, now);
    const next: Ticket = { ...cur, priority: nextPriority, updatedAt: now.toISOString() };
    if (slaDueAt) next.slaDueAt = slaDueAt;
    else delete next.slaDueAt;
    if (await ticketStore.cas(cur, next)) {
      // A settled ticket keeps no clock; an open one re-arms at the new due time.
      if (next.status !== 'solved' && next.status !== 'closed') await armSlaTimer(next);
      ticketMutated('priority-changed', next, { from: cur.priority, to: nextPriority, actor });
      return next;
    }
  }
  throw new OpenwopError('conflict', 'Concurrent priority update — retry.', 409, { ticketId });
}

/** ADR 0878 D1/D3 — the ticket as any NON-member-HTTP surface sees it (the chat
 *  tool, the node surface, run history): the requester's address is PII the model
 *  and the run log never need; the channel KIND is what decides a reply. */
export function projectTicketForAgent(t: Ticket): Omit<Ticket, 'requester' | 'replyChannel'> & { replyChannel: TicketReplyChannel['kind'] | 'none' } {
  const { requester: _requester, replyChannel, ...rest } = t;
  void _requester;
  return { ...rest, replyChannel: replyChannel?.kind ?? 'none' };
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

/** ADR 0878 D4 — the requester-identity forms a subject key can take, normalized
 *  the way the ticket stores them (E.164 phone, lower-cased email). A DSAR keyed
 *  `+15551234567`, `whatsapp:+15551234567`, `wa:+1…` or `Jane@X.com` must all land. */
function requesterForms(forms: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const f of forms) {
    const v = f.startsWith('wa:') ? f.slice(3) : f;
    // A phone only when it SAYS it is one (`+…`, `whatsapp:+…`, `wa:…`): the
    // normalizer also accepts Meta's plus-less digits, and a bare 7–15 digit id
    // in a DSAR (an order number, a CRM id) must not erase an unrelated customer
    // (grade-code SD2CD-15).
    if (v.startsWith('+') || v.startsWith('whatsapp:') || f.startsWith('wa:')) {
      const phone = normalizeWaNumber(v);
      if (phone) out.add(phone);
    }
    if (v.includes('@')) out.add(v.trim().toLowerCase());
  }
  return out;
}

/** A first-contact ticket (no golden contact) whose inbound WhatsApp author
 *  `wa:<phone>` names the erased subject. Twilio's raw sender is
 *  `whatsapp:+E164`, so authors written before ADR 0878 read `wa:whatsapp:+1…` —
 *  both sides are normalized (pre-code review H5: the old literal match never
 *  reached a Twilio thread from a phone-keyed DSAR). */
function firstContactRequesterErased(t: Ticket, phones: ReadonlySet<string>): boolean {
  return t.messages.some((m) => {
    if (m.direction !== 'inbound' || !m.author.startsWith('wa:')) return false;
    const phone = normalizeWaNumber(m.author.slice('wa:'.length));
    return !!phone && phones.has(phone);
  });
}

/** The subject line a customer's own words wrote (WhatsApp / widget intake take
 *  the first 80 chars of the first message). A form title or a member-typed subject
 *  is not the requester's text and survives. */
const DERIVED_SUBJECT_LABEL: Partial<Record<TicketChannel, string>> = { whatsapp: 'WhatsApp', widget: 'Widget' };

/** DSAR eraser — redact the erased subject's PII across every ticket in the tenant.
 *  Requester leg (D4): the ticket's golden contact, its captured `requester`
 *  phone/email, or a first-contact WhatsApp author names the subject → inbound
 *  bodies, the requester, a customer-derived subject line, and every drafted reply
 *  on the ticket. Staff leg: authored messages, `createdBy`, `assigneeMemberId`.
 *  Each ticket is a CAS mutate (pre-code review M2: a blind `put` from the list read
 *  reverted any append landing in between). Tenant-scoped; fail-closed on falsy
 *  input; idempotent (a re-run matches the sentinel, not an id). */
export async function eraseSubjectTickets(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  const reqForms = requesterForms(forms);
  const requesterErasedOn = (t: Ticket): { contact: boolean; any: boolean } => {
    const contact = !!t.contactId && forms.has(t.contactId);
    const captured = (!!t.requester?.phone && reqForms.has(t.requester.phone))
      || (!!t.requester?.email && reqForms.has(t.requester.email));
    return { contact, any: contact || captured || firstContactRequesterErased(t, reqForms) };
  };
  // Authors written before ADR 0878 as `user:user:<hash>` (SD2CD-2) still match.
  const authoredBySubject = (author: string): boolean =>
    forms.has(author) || (author.startsWith('user:user:') && forms.has(author.slice('user:'.length)));
  const redact = (t: Ticket): Ticket | null => {
    const req = requesterErasedOn(t);
    let changed = false;
    const messages = t.messages.map((m) => {
      if (!authoredBySubject(m.author) && !(req.any && m.direction === 'inbound')) return m;
      if (m.body === ERASED && m.author === redactAuthorRef(m.author)) return m;
      changed = true;
      return { ...m, body: ERASED, author: redactAuthorRef(m.author) };
    });
    const next: Ticket = { ...t, messages };
    if (authoredBySubject(t.createdBy)) { next.createdBy = ERASED; changed = true; }
    if (t.assigneeMemberId && forms.has(t.assigneeMemberId)) { delete next.assigneeMemberId; changed = true; }
    if (req.any) {
      if (req.contact) { next.contactId = ERASED; changed = true; }
      if (t.requester) { delete next.requester; changed = true; }
      const label = DERIVED_SUBJECT_LABEL[t.channel];
      const erasedSubject = label ? `${label}: ${ERASED}` : t.subject;
      if (erasedSubject !== t.subject) { next.subject = erasedSubject; changed = true; }
    }
    if (!changed) return null;
    next.updatedAt = new Date().toISOString();
    return next;
  };
  for (const listed of await ticketStore.listForTenant(tenantId)) {
    if (!redact(listed)) continue;
    // The drafted replies on this ticket quote the thread (their `reason` names the
    // subject) — the requester's words must not survive in the approval queue.
    // BEFORE the ticket: once the ticket is redacted nothing on it names the
    // subject any more, so a run that died between the two writes could never
    // reach the drafts on a re-run (grade-code SD2CD-14). The drafts eraser is
    // idempotent.
    if (requesterErasedOn(listed).any) {
      const { eraseServiceDeskReplyDrafts } = await import('../assistant/erasure.js');
      await eraseServiceDeskReplyDrafts(tenantId, listed.ticketId);
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const cur = await ticketStore.get(tenantId, listed.ticketId);
      if (!cur) break;
      const next = redact(cur);
      if (!next) break;
      if (await ticketStore.cas(cur, next)) break;
    }
  }
}

/** Register the service-desk DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from `feature.ts` `registerRoutes` (runs for every feature
 *  regardless of toggle, so a tenant that used the desk then turned it off is
 *  still erasable). */
export function registerServiceDeskErasure(): void {
  registerSubjectEraser(eraseSubjectTickets);
}
