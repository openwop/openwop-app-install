/**
 * Chat-first port — Phase 5 lifecycle/honesty residue batch.
 *
 * A5 — chat-widget abuse-counter retention (the two unauth `chatwidget:*` caps
 *      namespaces now age on the ADR 0077 `internal` classification).
 * D2 — projects DSAR: a member's `user:` ref is anonymized IN PLACE (never a
 *      whole-project delete; agent members + charter untouched).
 * D8 — service-desk ticket DSAR: requester/customer PII (message bodies + actor
 *      refs) redacted in place; the whole ticket survives.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import { checkWidgetTurn } from '../src/features/chat-widget/capsTracker.js';
import type { WidgetConfig } from '../src/features/chat-widget/widgetService.js';
import { eraseSubjectProjects } from '../src/features/projects/projectsService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { createTicket, appendMessage, getTicket, eraseSubjectTickets } from '../src/features/service-desk/tickets.js';

const DAY = 86_400_000;
const now = 1_900_000_000_000;
const cutoffIso = new Date(now - 35 * DAY).toISOString();
const OLD = new Date(now - 60 * DAY).toISOString();
const FRESH = new Date(now - 5 * DAY).toISOString();

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

// ── A5: chat-widget caps retention ────────────────────────────────────────────
describe('A5 — chat-widget abuse-counter retention', () => {
  // Partial shapes over the REAL namespaces — the purger reads only these fields.
  const sessCol = () => new DurableCollection<{ sKey: string; turns: number; tenantId: string; updatedAt: string }>('chatwidget:session', (s) => s.sKey);
  const dayCol = () => new DurableCollection<{ dKey: string; sessions: number; tenantId: string; updatedAt: string }>('chatwidget:day', (d) => d.dKey);

  it('ages both counter namespaces on the internal classification, keeps fresh rows', async () => {
    const s = sessCol();
    const d = dayCol();
    await s.put({ sKey: 'w:old', turns: 3, tenantId: 'tA', updatedAt: OLD });
    await s.put({ sKey: 'w:fresh', turns: 1, tenantId: 'tA', updatedAt: FRESH });
    await d.put({ dKey: 'w:2020-01-01', sessions: 9, tenantId: 'tA', updatedAt: OLD });
    await d.put({ dKey: 'w:today', sessions: 1, tenantId: 'tA', updatedAt: FRESH });

    const results = await purgeRetained('tA', 'internal', cutoffIso);
    expect(results.find((r) => r.feature === 'chat-widget')).toMatchObject({ deleted: 2, ok: true });
    expect(await s.get('w:old')).toBeNull();
    expect(await s.get('w:fresh')).not.toBeNull();
    expect(await d.get('w:2020-01-01')).toBeNull();
    expect(await d.get('w:today')).not.toBeNull();
  });

  it('is a no-op for the wrong classification, another tenant, and a blank tenant', async () => {
    const s = sessCol();
    await s.put({ sKey: 'w:old', turns: 3, tenantId: 'tA', updatedAt: OLD });
    // confidential-pii is not this feature's classification
    expect((await purgeRetained('tA', 'confidential-pii', cutoffIso)).find((r) => r.feature === 'chat-widget')?.deleted).toBe(0);
    // a different tenant never reaches tA's rows
    expect((await purgeRetained('tB', 'internal', cutoffIso)).find((r) => r.feature === 'chat-widget')?.deleted).toBe(0);
    expect(await s.get('w:old')).not.toBeNull();
    // fail-closed on a blank tenant (no global purge)
    expect(await purgeRetained('', 'internal', cutoffIso)).toEqual([]);
    expect(await s.get('w:old')).not.toBeNull();
  });

  it('checkWidgetTurn now stamps tenantId + updatedAt so a written row is purgeable', async () => {
    const widget: WidgetConfig = { widgetId: 'wZ', tenantId: 'tZ', orgId: 'o', agentId: 'a', allowedDomains: ['x.com'], caps: {}, token: 'wgt', enabled: true, createdBy: 'u', createdAt: 'x', updatedAt: 'x' };
    expect((await checkWidgetTurn(widget, 'sess-1', '2026-07-21')).allowed).toBe(true);
    const row = await sessCol().get('wZ:sess-1');
    expect(row).toMatchObject({ turns: 1, tenantId: 'tZ', updatedAt: '2026-07-21T00:00:00.000Z' });
  });
});

// ── D2: projects subject erasure ──────────────────────────────────────────────
describe('D2 — projects DSAR anonymizes a member ref in place', () => {
  const projCol = () => new DurableCollection<{ id: string; tenantId: string; orgId: string; name: string; members: { ref: string; role: string; addedAt: string }[]; charter?: { brief?: string }; updatedAt: string; createdAt: string; workflows: string[] }>('projects:project', (p) => p.id);

  it('redacts the erased user’s ref, leaving other members, agents, and the charter intact', async () => {
    const c = projCol();
    await c.put({
      id: 'project-1', tenantId: 'tP', orgId: 'o1', name: 'Launch', workflows: [],
      members: [
        { ref: 'user:alice', role: 'lead', addedAt: 't1' },
        { ref: 'user:bob', role: 'contributor', addedAt: 't2' },
        { ref: 'agent:bot', role: 'observer', addedAt: 't3' },
      ],
      charter: { brief: 'org-authored plan text' },
      createdAt: 'c', updatedAt: 'c',
    });

    await eraseSubjectProjects('tP', 'user:alice');

    const after = await c.get('project-1');
    expect(after?.members.find((m) => m.role === 'lead')?.ref).toBe('user:[erased]');
    expect(after?.members.find((m) => m.ref === 'user:bob')).toBeTruthy(); // other person untouched
    expect(after?.members.find((m) => m.ref === 'agent:bot')).toBeTruthy(); // agent never a data subject
    expect(after?.charter?.brief).toBe('org-authored plan text'); // charter not blanked (no subject attribution)

    // idempotent — a re-run matches the sentinel, not the id
    await eraseSubjectProjects('tP', 'user:alice');
    expect((await c.get('project-1'))?.members.filter((m) => m.ref === 'user:[erased]')).toHaveLength(1);
  });

  it('no-ops on a falsy tenant / a project in another tenant', async () => {
    const c = projCol();
    await c.put({ id: 'project-x', tenantId: 'tOther', orgId: 'o', name: 'X', workflows: [], members: [{ ref: 'user:alice', role: 'lead', addedAt: 't' }], createdAt: 'c', updatedAt: 'c' });
    // WF-PRJ-3 — the wrong-tenant no-op REPORTS zero rows, so the erasure seam's
    // `foundNothing` tell can see it (a void return was structurally invisible).
    expect(await eraseSubjectProjects('tP', 'user:alice')).toEqual({ rowsTouched: 0 }); // wrong tenant
    expect((await c.get('project-x'))?.members[0]?.ref).toBe('user:alice');
    expect(await eraseSubjectProjects('', 'user:alice')).toEqual({ rowsTouched: 0 });
    expect((await c.get('project-x'))?.members[0]?.ref).toBe('user:alice');
  });

  it('erases the PRODUCTION-shaped double-prefixed ref (`user:user:<hash>`) keyed by `User.userId`, and reports rowsTouched (PRJC-1 / WF-PRJ-3)', async () => {
    // PRJC-1 — the double-prefix class, live on a second store. `User.userId` is
    // ITSELF `user:<hash>` (usersService.userIdFor) and `userMemberRef` prefixes
    // it AGAIN (`addProjectMember` forces exactly that shape via the org-membership
    // check), so stored refs are `user:user:<hash>`. `subjectKeyForms` strips one
    // tag and adds one scope — never a double form — so a DSAR keyed by
    // `User.userId` (the natural admin key, what `isWorkspaceMember` matches on)
    // used to touch ZERO real member refs while the fan-out reported success.
    // This fixture is built the way `addProjectMember` + the route tests build
    // refs (`user:${login.body.user.userId}`) — the old fixture (`ref:'user:alice'`,
    // single prefix) was green over the live bug.
    const c = projCol();
    const tenantId = 'tP2';
    const subjectKey = userIdFor(tenantId, 'oidc:alice-prod'); // == User.userId, itself `user:<hash>`
    expect(subjectKey.startsWith('user:')).toBe(true); // anti-vacuity guard: the fixture stays production-shaped
    const storedRef = `user:${subjectKey}`; // what addProjectMember stores — `user:user:<hash>`
    await c.put({
      id: 'project-prod', tenantId, orgId: 'o1', name: 'Prod-shaped', workflows: [],
      members: [
        { ref: storedRef, role: 'lead', addedAt: 't1' },
        { ref: `user:${userIdFor(tenantId, 'oidc:bob-prod')}`, role: 'contributor', addedAt: 't2' },
      ],
      createdAt: 'c', updatedAt: 'c',
    });

    const report = await eraseSubjectProjects(tenantId, subjectKey);

    const after = await c.get('project-prod');
    expect(after?.members.find((m) => m.role === 'lead')?.ref).toBe('user:[erased]');
    expect(after?.members.find((m) => m.role === 'contributor')?.ref).not.toBe('user:[erased]'); // the other person untouched
    // WF-PRJ-3 — the eraser reports what it actually touched.
    expect(report).toEqual({ rowsTouched: 1 });
    // Idempotent AND honest about it: the re-run touches nothing and says so.
    expect(await eraseSubjectProjects(tenantId, subjectKey)).toEqual({ rowsTouched: 0 });
    expect((await c.get('project-prod'))?.members.filter((m) => m.ref === 'user:[erased]')).toHaveLength(1);
  });

  it('an AGENT-keyed DSAR must NOT redact a `user:X` member ref that shares the bare id (adversarial F2)', async () => {
    // `subjectKeyForms('agent:X')` contains the bare raw `X`, so a strip arm
    // that peels ONE `user:` tag from any `user:`-prefixed ref would bridge tag
    // types: `agent:X` → strips `user:X` to `X` → forms hit → a DIFFERENT
    // principal's membership redacted. The strip arm is therefore restricted to
    // the exact production double-prefix shape (`user:user:…`).
    const c = projCol();
    await c.put({
      id: 'project-bridge', tenantId: 'tB', orgId: 'o1', name: 'Bridge', workflows: [],
      members: [
        { ref: 'user:shared-id', role: 'lead', addedAt: 't1' },
        { ref: 'agent:shared-id', role: 'observer', addedAt: 't2' },
      ],
      createdAt: 'c', updatedAt: 'c',
    });
    expect(await eraseSubjectProjects('tB', 'agent:shared-id')).toEqual({ rowsTouched: 0 });
    const after = await c.get('project-bridge');
    expect(after?.members.find((m) => m.role === 'lead')?.ref).toBe('user:shared-id'); // untouched
    expect(after?.members.find((m) => m.role === 'observer')?.ref).toBe('agent:shared-id');
  });

  it('`rowsTouched` counts ROWS, not refs — two matching refs on one project report 1 (adversarial F5)', async () => {
    const c = projCol();
    const tenantId = 'tR';
    const subjectKey = userIdFor(tenantId, 'oidc:carol-prod');
    // Contract fixture: the same person's ref stored under two roles on ONE row.
    await c.put({
      id: 'project-tworole', tenantId, orgId: 'o1', name: 'TwoRole', workflows: [],
      members: [
        { ref: `user:${subjectKey}`, role: 'lead', addedAt: 't1' },
        { ref: `user:${subjectKey}`, role: 'contributor', addedAt: 't2' },
      ],
      createdAt: 'c', updatedAt: 'c',
    });
    expect(await eraseSubjectProjects(tenantId, subjectKey)).toEqual({ rowsTouched: 1 });
    expect((await c.get('project-tworole'))?.members.every((m) => m.ref === 'user:[erased]')).toBe(true);
  });
});

// ── D8: service-desk ticket subject erasure ───────────────────────────────────
describe('D8 — service-desk ticket DSAR redacts requester/customer PII in place', () => {
  const T = 'tSD';
  const ORG = 'org-sd';

  async function seedTicket() {
    const created = await createTicket({
      tenantId: T, orgId: ORG, subject: 'card declined', channel: 'whatsapp', externalKey: 'wa:cust-1:day',
      contactId: 'cust-1', createdBy: 'staff-1',
      firstMessage: { messageId: 'm1', body: 'my card 4111 1111 was declined', author: 'contact:cust-1', direction: 'inbound' },
    });
    await appendMessage(T, created.ticket.ticketId, { messageId: 'm2', body: 'happy to help, retry now', author: 'user:staff-1', direction: 'outbound' });
    return created.ticket.ticketId;
  }

  it('erasing the requester scrubs the inbound thread + the contact link, keeps staff replies + the ticket', async () => {
    const id = await seedTicket();
    await eraseSubjectTickets(T, 'cust-1');
    const t = await getTicket(T, id);
    expect(t).not.toBeNull();                          // ticket survives
    expect(t?.messages[0]?.body).toBe('[erased]');     // customer message body scrubbed
    expect(t?.messages[0]?.author).toBe('contact:[erased]'); // author shape preserved, id gone
    expect(t?.contactId).toBe('[erased]');             // CRM contact reference severed
    expect(t?.messages[1]?.body).toBe('happy to help, retry now'); // staff reply untouched
    expect(t?.subject).toBe('card declined');          // structural fields survive
  });

  it('erasing a staff subject scrubs their authored messages + createdBy, and is idempotent', async () => {
    const id = await seedTicket();
    await eraseSubjectTickets(T, 'staff-1');
    let t = await getTicket(T, id);
    expect(t?.messages[1]?.body).toBe('[erased]');
    expect(t?.messages[1]?.author).toBe('user:[erased]');
    expect(t?.createdBy).toBe('[erased]');
    expect(t?.messages[0]?.body).toBe('my card 4111 1111 was declined'); // requester side untouched by a staff erasure

    await eraseSubjectTickets(T, 'staff-1'); // idempotent — sentinel is not a subject-key form
    t = await getTicket(T, id);
    expect(t?.messages[1]?.author).toBe('user:[erased]');
  });

  it('no-ops on a falsy tenant', async () => {
    const id = await seedTicket();
    await eraseSubjectTickets('', 'cust-1');
    expect((await getTicket(T, id))?.contactId).toBe('cust-1');
  });

  // DATA-2 — the FIRST-CONTACT requester: a WhatsApp sender whose phone never
  // resolved a golden contact carries author `wa:<phone>` with NO contactId. A DSAR
  // keyed on that phone must still reach the inbound side.
  it('erases a first-contact WhatsApp requester (no golden contact) matched on the sender phone', async () => {
    const phone = '+15550009';
    const { ticket } = await createTicket({
      tenantId: T, orgId: ORG, subject: 'where is my order', channel: 'whatsapp', externalKey: `wa:conn-1:${phone}`,
      createdBy: 'system:service-desk', // no contactId — first contact, never resolved
      firstMessage: { messageId: 'wa-1', body: 'my order 4111 never arrived', author: `wa:${phone}`, direction: 'inbound' },
    });
    await appendMessage(T, ticket.ticketId, { messageId: 'r-1', body: 'looking into it', author: 'user:staff-1', direction: 'outbound' });
    expect(ticket.contactId).toBeUndefined();

    // Key the erasure on the bare phone (as a resolver would surface it).
    await eraseSubjectTickets(T, phone);
    const t = await getTicket(T, ticket.ticketId);
    expect(t).not.toBeNull();                              // ticket survives
    expect(t?.messages[0]?.body).toBe('[erased]');         // customer words scrubbed
    expect(t?.messages[0]?.author).toBe('wa:[erased]');    // phone dropped, ref shape kept
    expect(t?.contactId).toBeUndefined();                  // no contactId invented on a first-contact ticket
    expect(t?.messages[1]?.body).toBe('looking into it');  // staff reply untouched
    expect(t?.subject).toBe('where is my order');          // structure survives

    await eraseSubjectTickets(T, phone); // idempotent — sentinel no longer names the phone
    expect((await getTicket(T, ticket.ticketId))?.messages[0]?.author).toBe('wa:[erased]');
  });

  it('leaves an anonymous `visitor` thread untouched (no identity to match)', async () => {
    const { ticket } = await createTicket({
      tenantId: T, orgId: ORG, subject: 'form: help', channel: 'form', externalKey: 'form:sub-9',
      createdBy: 'system:service-desk',
      firstMessage: { messageId: 'f-1', body: 'anonymous question', author: 'visitor', direction: 'inbound' },
    });
    await eraseSubjectTickets(T, '+15550009');
    const t = await getTicket(T, ticket.ticketId);
    expect(t?.messages[0]?.body).toBe('anonymous question'); // untouched — visitor carries no identity
    expect(t?.messages[0]?.author).toBe('visitor');
  });
});
