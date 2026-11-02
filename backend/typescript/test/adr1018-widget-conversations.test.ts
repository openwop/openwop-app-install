/**
 * ADR 1018 D2/D3 — public widget conversations, end to end over real HTTP.
 *
 * Breaks if:
 *  - a visitor's second turn reaches the model WITHOUT the first (the transcript the
 *    embed shows was a lie, `CW68WF-2`), or a prior visitor turn reaches it unfenced;
 *  - two visitors with different session ids share a thread, or the shared `'anon'`
 *    fallback (no session id) threads at all;
 *  - the history a model receives carries anything but text (ADR 1002: no run id);
 *  - the operator cannot read what visitors asked (`CW68WF-3`), a viewer can, another
 *    org can, or a delete leaves the thread behind;
 *  - a failed dispatch stores an unanswered turn.
 *
 * The dispatch mock returns a DIFFERENT reply per call, so a test that reads back the
 * wrong turn cannot pass on a coincidence.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';

const { calls, failNext, emptyNext } = vi.hoisted(() => ({ calls: [] as Array<Array<{ role: string; content: unknown }>>, failNext: { on: false }, emptyNext: { on: false } }));
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...real,
    dispatchManagedChat: vi.fn(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
      calls.push(req.messages.map((m) => ({ ...m })));
      if (failNext.on) { failNext.on = false; throw new Error('provider down'); }
      if (emptyNext.on) { emptyNext.on = false; return { completion: '', usage: { inputTokens: 1, outputTokens: 0 } }; }
      return { completion: `reply-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    }),
  };
});

import { createApp } from '../src/index.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

let BASE: string;
let server: http.Server;
const AGENT = 'vendor.openwop-app.code-exec.agents.default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
const PRIOR_SUPERADMINS = process.env.OPENWOP_SUPERADMIN_TENANTS;
afterAll(async () => {
  if (PRIOR_SUPERADMINS === undefined) delete process.env.OPENWOP_SUPERADMIN_TENANTS; else process.env.OPENWOP_SUPERADMIN_TENANTS = PRIOR_SUPERADMINS;
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(() => { calls.length = 0; failNext.on = false; emptyNext.on = false; });

interface Res { status: number; body: Record<string, unknown> | undefined }
interface Client { call: (method: string, p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as Record<string, unknown> | undefined) };
    },
  };
}
let n = 0;
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.call('POST', '/host/openwop-app/test/login', { email: `cw-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body!.user as { userId: string }).userId;
}
async function setup(): Promise<{ owner: Client; viewer: Client; orgId: string; widgetTenant: string; widgetId: string; token: string }> {
  const tenantId = `org:cw-${Date.now()}-${n++}`;
  // ADR 1018 D8 — these widgets answer on the managed key, which only a listed
  // superadmin tenant may use.
  process.env.OPENWOP_SUPERADMIN_TENANTS = [process.env.OPENWOP_SUPERADMIN_TENANTS, tenantId].filter(Boolean).join(',');
  const owner = client();
  await signup(owner, tenantId);
  const viewer = client();
  const viewerId = await signup(viewer, tenantId);
  const org = await owner.call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = org.body!.orgId as string;
  const add = await owner.call('POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  const w = await owner.call('POST', `/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets`, { agentId: AGENT, allowedDomains: ['acme.com'] });
  expect(w.status, JSON.stringify(w.body)).toBe(201);
  const widget = w.body!.widget as { widgetId: string; token: string; tenantId: string };
  return { owner, viewer, orgId, widgetTenant: widget.tenantId, widgetId: widget.widgetId, token: widget.token };
}
const visit = (token: string, message: string, sessionId?: string): Promise<Response> =>
  fetch(`${BASE}/host/openwop-app/public/widget/message`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.acme.com' }, body: JSON.stringify({ token, message, ...(sessionId ? { sessionId } : {}) }) });
const conv = (orgId: string, widgetId: string): string => `/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets/${widgetId}/conversations`;
const SID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

describe('ADR 1018 D2 — the model sees the visitor thread', () => {
  it('a second turn carries the first exchange, fenced, before the new message', async () => {
    const { token } = await setup();
    expect((await visit(token, 'Which plans do you sell?', SID_A)).status).toBe(200);
    expect((await visit(token, 'What about the second one?', SID_A)).status).toBe(200);
    expect(calls).toHaveLength(2);
    const second = calls[1]!;
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(String(second[1]!.content)).toContain('Which plans do you sell?');
    expect(String(second[1]!.content)).toMatch(/UNTRUSTED/); // re-fenced, every time
    expect(second[2]!.content).toBe('reply-1');
    expect(String(second[3]!.content)).toContain('What about the second one?');
    // ADR 1002 — the history is text: no run/ask/conversation id, no timestamp.
    for (const m of second.slice(1, 3)) expect(String(m.content)).not.toMatch(/run[_-]?id|askId|conversationId|\d{4}-\d{2}-\d{2}T/i);
  });

  it('different sessions never share a thread', async () => {
    const { token } = await setup();
    await visit(token, 'secret from A', SID_A);
    await visit(token, 'hello from B', SID_B);
    expect(calls[1]!.map((m) => m.role)).toEqual(['system', 'user']);
    expect(JSON.stringify(calls[1])).not.toContain('secret from A');
  });

  it('no session id (the shared anon fallback) and a short id stay stateless', async () => {
    const { token } = await setup();
    await visit(token, 'first without id');
    await visit(token, 'second without id');
    await visit(token, 'short id one', 'short');
    await visit(token, 'short id two', 'short');
    for (const c of calls) expect(c.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('an EMPTY reply is not stored either (grade-code CW68C-5)', async () => {
    const { token } = await setup();
    emptyNext.on = true;
    expect((await visit(token, 'blank answer turn', SID_A)).status).toBe(200);
    await visit(token, 'next', SID_A);
    expect(JSON.stringify(calls[1])).not.toContain('blank answer turn');
  });

  it('the raw session id is stored nowhere (grade-code CW68C-2)', async () => {
    const { token } = await setup();
    const sid = 'rawsid-cccccccc-3333-4333-8333-cccccccccccc';
    await visit(token, 'hello', sid);
    await visit(token, 'again', sid);
    const rows = await hostExtStorage().kvList('hostext:chatwidget:');
    expect(rows.length).toBeGreaterThan(0); // non-vacuous: the turn wrote counters + a thread
    expect(rows.filter((r) => r.key.includes(sid) || r.value.includes(sid))).toEqual([]);
  });

  it('a failed dispatch stores nothing, so the next turn sees no unanswered message', async () => {
    const { token } = await setup();
    failNext.on = true;
    expect((await visit(token, 'lost turn', SID_A)).status).toBeGreaterThanOrEqual(500);
    await visit(token, 'retry', SID_A);
    expect(JSON.stringify(calls[1])).not.toContain('lost turn');
  });
});

describe('grade-ux CW68U-2 — a widget must name an agent the gateway can run', () => {
  it('refuses an unknown agent id on create and on re-assignment', async () => {
    const { owner, orgId, widgetId } = await setup();
    const base = `/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets`;
    const bad = await owner.call('POST', base, { agentId: 'no-such-agent', allowedDomains: ['acme.com'] });
    expect(bad.status).toBe(400);
    expect((bad.body!.details as { field?: string }).field).toBe('agentId');
    expect((await owner.call('PATCH', `${base}/${widgetId}`, { agentId: 'no-such-agent' })).status).toBe(400);
    expect(((await owner.call('GET', `${base}/${widgetId}`)).body!.widget as { agentId: string }).agentId).toBe(AGENT);
  });

  it('re-enabling a widget whose agent is gone is refused (CW68U-16)', async () => {
    const { owner, orgId, widgetTenant, widgetId } = await setup();
    const base = `/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets`;
    // The roster-deletion hook's end state: bound to an agent that no longer resolves, disabled.
    const { patchWidget } = await import('../src/features/chat-widget/widgetService.js');
    await patchWidget(widgetTenant, orgId, widgetId, { agentId: 'deleted-agent', enabled: false });
    const r = await owner.call('PATCH', `${base}/${widgetId}`, { enabled: true });
    expect(r.status).toBe(400);
    expect(((await owner.call('GET', `${base}/${widgetId}`)).body!.widget as { enabled: boolean }).enabled).toBe(false);
    // With a servable agent named in the same PATCH, it turns back on.
    expect((await owner.call('PATCH', `${base}/${widgetId}`, { enabled: true, agentId: AGENT })).status).toBe(200);
  });
});

describe('ADR 1018 D3 — the operator reads recent conversations', () => {
  it('lists summaries, reads one thread, and deletes it; a viewer and another org cannot', async () => {
    const { owner, viewer, orgId, widgetId, token } = await setup();
    await visit(token, 'Do you ship to Canada?', SID_A);
    await visit(token, 'And to Mexico?', SID_A);

    const list = await owner.call('GET', conv(orgId, widgetId));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const items = list.body!.conversations as Array<{ threadId: string; messageCount: number; preview: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.messageCount).toBe(4);
    expect(items[0]!.preview).toBe('Do you ship to Canada?');
    expect(JSON.stringify(list.body)).not.toContain(SID_A); // the raw session id never leaves

    const one = await owner.call('GET', `${conv(orgId, widgetId)}/${items[0]!.threadId}`);
    expect(one.status).toBe(200);
    expect((one.body!.conversation as { messages: Array<{ role: string; text: string }> }).messages.map((m) => `${m.role}:${m.text}`))
      .toEqual(['visitor:Do you ship to Canada?', 'agent:reply-1', 'visitor:And to Mexico?', 'agent:reply-2']);

    // workspace:write — a viewer of the same org is refused the read AND the delete.
    expect((await viewer.call('GET', conv(orgId, widgetId))).status).toBe(403);
    expect((await viewer.call('DELETE', `${conv(orgId, widgetId)}/${items[0]!.threadId}`)).status).toBe(403);

    // Another org's owner, with this widget id, gets a uniform 404.
    const other = await setup();
    expect((await other.owner.call('GET', conv(other.orgId, widgetId))).status).toBe(404);

    expect((await owner.call('DELETE', `${conv(orgId, widgetId)}/${items[0]!.threadId}`)).status).toBe(204);
    expect(((await owner.call('GET', conv(orgId, widgetId))).body!.conversations as unknown[])).toHaveLength(0);
    // A deleted thread is gone from the model's view too.
    await visit(token, 'after delete', SID_A);
    expect(calls.at(-1)!.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('concurrent appends leave the summary matching the thread (grade-code N1)', async () => {
    const { orgId, widgetTenant, widgetId } = await setup();
    const vt = await import('../src/features/chat-widget/visitorThreads.js');
    const w = { tenantId: widgetTenant, orgId, widgetId } as Parameters<typeof vt.appendExchange>[0];
    const threadId = vt.threadIdFor(widgetId, SID_B)!;
    // Distinct, increasing timestamps so a summary written out of order is detectable.
    await Promise.all(Array.from({ length: 6 }, (_, i) => vt.appendExchange(w, threadId, `q${i}`, `a${i}`, `2026-10-31T10:00:0${i}.000Z`)));
    const thread = await vt.getThread(w, threadId);
    const [summary] = await vt.listThreadSummaries(w);
    expect(summary!.messageCount).toBe(thread!.messages.length);
    expect(summary!.updatedAt).toBe(thread!.updatedAt);
  });

  it('a summary for an older thread revision never replaces a newer one (grade-code N1)', async () => {
    // The race, made deterministic: the summary of a LATER append (rev 3) is already
    // stored when the write for an earlier revision lands, with a later wall clock.
    const { orgId, widgetTenant, widgetId } = await setup();
    const vt = await import('../src/features/chat-widget/visitorThreads.js');
    const w = { tenantId: widgetTenant, orgId, widgetId } as Parameters<typeof vt.appendExchange>[0];
    const threadId = vt.threadIdFor(widgetId, SID_A)!;
    const key = `hostext:chatwidget:threadsum:${widgetTenant}:${orgId}:${widgetId}:${threadId}`;
    await hostExtStorage().kvSet(key, JSON.stringify({ tenantId: widgetTenant, orgId, widgetId, threadId, startedAt: '2026-10-31T08:00:00.000Z', updatedAt: '2026-10-31T09:00:00.000Z', messageCount: 6, preview: 'later', rev: 3 }));
    await vt.appendExchange(w, threadId, 'earlier', 'reply', '2026-10-31T10:00:00.000Z'); // thread rev 1
    const [summary] = await vt.listThreadSummaries(w);
    expect(summary!.messageCount).toBe(6);
    expect(summary!.preview).toBe('later');
  });

  it('deleting the widget deletes its threads', async () => {
    const { owner, orgId, widgetTenant, widgetId, token } = await setup();
    await visit(token, 'hello', SID_A);
    const { listThreadSummaries } = await import('../src/features/chat-widget/visitorThreads.js');
    const coords = { tenantId: widgetTenant, orgId, widgetId };
    expect(await listThreadSummaries(coords)).toHaveLength(1); // non-vacuous: the coordinates find it
    expect((await owner.call('DELETE', `/host/openwop-app/chat-widget/orgs/${encodeURIComponent(orgId)}/widgets/${widgetId}`)).status).toBe(204);
    // The widget row is gone, so read the store directly by the widget's coordinates.
    expect(await listThreadSummaries(coords)).toEqual([]);
  });
});
