/**
 * CS-CH-3 (conversation-stack audit residue) — channel message pagination.
 *
 * The channel messages route (and catch-up) previously read the WHOLE thread
 * on every call. Pins the chat-sessions paging idiom on the channel surface:
 *  - ?limit=N → the N most-recent messages (ASC) + nextCursor
 *  - &before=<cursor> → the N older than the cursor; null cursor at history start
 *  - no limit → the legacy full-thread shape, unchanged (back-compat)
 *  - the shared cursor codec rejects malformed cursors (400)
 *  - catch-up stays correct on a long thread (bounded read; counter-based unread):
 *    the unread count is an exact COUNT of the thread (not the stale `message_count`
 *    column) and the summarized tail is capped at 50 messages, newest included.
 *
 * What breaks it: a page that drops/duplicates a message at a cursor boundary, a
 * legacy caller that suddenly gets a paged shape, or catch-up reading the whole
 * thread / miscounting unread (the CS-CH-3 architect-review finding).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { createChannel, addChannelAgent, postChannelMessage, resolveChannelCatchup } from '../src/features/channels/channelService.js';

/** ADR 0879 D1 — a caller holding `workspace:write` (not an admin): the service-level
 *  witnesses below exercise the channel rules, not the role gate (route tests do). */
const FULL_AUTHORITY = { canWrite: true, isAdmin: false };

let server: http.Server;
let BASE: string;
const CH = '/host/openwop-app/channels';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  getAgentRegistry().register({
    agentId: 'chpage.agent', persona: 'Catch-up Agent', modelClass: 'general',
    systemPrompt: 'summarize', packName: 'test', packVersion: '0', toolAllowlist: [],
  });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: unknown }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}

const TENANT = `t-chpage-${Date.now()}`;
async function login(name: string) {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `chpage-${name}-${n++}@x.test`, displayName: name, tenantId: TENANT });
  expect(r.status).toBe(201);
  // ADR 0879 D1 — a co-tenant login gets no member row from the seam (it founds the
  // workspace for the FIRST login only), and channel writes now ask the ROLE. Make
  // every person a real Editor of the workspace, the production shape (idempotent: a
  // founder keeps their owner row).
  await createMember({ orgId: TENANT, tenantId: TENANT, displayName: name, subject: (r.body as { user: { userId: string } }).user.userId, roles: ['editor'] });
  return c;
}

interface MsgRow { messageId: string; content: string }
interface PageBody { messages: MsgRow[]; nextCursor?: string | null }
/** Narrow a messages response at runtime (no laundering cast). */
function page(r: Res): PageBody {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const b = r.body as { messages?: unknown };
  expect(Array.isArray(b.messages)).toBe(true);
  return r.body as PageBody;
}
const channelIdOf = (r: Res): string => (r.body as { channel: { conversationId: string } }).channel.conversationId;

describe('CS-CH-3 — channel message pagination', () => {
  it('pages a long thread newest-first with a stable cursor chain; legacy no-limit shape unchanged', async () => {
    const c = await login('owner');
    const created = await c.post(CH, { name: `pager-${Math.random().toString(36).slice(2, 8)}`, visibility: 'public' });
    expect(created.status).toBe(201);
    const id = channelIdOf(created);
    for (let i = 1; i <= 12; i++) {
      const post = await c.post(`${CH}/${id}/messages`, { content: `msg-${String(i).padStart(2, '0')}` });
      expect(post.status).toBe(201);
    }

    // Page 1 — the 5 most recent, ASC.
    const b1 = page(await c.get(`${CH}/${id}/messages?limit=5`));
    expect(b1.messages.map((m) => m.content)).toEqual(['msg-08', 'msg-09', 'msg-10', 'msg-11', 'msg-12']);
    expect(typeof b1.nextCursor).toBe('string');

    // Page 2 — older than the cursor.
    const b2 = page(await c.get(`${CH}/${id}/messages?limit=5&before=${encodeURIComponent(b1.nextCursor as string)}`));
    expect(b2.messages.map((m) => m.content)).toEqual(['msg-03', 'msg-04', 'msg-05', 'msg-06', 'msg-07']);

    // Page 3 — history start: remaining 2, null cursor.
    const b3 = page(await c.get(`${CH}/${id}/messages?limit=5&before=${encodeURIComponent(b2.nextCursor as string)}`));
    expect(b3.messages.map((m) => m.content)).toEqual(['msg-01', 'msg-02']);
    expect(b3.nextCursor).toBeNull();

    // Legacy shape — full thread, NO nextCursor key.
    const legacy = await c.get(`${CH}/${id}/messages`);
    const lb = page(legacy);
    expect(lb.messages).toHaveLength(12);
    expect('nextCursor' in (legacy.body as object)).toBe(false);

    // Malformed inputs 400 through the shared codec.
    expect((await c.get(`${CH}/${id}/messages?limit=0`)).status).toBe(400);
    expect((await c.get(`${CH}/${id}/messages?limit=5&before=not-a-cursor`)).status).toBe(400);
  });

  it('catch-up stays correct with the bounded read (counter-based unread)', async () => {
    // Service leg (in-process — createApp initialized persistence): 55 posts > the
    // 50-message cap. Unread is the exact count; the task covers ONLY the newest 50.
    const owner = 'u-catch';
    const ch = await createChannel(TENANT, owner, { name: `catchup-${n++}`, visibility: 'public' }, FULL_AUTHORITY);
    await addChannelAgent(TENANT, ch.conversationId, owner, FULL_AUTHORITY, 'chpage.agent');
    for (let i = 1; i <= 55; i++) await postChannelMessage(TENANT, ch.conversationId, owner, `c-${String(i).padStart(2, '0')}`, FULL_AUTHORITY);
    const r = await resolveChannelCatchup(TENANT, ch.conversationId, owner, FULL_AUTHORITY);
    expect(r.agentId).toBe('chpage.agent');
    expect(r.unreadCount).toBe(55);
    expect(r.task).toContain('c-55'); // the newest is in the tail
    expect(r.task).toContain('c-06'); // the oldest of the capped 50
    expect(r.task).not.toContain('c-05'); // beyond the cap — not read

    // Route leg: POST /catchup maps the same resolution onto { runId, unreadCount }.
    const c = await login('catcher');
    const created = await c.post(CH, { name: `catchup-route-${n++}`, visibility: 'public', agentIds: ['chpage.agent'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = channelIdOf(created);
    // 'mention' policy: the un-mentioned posts below dispatch NO agent turn, so no
    // background run can append a reply into the thread and move the count.
    expect((await c.put(`${CH}/${id}/agents/chpage.agent/policy`, { policy: 'mention' })).status).toBe(200);
    for (let i = 1; i <= 6; i++) expect((await c.post(`${CH}/${id}/messages`, { content: `r-${i}` })).status).toBe(201);
    const res = await c.post(`${CH}/${id}/catchup`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const body = res.body as { runId?: unknown; unreadCount?: unknown };
    expect(typeof body.runId).toBe('string');
    expect(body.unreadCount).toBe(6);
  });
});
