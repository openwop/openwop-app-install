/**
 * ADR 0192 — channels UX & identity parity, Phase 1 route-level coverage.
 *
 * Everything here is observable ONLY at the HTTP boundary (the architect
 * finding-11 list): the three membership-bypass closures, the `members/me`
 * registration-order pin, the owner-leave 409, one-flow create + name
 * normalization, the rename dual-store reconciliation, the resolved roster,
 * browse counts, unread differencing + `@channel` mention counters, and the
 * notification-prefs merge-on-absent semantics.
 *
 * Cookie-authed (the /test/login harness): the generic chat-session routes
 * bucket api-key principals under the `_anon` tenant (chatSessions.ts
 * `tenantFromReq`) while the channel routes use `default` — so only a real
 * signed-in user exercises BOTH route families against one tenant, which is
 * exactly the situation the D3 bypass closures protect.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { CONVERSATION_TYPES } from '../src/host/conversationStore.js';

const CH = '/v1/host/openwop-app/channels';
const SESS = '/v1/host/openwop-app/chat/sessions';
const PREFS = '/v1/host/openwop-app/notifications/preferences';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  getAgentRegistry().register({
    agentId: 'test.reviewer', persona: 'Code Reviewer', modelClass: 'general',
  } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
  getAgentRegistry().register({
    agentId: 'test.reviewer2', persona: 'Code Reviewer', modelClass: 'general',
  } as Parameters<ReturnType<typeof getAgentRegistry>['register']>[0]);
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
type Client = ReturnType<typeof client>;

// One SHARED tenant per suite run — channels are tenant-scoped, and the test
// seam otherwise mints a personal tenant per user (co-tenant users need the
// explicit tenantId, per authTestSeam.ts).
const TENANT = `t-adr0192-${Date.now()}`;

async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `adr0192-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} Person`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string };
}

async function makeChannel(c: Client, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await c.post(CH, { name: `room-${Math.random().toString(36).slice(2, 8)}`, visibility: 'public', ...extra });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.channel.conversationId as string;
}

function headerOf(list: Res, id: string): any {
  return (list.body.sessions as any[]).find((s) => s.sessionId === id);
}

describe('ADR 0192 D4 — one-flow create + name normalization', () => {
  it('normalizes the channel name at create and rename, reconciling BOTH stores', async () => {
    const { c } = await login('owner');
    const created = await c.post(CH, { name: '  War Room! 2026  ', visibility: 'public' });
    expect(created.status).toBe(201);
    expect(created.body.channel.channel.name).toBe('war-room-2026');
    const id = created.body.channel.conversationId as string;

    expect((await c.patch(`${CH}/${id}`, { name: 'Ops OnCall' })).status).toBe(200);
    const detail = await c.get(`${CH}/${id}`);
    expect(detail.body.channel.channel.name).toBe('ops-oncall');
    // The session-header title (the rail's list source) tracked the rename —
    // the pre-0192 drift is closed.
    const header = headerOf(await c.get(SESS), id);
    expect(header?.title).toBe('ops-oncall');
  });

  it('creates with initial members + agents through the real membership paths (slugs stamped, names resolved)', async () => {
    const { c, userId: ownerId } = await login('owner');
    const { userId: memberId } = await login('member');
    const created = await c.post(CH, {
      name: 'kickoff', visibility: 'private',
      memberUserIds: [memberId],
      agentIds: ['test.reviewer', 'test.reviewer2'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.channel.conversationId as string;
    const detail = await c.get(`${CH}/${id}`);
    const roster = detail.body.channel.roster as Array<{ subjectRef: string; role: string; mentionSlug?: string; displayName: string; kind: string }>;
    // Owner synthesized (not a participant row) + member + two agents.
    expect(roster.find((r) => r.role === 'owner')?.subjectRef).toBe(`user:${ownerId}`);
    expect(roster.some((r) => r.subjectRef === `user:${memberId}`)).toBe(true);
    // Same-persona agents dedupe their mention slugs (host/slug.ts uniqueSlug).
    const slugs = roster.filter((r) => r.kind === 'agent').map((r) => r.mentionSlug).sort();
    expect(slugs).toEqual(['code-reviewer', 'code-reviewer-2']);
    // D2 — display identity resolved server-side; no raw refs render as names.
    const owner = roster.find((r) => r.role === 'owner');
    expect(owner?.displayName).toBe('owner Person');
    expect(roster.every((r) => r.displayName && !r.displayName.startsWith('user:') && !r.displayName.startsWith('agent:'))).toBe(true);
  });

  it('rejects a create whose agent does not resolve (fail-closed, nothing created)', async () => {
    const { c } = await login('owner');
    expect((await c.post(CH, { name: 'ghost', agentIds: ['no.such.agent'] })).status).toBe(404);
  });
});

describe('ADR 0192 D3 — self-serve leave + the members/me registration-order pin', () => {
  it('a member leaves via members/me (NOT owner-gated — the shadowing regression); the owner gets 409', async () => {
    const { c: ownerC } = await login('owner');
    const { c: memberC } = await login('member');
    const id = await makeChannel(ownerC);
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);
    // The pin: if `me` bound to `:userId`, the owner-gate would 403 this leave.
    expect((await memberC.del(`${CH}/${id}/members/me`)).status).toBe(204);
    // Having left, the member is no longer a participant → 404 mask.
    expect((await memberC.del(`${CH}/${id}/members/me`)).status).toBe(404);
    // The owner cannot leave — archive/transfer is the door (409 conflict).
    expect((await ownerC.del(`${CH}/${id}/members/me`)).status).toBe(409);
  });
});

describe('ADR 0192 D3 — membership-mutation bypass closures (architect finding 2)', () => {
  it('generic participant PUT/DELETE reject channels (400, typed) — even for the owner', async () => {
    const { c } = await login('owner');
    const { userId: memberId } = await login('member');
    const id = await makeChannel(c);
    const put = await c.put(`${SESS}/${id}/participants`, { subjectRef: 'agent:no.such.agent' });
    expect(put.status, JSON.stringify(put.body)).toBe(400);
    expect(String(put.body.error?.message ?? put.body.message)).toMatch(/channels\/:id\/members/);
    const del = await c.del(`${SESS}/${id}/participants/${encodeURIComponent(`user:${memberId}`)}`);
    expect(del.status).toBe(400);
  });

  it('board promotion rejects channels (the descriptor-destroying path)', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const promote = await c.post(`${SESS}/${id}/board`, { boardId: 'board-1', participants: [] });
    expect(promote.status, JSON.stringify(promote.body)).toBe(400);
    // The descriptor survived.
    const detail = await c.get(`${CH}/${id}`);
    expect(detail.body.channel.type).toBe('channel');
    expect(detail.body.channel.channel).toBeTruthy();
  });

  it('generic message POST rejects channels (the append-path convergence, D6)', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const post = await c.post(`${SESS}/${id}/messages`, { messageId: 'gm1', role: 'user', content: 'hi' });
    expect(post.status, JSON.stringify(post.body)).toBe(400);
    expect(String(post.body.error?.message ?? post.body.message)).toMatch(/channels\/:id\/messages/);
  });
});

describe('ADR 0192 D6 — unread differencing + @channel mention counters', () => {
  it('unreadCount derives from messageCount − readMessageCount; @channel bumps the mention tier; markRead clears it', async () => {
    const { c: ownerC, userId: ownerId } = await login('owner');
    const { c: memberC } = await login('member');
    const id = await makeChannel(ownerC);
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);

    // Member posts twice; the second is a broadcast mention.
    expect((await memberC.post(`${CH}/${id}/messages`, { content: 'first' })).status).toBe(201);
    expect((await memberC.post(`${CH}/${id}/messages`, { content: '@channel standup in 5' })).status).toBe(201);
    // Mention stamping is post-append fire-and-forget — settle it.
    await new Promise((r) => setTimeout(r, 200));

    // The OWNER's participant row (the cookie create path stores one) carries
    // the mention counter; the AUTHOR must not self-mention.
    const header = headerOf(await ownerC.get(SESS), id);
    expect(header, 'channel visible in the owner rail list').toBeTruthy();
    expect(header.messageCount).toBe(2);
    const ownerRef = `user:${ownerId}`;
    const beforeParts = await ownerC.get(`${SESS}/${id}/participants`);
    const beforeOwner = (beforeParts.body.participants as any[]).find((p) => p.subjectRef === ownerRef);
    const beforeMember = (beforeParts.body.participants as any[]).find((p) => p.role === 'member' && p.subjectRef.startsWith('user:'));
    expect(beforeOwner?.mentionCount).toBe(1); // @channel reached the owner
    expect(beforeMember?.mentionCount).toBeUndefined(); // no self-mention for the author

    // Owner marks read → readMessageCount stamps to the current messageCount
    // and the mention tier clears.
    expect((await ownerC.post(`${SESS}/${id}/read`)).status).toBe(204);
    const afterHeader = headerOf(await ownerC.get(SESS), id);
    const afterOwner = (afterHeader.participants as any[]).find((p) => p.subjectRef === ownerRef);
    expect(afterOwner?.readMessageCount).toBe(afterHeader.messageCount); // unread = 0 by differencing
    expect(afterOwner?.mentionCount).toBeUndefined(); // zeroed on read (0 is elided)

    // The member's side: reads stamp their own marker the same way.
    expect((await memberC.post(`${SESS}/${id}/read`)).status).toBe(204);
    const memberHeader = headerOf(await memberC.get(SESS), id);
    const memberRow = (memberHeader.participants as any[]).find((p) => p.role === 'member' && p.subjectRef.startsWith('user:'));
    expect(memberRow?.readMessageCount).toBe(memberHeader.messageCount);
  });
});

describe('mentions-inbox rollup (2026-07-17) — the channel LIST carries the caller\'s counts', () => {
  it('a joined caller\'s list rows carry unreadCount + mentionCount; markRead clears; non-joined rows carry none', async () => {
    const { c: ownerC } = await login('owner');
    const { c: memberC } = await login('member');
    const { c: outsiderC } = await login('outsider');
    const id = await makeChannel(ownerC);
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);

    expect((await memberC.post(`${CH}/${id}/messages`, { content: 'hello' })).status).toBe(201);
    expect((await memberC.post(`${CH}/${id}/messages`, { content: '@channel ping' })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 200)); // mention stamp is post-append fire-and-forget

    // The OWNER sees both counts on the LIST (the mentions-inbox read).
    const ownerList = await ownerC.get(CH);
    const ownerRow = (ownerList.body.channels as any[]).find((r) => r.conversationId === id);
    expect(ownerRow.joined).toBe(true);
    expect(ownerRow.unreadCount).toBe(2);
    expect(ownerRow.mentionCount).toBe(1);

    // A non-member (public channel visible in the browse list) carries NO counts.
    const outList = await outsiderC.get(CH);
    const outRow = (outList.body.channels as any[]).find((r) => r.conversationId === id);
    expect(outRow.joined).toBe(false);
    expect(outRow.unreadCount).toBeUndefined();
    expect(outRow.mentionCount).toBeUndefined();

    // markRead clears both by differencing.
    expect((await ownerC.post(`${SESS}/${id}/read`)).status).toBe(204);
    const after = (await ownerC.get(CH)).body.channels as any[];
    const afterRow = after.find((r) => r.conversationId === id);
    expect(afterRow.unreadCount).toBe(0);
    expect(afterRow.mentionCount).toBe(0);
  });
});

describe('ADR 0192 D5 — envelope posts', () => {
  it('accepts a serialized ChatMessage envelope, stores it verbatim, resolves the author identity', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const envelope = JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'hello with attachment' }, { type: 'image', data: 'x'.repeat(64) }] });
    const post = await c.post(`${CH}/${id}/messages`, { content: envelope });
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    const messages = await c.get(`${CH}/${id}/messages`);
    const stored = (messages.body.messages as any[]).find((m) => m.messageId === post.body.messageId);
    expect(stored.content).toBe(envelope); // envelope stored verbatim
    expect(stored.authorDisplayName).toBe('owner Person'); // D2 — resolved author identity
    expect(stored.authorKind).toBe('user');
  });
});

describe('ADR 0192 D8 — browse directory counts', () => {
  it('discovery rows carry memberCount/agentCount/lastActivityAt without leaking the roster', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c, { agentIds: ['test.reviewer'] });
    const { c: browser } = await login('browser');
    const list = await browser.get(CH);
    const row = (list.body.channels as any[]).find((r) => r.conversationId === id);
    expect(row).toBeTruthy();
    expect(row.memberCount).toBe(1); // the owner
    expect(row.agentCount).toBe(1);
    expect(typeof row.lastActivityAt).toBe('string');
    expect(row.participants).toBeUndefined(); // the FU-4 privacy posture holds
    expect(row.ownerUserId).toBeUndefined();
  });
});

describe('ADR 0192 Phase-2 amendments — isSelf + viewerSubjectRef', () => {
  it('marks the CALLER\'s participant row isSelf (owner and member views differ) and returns viewerSubjectRef', async () => {
    const { c: ownerC, userId: ownerId } = await login('owner');
    const { c: memberC, userId: memberId } = await login('member');
    const id = await makeChannel(ownerC);
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);

    const ownerView = headerOf(await ownerC.get(SESS), id);
    expect((ownerView.participants as any[]).find((p) => p.isSelf)?.subjectRef).toBe(`user:${ownerId}`);
    const memberView = headerOf(await memberC.get(SESS), id);
    expect((memberView.participants as any[]).find((p) => p.isSelf)?.subjectRef).toBe(`user:${memberId}`);

    const detail = await memberC.get(`${CH}/${id}`);
    expect(detail.body.channel.viewerSubjectRef).toBe(`user:${memberId}`);
  });
});

describe('ADR 0192 — the generic create path stays closed to channels', () => {
  // Pin: CONVERSATION_TYPES deliberately omits 'channel' so the generic
  // conversation-create route can't mint channels (the D3 guards assume this
  // class of bypass can't exist). A future "just add it to the const" must
  // consciously break this test and revisit the guards.
  it('CONVERSATION_TYPES does not contain channel', () => {
    expect(CONVERSATION_TYPES).not.toContain('channel');
  });
  it('the generic session create rejects type:channel', async () => {
    const { c } = await login('owner');
    const r = await c.post(SESS, { title: 'sneaky', type: 'channel' });
    expect(r.status).toBe(400);
  });
});

describe('ADR 0192 D7 — notification prefs mutedConversations (merge-on-absent)', () => {
  it('stores bounded mute ids and preserves them when an older client PUTs without the field', async () => {
    const { c } = await login('owner');
    const get = await c.get(PREFS);
    if (get.status === 404) return; // prefs surface gated off in this env
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    const base = get.body.preferences;

    const put = await c.put(PREFS, { ...base, mutedConversations: ['conv-1', 'conv-1', 'conv-2'] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.preferences.mutedConversations).toEqual(['conv-1', 'conv-2']); // deduped

    // An older client PUTs the pre-0192 shape (no field) — mutes survive.
    const { mutedConversations: _dropped, ...legacyShape } = put.body.preferences;
    const legacyPut = await c.put(PREFS, legacyShape);
    expect(legacyPut.status).toBe(200);
    expect(legacyPut.body.preferences.mutedConversations).toEqual(['conv-1', 'conv-2']);
  });

  it('rejects an unbounded mute list', async () => {
    const { c } = await login('owner');
    const get = await c.get(PREFS);
    if (get.status === 404) return;
    const bad = await c.put(PREFS, { ...get.body.preferences, mutedConversations: Array.from({ length: 501 }, (_, i) => `c-${i}`) });
    expect(bad.status).toBe(400);
  });
});
