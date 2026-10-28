/**
 * Durable UI state + message feedback (ADR 0071) — ROUTE-level harness.
 *
 * Proves:
 *  - UI state is strictly caller-scoped: a second user in the SAME tenant never
 *    sees it (the subject comes from the session, never the body), and DELETE
 *    really removes the row (read back, not trusted from the 204);
 *  - the resourceType allowlist and the 4096-byte value cap fail closed, each
 *    with its own refusal message;
 *  - message feedback round-trips and re-rating overwrites; another member of
 *    the tenant who cannot see the conversation can neither read nor overwrite
 *    it (404, the visibility gate);
 *  - feedback naming a REAL conversation in ANOTHER tenant is 404 (the tenant
 *    fence), with a positive control that its owner can rate it.
 *
 * Sabotage witnesses (8f W4): ui-subject-shared, ui-type-allowlist,
 * ui-value-cap, ui-delete-noop, fb-missing-session, fb-rating-vocab,
 * fb-overwrite, fb-visibility-r2.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The host error envelope (`middleware/errorEnvelope.ts`). */
interface ErrorBody { error: string; message: string }
interface UiStateList { items: Array<{ key: string; value: unknown }> }
interface FeedbackRecord { rating: string; reason?: string }
interface FeedbackRead { feedback: FeedbackRecord | null }
interface SessionCreated { sessionId: string }

interface Res<T> { status: number; body: T }
interface Client {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  put: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  del: (p: string) => Promise<number>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, text: res.status === 204 ? '' : await res.text() };
  };
  const json = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const r = await call(method, path, body);
    return { status: r.status, body: (r.text ? JSON.parse(r.text) : null) as T };
  };
  return {
    get: <T>(p: string) => json<T>('GET', p),
    post: <T>(p: string, b?: unknown) => json<T>('POST', p, b),
    put: <T>(p: string, b?: unknown) => json<T>('PUT', p, b),
    del: async (p: string) => (await call('DELETE', p)).status,
  };
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<void> {
  const r = await c.post<unknown>('/host/openwop-app/test/login', { email: `ui-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
async function newSession(c: Client): Promise<string> {
  const s = await c.post<SessionCreated>('/host/openwop-app/chat/sessions', { title: 'Chat' });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return s.body.sessionId;
}

const UI = '/host/openwop-app/ui-state';
const FB = (m: string) => `/host/openwop-app/chat/messages/${m}/feedback`;

describe('ui-state — caller-scoped durable display prefs', () => {
  it('PUTs + GETs the caller’s own rows; a second user never sees them', async () => {
    const tenantId = `org:ui-${Date.now()}-${n++}`;
    const alice = client(); await signup(alice, tenantId);
    const bob = client(); await signup(bob, tenantId);

    const put = await alice.put<unknown>(UI, { resourceType: 'artifact', resourceId: 'document:doc:1', key: 'selectedRevision', value: 'document:doc:1:2' });
    expect(put.status).toBe(200);

    const mine = await alice.get<UiStateList>(`${UI}?resourceType=artifact&resourceId=document:doc:1`);
    expect(mine.body.items.map((i) => [i.key, i.value])).toEqual([['selectedRevision', 'document:doc:1:2']]);

    // Bob — same tenant — sees NONE of alice's UI state (subject-scoped).
    const bobView = await bob.get<UiStateList>(`${UI}?resourceType=artifact&resourceId=document:doc:1`);
    expect(bobView.status).toBe(200);
    expect(bobView.body.items).toEqual([]);

    // DELETE removes it — read back, not trusted from the status.
    expect(await alice.del(`${UI}/artifact/${encodeURIComponent('document:doc:1')}/selectedRevision`)).toBe(204);
    expect((await alice.get<UiStateList>(`${UI}?resourceType=artifact`)).body.items).toEqual([]);
  });

  it('fails closed on an unknown resourceType (400) and an over-cap value (400)', async () => {
    const alice = client(); await signup(alice, `org:ui-${Date.now()}-${n++}`);
    const badType = await alice.put<ErrorBody>(UI, { resourceType: 'secrets', resourceId: 'x', key: 'k', value: 1 });
    expect(badType.status).toBe(400);
    expect(badType.body.message).toMatch(/resourceType MUST be one of/);
    // SPACED text, so no secret-shape redactor can shrink it under the cap first.
    const big = 'word '.repeat(1000);
    const overCap = await alice.put<ErrorBody>(UI, { resourceType: 'conversation', resourceId: 'c1', key: 'blob', value: big });
    expect(overCap.status).toBe(400);
    expect(overCap.body.message).toMatch(/exceeds the 4096-byte UI-state cap/);
    // Nothing was stored by either refused write.
    expect((await alice.get<UiStateList>(UI)).body.items).toEqual([]);
  });
});

describe('message feedback — per-user, visibility-gated', () => {
  it('round-trips the caller’s feedback; another member who cannot see the conversation can neither read nor overwrite it', async () => {
    const tenantId = `org:fb-${Date.now()}-${n++}`;
    const alice = client(); await signup(alice, tenantId);
    const bob = client(); await signup(bob, tenantId);
    const conversationId = await newSession(alice);

    const post = await alice.post<FeedbackRecord>(FB('m1'), { conversationId, rating: 'up', reason: 'great answer' });
    expect(post.status).toBe(200);
    expect(post.body.rating).toBe('up');

    const got = await alice.get<FeedbackRead>(`${FB('m1')}?conversationId=${conversationId}`);
    expect(got.body.feedback?.rating).toBe('up');
    expect(got.body.feedback?.reason).toBe('great answer');

    // Re-rate overwrites (one row per user), not a second row.
    await alice.post<FeedbackRecord>(FB('m1'), { conversationId, rating: 'down' });
    expect((await alice.get<FeedbackRead>(`${FB('m1')}?conversationId=${conversationId}`)).body.feedback?.rating).toBe('down');

    // Bob — same tenant, not a participant — is refused by the visibility gate.
    const bobRead = await bob.get<ErrorBody>(`${FB('m1')}?conversationId=${conversationId}`);
    expect(bobRead.status).toBe(404);
    // The id inside the message is redacted as high-entropy by the error
    // sanitizer, so the shape is asserted, not the id.
    expect(bobRead.body.message).toMatch(/^chat_session ".*" not found\.$/);
    const bobWrite = await bob.post<ErrorBody>(FB('m1'), { conversationId, rating: 'up' });
    expect(bobWrite.status).toBe(404);
    expect((await alice.get<FeedbackRead>(`${FB('m1')}?conversationId=${conversationId}`)).body.feedback?.rating).toBe('down');
  });

  it('rejects feedback on a conversation the caller cannot see (404)', async () => {
    // A REAL conversation, in ANOTHER tenant — not an id that exists nowhere.
    const carol = client(); await signup(carol, `org:fb-other-${Date.now()}-${n++}`);
    const foreign = await newSession(carol);
    // Positive control: its owner can rate it.
    expect((await carol.post<FeedbackRecord>(FB('m1'), { conversationId: foreign, rating: 'up' })).status).toBe(200);

    const alice = client(); await signup(alice, `org:fb-${Date.now()}-${n++}`);
    const r = await alice.post<ErrorBody>(FB('m1'), { conversationId: foreign, rating: 'up' });
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/^chat_session ".*" not found\.$/);
  });

  it('validates the rating vocabulary (400)', async () => {
    const alice = client(); await signup(alice, `org:fb-${Date.now()}-${n++}`);
    const conversationId = await newSession(alice);
    const r = await alice.post<ErrorBody>(FB('m1'), { conversationId, rating: 'love-it' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/rating MUST be 'up' \| 'down' \| 'neutral'/);
    expect((await alice.get<FeedbackRead>(`${FB('m1')}?conversationId=${conversationId}`)).body.feedback).toBeNull();
  });
});
