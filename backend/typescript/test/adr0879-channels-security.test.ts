/**
 * ADR 0879 — channels integrity and exits (feature loop round 2, row 40).
 *
 * Every case here was written BEFORE the fix and run red on `2d0b4bdd4`
 * (`origin/main` at the start of the row). Authorization is only observable at
 * the route boundary, so the HTTP cases drive the real app with real signed-in
 * people (the ADR 0026 test-auth seam) in a SHARED `ws:` workspace — the one
 * tenant shape where "in the tenant" and "may write" differ.
 *
 *  S1  a workspace VIEWER created channels, posted, reacted and started paid
 *      catch-up runs (no role gate anywhere in the feature);
 *  S2  the channel OWNER could rewrite another member's words, which kept the
 *      victim's attribution (only an `edited` stamp);
 *  S3  `POST …/members` added any string as a member (no workspace check), so a
 *      non-member was notified and @channel-stamped;
 *  S4  removing a person from the WORKSPACE left them in every channel roster;
 *  S5  an open live stream kept delivering after its holder was removed from a
 *      private channel (the gate ran once, at open);
 *  S6  DSAR erasure left the subject's channel posts (words + author id);
 *  S7  the agent-runner `conversationId` lane appended an agent post into ANY
 *      conversation id (a private channel the agent is not in, an archived one,
 *      another tenant's) — reachable from any workflow an Editor can author;
 *  S8  `ctx.chat.sendMessage` did the same with no actor check at all.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import { createChatSurface } from '../src/host/chatSurface.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { createMember } from '../src/host/accessControlService.js';
import { createChannel, addChannelAgent, addChannelMember, archiveChannel } from '../src/features/channels/channelService.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import type { AiCallRequest, AiCallResult, NodeContext } from '../src/executor/types.js';

/** ADR 0879 D1 — a caller holding `workspace:write` (not an admin): the service-level
 *  witnesses below exercise the channel rules, not the role gate (route tests do). */
const FULL_AUTHORITY = { canWrite: true, isAdmin: false };

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  getAgentRegistry().register({
    agentId: 'adr0879.helper', persona: 'Helper', modelClass: 'general',
    systemPrompt: 'help', packName: 'test', packVersion: '0', toolAllowlist: [],
  });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    cookie: () => cookie,
    call,
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

let n = 0;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: `chs-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const CH = '/host/openwop-app/channels';
const CHAT = '/host/openwop-app/chat/sessions';
const WS = '/host/openwop-app/workspaces';

interface Member { client: Client; userId: string; memberId: string }
/** An owner's shared workspace plus one member per requested role, each switched in. */
async function workspace(...roles: Array<'viewer' | 'editor' | 'admin'>): Promise<{ owner: Client; ownerId: string; ws: string; members: Member[] }> {
  const owner = client();
  const o = await signup(owner);
  const ws = (await owner.post(WS, { name: `Chan ${n++}` })).body.workspaceId as string;
  expect((await owner.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  const members: Member[] = [];
  for (const role of roles) {
    const c = client();
    const u = await signup(c);
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: role, subject: u.userId, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    members.push({ client: c, userId: u.userId, memberId: add.body.memberId as string });
  }
  return { owner, ownerId: o.userId, ws, members };
}

async function newChannel(owner: Client, visibility: 'public' | 'private'): Promise<string> {
  const r = await owner.post(CH, { name: `room-${n++}`, visibility });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.channel.conversationId as string;
}

async function messages(c: Client, id: string): Promise<Array<{ messageId: string; content: string; authorSubject: string | null }>> {
  const r = await c.get(`${CH}/${id}/messages`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.messages;
}

describe('ADR 0879 S1 — a viewer reads channels but writes nothing', () => {
  it('refuses create, post, react and catch-up with 403 forbidden_scope; reading and joining still work', async () => {
    const { owner, members: [viewer] } = await workspace('viewer');
    const id = await newChannel(owner, 'public');
    const posted = await owner.post(`${CH}/${id}/messages`, { content: 'hello team' });
    expect(posted.status).toBe(201);

    expect((await viewer!.client.get(`${CH}/${id}/messages`)).status).toBe(200);
    expect((await viewer!.client.post(`${CH}/${id}/join`)).status).toBe(200);

    const refused = [
      await viewer!.client.post(CH, { name: 'viewer-room' }),
      await viewer!.client.post(`${CH}/${id}/messages`, { content: 'viewer words' }),
      await viewer!.client.put(`${CHAT}/${id}/messages/${posted.body.messageId}/reactions/${encodeURIComponent('👍')}`),
      await viewer!.client.post(`${CH}/${id}/catchup`),
    ];
    for (const r of refused) {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body?.error ?? r.body?.code).toBe('forbidden_scope');
    }
    const after = await messages(owner, id);
    expect(after.map((m) => m.content)).toEqual(['hello team']);
  });
});

describe('ADR 0879 S2 — the owner moderates (delete) but never rewrites another member', () => {
  it('owner edit of a member post is 403 and the words are unchanged; owner delete still tombstones', async () => {
    const { owner, members: [editor] } = await workspace('editor');
    const id = await newChannel(owner, 'public');
    const posted = await editor!.client.post(`${CH}/${id}/messages`, { content: 'my own words' });
    expect(posted.status).toBe(201);
    const mid = posted.body.messageId as string;

    const edit = await owner.put(`${CHAT}/${id}/messages/${mid}`, { content: 'words put in your mouth' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(403);
    expect((await messages(owner, id)).find((m) => m.messageId === mid)?.content).toBe('my own words');

    // The author still edits their own post.
    expect((await editor!.client.put(`${CHAT}/${id}/messages/${mid}`, { content: 'my own words, fixed' })).status).toBe(200);
    // Moderation stays: the owner may tombstone it.
    expect((await owner.del(`${CHAT}/${id}/messages/${mid}`)).status).toBe(204);
  });
});

describe('ADR 0879 S3 — only a workspace member can be added to a channel', () => {
  it('refuses an id that is not a member of this workspace and leaves the roster unchanged', async () => {
    const { owner, members: [editor] } = await workspace('editor');
    const id = await newChannel(owner, 'private');
    const stranger = client();
    const s = await signup(stranger); // a real user, but of ANOTHER workspace

    const bad = await owner.post(`${CH}/${id}/members`, { userId: s.userId });
    expect(bad.status, JSON.stringify(bad.body)).toBe(404);
    const junk = await owner.post(`${CH}/${id}/members`, { userId: 'anyone-at-all' });
    expect(junk.status, JSON.stringify(junk.body)).toBe(404);

    const ok = await owner.post(`${CH}/${id}/members`, { userId: editor!.userId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const roster = (await owner.get(`${CH}/${id}`)).body.channel.roster as Array<{ subjectRef: string }>;
    expect(roster.map((r) => r.subjectRef)).not.toContain(`user:${s.userId}`);
    expect(roster.map((r) => r.subjectRef)).toContain(`user:${editor!.userId}`);
  });
});

describe('ADR 0879 S4 — leaving the workspace leaves its channels', () => {
  it('a removed workspace member is dropped from every channel roster', async () => {
    const { owner, ws, members: [editor] } = await workspace('editor');
    const id = await newChannel(owner, 'private');
    expect((await owner.post(`${CH}/${id}/members`, { userId: editor!.userId })).status).toBe(200);
    const pub = await newChannel(owner, 'public');
    expect((await editor!.client.post(`${CH}/${pub}/join`)).status).toBe(200);

    const removed = await owner.del(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members/${encodeURIComponent(editor!.memberId)}`);
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);

    for (const ch of [id, pub]) {
      const roster = (await owner.get(`${CH}/${ch}`)).body.channel.roster as Array<{ subjectRef: string }>;
      expect(roster.map((r) => r.subjectRef)).not.toContain(`user:${editor!.userId}`);
    }
  });
});

describe('ADR 0879 S5 — the live stream re-checks membership', () => {
  it('a stream opened by a member delivers nothing after they are removed from the private channel', async () => {
    const { owner, members: [editor] } = await workspace('editor');
    const id = await newChannel(owner, 'private');
    expect((await owner.post(`${CH}/${id}/members`, { userId: editor!.userId })).status).toBe(200);

    const ac = new AbortController();
    const res = await fetch(`${BASE}${CH}/${id}/stream`, { headers: { cookie: editor!.client.cookie() }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          seen += decoder.decode(value);
        }
      } catch { /* aborted */ }
    })();

    expect((await owner.post(`${CH}/${id}/messages`, { content: 'before removal' })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toContain('channel.message');
    const framesBefore = seen.split('event: channel.message').length;

    expect((await owner.del(`${CH}/${id}/members/${encodeURIComponent(editor!.userId)}`)).status).toBe(200);
    expect((await owner.post(`${CH}/${id}/messages`, { content: 'after removal — private' })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await pump;
    expect(seen.split('event: channel.message').length).toBe(framesBefore);
  });
});

describe('ADR 0879 S6 — DSAR erasure reaches the subject\'s channel posts', () => {
  it('erasing a member tombstones their words and their author id; others\' posts are untouched', async () => {
    const { owner, ws, members: [editor] } = await workspace('editor');
    const id = await newChannel(owner, 'public');
    const mine = await editor!.client.post(`${CH}/${id}/messages`, { content: 'my phone is 555-0100' });
    expect(mine.status).toBe(201);
    expect((await owner.post(`${CH}/${id}/messages`, { content: 'owner words' })).status).toBe(201);

    await eraseSubject(ws, editor!.userId);

    const after = await messages(owner, id);
    const erased = after.find((m) => m.messageId === mine.body.messageId);
    expect(erased).toBeDefined();
    expect(erased!.content).not.toContain('555-0100');
    expect(erased!.authorSubject).not.toBe(`user:${editor!.userId}`);
    expect(after.find((m) => m.content === 'owner words')).toBeDefined();
    // ADR 0879 D0 — the participant row is stored as `user:<userId>` = `user:user:<hash>`;
    // the conversation eraser now matches that spelling too.
    const roster = (await owner.get(`${CH}/${id}`)).body.channel.participants as Array<{ subjectRef: string }>;
    expect(roster.map((p) => p.subjectRef)).not.toContain(`user:${editor!.userId}`);
  });
});

describe('ADR 0879 D3 — an admin manages; an editor who is not the owner does not', () => {
  it('editor 403 on manage; admin renames, deletes a member post, but cannot see a private room it is not in', async () => {
    const { owner, members: [editor, admin] } = await workspace('editor', 'admin');
    const id = await newChannel(owner, 'public');
    expect((await editor!.client.post(`${CH}/${id}/join`)).status).toBe(200);
    const editorArchive = await editor!.client.post(`${CH}/${id}/archive`);
    expect(editorArchive.status, JSON.stringify(editorArchive.body)).toBe(403);

    const posted = await editor!.client.post(`${CH}/${id}/messages`, { content: 'spam spam' });
    expect(posted.status).toBe(201);
    const detail = (await admin!.client.get(`${CH}/${id}`)).body.channel;
    expect(detail.viewerCanManage).toBe(true);
    expect((await admin!.client.del(`${CHAT}/${id}/messages/${posted.body.messageId}`)).status).toBe(204);

    const priv = await newChannel(owner, 'private');
    expect((await admin!.client.get(`${CH}/${priv}`)).status).toBe(404);
    expect((await admin!.client.post(`${CH}/${priv}/archive`)).status).toBe(404);
  });
});

describe('ADR 0879 H3 — the generic chat-session doors refuse a channel', () => {
  it('rename, delete and branch through /chat/sessions are 400 for a channel; the channel is intact', async () => {
    const { owner, members: [editor] } = await workspace('editor');
    const id = await newChannel(owner, 'public');
    expect((await editor!.client.post(`${CH}/${id}/join`)).status).toBe(200);
    expect((await owner.post(`${CH}/${id}/messages`, { content: 'history' })).status).toBe(201);
    const refused = [
      await editor!.client.call('PATCH', `${CHAT}/${id}`, { title: 'hijacked' }),
      await owner.del(`${CHAT}/${id}`),
      await editor!.client.post(`${CHAT}/${id}/branch`, {}),
    ];
    for (const r of refused) expect(r.status, JSON.stringify(r.body)).toBe(400);
    const after = (await owner.get(`${CH}/${id}`)).body.channel;
    expect(after.channel.name.startsWith('room-')).toBe(true);
    expect((await messages(owner, id)).map((m) => m.content)).toEqual(['history']);
  });
});

describe('ADR 0879 D8 — announcement channels', () => {
  it('only managers post; members read; the flag tells the client', async () => {
    const { owner, members: [editor] } = await workspace('editor');
    const id = await newChannel(owner, 'public');
    expect((await editor!.client.post(`${CH}/${id}/join`)).status).toBe(200);
    expect((await editor!.client.call('PATCH', `${CH}/${id}`, { postingPolicy: 'managers' })).status).toBe(403);
    const set = await owner.call('PATCH', `${CH}/${id}`, { postingPolicy: 'managers' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.channel.channel.postingPolicy).toBe('managers');

    const refused = await editor!.client.post(`${CH}/${id}/messages`, { content: 'me too' });
    expect(refused.status).toBe(403);
    expect(refused.body?.details?.code).toBe('channel_managers_only');
    expect((await owner.post(`${CH}/${id}/messages`, { content: 'launch is friday' })).status).toBe(201);
    expect((await editor!.client.get(`${CH}/${id}`)).body.channel.viewerCanPost).toBe(false);
    expect((await owner.get(`${CH}/${id}`)).body.channel.viewerCanPost).toBe(true);
    expect((await messages(editor!.client, id)).map((m) => m.content)).toEqual(['launch is friday']);
    expect((await owner.call('PATCH', `${CH}/${id}`, { postingPolicy: 'nobody' })).status).toBe(400);
  });
});

// ── the run lanes (S7, S8) — in-process, after createApp initialised persistence ──

const runCtx = (over: Record<string, unknown>): NodeContext =>
  ({
    runId: `run-${n++}`,
    inputs: {},
    config: { offerTools: [] },
    configurable: {},
    emit: async () => {},
    callAI: async (_req: AiCallRequest): Promise<AiCallResult> => ({ content: 'AGENT SAYS HI' }),
    callAIWithTools: async () => { throw new Error('no tools offered'); },
    ...over,
  } as unknown as NodeContext);

async function threadOf(id: string): Promise<string[]> {
  return (await hostExtStorage().listChatSessionMessages(id)).map((m) => m.content);
}

describe('ADR 0879 S7 — an agent posts only where it is a member, in its own tenant', () => {
  it('refuses a private channel the agent is not in, an archived channel, and another tenant; still posts as a member', async () => {
    const T = `t-0879-run-${n++}`;
    // Real workspace-root member rows: the post gate asks the ROLE (ADR 0879 D7).
    for (const subject of ['u-owner', 'u-member']) await createMember({ orgId: T, tenantId: T, displayName: subject, subject, roles: ['editor'] });
    const outsider = await createChannel(T, 'u-owner', { name: `secret-${n++}`, visibility: 'private' }, FULL_AUTHORITY);
    const out = await agentRunnerNode.execute(runCtx({ tenantId: T, inputs: { agentId: 'adr0879.helper', task: 'x', conversationId: outsider.conversationId } }));
    // A refused post is a TYPED failure (never a silent success), and nothing lands.
    expect(out.status).toBe('failure');
    expect((out as { error?: { code?: string } }).error?.code).toBe('conversation_write_refused');
    expect(await threadOf(outsider.conversationId)).toEqual([]);

    const home = await createChannel(T, 'u-owner', { name: `home-${n++}`, visibility: 'private' }, FULL_AUTHORITY);
    await addChannelAgent(T, home.conversationId, 'u-owner', FULL_AUTHORITY, 'adr0879.helper');
    // A human behind the run who cannot see the private room narrows it shut.
    await agentRunnerNode.execute(runCtx({ tenantId: T, actingUserId: 'u-stranger', inputs: { agentId: 'adr0879.helper', task: 'x', conversationId: home.conversationId } }));
    expect(await threadOf(home.conversationId)).toEqual([]);
    // Another tenant's run naming this room's id.
    await agentRunnerNode.execute(runCtx({ tenantId: `${T}-other`, inputs: { agentId: 'adr0879.helper', task: 'x', conversationId: home.conversationId } }));
    expect(await threadOf(home.conversationId)).toEqual([]);

    // The real channel turn (system-fired, the poster as the narrowing subject) still posts.
    await addChannelMember(T, home.conversationId, 'u-owner', FULL_AUTHORITY, 'u-member');
    await agentRunnerNode.execute(runCtx({ tenantId: T, orgScopeSubject: 'u-member', inputs: { agentId: 'adr0879.helper', task: 'x', conversationId: home.conversationId } }));
    expect((await threadOf(home.conversationId)).join('\n')).toContain('AGENT SAYS HI');

    await archiveChannel(T, home.conversationId, 'u-owner', FULL_AUTHORITY);
    const before = (await threadOf(home.conversationId)).length;
    await agentRunnerNode.execute(runCtx({ tenantId: T, orgScopeSubject: 'u-member', inputs: { agentId: 'adr0879.helper', task: 'x', conversationId: home.conversationId } }));
    expect((await threadOf(home.conversationId)).length).toBe(before);
  });
});

describe('ADR 0879 S8 — ctx.chat.sendMessage writes only where its actor may post', () => {
  it('refuses a private channel the actor is not in, and a channel with no actor; the default session still works', async () => {
    const T = `t-0879-chat-${n++}`;
    await createMember({ orgId: T, tenantId: T, displayName: 'owner', subject: 'u-owner', roles: ['editor'] });
    const room = await createChannel(T, 'u-owner', { name: `quiet-${n++}`, visibility: 'private' }, FULL_AUTHORITY);

    await expect(createChatSurface({ tenantId: T, actingUserId: 'u-stranger' })
      .sendMessage({ sessionId: room.conversationId, content: 'forged', role: 'user', idempotencyKey: `k-${n++}` })).rejects.toThrow();
    await expect(createChatSurface({ tenantId: T })
      .sendMessage({ sessionId: room.conversationId, content: 'forged', role: 'system', idempotencyKey: `k-${n++}` })).rejects.toThrow();
    expect(await threadOf(room.conversationId)).toEqual([]);

    // Not even the owner's own workflow: a sendMessage row has no author, so in a room
    // of peers it would escape the author rules (grade-code CH2CD-3). Channels hear
    // from workflows through an agent member.
    await expect(createChatSurface({ tenantId: T, actingUserId: 'u-owner' })
      .sendMessage({ sessionId: room.conversationId, content: 'status: green', idempotencyKey: `k-${n++}` })).rejects.toThrow(/channel_needs_agent/);
    expect(await threadOf(room.conversationId)).toEqual([]);

    // The owner's own conversation (owned, not a channel) still takes their workflow's post…
    const mine = 'conv-own-' + n++;
    await hostExtStorage().createChatSession({ sessionId: mine, tenantId: T, title: 'mine', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0 });
    await ensureConversationMeta(T, mine, { type: 'agent', ownerUserId: 'u-owner' });
    await createChatSurface({ tenantId: T, actingUserId: 'u-owner' })
      .sendMessage({ sessionId: mine, content: 'status: green', idempotencyKey: `k-${n++}` });
    expect((await threadOf(mine)).join('\n')).toContain('status: green');
    // …and nobody else's run, nor a run with no person behind it.
    await expect(createChatSurface({ tenantId: T, actingUserId: 'u-stranger' })
      .sendMessage({ sessionId: mine, content: 'forged', idempotencyKey: `k-${n++}` })).rejects.toThrow(/not_visible/);
    await expect(createChatSurface({ tenantId: T })
      .sendMessage({ sessionId: mine, content: 'forged', idempotencyKey: `k-${n++}` })).rejects.toThrow(/no_human/);

    // The per-tenant workflow activity session is untouched by the rule.
    const sent = await createChatSurface({ tenantId: T }).sendMessage({ content: 'activity', idempotencyKey: `k-${n++}` });
    expect(sent.messageId).toBeTruthy();
  });
});

// ── grade-code CH2CD-1 / CH2CD-5 — the run-lane gate's own legs, each on its own ──

describe('ADR 0879 D7 — every leg of the run-lane post gate, separately', () => {
  async function room(T: string, policy?: 'managers'): Promise<string> {
    for (const [subject, role] of [['u-owner', 'editor'], ['u-editor', 'editor'], ['u-viewer', 'viewer']] as const) {
      await createMember({ orgId: T, tenantId: T, displayName: subject, subject, roles: [role] });
    }
    const ch = await createChannel(T, 'u-owner', { name: `legs-${n++}`, visibility: 'public' }, FULL_AUTHORITY);
    await addChannelAgent(T, ch.conversationId, 'u-owner', FULL_AUTHORITY, 'adr0879.helper');
    if (policy) {
      const { setChannelPostingPolicy } = await import('../src/features/channels/channelService.js');
      await setChannelPostingPolicy(T, ch.conversationId, 'u-owner', FULL_AUTHORITY, policy);
    }
    return ch.conversationId;
  }
  const turn = (T: string, id: string, extra: Record<string, unknown>) =>
    agentRunnerNode.execute(runCtx({ tenantId: T, inputs: { agentId: 'adr0879.helper', task: 'x', conversationId: id }, ...extra }));

  it('a Viewer behind the run is refused (the role leg)', async () => {
    const T = `t-0879-legs-${n++}`;
    const id = await room(T);
    await turn(T, id, { orgScopeSubject: 'u-viewer' });
    expect(await threadOf(id)).toEqual([]);
    await turn(T, id, { orgScopeSubject: 'u-editor' });
    expect((await threadOf(id)).length).toBe(1);
  });

  it('an agent that is not a member is refused even with a person who may post (the membership leg)', async () => {
    const T = `t-0879-legs-${n++}`;
    const id = await room(T);
    getAgentRegistry().register({ agentId: 'adr0879.outsider', persona: 'Outsider', modelClass: 'general', systemPrompt: 'x', packName: 'test', packVersion: '0', toolAllowlist: [] });
    await agentRunnerNode.execute(runCtx({ tenantId: T, orgScopeSubject: 'u-owner', inputs: { agentId: 'adr0879.outsider', task: 'x', conversationId: id } }));
    expect(await threadOf(id)).toEqual([]);
  });

  it('an announcement channel takes a reply to a manager, not to an editor (the policy leg)', async () => {
    const T = `t-0879-legs-${n++}`;
    const id = await room(T, 'managers');
    await turn(T, id, { orgScopeSubject: 'u-editor' });
    expect(await threadOf(id)).toEqual([]);
    await turn(T, id, { orgScopeSubject: 'u-owner' });
    expect((await threadOf(id)).length).toBe(1);
  });

  it('the implicit owner of a personal workspace is admitted through the stamped personal tenant (CH2CD-1)', async () => {
    const T = `user:p0879-${n++}`; // a personal tenant: no member rows at all
    const ch = await createChannel(T, 'u-self', { name: `mine-${n++}`, visibility: 'private' }, FULL_AUTHORITY);
    await addChannelAgent(T, ch.conversationId, 'u-self', FULL_AUTHORITY, 'adr0879.helper');
    await turn(T, ch.conversationId, { orgScopeSubject: 'u-self' });
    expect(await threadOf(ch.conversationId)).toEqual([]); // no personal tenant ⇒ no authority
    await turn(T, ch.conversationId, { orgScopeSubject: 'u-self', personalTenant: T });
    expect((await threadOf(ch.conversationId)).length).toBe(1);
  });
});

describe('ADR 0879 D4/D5 — leaving the workspace: ownership and the public-channel stream', () => {
  it('a departing owner relinquishes the room; an admin still manages it', async () => {
    const { owner, ws, members: [editor, admin] } = await workspace('editor', 'admin');
    const id = await newChannel(editor!.client, 'public');
    expect((await editor!.client.get(`${CH}/${id}`)).body.channel.viewerIsOwner).toBe(true);
    expect((await owner.del(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members/${encodeURIComponent(editor!.memberId)}`)).status).toBeLessThan(300);
    const after = (await admin!.client.get(`${CH}/${id}`)).body.channel;
    expect(after.ownerUserId).toBeUndefined();
    expect(after.viewerCanManage).toBe(true);
    expect((await admin!.client.post(`${CH}/${id}/archive`)).status).toBe(204);
  });

  it('a PUBLIC channel stream closes once its holder leaves the workspace', async () => {
    const { owner, ws, members: [editor] } = await workspace('editor');
    const id = await newChannel(owner, 'public');
    const ac = new AbortController();
    const res = await fetch(`${BASE}${CH}/${id}/stream`, { headers: { cookie: editor!.client.cookie() }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    let ended = false;
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { ended = true; return; }
          seen += decoder.decode(value);
        }
      } catch { /* aborted */ }
    })();
    expect((await owner.del(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members/${encodeURIComponent(editor!.memberId)}`)).status).toBeLessThan(300);
    expect((await owner.post(`${CH}/${id}/messages`, { content: 'after they left' })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 400));
    ac.abort();
    await pump;
    expect(seen).not.toContain('channel.message');
    expect(ended).toBe(true);
  });
});
