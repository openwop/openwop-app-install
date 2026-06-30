/**
 * Durable UI state + message feedback (ADR 0071) — ROUTE-level harness.
 * Proves UI state is strictly caller-scoped (a second user never sees it), the
 * resourceType allowlist + value cap fail closed, message feedback round-trips
 * and is per-user, and feedback on a non-visible conversation is 404.
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
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `ui-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

const UI = '/v1/host/openwop-app/ui-state';

describe('ui-state — caller-scoped durable display prefs', () => {
  it('PUTs + GETs the caller’s own rows; a second user never sees them', async () => {
    const tenantId = `org:ui-${Date.now()}-${n++}`;
    const alice = client(); await signup(alice, tenantId);
    const bob = client(); await signup(bob, tenantId);

    const put = await alice.put(UI, { resourceType: 'artifact', resourceId: 'document:doc:1', key: 'selectedRevision', value: 'document:doc:1:2' });
    expect(put.status).toBe(200);

    const mine = await alice.get(`${UI}?resourceType=artifact&resourceId=document:doc:1`);
    expect(mine.body.items.length).toBe(1);
    expect(mine.body.items[0].value).toBe('document:doc:1:2');

    // Bob — same tenant — sees NONE of alice's UI state (subject-scoped).
    const bobView = await bob.get(`${UI}?resourceType=artifact&resourceId=document:doc:1`);
    expect(bobView.body.items.length).toBe(0);

    // DELETE removes it.
    expect((await alice.del(`${UI}/artifact/${encodeURIComponent('document:doc:1')}/selectedRevision`)).status).toBe(204);
    expect((await alice.get(`${UI}?resourceType=artifact`)).body.items.length).toBe(0);
  });

  it('fails closed on an unknown resourceType (400) and an over-cap value (400)', async () => {
    const alice = client(); await signup(alice, `org:ui-${Date.now()}-${n++}`);
    expect((await alice.put(UI, { resourceType: 'secrets', resourceId: 'x', key: 'k', value: 1 })).status).toBe(400);
    const big = 'x'.repeat(5000);
    expect((await alice.put(UI, { resourceType: 'conversation', resourceId: 'c1', key: 'blob', value: big })).status).toBe(400);
  });
});

describe('message feedback — per-user, visibility-gated', () => {
  it('round-trips the caller’s feedback and keeps it per-user', async () => {
    const tenantId = `org:fb-${Date.now()}-${n++}`;
    const alice = client(); await signup(alice, tenantId);
    // A session owned by alice is visible to her.
    const session = await alice.post('/v1/host/openwop-app/chat/sessions', { title: 'Chat' });
    const conversationId = session.body.sessionId;

    const post = await alice.post('/v1/host/openwop-app/chat/messages/m1/feedback', { conversationId, rating: 'up', reason: 'great answer' });
    expect(post.status).toBe(200);
    expect(post.body.rating).toBe('up');

    const got = await alice.get(`/v1/host/openwop-app/chat/messages/m1/feedback?conversationId=${conversationId}`);
    expect(got.body.feedback.rating).toBe('up');
    expect(got.body.feedback.reason).toBe('great answer');

    // Re-rate overwrites (idempotent per user), not a second row.
    await alice.post('/v1/host/openwop-app/chat/messages/m1/feedback', { conversationId, rating: 'down' });
    expect((await alice.get(`/v1/host/openwop-app/chat/messages/m1/feedback?conversationId=${conversationId}`)).body.feedback.rating).toBe('down');
  });

  it('rejects feedback on a conversation the caller cannot see (404)', async () => {
    const alice = client(); await signup(alice, `org:fb-${Date.now()}-${n++}`);
    const r = await alice.post('/v1/host/openwop-app/chat/messages/m1/feedback', { conversationId: 'someone-elses-session', rating: 'up' });
    expect(r.status).toBe(404);
  });

  it('validates the rating vocabulary (400)', async () => {
    const alice = client(); await signup(alice, `org:fb-${Date.now()}-${n++}`);
    const session = await alice.post('/v1/host/openwop-app/chat/sessions', { title: 'Chat' });
    const r = await alice.post('/v1/host/openwop-app/chat/messages/m1/feedback', { conversationId: session.body.sessionId, rating: 'love-it' });
    expect(r.status).toBe(400);
  });
});
