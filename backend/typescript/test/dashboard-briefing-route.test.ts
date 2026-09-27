/**
 * ADR 0577 — the AI briefing tile's config row (a conversation POINTER),
 * observable through the HTTP boundary. Both polarities:
 *  - GET-absent ⇒ { config: null }; PUT round-trips through GET;
 *  - self-scoped: caller B never sees caller A's config (session-keyed);
 *  - PUT validates conversationId (missing / non-string / empty / oversize);
 *  - GDPR: the registered subject eraser reaches the briefing row.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getBriefingConfig, putBriefingConfig } from '../src/features/dashboard/dashboardService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
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
  return { get: (p: string) => call('GET', p), put: (p: string, b?: unknown) => call('PUT', p, b), post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function signup(c: ReturnType<typeof client>): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `brief-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const BRIEFING = '/v1/host/openwop-app/dashboard/briefing';

describe('ADR 0577 — dashboard briefing config route', () => {
  it('GET before any PUT ⇒ { config: null }; PUT round-trips through GET', async () => {
    const c = client();
    await signup(c);
    expect((await c.get(BRIEFING)).body).toEqual({ config: null });
    const put = await c.put(BRIEFING, { conversationId: 'conv:morning-1' });
    expect(put.status).toBe(200);
    expect(put.body.config.conversationId).toBe('conv:morning-1');
    const got = await c.get(BRIEFING);
    expect(got.body.config.conversationId).toBe('conv:morning-1');
  });

  it('is self-scoped: caller B never sees caller A\'s config — even in the SAME tenant', async () => {
    // Both callers share one tenant (the login seam's `tenantId` param):
    // with per-user tenants the tenant key would mask a broken SUBJECT key,
    // and a probe proved exactly that (a fixed subject stayed green).
    const a = client(); const b = client();
    const shared = `tnt-brief-${Date.now()}`;
    for (const c of [a, b]) {
      const r = await c.post('/v1/host/openwop-app/test/login', { email: `brief-${Date.now()}-${n++}@acme.test`, tenantId: shared });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    await a.put(BRIEFING, { conversationId: 'conv:a-private' });
    expect((await b.get(BRIEFING)).body).toEqual({ config: null });
  });

  it('PUT validates conversationId (missing / non-string / empty / oversize)', async () => {
    const c = client();
    await signup(c);
    for (const body of [{}, { conversationId: 42 }, { conversationId: '' }, { conversationId: 'x'.repeat(257) }]) {
      const r = await c.put(BRIEFING, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // the failed writes stored nothing
    expect((await c.get(BRIEFING)).body).toEqual({ config: null });
  });

  it('GDPR: eraseSubject reaches the briefing row via the registered eraser (others untouched)', async () => {
    // DSAR subjectKey = the opaque userId (the layout/note precedent).
    await putBriefingConfig('erasure-tenant', 'user-being-erased', 'conv:erase-me');
    await putBriefingConfig('erasure-tenant', 'unrelated-user', 'conv:keep');
    await eraseSubject('erasure-tenant', 'user-being-erased');
    expect(await getBriefingConfig('erasure-tenant', 'user-being-erased')).toBeNull();
    expect((await getBriefingConfig('erasure-tenant', 'unrelated-user'))?.conversationId).toBe('conv:keep');
  });

  it('service polarity: putBriefingConfig stores exactly the given pointer', async () => {
    const row = await putBriefingConfig('t-poly', 'u-poly', 'conv:poly');
    expect(row.conversationId).toBe('conv:poly');
    expect((await getBriefingConfig('t-poly', 'u-poly'))?.conversationId).toBe('conv:poly');
  });
});
