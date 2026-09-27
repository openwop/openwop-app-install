/**
 * ADR 0195 — message affordances (edit · tombstone · reactions), Phase 1
 * route-level coverage including the four gate-mandated cases: the
 * public-channel non-joined author (channel-aware visibility), the
 * edit-with-@channel mention pin, the tombstone-never-dispatches pin (by
 * construction: dispatch lives only on the channel POST path), and the
 * messageCount-immutability differencing pin.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

const CH = '/v1/host/openwop-app/channels';
const SESS = '/v1/host/openwop-app/chat/sessions';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
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

const TENANT = `t-adr0195-${Date.now()}`;
async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `adr0195-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} P`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string };
}

async function makeChannel(c: Client, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await c.post(CH, { name: `r-${Math.random().toString(36).slice(2, 8)}`, visibility: 'public', ...extra });
  expect(created.status).toBe(201);
  return created.body.channel.conversationId as string;
}

async function post(c: Client, id: string, text: string): Promise<string> {
  const r = await c.post(`${CH}/${id}/messages`, { content: text });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.messageId as string;
}

const E = (emoji: string): string => encodeURIComponent(emoji);

describe('ADR 0195 D1 — edit (server-derived editedAt, channel-aware authz)', () => {
  it('the author edits their own channel message; editedAt stamps only on real change', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const mid = await post(c, id, 'first draft');

    const edit = await c.put(`${SESS}/${id}/messages/${mid}`, { content: 'second draft' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const meta1 = JSON.parse(edit.body.meta as string) as { editedAt?: string };
    expect(meta1.editedAt).toBeTruthy();

    // Same content + fresh caller meta → the prior editedAt is PRESERVED, not
    // dropped (a content-unchanged PUT is a meta touch-up, not an un-edit).
    const noop = await c.put(`${SESS}/${id}/messages/${mid}`, { content: 'second draft', meta: JSON.stringify({ keep: true }) });
    expect(noop.status).toBe(200);
    const meta2 = JSON.parse(noop.body.meta as string) as { editedAt?: string; keep?: boolean };
    expect(meta2.keep).toBe(true);
    expect(meta2.editedAt).toBe(meta1.editedAt); // carried forward, not re-stamped
  });

  it('a non-author member cannot edit; the channel owner can', async () => {
    const { c: ownerC } = await login('owner');
    const { c: memberC } = await login('member');
    const id = await makeChannel(ownerC);
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);
    const mid = await post(memberC, id, 'my message');

    const { c: otherC } = await login('other');
    expect((await otherC.post(`${CH}/${id}/join`)).status).toBe(200);
    expect((await otherC.put(`${SESS}/${id}/messages/${mid}`, { content: 'tampered' })).status).toBe(403);

    // The channel owner may moderate (edit) a member's message.
    expect((await ownerC.put(`${SESS}/${id}/messages/${mid}`, { content: 'moderated' })).status).toBe(200);
  });

  it('a PUBLIC-channel author who never joined can edit + react to their own post (the visibility fix)', async () => {
    const { c: ownerC } = await login('owner');
    const id = await makeChannel(ownerC);
    const { c: visitorC } = await login('visitor');
    // Post WITHOUT joining (public channels admit any tenant member).
    const mid = await post(visitorC, id, 'drive-by');
    // Pre-0195 these 404'd (the generic predicate didn't know public channels).
    expect((await visitorC.put(`${SESS}/${id}/messages/${mid}`, { content: 'drive-by v2' })).status).toBe(200);
    expect((await visitorC.put(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`)).status).toBe(200);
  });

  it('an edit containing @channel does NOT re-bump mention counters', async () => {
    const { c: ownerC } = await login('owner');
    const { c: memberC, userId: memberId } = await login('member');
    const id = await makeChannel(ownerC);
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);
    const mid = await post(ownerC, id, '@channel heads up');
    await new Promise((r) => setTimeout(r, 150));

    const before = await memberC.get(SESS);
    const row = (before.body.sessions as any[]).find((s) => s.sessionId === id);
    const mentionBefore = (row.participants as any[]).find((p) => p.subjectRef === `user:${memberId}`)?.mentionCount;
    expect(mentionBefore).toBe(1);

    // Author edits the SAME @channel message twice — counters must not move.
    expect((await ownerC.put(`${SESS}/${id}/messages/${mid}`, { content: '@channel heads up (edited)' })).status).toBe(200);
    expect((await ownerC.put(`${SESS}/${id}/messages/${mid}`, { content: '@channel heads up (edited again)' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const after = await memberC.get(SESS);
    const rowAfter = (after.body.sessions as any[]).find((s) => s.sessionId === id);
    expect((rowAfter.participants as any[]).find((p) => p.subjectRef === `user:${memberId}`)?.mentionCount).toBe(1);
  });
});

describe('ADR 0195 D2 — tombstone delete', () => {
  it('tombstones in place: sentinel content + meta.deletedAt/deletedBy; messageCount UNCHANGED (differencing pin); reactions cascade', async () => {
    const { c, userId } = await login('owner');
    const id = await makeChannel(c);
    const mid = await post(c, id, 'delete me');
    await post(c, id, 'keep me');
    expect((await c.put(`${SESS}/${id}/messages/${mid}/reactions/${E('🎉')}`)).status).toBe(200);

    const beforeCount = ((await c.get(SESS)).body.sessions as any[]).find((s) => s.sessionId === id).messageCount;
    expect((await c.del(`${SESS}/${id}/messages/${mid}`)).status).toBe(204);

    const messages = (await c.get(`${CH}/${id}/messages`)).body.messages as any[];
    const tomb = messages.find((m) => m.messageId === mid);
    expect(tomb.content).toBe('{"deleted":true}');
    const meta = JSON.parse(tomb.meta as string) as { deletedAt?: string; deletedBy?: string };
    expect(meta.deletedAt).toBeTruthy();
    expect(meta.deletedBy).toBe(`user:${userId}`);
    expect(tomb.reactions).toBeUndefined(); // cascade

    const afterCount = ((await c.get(SESS)).body.sessions as any[]).find((s) => s.sessionId === id).messageCount;
    expect(afterCount).toBe(beforeCount); // ADR 0192 D6 unread differencing pin
  });

  it('archived channels reject edit and delete', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const mid = await post(c, id, 'frozen');
    expect((await c.post(`${CH}/${id}/archive`)).status).toBe(204);
    expect((await c.put(`${SESS}/${id}/messages/${mid}`, { content: 'thaw?' })).status).toBe(400);
    expect((await c.del(`${SESS}/${id}/messages/${mid}`)).status).toBe(400);
  });

  it('a tombstoned message is immutable: edit + react reject, re-delete is idempotent', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const mid = await post(c, id, 'delete me');
    expect((await c.del(`${SESS}/${id}/messages/${mid}`)).status).toBe(204);
    expect((await c.put(`${SESS}/${id}/messages/${mid}`, { content: 'undelete?' })).status).toBe(400);
    expect((await c.put(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`)).status).toBe(400);
    expect((await c.del(`${SESS}/${id}/messages/${mid}`)).status).toBe(204); // idempotent
  });
});

describe('ADR 0195 D3 — reactions', () => {
  it('add/remove are idempotent; aggregates carry {emoji, count, mine}; both projections join them', async () => {
    const { c: ownerC } = await login('owner');
    const { c: memberC } = await login('member');
    const id = await makeChannel(ownerC);
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);
    const mid = await post(ownerC, id, 'react to this');

    expect((await ownerC.put(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`)).status).toBe(200);
    expect((await ownerC.put(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`)).status).toBe(200); // idempotent
    const memberAdd = await memberC.put(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`);
    expect(memberAdd.status).toBe(200);
    expect(memberAdd.body.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);

    // Channels projection carries the aggregate; `mine` is viewer-relative.
    const ownerView = ((await ownerC.get(`${CH}/${id}/messages`)).body.messages as any[]).find((m) => m.messageId === mid);
    expect(ownerView.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    // Generic (paginated) projection too.
    const generic = ((await memberC.get(`${SESS}/${id}/messages?limit=10`)).body.messages as any[]).find((m) => m.messageId === mid);
    expect(generic.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);

    // Remove restores the count; removing again is a no-op.
    const rm = await memberC.del(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`);
    expect(rm.status).toBe(200);
    expect(rm.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect((await memberC.del(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`)).status).toBe(200);
  });

  it('rejects out-of-set emoji and unauthenticated/invisible callers', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c, { visibility: 'private' });
    const mid = await post(c, id, 'private');
    expect((await c.put(`${SESS}/${id}/messages/${mid}/reactions/${E('💩')}`)).status).toBe(400);
    // A different tenant-member can't even see a PRIVATE channel → 404 mask.
    const { c: other } = await login('outsider');
    expect((await other.put(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`)).status).toBe(404);
  });
});

describe('ADR 0195 — rail-list scope vs channel-aware visibility', () => {
  it('a public channel is READABLE by any member but NOT rail-listed for non-members', async () => {
    const { c: ownerC } = await login('owner');
    const id = await makeChannel(ownerC);
    await post(ownerC, id, 'hello');
    const { c: browser } = await login('browser');
    // Readable by id (the widened predicate)…
    expect((await browser.get(`${SESS}/${id}/messages`)).status).toBe(200);
    // …but not in the rail list (membership display rule).
    const list = await browser.get(SESS);
    expect((list.body.sessions as any[]).some((s) => s.sessionId === id)).toBe(false);
    // Members still see it listed.
    const ownerList = await ownerC.get(SESS);
    expect((ownerList.body.sessions as any[]).some((s) => s.sessionId === id)).toBe(true);
  });
});
