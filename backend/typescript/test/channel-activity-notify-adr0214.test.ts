/**
 * ADR 0214 — channel-activity notifications. An AGENT post to a channel notifies the
 * channel's human members (durable inbox); human posts don't notify; and the mute
 * policy (the ADR 0214 D2 resolver seam over the ADR 0192 D7 prefs store) suppresses
 * delivery per conversation, per TYPE (NOTIF-1) and inside quiet hours (NOTIF-2).
 *
 * What breaks it: a mute that is STORED but not consulted at delivery (the resolver
 * branches in `features/notifications/preferencesRoutes.ts` — this file is their only
 * delivery-level test), the agent-only guard, or the recipient set.
 *
 * Every "member got nothing" case first proves the owner DID get the notice
 * (a positive control), so a pipeline that delivers to nobody cannot pass as a mute.
 * Author exclusion is structural (only `user:` participants are collected; the author
 * is an `agent:` ref), so it is not asserted. The `ownerUserId` recipient add is a
 * legacy fallback: `ensureConversationMeta` already stores the owner as a participant
 * on every channel created today (w26 probe `notify-owner` — honest double guard).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { notifyChannelActivity, CHANNEL_POST_NOTIFICATION_TYPE } from '../src/host/channelActivityNotify.js';
import type { ChatMessageRecord } from '../src/types.js';

const CH = '/host/openwop-app/channels';
const NOTIFS = '/host/openwop-app/notifications';
const PREFS = '/host/openwop-app/notifications/preferences';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  getAgentRegistry().register({
    agentId: 'notif.a', persona: 'Notifier Agent', modelClass: 'general',
    systemPrompt: 'notify', packName: 'test', packVersion: '0', toolAllowlist: [],
  });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Notif { type: string; message: string; metadata?: { conversationId?: string } }
interface TypePref { type: string; muted: boolean; desktop: boolean }
interface Prefs { globalMute: boolean; types: TypePref[]; quietHours: Record<string, unknown>; mutedConversations?: string[] }
interface Res { status: number; body: unknown }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
type Client = ReturnType<typeof client>;

const TENANT = `t-0214-${Date.now()}`;
async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `n0214-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} P`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  // ADR 0879 D1 — a co-tenant login gets no member row from the seam (it founds the
  // workspace for the FIRST login only), and channel writes now ask the ROLE. Make
  // every person a real Editor of the workspace, the production shape (idempotent: a
  // founder keeps their owner row).
  await createMember({ orgId: TENANT, tenantId: TENANT, displayName: name, subject: (r.body as { user: { userId: string } }).user.userId, roles: ['editor'] });
  return { c, userId: (r.body as { user: { userId: string } }).user.userId };
}

/** Polls by ATTEMPT count (not wall clock — NOTIF-2 freezes `Date`) and FAILS on timeout. */
async function waitFor(pred: () => Promise<boolean>, what: string, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i++) { if (await pred()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`waitFor timed out: ${what}`);
}

function agentPost(sessionId: string, text: string): ChatMessageRecord {
  return { messageId: `m-${n++}`, sessionId, role: 'assistant', content: text, meta: null, authorSubject: 'agent:notif.a', createdAt: new Date().toISOString() };
}
const channelNotifs = async (c: Client, channelId: string): Promise<Notif[]> => {
  const r = await c.get(NOTIFS);
  return (r.body as { notifications: Notif[] }).notifications.filter((x) => x.type === CHANNEL_POST_NOTIFICATION_TYPE && x.metadata?.conversationId === channelId);
};
const getPrefs = async (c: Client): Promise<Prefs> => ((await c.get(PREFS)).body as { preferences: Prefs }).preferences;

async function channelWithMember(tag: string): Promise<{ owner: Client; member: Client; memberId: string; id: string }> {
  const { c: owner } = await login('owner');
  const { c: member, userId: memberId } = await login('member');
  const created = await owner.post(CH, { name: `${tag}-${n}`, visibility: 'private', agentIds: ['notif.a'] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as { channel: { conversationId: string } }).channel.conversationId;
  expect((await owner.post(`${CH}/${id}/members`, { userId: memberId })).status).toBe(200);
  return { owner, member, memberId, id };
}

/** Positive control: the owner (never muted) got exactly one notice — the pipeline ran. */
async function ownerGotIt(owner: Client, id: string): Promise<void> {
  await waitFor(async () => (await channelNotifs(owner, id)).length > 0, 'owner notified');
  expect(await channelNotifs(owner, id)).toHaveLength(1);
}

describe('ADR 0214 — channel-activity notifications', () => {
  it('an agent post notifies the channel members (owner + member); human posts do not', async () => {
    const { owner, member, memberId, id } = await channelWithMember('nA');

    notifyChannelActivity(TENANT, agentPost(id, 'Daily standup summary is ready.'));
    await waitFor(async () => (await channelNotifs(member, id)).length > 0, 'member notified');

    const mn = await channelNotifs(member, id);
    expect(mn).toHaveLength(1);
    expect(await channelNotifs(owner, id)).toHaveLength(1);
    expect(mn[0]!.message).toContain('Daily standup summary');

    // A HUMAN post to the same channel does NOT notify (agent-only scope). No hook
    // exists on the dropped path, so a SENTINEL agent post queued after it is the
    // barrier: both run the same async pipeline on the same store, in order.
    notifyChannelActivity(TENANT, { ...agentPost(id, 'a human message'), authorSubject: `user:${memberId}` });
    notifyChannelActivity(TENANT, agentPost(id, 'sentinel-after-human'));
    await waitFor(async () => (await channelNotifs(member, id)).some((x) => x.message.includes('sentinel-after-human')), 'sentinel delivered');
    const after = await channelNotifs(member, id);
    expect(after).toHaveLength(2);
    expect(after.some((x) => x.message.includes('a human message'))).toBe(false);
  });

  it('a muted conversation suppresses the notification for that member only', async () => {
    const { owner, member, id } = await channelWithMember('nB');

    // Member mutes THIS channel (ADR 0192 D7 store, enforced by the ADR 0214 D2 resolver).
    const prefs = await getPrefs(member);
    expect((await member.put(PREFS, { ...prefs, mutedConversations: [id] })).status).toBe(200);

    notifyChannelActivity(TENANT, agentPost(id, 'Weekly digest'));
    await ownerGotIt(owner, id);
    expect(await channelNotifs(member, id)).toHaveLength(0);
  });

  it('NOTIF-1 — muting the chat.channel_post TYPE silences agent posts across every channel', async () => {
    const { owner, member, id } = await channelWithMember('nC');

    // One switch, not per-channel: mute the channel-activity TYPE.
    const prefs = await getPrefs(member);
    expect(prefs.types.some((t) => t.type === CHANNEL_POST_NOTIFICATION_TYPE)).toBe(true);
    const types = prefs.types.map((t) => t.type === CHANNEL_POST_NOTIFICATION_TYPE ? { ...t, muted: true } : t);
    expect((await member.put(PREFS, { ...prefs, types })).status).toBe(200);

    notifyChannelActivity(TENANT, agentPost(id, 'Standup'));
    await ownerGotIt(owner, id);
    expect(await channelNotifs(member, id)).toHaveLength(0);
  });

  it('NOTIF-2 — quiet-hours (with a timezone) suppresses a normal-priority post', async () => {
    const { owner, member, id } = await channelWithMember('nD');

    // Pin `Date` to HH:30 UTC of the current hour, so "now" sits mid-window for the
    // whole case — no hour boundary can fall between the test's read and the
    // server's. Only `Date` is faked (timers stay real); restored in `finally`.
    const pinned = new Date(Date.now());
    pinned.setUTCMinutes(30, 0, 0);
    const h = pinned.getUTCHours();
    const win = (x: number) => `${String(((x % 24) + 24) % 24).padStart(2, '0')}:00`;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(pinned);
      const prefs = await getPrefs(member);
      const quietHours = { enabled: true, start: win(h - 1), end: win(h + 1), days: [0, 1, 2, 3, 4, 5, 6], allowUrgent: true, timezone: 'UTC' };
      expect((await member.put(PREFS, { ...prefs, quietHours })).status).toBe(200);

      notifyChannelActivity(TENANT, agentPost(id, 'Digest')); // priority 'normal' → not allowUrgent-exempt
      await ownerGotIt(owner, id);
      expect(await channelNotifs(member, id)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
