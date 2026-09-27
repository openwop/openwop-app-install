/**
 * ADR 0214 — channel-activity notifications. An AGENT post to a channel notifies the
 * channel's human members (durable inbox), the author is excluded, human posts don't
 * notify, and a muted conversation suppresses delivery (the ADR 0192 D7 store, now
 * enforced via the ADR 0214 D2 resolver seam).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { notifyChannelActivity, CHANNEL_POST_NOTIFICATION_TYPE } from '../src/host/channelActivityNotify.js';
import type { ChatMessageRecord } from '../src/types.js';

const CH = '/v1/host/openwop-app/channels';
const NOTIFS = '/v1/host/openwop-app/notifications';
const PREFS = '/v1/host/openwop-app/notifications/preferences';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  getAgentRegistry().register({ agentId: 'notif.a', persona: 'Notifier Agent', modelClass: 'general' } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
type Client = ReturnType<typeof client>;

const TENANT = `t-0214-${Date.now()}`;
async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `n0214-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} P`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string };
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await pred()) return; await new Promise((r) => setTimeout(r, 25)); }
}

function agentPost(sessionId: string, text: string): ChatMessageRecord {
  return { messageId: `m-${n++}`, sessionId, role: 'assistant', content: text, meta: null, authorSubject: 'agent:notif.a', createdAt: new Date().toISOString() };
}
const channelNotifs = (c: Client, channelId: string) => c.get(NOTIFS).then((r) => (r.body.notifications as any[]).filter((x) => x.type === CHANNEL_POST_NOTIFICATION_TYPE && x.metadata?.conversationId === channelId));

describe('ADR 0214 — channel-activity notifications', () => {
  it('an agent post notifies the channel members (owner + member), excluding the author; human posts do not', async () => {
    const { c: owner } = await login('owner');
    const { c: member, userId: memberId } = await login('member');
    const id = (await owner.post(CH, { name: `nA-${n}`, visibility: 'private', agentIds: ['notif.a'] })).body.channel.conversationId as string;
    await owner.post(`${CH}/${id}/members`, { userId: memberId });

    notifyChannelActivity(TENANT, agentPost(id, 'Daily standup summary is ready.'));
    await waitFor(async () => (await channelNotifs(member, id)).length > 0);

    const mn = await channelNotifs(member, id);
    const on = await channelNotifs(owner, id);
    expect(mn.length).toBe(1);
    expect(on.length).toBe(1);
    expect(mn[0].message).toContain('Daily standup summary');

    // A HUMAN post to the same channel does NOT notify (agent-only scope).
    notifyChannelActivity(TENANT, { ...agentPost(id, 'a human message'), authorSubject: `user:${memberId}` });
    await new Promise((r) => setTimeout(r, 150));
    expect((await channelNotifs(member, id)).length).toBe(1); // unchanged
  });

  it('a muted conversation suppresses the notification for that member only', async () => {
    const { c: owner } = await login('owner');
    const { c: member, userId: memberId } = await login('member');
    const id = (await owner.post(CH, { name: `nB-${n}`, visibility: 'private', agentIds: ['notif.a'] })).body.channel.conversationId as string;
    await owner.post(`${CH}/${id}/members`, { userId: memberId });

    // Member mutes THIS channel (ADR 0192 D7 store, now enforced).
    const prefs = (await member.get(PREFS)).body.preferences;
    expect((await member.put(PREFS, { ...prefs, mutedConversations: [id] })).status).toBe(200);

    notifyChannelActivity(TENANT, agentPost(id, 'Weekly digest'));
    // The owner (not muted) receives it — wait on that, then assert the member has none.
    await waitFor(async () => (await channelNotifs(owner, id)).length > 0);
    expect((await channelNotifs(member, id)).length).toBe(0);
  });

  it('NOTIF-1 — muting the chat.channel_post TYPE silences agent posts across every channel', async () => {
    const { c: owner } = await login('owner');
    const { c: member, userId: memberId } = await login('member');
    const id = (await owner.post(CH, { name: `nC-${n}`, visibility: 'private', agentIds: ['notif.a'] })).body.channel.conversationId as string;
    await owner.post(`${CH}/${id}/members`, { userId: memberId });

    // One switch, not per-channel: mute the channel-activity TYPE.
    const prefs = (await member.get(PREFS)).body.preferences;
    const types = (prefs.types as any[]).map((t) => t.type === 'chat.channel_post' ? { ...t, muted: true } : t);
    expect((await member.put(PREFS, { ...prefs, types })).status).toBe(200);

    notifyChannelActivity(TENANT, agentPost(id, 'Standup'));
    await waitFor(async () => (await channelNotifs(owner, id)).length > 0);
    expect((await channelNotifs(member, id)).length).toBe(0);
  });

  it('NOTIF-2 — quiet-hours (with a timezone) suppresses a normal-priority post', async () => {
    const { c: owner } = await login('owner');
    const { c: member, userId: memberId } = await login('member');
    const id = (await owner.post(CH, { name: `nD-${n}`, visibility: 'private', agentIds: ['notif.a'] })).body.channel.conversationId as string;
    await owner.post(`${CH}/${id}/members`, { userId: memberId });

    // A ~2h window centered on the current UTC hour, so "now" is deterministically inside.
    const h = new Date().getUTCHours();
    const win = (x: number) => `${String(((x % 24) + 24) % 24).padStart(2, '0')}:00`;
    const prefs = (await member.get(PREFS)).body.preferences;
    const quietHours = { enabled: true, start: win(h - 1), end: win(h + 1), days: [0, 1, 2, 3, 4, 5, 6], allowUrgent: true, timezone: 'UTC' };
    expect((await member.put(PREFS, { ...prefs, quietHours })).status).toBe(200);

    notifyChannelActivity(TENANT, agentPost(id, 'Digest')); // priority 'normal' → not allowUrgent-exempt
    await waitFor(async () => (await channelNotifs(owner, id)).length > 0);
    expect((await channelNotifs(member, id)).length).toBe(0);
  });
});
