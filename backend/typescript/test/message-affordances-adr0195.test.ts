/**
 * ADR 0195 — message affordances (edit · tombstone · reactions), Phase 1
 * route-level coverage including the four gate-mandated cases: the
 * public-channel non-joined author (channel-aware visibility), the
 * edit-with-@channel mention pin, the tombstone-never-dispatches pin (by
 * construction: dispatch lives only on the channel POST path — NOT asserted
 * here, see below), and the messageCount-immutability differencing pin.
 *
 * (w72) The tombstone-never-dispatches property is structural — the DELETE
 * handler has no dispatch call to reach — so no case in this file can fail on
 * it; it is stated, not tested. Every other gate case is asserted.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';

const CH = '/host/openwop-app/channels';
const SESS = '/host/openwop-app/chat/sessions';

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

/** The response fields these cases read — typed at the boundary, not `any`. */
interface Reaction { emoji: string; count: number; mine: boolean }
interface Participant { subjectRef: string; mentionCount?: number }
interface SessionRow { sessionId: string; messageCount: number; participants?: Participant[] }
interface MessageRow { messageId: string; content: string; meta?: string; reactions?: Reaction[] }
interface Body {
  user?: { userId: string };
  channel?: { conversationId: string };
  messageId?: string;
  meta?: string;
  reactions?: Reaction[];
  sessions?: SessionRow[];
  messages?: MessageRow[];
  error?: string;
  message?: string;
}
interface Res { status: number; body: Body }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: (out ?? {}) as Body };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}
type Client = ReturnType<typeof client>;

const TENANT = `t-adr0195-${Date.now()}`;
async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `adr0195-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} P`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  // ADR 0879 D1 — a co-tenant login gets no member row from the seam (it founds the
  // workspace for the FIRST login only), and channel writes now ask the ROLE. Make
  // every person a real Editor of the workspace, the production shape (idempotent: a
  // founder keeps their owner row).
  await createMember({ orgId: TENANT, tenantId: TENANT, displayName: name, subject: r.body.user!.userId, roles: ['editor'] });
  return { c, userId: r.body.user!.userId };
}

async function makeChannel(c: Client, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await c.post(CH, { name: `r-${Math.random().toString(36).slice(2, 8)}`, visibility: 'public', ...extra });
  expect(created.status).toBe(201);
  return created.body.channel!.conversationId;
}

async function post(c: Client, id: string, text: string): Promise<string> {
  const r = await c.post(`${CH}/${id}/messages`, { content: text });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.messageId!;
}

const E = (emoji: string): string => encodeURIComponent(emoji);

/** The refusal is the one this case means: code AND message, not any 4xx. */
function refusedWith(r: Res, status: number, code: string, message: string): void {
  expect(r.status).toBe(status);
  expect(r.body.error).toBe(code);
  expect(r.body.message).toContain(message);
}

const sessionRow = (r: Res, id: string): SessionRow | undefined => r.body.sessions?.find((s) => s.sessionId === id);
const mentionsOf = (r: Res, id: string, userId: string): number | undefined =>
  sessionRow(r, id)?.participants?.find((p) => p.subjectRef === `user:${userId}`)?.mentionCount;

describe('ADR 0195 D1 — edit (server-derived editedAt, channel-aware authz)', () => {
  it('the author edits their own channel message; editedAt stamps only on real change', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const mid = await post(c, id, 'first draft');

    const edit = await c.put(`${SESS}/${id}/messages/${mid}`, { content: 'second draft' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const meta1 = JSON.parse(edit.body.meta!) as { editedAt?: string };
    expect(meta1.editedAt).toBeTruthy();

    // Same content + fresh caller meta → the prior editedAt is PRESERVED, not
    // dropped (a content-unchanged PUT is a meta touch-up, not an un-edit).
    const noop = await c.put(`${SESS}/${id}/messages/${mid}`, { content: 'second draft', meta: JSON.stringify({ keep: true }) });
    expect(noop.status).toBe(200);
    const meta2 = JSON.parse(noop.body.meta!) as { editedAt?: string; keep?: boolean };
    expect(meta2.keep).toBe(true);
    expect(meta2.editedAt).toBe(meta1.editedAt); // carried forward, not re-stamped
  });

  it('a non-author member cannot edit; neither can the channel owner, who may delete', async () => {
    const { c: ownerC } = await login('owner');
    const { c: memberC } = await login('member');
    const id = await makeChannel(ownerC);
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);
    const mid = await post(memberC, id, 'my message');

    const { c: otherC } = await login('other');
    expect((await otherC.post(`${CH}/${id}/join`)).status).toBe(200);
    refusedWith(await otherC.put(`${SESS}/${id}/messages/${mid}`, { content: 'tampered' }), 403, 'forbidden', 'Only the author may edit');

    // ADR 0879 D2 — the owner moderates by DELETE, never by rewriting a post that
    // keeps its author's name (this used to assert 200).
    refusedWith(await ownerC.put(`${SESS}/${id}/messages/${mid}`, { content: 'moderated' }), 403, 'forbidden', 'Only the author may edit');
    expect((await ownerC.del(`${SESS}/${id}/messages/${mid}`)).status).toBe(204);
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
    // The bump lands asynchronously after the POST: wait for the real condition.
    await vi.waitFor(async () => { expect(mentionsOf(await memberC.get(SESS), id, memberId)).toBe(1); }, { timeout: 5_000, interval: 20 });

    // Author edits the SAME @channel message twice — counters must not move.
    expect((await ownerC.put(`${SESS}/${id}/messages/${mid}`, { content: '@channel heads up (edited)' })).status).toBe(200);
    expect((await ownerC.put(`${SESS}/${id}/messages/${mid}`, { content: '@channel heads up (edited again)' })).status).toBe(200);
    // A NEGATIVE assertion ("did not move"): a bump would land after the PUT the
    // same way the POST's did, so give it a positive control in the SAME window —
    // a fresh @channel POST that MUST move the counter to 2, and only 2.
    await post(ownerC, id, '@channel second announcement');
    await vi.waitFor(async () => { expect(mentionsOf(await memberC.get(SESS), id, memberId)).toBe(2); }, { timeout: 5_000, interval: 20 });
  });
});

describe('ADR 0195 D2 — tombstone delete', () => {
  it('tombstones in place: sentinel content + meta.deletedAt/deletedBy; messageCount UNCHANGED (differencing pin); reactions cascade', async () => {
    const { c, userId } = await login('owner');
    const id = await makeChannel(c);
    const mid = await post(c, id, 'delete me');
    await post(c, id, 'keep me');
    expect((await c.put(`${SESS}/${id}/messages/${mid}/reactions/${E('🎉')}`)).status).toBe(200);

    const beforeCount = sessionRow(await c.get(SESS), id)!.messageCount;
    expect((await c.del(`${SESS}/${id}/messages/${mid}`)).status).toBe(204);

    const messages = (await c.get(`${CH}/${id}/messages`)).body.messages ?? [];
    const tomb = messages.find((m) => m.messageId === mid)!;
    expect(tomb.content).toBe('{"deleted":true}');
    const meta = JSON.parse(tomb.meta!) as { deletedAt?: string; deletedBy?: string };
    expect(meta.deletedAt).toBeTruthy();
    expect(meta.deletedBy).toBe(`user:${userId}`);
    expect(tomb.reactions).toBeUndefined(); // cascade

    const afterCount = sessionRow(await c.get(SESS), id)!.messageCount;
    expect(afterCount).toBe(beforeCount); // ADR 0192 D6 unread differencing pin
  });

  it('archived channels reject edit and delete', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const mid = await post(c, id, 'frozen');
    expect((await c.post(`${CH}/${id}/archive`)).status).toBe(204);
    refusedWith(await c.put(`${SESS}/${id}/messages/${mid}`, { content: 'thaw?' }), 400, 'validation_error', 'Channel is archived.');
    refusedWith(await c.del(`${SESS}/${id}/messages/${mid}`), 400, 'validation_error', 'Channel is archived.');
  });

  it('a tombstoned message is immutable: edit + react reject, re-delete is idempotent', async () => {
    const { c } = await login('owner');
    const id = await makeChannel(c);
    const mid = await post(c, id, 'delete me');
    expect((await c.del(`${SESS}/${id}/messages/${mid}`)).status).toBe(204);
    refusedWith(await c.put(`${SESS}/${id}/messages/${mid}`, { content: 'undelete?' }), 400, 'validation_error', 'A deleted message cannot be edited.');
    expect((await c.put(`${SESS}/${id}/messages/${mid}/reactions/${E('👍')}`)).status).toBe(400);
    const tombMeta = async (): Promise<string | undefined> =>
      ((await c.get(`${CH}/${id}/messages`)).body.messages ?? []).find((m) => m.messageId === mid)?.meta;
    const first = await tombMeta();
    expect(first).toContain('deletedAt');
    expect((await c.del(`${SESS}/${id}/messages/${mid}`)).status).toBe(204); // idempotent
    // …and idempotent in EFFECT, not just status: a re-delete that re-stamped
    // deletedAt also answered 204 (w72 probe maf-redelete).
    expect(await tombMeta()).toBe(first);
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
    const ownerView = ((await ownerC.get(`${CH}/${id}/messages`)).body.messages ?? []).find((m) => m.messageId === mid);
    expect(ownerView?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    // Generic (paginated) projection too.
    const generic = ((await memberC.get(`${SESS}/${id}/messages?limit=10`)).body.messages ?? []).find((m) => m.messageId === mid);
    expect(generic?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);

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
    refusedWith(await c.put(`${SESS}/${id}/messages/${mid}/reactions/${E('💩')}`), 400, 'validation_error', 'emoji MUST be one of the supported set');
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
    expect(sessionRow(list, id)).toBeUndefined();
    // Members still see it listed.
    const ownerList = await ownerC.get(SESS);
    expect(sessionRow(ownerList, id)).toBeDefined();
  });
});
