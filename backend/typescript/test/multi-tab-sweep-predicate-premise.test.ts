/**
 * ADR 0978 D3 — the server premise the chat's automatic-delete predicate
 * (`frontend/react/src/chat/lib/abandonedChat.ts`) rests on, pinned at the HTTP
 * boundary (feature loop row 55, MT2WF-2):
 *   1. a plain chat a user creates lists, for that user, with exactly the shape the
 *      predicate matches — `ownerUserId` + ONE participant `user:<owner>` (role owner);
 *   2. a co-member never lists it — so a listed owner-only row proves the caller owns it;
 *   3. a meta-less legacy row lists to EVERY member and any member may DELETE it — the
 *      vector the old type-only sweep fired on, and why the predicate excludes it.
 * Break (1) and the sweep stops cleaning a user's own leftovers; break (2) and the
 * predicate would let one member's browser delete another member's chats.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}

const S = '/host/openwop-app/chat/sessions';

async function member(tenantId: string, tag: string) {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `${tag}-${n}@sweep.test`, tenantId, subject: `oidc:${tag}-${n}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId as string };
}

describe('ADR 0978 D3 — the abandoned-chat predicate premise', () => {
  it('an owner-only plain chat lists only to its owner, in the exact predicate shape', async () => {
    const tenantId = `sweep-${Date.now()}-${n++}`;
    const a = await member(tenantId, 'a');
    const b = await member(tenantId, 'b');
    const created = await a.c.post(S, {});
    expect(created.status).toBe(201);
    const id = created.body.sessionId as string;

    const mine = (await a.c.get(S)).body.sessions.find((s: { sessionId: string }) => s.sessionId === id);
    expect(mine).toMatchObject({ type: 'agent', messageCount: 0, ownerUserId: a.userId });
    expect(mine.participants).toHaveLength(1);
    expect(mine.participants[0]).toMatchObject({ subjectRef: `user:${a.userId}`, role: 'owner' });

    const theirs = (await b.c.get(S)).body.sessions as Array<{ sessionId: string }>;
    expect(theirs.some((s) => s.sessionId === id)).toBe(false);
  });

  it('a meta-less legacy row lists to every member and any member may delete it (why it is excluded)', async () => {
    const tenantId = `sweep-${Date.now()}-${n++}`;
    const a = await member(tenantId, 'a');
    const b = await member(tenantId, 'b');
    const id = `legacy-${n}`;
    const ts = new Date().toISOString();
    await hostExtStorage().createChatSession({ sessionId: id, tenantId, title: 'Legacy', createdAt: ts, updatedAt: ts, messageCount: 0 });

    const seenByA = (await a.c.get(S)).body.sessions.find((s: { sessionId: string }) => s.sessionId === id);
    expect(seenByA).toMatchObject({ type: 'agent', messageCount: 0, participants: [] });
    expect(seenByA.ownerUserId).toBeUndefined();
    expect((await b.c.del(`${S}/${id}`)).status).toBe(204);
  });
});
