/**
 * ADR 0878 D3 — a reply is delivered, and the thread says what happened. Before
 * this an outbound message was appended and sent nowhere (SD2WF-1).
 *
 * Route-level where the lane is HTTP (who mints the id, what gets delivered),
 * service-level for the state machine.
 *
 * Tracker TST-BHB-2. Red when (sabotage-witnessed, wave 62): the no-reply-channel
 * branch stops recording `not_sent`; an internal note reaches `deliverOutbound`;
 * `deliverOutbound` delivers a non-outbound message; the widget sub-toggle stops
 * deciding `visible` vs `not_sent`; a final state becomes retryable or a stale
 * `pending` stops reading `unknown`; a retry stops counting attempts; or the executor
 * marks an undelivered reply `sent`.
 *
 * Recorded guards (each probed on its own, wave 62):
 *  - "a caller-supplied id cannot name another message" is held THREE times: the
 *    route mints `client:<userId>:<key>` (routes.ts), `appendMessageResult` refuses
 *    to re-append an existing id, and `deliverOutbound` refuses a non-outbound
 *    message. The route mint is observable here (the reply lands under a
 *    `client:` id); the direction check is asserted directly.
 *  - "delivered once" is a double guard: the executor delivers only on the append
 *    that wrote the reply, and `deliverOutbound` itself returns an existing row
 *    without re-sending. A single-guard sabotage stays green by design.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createTicket, appendMessage, getTicket, listTickets } from '../src/features/service-desk/tickets.js';
import { deliverOutbound, deliveries, listDeliveries, STALE_PENDING_MS } from '../src/features/service-desk/delivery.js';
import type { StartRunDeps } from '../src/host/runStarter.js';

let BASE: string;
let server: http.Server;
let runDeps: StartRunDeps;
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  await saveConfig({ ...getToggleDefault(id)!, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  runDeps = { storage: app.locals.storage, hostSuite: app.locals.hostSuite };
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  await setToggle('service-desk', 'on');
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
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined }; // wire JSON
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; tenantId: string; orgId: string }> {
  const tenantId = `org:sd2d-${Date.now()}-${n++}`;
  const owner = client();
  expect((await owner.post('/host/openwop-app/test/login', { email: `sd2d-${n++}@acme.test`, tenantId })).status).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Support' });
  return { owner, tenantId, orgId: org.body!.orgId as string };
}
const sd = (orgId: string, s = ''): string => `/host/openwop-app/service-desk/orgs/${encodeURIComponent(orgId)}${s}`;
type Delivered = Record<string, { state: string; code?: string; attempts: number }>;

describe('ADR 0878 D3 — reply delivery', () => {
  it('a reply on a ticket with no reply channel is recorded NOT sent, and says why; an internal note is never delivered', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const id = ((await owner.post(sd(orgId, '/tickets'), { subject: 'Phone call follow-up' })).body!.ticket as { ticketId: string }).ticketId;
    const reply = await owner.post(sd(orgId, `/tickets/${id}/messages`), { body: 'We refunded you.', direction: 'outbound' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body!.delivery).toMatchObject({ state: 'not_sent', code: 'no_reply_channel' });
    const note = await owner.post(sd(orgId, `/tickets/${id}/messages`), { body: 'internal', direction: 'internal' });
    expect(note.body!.delivery).toBeUndefined();
    expect(Object.keys(note.body!.deliveries as Delivered)).toHaveLength(1);
  });

  it('a caller-supplied id can never name (and so deliver) a message someone else wrote', async () => {
    const { owner, tenantId, orgId } = await ownerWithOrg();
    const { ticket } = await createTicket({ tenantId, orgId, subject: 'Widget: hi', channel: 'widget', externalKey: `widget:v-${n++}`, replyChannel: { kind: 'widget' }, createdBy: 'system',
      firstMessage: { messageId: 'w:1', body: 'hi', author: 'visitor', direction: 'inbound' } });
    await appendMessage(tenantId, ticket.ticketId, { messageId: 'note-secret', body: 'internal: customer is a fraud risk', author: 'user:x', direction: 'internal' });
    const r = await owner.post(sd(orgId, `/tickets/${ticket.ticketId}/messages`), { body: 'Thanks!', direction: 'outbound', messageId: 'note-secret' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (await getTicket(tenantId, ticket.ticketId))!;
    expect(after.messages.filter((m) => m.messageId === 'note-secret')).toHaveLength(1);
    expect(after.messages.find((m) => m.messageId === 'note-secret')!.direction).toBe('internal');
    // The route minted its own id for the reply (the first of the three guards).
    expect(after.messages.some((m) => m.direction === 'outbound' && m.messageId.startsWith('client:') && m.messageId.endsWith(':note-secret'))).toBe(true);
    expect((await listDeliveries(tenantId, ticket.ticketId))['note-secret']).toBeUndefined();
    // …and the service itself refuses to deliver a non-outbound message.
    await expect(deliverOutbound({ tenantId, ticketId: ticket.ticketId, messageId: 'note-secret' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('widget: visible while the widget sub-toggle is on, not_sent while it is off', async () => {
    const { owner, tenantId, orgId } = await ownerWithOrg();
    const { ticket } = await createTicket({ tenantId, orgId, subject: 'Widget: help', channel: 'widget', externalKey: `widget:v-${n++}`, replyChannel: { kind: 'widget' }, createdBy: 'system' });
    await setToggle('service-desk.widget', 'on');
    try {
      const on = await owner.post(sd(orgId, `/tickets/${ticket.ticketId}/messages`), { body: 'On it', direction: 'outbound' });
      expect(on.body!.delivery).toMatchObject({ state: 'visible' });
    } finally { await setToggle('service-desk.widget', 'off'); }
    const off = await owner.post(sd(orgId, `/tickets/${ticket.ticketId}/messages`), { body: 'Still on it', direction: 'outbound' });
    expect(off.body!.delivery).toMatchObject({ state: 'not_sent', code: 'widget_off' });
  });

  it('WhatsApp: intake captures the channel + normalized number, a reply reaches the governed send, and a failure is retryable', async () => {
    const { owner, tenantId, orgId } = await ownerWithOrg();
    const { onWhatsAppInboundForTickets, setIntakeConfig } = await import('../src/features/service-desk/intake.js');
    await setIntakeConfig(tenantId, orgId, 'admin');
    await onWhatsAppInboundForTickets({ tenantId, connectionId: 'conn-wa', body: { From: 'whatsapp:+15550123', Body: 'my order is late', MessageSid: 'SMd1' } });
    const [ticket] = await listTickets(tenantId, orgId);
    expect(ticket!.replyChannel).toEqual({ kind: 'whatsapp', connectionId: 'conn-wa' });
    expect(ticket!.requester).toEqual({ phone: '+15550123' });
    expect(ticket!.messages[0]!.author).toBe('wa:+15550123');
    // WhatsApp is off for this tenant: the governed send refuses, typed — and the
    // thread SAYS so instead of reading as sent.
    const r = await owner.post(sd(orgId, `/tickets/${ticket!.ticketId}/messages`), { body: 'Sorry — shipping today.', direction: 'outbound' });
    expect(r.body!.delivery).toMatchObject({ state: 'failed', code: 'feature_disabled' });
    const messageId = (r.body!.ticket as { messages: Array<{ messageId: string; direction: string }> }).messages.at(-1)!.messageId;
    const retry = await owner.post(sd(orgId, `/tickets/${ticket!.ticketId}/messages/${encodeURIComponent(messageId)}/retry`));
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body!.delivery).toMatchObject({ state: 'failed', attempts: 2 });
  });

  it('retry refuses a final state, and a crash-orphaned pending becomes retryable as `unknown`', async () => {
    const { owner, tenantId, orgId } = await ownerWithOrg();
    const id = ((await owner.post(sd(orgId, '/tickets'), { subject: 'x' })).body!.ticket as { ticketId: string }).ticketId;
    const r = await owner.post(sd(orgId, `/tickets/${id}/messages`), { body: 'hello', direction: 'outbound' });
    const messageId = (r.body!.ticket as { messages: Array<{ messageId: string }> }).messages.at(-1)!.messageId;
    // not_sent is final.
    expect((await owner.post(sd(orgId, `/tickets/${id}/messages/${encodeURIComponent(messageId)}/retry`))).status).toBe(409);
    // A pending row older than the stale window (the process died mid-send).
    const key = `${tenantId}:${id}:${messageId}`;
    const row = (await deliveries.get(key))!;
    await deliveries.put({ ...row, state: 'pending', at: new Date(Date.now() - STALE_PENDING_MS - 1000).toISOString() });
    expect((await listDeliveries(tenantId, id))[messageId]!.state).toBe('unknown');
    const retried = await owner.post(sd(orgId, `/tickets/${id}/messages/${encodeURIComponent(messageId)}/retry`));
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body!.delivery).toMatchObject({ state: 'not_sent', attempts: 2 });
  });

  it('an approved agent draft is delivered by the executor (once)', async () => {
    const { tenantId, orgId } = await ownerWithOrg();
    const { ticket } = await createTicket({ tenantId, orgId, subject: 'Widget: where is it', channel: 'widget', externalKey: `widget:v-${n++}`, replyChannel: { kind: 'widget' }, createdBy: 'system' });
    const { enqueueActionWithApproval } = await import('../src/features/assistant/actionApproval.js');
    const action = await enqueueActionWithApproval(tenantId, { kind: 'servicedesk.reply', payload: { ticketId: ticket.ticketId }, draft: 'It ships tomorrow.', riskLevel: 'medium' });
    expect(action.orgId).toBe(orgId); // stamped from the TICKET
    const { executeApprovedAction } = await import('../src/features/assistant/actionExecution.js');
    await executeApprovedAction(runDeps, tenantId, action, 'approver-1');
    await executeApprovedAction(runDeps, tenantId, action, 'approver-1');
    const d = await listDeliveries(tenantId, ticket.ticketId);
    expect(d[`reply:${action.actionId}`]).toMatchObject({ attempts: 1 });
    // grade-code SD2CD-1 — the widget sub-toggle is off here, so the visitor cannot
    // see it: the action is `failed`, not `sent` (it used to read `sent` regardless).
    expect(d[`reply:${action.actionId}`]!.state).toBe('not_sent');
    const { getPendingAction } = await import('../src/features/assistant/assistantService.js');
    expect((await getPendingAction(tenantId, action.actionId))!.status).toBe('failed');
  });

  it('an approved draft that IS delivered reads `sent`', async () => {
    const { tenantId, orgId } = await ownerWithOrg();
    const { ticket } = await createTicket({ tenantId, orgId, subject: 'Widget: ok', channel: 'widget', externalKey: `widget:v-${n++}`, replyChannel: { kind: 'widget' }, createdBy: 'system' });
    await setToggle('service-desk.widget', 'on');
    try {
      const { enqueueActionWithApproval } = await import('../src/features/assistant/actionApproval.js');
      const action = await enqueueActionWithApproval(tenantId, { kind: 'servicedesk.reply', payload: { ticketId: ticket.ticketId }, draft: 'Done.' });
      const { executeApprovedAction } = await import('../src/features/assistant/actionExecution.js');
      await executeApprovedAction(runDeps, tenantId, action, 'approver-1');
      const { getPendingAction } = await import('../src/features/assistant/assistantService.js');
      expect((await getPendingAction(tenantId, action.actionId))!.status).toBe('sent');
    } finally { await setToggle('service-desk.widget', 'off'); }
  });
});
