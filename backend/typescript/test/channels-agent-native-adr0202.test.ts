/**
 * ADR 0202 — agent-native channels, Phase 1 route-level coverage: the response
 * policy (add-time stamp + owner-editable + roster surfacing), and AI catch-up
 * (member-gate, no-agent 400, no in-channel append, run metadata).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

const CH = '/v1/host/openwop-app/channels';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  getAgentRegistry().register({ agentId: 'nat.a', persona: 'Agent A', modelClass: 'general' } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
  getAgentRegistry().register({ agentId: 'nat.b', persona: 'Agent B', modelClass: 'general' } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}
type Client = ReturnType<typeof client>;

const TENANT = `t-adr0200-${Date.now()}`;
async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `adr0200-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} P`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string };
}

function agentRow(detail: Res, agentId: string): any {
  return (detail.body.channel.roster as any[]).find((r) => r.subjectRef === `agent:${agentId}`);
}

describe('ADR 0202 D1 — response policy', () => {
  it('the first agent added is stamped all; a second defaults to mention', async () => {
    const { c } = await login('owner');
    const id = (await c.post(CH, { name: `p-${n}`, visibility: 'public', agentIds: ['nat.a'] })).body.channel.conversationId as string;
    let detail = await c.get(`${CH}/${id}`);
    expect(agentRow(detail, 'nat.a').responsePolicy).toBe('all');

    expect((await c.post(`${CH}/${id}/members`, { agentId: 'nat.b' })).status).toBe(200);
    detail = await c.get(`${CH}/${id}`);
    expect(agentRow(detail, 'nat.a').responsePolicy).toBe('all'); // A retained
    expect(agentRow(detail, 'nat.b').responsePolicy).toBe('mention'); // B defaulted
  });

  it('the owner can change an agent policy; a non-owner cannot', async () => {
    const { c: ownerC } = await login('owner');
    const id = (await ownerC.post(CH, { name: `p2-${n}`, visibility: 'public', agentIds: ['nat.a'] })).body.channel.conversationId as string;
    expect((await ownerC.put(`${CH}/${id}/agents/nat.a/policy`, { policy: 'mention' })).status).toBe(200);
    expect(agentRow(await ownerC.get(`${CH}/${id}`), 'nat.a').responsePolicy).toBe('mention');

    const { c: memberC } = await login('member');
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);
    expect((await memberC.put(`${CH}/${id}/agents/nat.a/policy`, { policy: 'all' })).status).toBe(403);
    expect((await ownerC.put(`${CH}/${id}/agents/nat.a/policy`, { policy: 'bogus' })).status).toBe(400);
  });
});

describe('ADR 0202 D2 — AI catch-up', () => {
  it('a channel with NO agent member 400s (no phantom host summarizer)', async () => {
    const { c } = await login('owner');
    const id = (await c.post(CH, { name: `c-${n}`, visibility: 'public' })).body.channel.conversationId as string;
    expect((await c.post(`${CH}/${id}/catchup`)).status).toBe(400);
  });

  it('a member gets a runId + unreadCount; the summary is NOT posted in-channel', async () => {
    const { c } = await login('owner');
    const id = (await c.post(CH, { name: `c2-${n}`, visibility: 'public', agentIds: ['nat.a'] })).body.channel.conversationId as string;
    await c.post(`${CH}/${id}/messages`, { content: 'first' });
    await c.post(`${CH}/${id}/messages`, { content: 'second' });
    const before = (await c.get(`${CH}/${id}/messages`)).body.messages.length as number;

    const catchup = await c.post(`${CH}/${id}/catchup`);
    expect(catchup.status, JSON.stringify(catchup.body)).toBe(202);
    expect(typeof catchup.body.runId).toBe('string');
    expect(typeof catchup.body.unreadCount).toBe('number');

    // The run posts NOTHING into the channel (conversationId omitted) — the
    // message count is unchanged (a live agent reply would have appended).
    await new Promise((r) => setTimeout(r, 200));
    const after = (await c.get(`${CH}/${id}/messages`)).body.messages.length as number;
    expect(after).toBe(before);
  });

  it('a non-member is denied catch-up on a private channel (404 mask)', async () => {
    const { c } = await login('owner');
    const id = (await c.post(CH, { name: `c3-${n}`, visibility: 'private', agentIds: ['nat.a'] })).body.channel.conversationId as string;
    const { c: other } = await login('outsider');
    expect((await other.post(`${CH}/${id}/catchup`)).status).toBe(404);
  });
});
