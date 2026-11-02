/**
 * ADR 0577 — the AI briefing tile's config row (a conversation POINTER),
 * observable through the HTTP boundary. Both polarities:
 *  - GET-absent ⇒ { config: null }; PUT round-trips through GET;
 *  - self-scoped: caller B never sees caller A's config (session-keyed);
 *  - PUT validates conversationId (missing / non-string / empty / oversize);
 *  - GDPR: the registered subject eraser reaches the briefing row.
 *
 * TST-CUB-1. Red when the route keys on a fixed subject (the same-tenant B leg),
 * when the 256-char cap moves, when the eraser skips the briefing row, or when
 * `putBriefingConfig` stores anything but the given pointer under (tenant, subject).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getBriefingConfig, putBriefingConfig, type DashboardBriefingConfig } from '../src/features/dashboard/dashboardService.js';
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

interface Res<T> { status: number; body: T }
interface ConfigBody { config: DashboardBriefingConfig | null }
interface ErrorBody { error: string; message: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
async function signup(c: ReturnType<typeof client>): Promise<void> {
  const r = await c.post('/host/openwop-app/test/login', { email: `brief-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const BRIEFING = '/host/openwop-app/dashboard/briefing';

describe('ADR 0577 — dashboard briefing config route', () => {
  it('GET before any PUT ⇒ { config: null }; PUT round-trips through GET', async () => {
    const c = client();
    await signup(c);
    expect((await c.get<ConfigBody>(BRIEFING)).body).toEqual({ config: null });
    const put = await c.put<ConfigBody>(BRIEFING, { conversationId: 'conv:morning-1' });
    expect(put.status).toBe(200);
    expect(put.body.config?.conversationId).toBe('conv:morning-1');
    const got = await c.get<ConfigBody>(BRIEFING);
    expect(got.body.config?.conversationId).toBe('conv:morning-1');
  });

  it('is self-scoped: caller B never sees caller A\'s config — even in the SAME tenant', async () => {
    // Both callers share one tenant (the login seam's `tenantId` param):
    // with per-user tenants the tenant key would mask a broken SUBJECT key,
    // and a probe proved exactly that (a fixed subject stayed green).
    const a = client(); const b = client();
    const shared = `tnt-brief-${Date.now()}`;
    for (const c of [a, b]) {
      const r = await c.post('/host/openwop-app/test/login', { email: `brief-${Date.now()}-${n++}@acme.test`, tenantId: shared });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    await a.put(BRIEFING, { conversationId: 'conv:a-private' });
    expect((await b.get<ConfigBody>(BRIEFING)).body).toEqual({ config: null });
    // owner control: A's own read still holds the row B could not see
    expect((await a.get<ConfigBody>(BRIEFING)).body.config?.conversationId).toBe('conv:a-private');
  });

  it('PUT validates conversationId (missing / non-string / empty / oversize)', async () => {
    const c = client();
    await signup(c);
    for (const body of [{}, { conversationId: 42 }, { conversationId: '' }, { conversationId: 'x'.repeat(257) }]) {
      const r = await c.put<ErrorBody>(BRIEFING, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe('validation_error');
      expect(r.body.message).toMatch(/conversationId/);
    }
    // the failed writes stored nothing
    expect((await c.get<ConfigBody>(BRIEFING)).body).toEqual({ config: null });
    // boundary control: exactly 256 chars is accepted
    expect((await c.put<ConfigBody>(BRIEFING, { conversationId: 'x'.repeat(256) })).status).toBe(200);
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
    // What the route case cannot show: the stored row's own (tenant, subject)
    // stamp, and that a SECOND subject in the same tenant keeps its own pointer.
    const row = await putBriefingConfig('t-poly', 'u-poly', 'conv:poly');
    expect(row).toMatchObject({ tenantId: 't-poly', subject: 'u-poly', conversationId: 'conv:poly' });
    await putBriefingConfig('t-poly', 'u-poly-2', 'conv:poly-2');
    expect(await getBriefingConfig('t-poly', 'u-poly')).toMatchObject({ tenantId: 't-poly', subject: 'u-poly', conversationId: 'conv:poly' });
    expect((await getBriefingConfig('t-poly', 'u-poly-2'))?.conversationId).toBe('conv:poly-2');
    expect(await getBriefingConfig('t-poly', 'u-nobody')).toBeNull();
  });
});
