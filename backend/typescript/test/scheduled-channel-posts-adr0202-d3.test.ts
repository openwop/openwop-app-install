/**
 * ADR 0202 D3 + D6 — scheduled agent posts, route-level coverage.
 *
 * D3 (channel scope): owner-gated create / member-gated list on
 * `/scheduled-chats/channels/:channelId/chats`, the bound agent MUST be a channel
 * member, and `conversationId` is FORCED to the channelId (a channel schedule can't
 * target a foreign conversation). Composes the EXISTING scheduler — one job per chat.
 *
 * D6 (org create-path hardening): the agent must resolve and the caller must be able
 * to SEE the bound conversation (else 404) — closing the pre-existing "validates
 * nothing" gap on the org path.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { getJob } from '../src/host/schedulingService.js';

const CH = '/v1/host/openwop-app/channels';
const schedCh = (id: string, suffix = ''): string => `/v1/host/openwop-app/scheduled-chats/channels/${encodeURIComponent(id)}/chats${suffix}`;
const schedOrg = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/scheduled-chats/orgs/${encodeURIComponent(orgId)}/chats${suffix}`;

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const reg = getAgentRegistry();
  reg.register({ agentId: 'sch.a', persona: 'Scheduler Agent A', modelClass: 'general' } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
  reg.register({ agentId: 'sch.b', persona: 'Scheduler Agent B', modelClass: 'general' } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
type Client = ReturnType<typeof client>;

const TENANT = `t-d3-${Date.now()}`;
async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `d3-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} P`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string };
}

const CRON = '0 9 * * *';

/** Poll until `pred` holds or the timeout elapses (for async event-bus propagation). */
async function waitFor(pred: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ADR 0202 D3 — channel-scoped scheduled posts', () => {
  it('owner schedules a recurring post for a channel-member agent; conversationId is forced to the channel; one job binds', async () => {
    const { c } = await login('owner');
    const id = (await c.post(CH, { name: `d3-${n}`, visibility: 'public', agentIds: ['sch.a'] })).body.channel.conversationId as string;

    // A body conversationId is IGNORED — the schedule always posts in-channel.
    const created = await c.post(schedCh(id), { agentId: 'sch.a', prompt: 'daily standup', cronExpr: CRON, conversationId: 'attacker-controlled' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.chat.channelId).toBe(id);
    expect(created.body.chat.orgId).toBeUndefined();
    expect(created.body.chat.conversationId).toBe(id); // forced, not the body value
    expect(await getJob(`schedchat-${created.body.chat.chatId}`)).not.toBeNull();

    const list = await c.get(schedCh(id));
    expect(list.status).toBe(200);
    expect(list.body.chats.some((x: any) => x.chatId === created.body.chat.chatId)).toBe(true);
  });

  it('rejects scheduling an agent that is NOT a channel member (M3)', async () => {
    const { c } = await login('owner');
    const id = (await c.post(CH, { name: `d3m-${n}`, visibility: 'public', agentIds: ['sch.a'] })).body.channel.conversationId as string;
    const r = await c.post(schedCh(id), { agentId: 'sch.b', prompt: 'x', cronExpr: CRON }); // sch.b not added
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('create is owner-gated; list is member-gated; a non-member learns nothing (404)', async () => {
    const { c: owner } = await login('owner');
    const { c: member, userId: memberId } = await login('member');
    const { c: stranger } = await login('stranger');
    const id = (await owner.post(CH, { name: `d3g-${n}`, visibility: 'private', agentIds: ['sch.a'] })).body.channel.conversationId as string;
    await owner.post(`${CH}/${id}/members`, { userId: memberId });

    // Non-owner member: may list, may NOT create.
    expect((await member.post(schedCh(id), { agentId: 'sch.a', prompt: 'p', cronExpr: CRON })).status).toBe(403);
    expect((await member.get(schedCh(id))).status).toBe(200);

    // Non-member of a private channel: 404-masked on both.
    expect((await stranger.get(schedCh(id))).status).toBe(404);
    expect((await stranger.post(schedCh(id), { agentId: 'sch.a', prompt: 'p', cronExpr: CRON })).status).toBe(404);
  });

  it('owner can pause then delete a channel schedule; a non-owner cannot pause; the job deregisters', async () => {
    const { c: owner } = await login('owner');
    const { c: member, userId: memberId } = await login('member');
    const id = (await owner.post(CH, { name: `d3d-${n}`, visibility: 'private', agentIds: ['sch.a'] })).body.channel.conversationId as string;
    await owner.post(`${CH}/${id}/members`, { userId: memberId });
    const chatId = (await owner.post(schedCh(id), { agentId: 'sch.a', prompt: 'p', cronExpr: CRON })).body.chat.chatId as string;

    // Pause is owner-gated: a member cannot; the owner can.
    expect((await member.post(schedCh(id, `/${chatId}/pause`), { enabled: false })).status).toBe(403);
    expect((await owner.post(schedCh(id, `/${chatId}/pause`), { enabled: false })).status).toBe(200);
    expect((await getJob(`schedchat-${chatId}`))!.enabled).toBe(false);

    expect((await owner.del(schedCh(id, `/${chatId}`))).status).toBe(204);
    expect(await getJob(`schedchat-${chatId}`)).toBeNull();
    expect((await owner.get(schedCh(id))).body.chats.some((x: any) => x.chatId === chatId)).toBe(false);
  });

  it('ADR 0202 OQ-3 — removing the agent from the channel auto-cleans its scheduled posts (event-wired)', async () => {
    const { c } = await login('owner');
    const id = (await c.post(CH, { name: `oq3-${n}`, visibility: 'public', agentIds: ['sch.a'] })).body.channel.conversationId as string;
    const chatId = (await c.post(schedCh(id), { agentId: 'sch.a', prompt: 'daily', cronExpr: CRON })).body.chat.chatId as string;
    expect(await getJob(`schedchat-${chatId}`)).not.toBeNull();

    // Remove the agent — the participant-removed event fans out to scheduled-agent-chats.
    expect((await c.del(`${CH}/${id}/agents/sch.a`)).status).toBe(200);
    await waitFor(async () => (await getJob(`schedchat-${chatId}`)) === null);

    expect(await getJob(`schedchat-${chatId}`)).toBeNull();
    expect((await c.get(schedCh(id))).body.chats.some((x: any) => x.chatId === chatId)).toBe(false);
  });

  it('a channel schedule is isolated by scope — another channel owner cannot delete it via their own channel route', async () => {
    const { c } = await login('owner');
    const a = (await c.post(CH, { name: `d3iA-${n}`, visibility: 'public', agentIds: ['sch.a'] })).body.channel.conversationId as string;
    const b = (await c.post(CH, { name: `d3iB-${n}`, visibility: 'public', agentIds: ['sch.a'] })).body.channel.conversationId as string;
    const chatId = (await c.post(schedCh(a), { agentId: 'sch.a', prompt: 'p', cronExpr: CRON })).body.chat.chatId as string;
    // Same owner, but addressing channel B's route with A's chatId → keyed miss → 404.
    expect((await c.del(schedCh(b, `/${chatId}`))).status).toBe(404);
    expect(await getJob(`schedchat-${chatId}`)).not.toBeNull(); // untouched
  });
});

describe('ADR 0202 D6 — org create-path hardening', () => {
  async function orgOwner(): Promise<{ c: Client; orgId: string }> {
    const { c } = await login('orgowner');
    const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Ops' })).body.orgId as string;
    return { c, orgId };
  }

  it('binds a schedule when the agent resolves and the caller can see the conversation', async () => {
    const { c, orgId } = await orgOwner();
    const conv = (await c.post(CH, { name: `d6ok-${n}`, visibility: 'public', agentIds: ['sch.a'] })).body.channel.conversationId as string;
    const r = await c.post(schedOrg(orgId), { agentId: 'sch.a', prompt: 'digest', conversationId: conv, cronExpr: CRON });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.chat.orgId).toBe(orgId);
  });

  it('rejects an agent that does not resolve (404)', async () => {
    const { c, orgId } = await orgOwner();
    const conv = (await c.post(CH, { name: `d6a-${n}`, visibility: 'public' })).body.channel.conversationId as string;
    const r = await c.post(schedOrg(orgId), { agentId: 'ghost-agent', prompt: 'x', conversationId: conv, cronExpr: CRON });
    expect(r.status).toBe(404);
  });

  it('rejects binding a private conversation the caller cannot see (IDOR — 404-masked)', async () => {
    const { c, orgId } = await orgOwner();
    // A DIFFERENT user owns a private channel the org-owner is not a member of.
    const { c: other } = await login('convowner');
    const foreign = (await other.post(CH, { name: `d6idor-${n}`, visibility: 'private' })).body.channel.conversationId as string;
    const r = await c.post(schedOrg(orgId), { agentId: 'sch.a', prompt: 'x', conversationId: foreign, cronExpr: CRON });
    expect(r.status).toBe(404);
  });

  it('the IDOR check is not bypassable with a whitespace-padded conversationId (check == store)', async () => {
    const { c, orgId } = await orgOwner();
    const { c: other } = await login('convowner2');
    const foreign = (await other.post(CH, { name: `d6pad-${n}`, visibility: 'private' })).body.channel.conversationId as string;
    // Padding once slipped past the exact-match access check while the service trimmed
    // and stored the real foreign id (architect H1). Must be rejected the same as exact.
    const r = await c.post(schedOrg(orgId), { agentId: 'sch.a', prompt: 'x', conversationId: `  ${foreign}`, cronExpr: CRON });
    expect(r.status).toBe(404);
  });
});
