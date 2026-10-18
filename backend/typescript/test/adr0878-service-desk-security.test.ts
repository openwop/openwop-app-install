/**
 * ADR 0878 — service desk round 2: the security floor. Each case below was
 * written FIRST and run RED against `origin/main` @ `6b30fb3a9` before any fix
 * (the round-2 "prove it red" rule); the ADR's evidence table records which
 * assertion failed and how.
 *
 *  - SD2-S1  the node lane: `ctx.features['service-desk'].getTicket` took no
 *            `orgId`, so the ADR 0832 org floor never fired and a member of
 *            org A read org B's ticket (thread included) by id.
 *  - SD2-S2  the intake config is TENANT-wide (it routes every WhatsApp and
 *            widget ticket) but was written under an ORG-scoped admin check,
 *            so an admin of org B re-pointed the whole tenant's inbound
 *            support into org B — and rotated the published widget key.
 *  - SD2-S3  the widget visitor token was HMAC'd with
 *            `process.env.OPENWOP_SESSION_SECRET ?? ''`: unset, the key is the
 *            empty string and anyone can mint a valid token.
 *  - SD2-S4  DSAR left the requester's words in the `subject` (WhatsApp and
 *            widget subjects ARE the first message), and could not reach a form
 *            requester at all when no CRM contact had resolved.
 *  - SD2-S5  assignment accepted any string — a ticket assigned to nobody.
 *  - SD2-S6  an agent-drafted reply was an `assistant-action` approval:
 *            visible to, and decidable by, every member of the TENANT, so an
 *            org-A editor read org B's customer thread in their inbox and could
 *            approve the reply onto org B's ticket.
 *  - SD2-S7  WhatsApp intake read no toggle: with Service desk OFF, inbound
 *            messages still filed tickets and armed SLA clocks.
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createTicket, getTicket, eraseSubjectTickets, listTickets } from '../src/features/service-desk/tickets.js';

let BASE: string;
let server: http.Server;

const setDesk = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('service-desk');
  await saveConfig({ ...d!, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  await setDesk('on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: Record<string, unknown> | undefined }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const out = res.status === 204 ? undefined : (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined; // wire JSON
    return { status: res.status, body: out };
  };
  return { call, get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
type Client = ReturnType<typeof client>;

let n = 0;
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/host/openwop-app/test/login', { email: `sd2-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body!.user as { userId: string }).userId;
}
const sd = (orgId: string, s = ''): string => `/host/openwop-app/service-desk/orgs/${encodeURIComponent(orgId)}${s}`;

/** A shared tenant with two orgs: the owner admins both; `mallory` is admin of
 *  org B only; `alice` is an editor of org A only. */
async function twoOrgTenant(): Promise<{ tenantId: string; owner: Client; mallory: Client; alice: Client; aliceId: string; orgA: string; orgB: string }> {
  const tenantId = `org:sd2-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, tenantId);
  const mallory = client();
  const malloryId = await signup(mallory, tenantId);
  const alice = client();
  const aliceId = await signup(alice, tenantId);
  const a = await owner.post('/host/openwop-app/orgs', { name: 'Support A' });
  const b = await owner.post('/host/openwop-app/orgs', { name: 'Sales B' });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const orgA = a.body!.orgId as string;
  const orgB = b.body!.orgId as string;
  expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgB)}/members`, { displayName: 'M', subject: malloryId, roles: ['admin'] })).status).toBe(201);
  expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'A', subject: aliceId, roles: ['editor'] })).status).toBe(201);
  return { tenantId, owner, mallory, alice, aliceId, orgA, orgB };
}

describe('ADR 0878 — service desk security floor', () => {
  it('SD2-S1: the node surface refuses a ticket in an org the run\'s person is not in', async () => {
    const { tenantId, aliceId, orgB } = await twoOrgTenant();
    const { ticket } = await createTicket({ tenantId, orgId: orgB, subject: 'Org B secret', channel: 'manual', externalKey: 's1', createdBy: 'system',
      firstMessage: { messageId: 'in-1', body: 'my account number is 12345', author: 'contact:c1' } });
    const { buildFeatureSurfaces } = await import('../src/host/featureSurfaces.js');
    const surfaces = buildFeatureSurfaces({ tenantId, runId: 'run-s1', actingUserId: aliceId });
    // The same answer as an unknown id — no existence oracle (ADR 0878 D1).
    expect(await surfaces['service-desk']!.getTicket!({ ticketId: ticket.ticketId })).toEqual({ ticket: null });
  });

  it('SD2-S2: an admin of ONE org cannot re-point the tenant\'s intake (or rotate its widget key)', async () => {
    const { owner, mallory, orgA, orgB } = await twoOrgTenant();
    const set = await owner.put(sd(orgA, '/intake-config'), {});
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const key = (set.body!.config as { publicIntakeKey: string }).publicIntakeKey;
    const hijack = await mallory.put(sd(orgB, '/intake-config'), {});
    expect(hijack.status, JSON.stringify(hijack.body)).toBe(403);
    const after = await owner.get(sd(orgA, '/intake-config'));
    expect((after.body!.config as { defaultOrgId: string; publicIntakeKey: string }).defaultOrgId).toBe(orgA);
    expect((after.body!.config as { publicIntakeKey: string }).publicIntakeKey).toBe(key);
  });

  it('SD2-S3: a visitor token signed with an empty key does not verify', async () => {
    const { verifyVisitorToken } = await import('../src/features/service-desk/widgetRoutes.js');
    const saved = process.env.OPENWOP_SESSION_SECRET;
    delete process.env.OPENWOP_SESSION_SECRET;
    try {
      const id = 'abcdef0123456789abcd';
      const forged = `sdv1.${id}.${createHmac('sha256', '').update(`sd-visitor|${id}`).digest('hex').slice(0, 32)}`;
      expect(verifyVisitorToken(forged, 't-any')).toBeNull();
    } finally {
      process.env.OPENWOP_SESSION_SECRET = saved;
    }
  });

  it('SD2-S4a: DSAR redacts the subject line a WhatsApp first message wrote (Twilio-shaped sender)', async () => {
    const { onWhatsAppInboundForTickets, setIntakeConfig } = await import('../src/features/service-desk/intake.js');
    const tenantId = `t-sd2-s4-${n++}`;
    await setIntakeConfig(tenantId, 'o', 'admin');
    // Twilio's real `From` carries the `whatsapp:` scheme (pre-code review H5).
    await onWhatsAppInboundForTickets({ tenantId, connectionId: 'c', body: { From: 'whatsapp:+15550009', Body: 'my card ends 4242 and I live at 1 Elm St', MessageSid: 'SM1' } });
    const [ticket] = await listTickets(tenantId, 'o');
    expect(ticket).toBeDefined();
    await eraseSubjectTickets(tenantId, '+15550009');
    const after = (await getTicket(tenantId, ticket!.ticketId))!;
    expect(after.messages[0]!.body).toBe('[erased]');
    expect(after.subject).not.toContain('4242');
    expect(JSON.stringify(after)).not.toContain('5550009');
  });

  it('SD2-S4b: DSAR reaches a form requester who never resolved a CRM contact', async () => {
    const tenantId = `t-sd2-s4b-${n++}`;
    const { ticket } = await createTicket({ tenantId, orgId: 'o', subject: 'Form: Contact us', channel: 'form', externalKey: 'form:sub-1', createdBy: 'system:service-desk',
      requester: { email: 'jane@example.com' },
      firstMessage: { messageId: 'form:sub-1', body: 'email: jane@example.com\nname: Jane Roe', author: 'visitor', direction: 'inbound' } });
    await eraseSubjectTickets(tenantId, 'jane@example.com');
    const after = (await getTicket(tenantId, ticket.ticketId))!;
    expect(after.messages[0]!.body).toBe('[erased]');
    expect(JSON.stringify(after)).not.toContain('jane@example.com');
  });

  it('SD2-S5: assignment refuses someone who is not a member of the ticket\'s org', async () => {
    const { owner, orgA } = await twoOrgTenant();
    const c = await owner.post(sd(orgA, '/tickets'), { subject: 'Assign me' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const id = (c.body!.ticket as { ticketId: string }).ticketId;
    const r = await owner.post(sd(orgA, `/tickets/${encodeURIComponent(id)}/assign`), { assigneeMemberId: 'nobody-at-all' });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it('SD2-S6: a drafted reply on an org-B ticket is neither visible to nor decidable by an org-A-only member', async () => {
    const { tenantId, owner, alice, aliceId, orgB } = await twoOrgTenant();
    const { ticket } = await createTicket({ tenantId, orgId: orgB, subject: 'Refund for order 991', channel: 'manual', externalKey: 's6', createdBy: 'system',
      firstMessage: { messageId: 'in-1', body: 'please refund', author: 'contact:c1' } });
    const { enqueueActionWithApproval } = await import('../src/features/assistant/actionApproval.js');
    const action = await enqueueActionWithApproval(tenantId, {
      kind: 'servicedesk.reply', payload: { ticketId: ticket.ticketId, orgId: orgB, channel: 'manual' },
      draft: 'Your refund is approved.', riskLevel: 'medium', reason: 'Support reply', derivedFromUntrusted: true,
    });
    const { getApproval, assertApprovalEligibility } = await import('../src/host/approvalService.js');
    const { mayViewApproval } = await import('../src/host/approvalAudience.js');
    const approval = (await getApproval(action.approvalId!))!;
    expect(await mayViewApproval(tenantId, aliceId, approval)).toBe(false);
    await expect(assertApprovalEligibility(tenantId, aliceId, approval)).rejects.toMatchObject({ code: 'forbidden_scope' });
    // The assistant's OWN decide route never reaches eligibility (pre-code review
    // Blocker 1) — it must refuse too, for a reject as much as an approve, and its
    // list must not show the draft.
    const listed = await alice.get('/host/openwop-app/assistant/pending-actions');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(action.actionId);
    const rejected = await alice.post(`/host/openwop-app/assistant/pending-actions/${encodeURIComponent(action.actionId)}/reject`, {});
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(403);
    const edited = await alice.call('PATCH', `/host/openwop-app/assistant/pending-actions/${encodeURIComponent(action.actionId)}`, { draft: 'x', expectedContentHash: 'h' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(404);
    // …while the owner (writer in org B) still sees it.
    const ownerList = await owner.get('/host/openwop-app/assistant/pending-actions');
    expect(JSON.stringify(ownerList.body)).toContain(action.actionId);
  });

  it('SD2-S7: WhatsApp intake files nothing while Service desk is OFF', async () => {
    const { onWhatsAppInboundForTickets, setIntakeConfig } = await import('../src/features/service-desk/intake.js');
    const tenantId = `t-sd2-s7-${n++}`;
    await setIntakeConfig(tenantId, 'org-s7', 'admin');
    await setDesk('off');
    try {
      await onWhatsAppInboundForTickets({ tenantId, connectionId: 'c', body: { From: '+15550101', Body: 'hello', MessageSid: 'SMs7' } });
      expect(await listTickets(tenantId, 'org-s7')).toEqual([]);
    } finally {
      await setDesk('on');
    }
  });
});

describe('ADR 0878 — grade-code follow-ups (each proved or reasoned red before its fix)', () => {
  it('SD2CD-2: a member\'s reply is authored under ONE `user:` prefix, so their DSAR reaches it', async () => {
    const { tenantId, owner, orgA } = await twoOrgTenant();
    const id = ((await owner.post(sd(orgA, '/tickets'), { subject: 'Note me' })).body!.ticket as { ticketId: string }).ticketId;
    const r = await owner.post(sd(orgA, `/tickets/${id}/messages`), { body: 'my private note', direction: 'internal' });
    const msg = (r.body!.ticket as { messages: Array<{ author: string }> }).messages.at(-1)!;
    expect(msg.author.startsWith('user:user:')).toBe(false);
    await eraseSubjectTickets(tenantId, msg.author);
    expect((await getTicket(tenantId, id))!.messages.at(-1)!.body).toBe('[erased]');
  });

  it('SD2CD-3: a support-reply approval from BEFORE rows carried an org is still that org\'s', async () => {
    const { tenantId, aliceId, orgB } = await twoOrgTenant();
    const { ticket } = await createTicket({ tenantId, orgId: orgB, subject: 'Legacy', channel: 'manual', externalKey: 'legacy', createdBy: 'system' });
    const { enqueuePendingAction } = await import('../src/features/assistant/assistantService.js');
    const { createAssistantActionApproval } = await import('../src/host/approvalService.js');
    const { mayViewApproval } = await import('../src/host/approvalAudience.js');
    // The pre-ADR-0878 shape: no `orgId` on the action, none on the approval.
    const action = await enqueuePendingAction(tenantId, { kind: 'servicedesk.reply', payload: { ticketId: ticket.ticketId }, draft: 'old draft' });
    const approval = await createAssistantActionApproval({ tenantId, actionId: action.actionId, proposal: 'servicedesk.reply: "old draft"', rosterId: 'r', persona: 'p' });
    expect(approval.orgId).toBeUndefined();
    expect(await mayViewApproval(tenantId, aliceId, approval)).toBe(false);
  });

  it('SD2CD-12: a support reply\'s ticket cannot be re-pointed by an edit (422, not a silent 200)', async () => {
    const { tenantId, owner, orgA } = await twoOrgTenant();
    const { ticket } = await createTicket({ tenantId, orgId: orgA, subject: 'Edit me', channel: 'manual', externalKey: 'edit', createdBy: 'system' });
    const { enqueueActionWithApproval, contentHashOf } = await import('../src/features/assistant/actionApproval.js');
    const action = await enqueueActionWithApproval(tenantId, { kind: 'servicedesk.reply', payload: { ticketId: ticket.ticketId }, draft: 'hi' });
    const r = await owner.call('PATCH', `/host/openwop-app/assistant/pending-actions/${encodeURIComponent(action.actionId)}`, { payload: { ticketId: 'tkt-other' }, expectedContentHash: contentHashOf(action) });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
  });

  it('SD2CD-15: a bare digit id in a DSAR does not erase a customer whose number has those digits', async () => {
    const tenantId = `t-sd2cd15-${n++}`;
    const { ticket } = await createTicket({ tenantId, orgId: 'o', subject: 'Form: Order', channel: 'form', externalKey: 'f15', createdBy: 'system',
      requester: { phone: '+15550177' }, firstMessage: { messageId: 'f15', body: 'my order', author: 'visitor', direction: 'inbound' } });
    await eraseSubjectTickets(tenantId, '15550177');
    expect((await getTicket(tenantId, ticket.ticketId))!.messages[0]!.body).toBe('my order');
    await eraseSubjectTickets(tenantId, '+15550177');
    expect((await getTicket(tenantId, ticket.ticketId))!.messages[0]!.body).toBe('[erased]');
  });
});
