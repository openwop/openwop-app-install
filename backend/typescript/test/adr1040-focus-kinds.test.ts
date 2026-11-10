/**
 * ADR 1040 D4 — feature-registered conversation focus kinds.
 *
 *  - Only a REGISTERED kind binds; registration refuses a malformed or duplicate kind.
 *  - Bind runs the kind's `authorize` (and its feature toggle); a refusal is a
 *    uniform 404 and stores nothing.
 *  - EVERY tool read re-authorizes with the calling turn's scope: a focus whose
 *    entity the caller lost access to after the bind reads nothing, a
 *    model-supplied id the caller cannot read reads nothing, a turn with no
 *    acting user reads nothing, and an `authorize` that throws reads nothing.
 *  - A participant who can see the conversation cannot re-point (or clear) the
 *    owner's focus; a legacy session row with no meta cannot be claimed by it.
 *
 * Red when: `resolveAuthorizedFocus` trusts the explicit id or the stored focus
 * (host/conversationFocus.ts); `focusAuthorized` skips the feature gate or lets
 * a throw through; or the focus route drops the registered-kind check, the
 * manage gate, or the legacy-row refusal (routes/chatSessions.ts).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getConversationMeta, setConversationRun } from '../src/host/conversationStore.js';
import {
  __unregisterConversationFocusKind,
  registerConversationFocusKind,
  resolveAuthorizedFocus,
} from '../src/host/conversationFocus.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
let storage: Storage;
let BASE = '';
let n = 0;

/** The fake feature's entity ACL: `${tenantId}|${userId}|${id}` entries may read. */
const readable = new Set<string>();
const KIND = 'testfeat.thing';
const THROWING = 'testfeat.boom';
const GATED = 'cad.testgated'; // owned by a real toggled feature (cad)

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  registerConversationFocusKind({ kind: KIND, featureId: 'testfeat', label: 'thing', authorize: async (s, id) => readable.has(`${s.tenantId}|${s.actingUserId}|${id}`) });
  registerConversationFocusKind({ kind: THROWING, featureId: 'testfeat', label: 'boom', authorize: async () => { throw new Error('backend down'); } });
  registerConversationFocusKind({ kind: GATED, featureId: 'cad', label: 'gated', authorize: async () => true });
}, 60_000);
afterAll(async () => {
  __unregisterConversationFocusKind(KIND);
  __unregisterConversationFocusKind(THROWING);
  __unregisterConversationFocusKind(GATED);
  await new Promise<void>((res) => server.close(() => res()));
});

interface Body { user?: { userId: string }; focus?: unknown; error?: string }
interface Res { status: number; body: Body }
interface Client { userId: string; put: (p: string, b?: unknown) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
async function loginTo(tenantId: string, who: string): Promise<Client> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body) };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user?.userId ?? '', put: (p, b) => call('PUT', p, b), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

const FOCUS = (sid: string) => `/host/openwop-app/chat/sessions/${sid}/focus`;
const sid = (tag: string) => `f1040-${tag}-${Date.now()}-${n++}`;
async function pair() {
  const tenantId = `org:f1040-${Date.now()}-${n++}`;
  const a = await loginTo(tenantId, 'a');
  const b = await loginTo(tenantId, 'b');
  readable.add(`${tenantId}|${a.userId}|book-1`);
  return { tenantId, a, b };
}

describe('registration', () => {
  it('refuses a malformed or duplicate kind', () => {
    expect(() => registerConversationFocusKind({ kind: 'book', label: 'x', authorize: async () => true })).toThrow(/featureId/);
    expect(() => registerConversationFocusKind({ kind: 'Bad.Kind', label: 'x', authorize: async () => true })).toThrow();
    expect(() => registerConversationFocusKind({ kind: 'nogate.thing', label: 'x', authorize: async () => true })).toThrow(/featureId/);
    expect(() => registerConversationFocusKind({ kind: 'other.thing', featureId: 'cad', label: 'x', authorize: async () => true })).toThrow(/featureId/);
    expect(() => registerConversationFocusKind({ kind: KIND, featureId: 'testfeat', label: 'x', authorize: async () => true })).toThrow(/already registered/);
    expect(() => registerConversationFocusKind({ kind: 'canvas', label: 'x', authorize: async () => true })).toThrow(/already registered/);
  });
});

describe('bind', () => {
  it('a registered kind the caller may read binds; nothing else does, and a refusal stores nothing', async () => {
    const { tenantId, a, b } = await pair();
    const ok = sid('ok');
    expect((await a.put(FOCUS(ok), { kind: KIND, id: 'book-1' })).status).toBe(200);
    expect((await getConversationMeta(tenantId, ok))?.focus).toEqual({ kind: KIND, id: 'book-1' });

    const unknown = sid('unknown');
    expect((await a.put(FOCUS(unknown), { kind: 'nobody.thing', id: 'book-1' })).status).toBe(400);
    const refused = sid('refused');
    expect((await b.put(FOCUS(refused), { kind: KIND, id: 'book-1' })).status).toBe(404);
    const throws = sid('throws');
    expect((await a.put(FOCUS(throws), { kind: THROWING, id: 'book-1' })).status).toBe(404);
    for (const id of [unknown, refused, throws]) expect(await getConversationMeta(tenantId, id)).toBeNull();
  });

  it('a participant who can see the conversation cannot re-point or clear the owner\'s focus', async () => {
    const { tenantId, a, b } = await pair();
    readable.add(`${tenantId}|${b.userId}|book-2`);
    const id = sid('shared');
    expect((await a.post('/host/openwop-app/chat/sessions', { sessionId: id, title: 'Shared', participants: [`user:${b.userId}`] })).status).toBe(201);
    expect((await a.put(FOCUS(id), { kind: KIND, id: 'book-1' })).status).toBe(200);
    expect((await b.put(FOCUS(id), { kind: KIND, id: 'book-2' })).status).toBe(403);
    expect((await b.del(FOCUS(id))).status).toBe(403);
    expect((await getConversationMeta(tenantId, id))?.focus).toEqual({ kind: KIND, id: 'book-1' });
  });

  it('an ownerless meta (minted by a run setter) cannot be steered by any member', async () => {
    const { tenantId, b } = await pair();
    readable.add(`${tenantId}|${b.userId}|book-4`);
    const id = sid('ownerless');
    await setConversationRun(tenantId, id, 'run-x');
    expect((await b.put(FOCUS(id), { kind: KIND, id: 'book-4' })).status).toBe(404);
    expect((await getConversationMeta(tenantId, id))?.focus).toBeUndefined();
  });

  it('a legacy session row with no meta cannot be claimed by binding it', async () => {
    const { tenantId, b } = await pair();
    readable.add(`${tenantId}|${b.userId}|book-3`);
    const id = sid('legacy');
    const now = new Date().toISOString();
    await storage.createChatSession({ sessionId: id, tenantId, title: 'Old chat', createdAt: now, updatedAt: now, messageCount: 0 });
    expect((await b.put(FOCUS(id), { kind: KIND, id: 'book-3' })).status).toBe(404);
    expect(await getConversationMeta(tenantId, id)).toBeNull();
  });
});

describe('the owning feature\'s toggle is checked at bind AND per call', () => {
  const setCad = async (status: 'on' | 'off'): Promise<void> => {
    const d = getToggleDefault('cad');
    expect(d).toBeDefined();
    await saveConfig({ ...d!, status }, 'test');
  };

  it('off: bind is refused and a stored focus reads nothing; on: both work', async () => {
    const { tenantId, a } = await pair();
    await setCad('on');
    const id = sid('gated');
    expect((await a.put(FOCUS(id), { kind: GATED, id: 'g-1' })).status).toBe(200);
    expect(await resolveAuthorizedFocus({ tenantId, actingUserId: a.userId, conversationId: id }, GATED)).toBe('g-1');
    await setCad('off');
    try {
      expect(await resolveAuthorizedFocus({ tenantId, actingUserId: a.userId, conversationId: id }, GATED)).toBeUndefined();
      expect((await a.put(FOCUS(sid('gated-off')), { kind: GATED, id: 'g-2' })).status).toBe(404);
    } finally {
      await saveConfig(getToggleDefault('cad')!, 'test'); // back to the shipped default
    }
  });
});

describe('every tool read re-authorizes', () => {
  it('the bound focus resolves for the owner, and reads NOTHING once access is revoked', async () => {
    const { tenantId, a } = await pair();
    const id = sid('revoke');
    expect((await a.put(FOCUS(id), { kind: KIND, id: 'book-1' })).status).toBe(200);
    const scope = { tenantId, actingUserId: a.userId, conversationId: id };
    expect(await resolveAuthorizedFocus(scope, KIND)).toBe('book-1');
    readable.delete(`${tenantId}|${a.userId}|book-1`);
    expect(await resolveAuthorizedFocus(scope, KIND)).toBeUndefined();
    // Still stored: the binding is a default, the per-call check is what decides.
    expect((await getConversationMeta(tenantId, id))?.focus).toEqual({ kind: KIND, id: 'book-1' });
  });

  it('a model-supplied id the caller cannot read reads nothing; one they can, resolves', async () => {
    const { tenantId, a, b } = await pair();
    expect(await resolveAuthorizedFocus({ tenantId, actingUserId: b.userId }, KIND, 'book-1')).toBeUndefined();
    expect(await resolveAuthorizedFocus({ tenantId, actingUserId: a.userId }, KIND, 'book-1')).toBe('book-1');
  });

  it('another user acting in the owner\'s conversation reads nothing (the CALL\'s scope decides)', async () => {
    const { tenantId, a, b } = await pair();
    const id = sid('other-actor');
    expect((await a.put(FOCUS(id), { kind: KIND, id: 'book-1' })).status).toBe(200);
    expect(await resolveAuthorizedFocus({ tenantId, actingUserId: b.userId, conversationId: id }, KIND)).toBeUndefined();
  });

  it('no acting user, a throwing authorize, or a different kind read nothing', async () => {
    const { tenantId, a } = await pair();
    const id = sid('edges');
    expect((await a.put(FOCUS(id), { kind: KIND, id: 'book-1' })).status).toBe(200);
    expect(await resolveAuthorizedFocus({ tenantId, conversationId: id }, KIND)).toBeUndefined();
    expect(await resolveAuthorizedFocus({ tenantId, actingUserId: a.userId }, THROWING, 'book-1')).toBeUndefined();
    expect(await resolveAuthorizedFocus({ tenantId, actingUserId: a.userId, conversationId: id }, 'canvas')).toBeUndefined();
  });
});
