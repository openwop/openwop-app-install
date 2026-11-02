/**
 * ADR 0940 P1 — white-label custom hosts.
 *
 * A response served on a bound customer hostname carries no platform
 * fingerprint: no `X-Powered-By` (disabled app-wide, ADR 0940 F1) and no
 * `OpenWOP-Version` / `Vary: OpenWOP-Version` (stripped by the custom-domain
 * guard, F2). Published pages there are not protocol responses (versioning
 * §1.4: a non-protocol response on a shared name MUST NOT carry the version).
 * The platform origin's protocol routes keep `OpenWOP-Version`.
 *
 * Tracker TST-CQG-4 (w68). Sabotage-witnessed: red when the custom-domain guard
 * stops removing `OpenWOP-Version`, and when `x-powered-by` is re-enabled. The
 * guard's `setHeader` override (which drops a LATER version write) is a second
 * guard this test cannot reach: on every path here the negotiator stamps the
 * header BEFORE the guard runs, so `removeHeader` is the one that strips it
 * (w68 round 1: the override-only sabotage stayed green). Recorded ceiling.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { addDomain, verifyDomain, resolveCustomHost, invalidateHostCache, __resetCustomDomains } from '../src/host/customDomains.js';

let BASE: string; let PORT = 0; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  for (const id of ['users', 'custom-domains']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Every JSON field this file reads (login, orgs, cms pages). */
interface Body { user?: { tenantId?: string }; orgId: string; pageId: string; slug: string }
interface Res { status: number; body: Body }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    // JSON.parse is the typing boundary (every route here answers JSON, or 204 with no body).
    const text = await res.text();
    const out: Body = JSON.parse(text === '' ? '{}' : text);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}


interface Raw { status: number; headers: http.IncomingHttpHeaders; body: string }
/** Raw request with a spoofed Host header (fetch forbids overriding Host), returning headers. */
function rawGet(path: string, host: string, extra: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { host, ...extra } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post('/host/openwop-app/test/login', { email: `cd-${Date.now()}-${n++}@acme.test` });
  expect(login.status).toBe(201);
  const org = await user.post('/host/openwop-app/orgs', { name: 'Domain Co' });
  expect(org.status).toBe(201);
  const tenantId = login.body.user?.tenantId ?? '';
  expect(tenantId).not.toBe('');
  return { user, orgId: org.body.orgId, tenantId };
}


const varyTokens = (r: Raw): string[] => String(r.headers['vary'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

describe('ADR 0940 P1 — white-label custom hosts', () => {
  it('a bound customer host serves without X-Powered-By or OpenWOP-Version; the platform keeps the version', async () => {
    await __resetCustomDomains();
    const { user, orgId, tenantId } = await marketer();
    const page = await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title: 'White Label Home' });
    expect(page.status).toBe(201);
    const published = await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${page.body.pageId}/publish`);
    expect(published.status).toBe(200);
    const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: 'wl.acme.test' });
    await verifyDomain(tenantId, orgId, 'wl.acme.test', async () => [[added.verificationToken]]);
    invalidateHostCache();
    expect(await resolveCustomHost('wl.acme.test')).toEqual({ tenantId, orgId });

    const pagePath = `/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(page.body.slug)}`;
    const guard404 = await rawGet('/host/openwop-app/orgs', 'wl.acme.test');
    expect(guard404.status, 'a non-public path on a customer host is the guard 404').toBe(404);
    for (const [label, r] of [
      ['document /', await rawGet('/', 'wl.acme.test')],
      ['public page read', await rawGet(pagePath, 'wl.acme.test')],
      ['public page read with a protocol header', await rawGet(pagePath, 'wl.acme.test', { 'openwop-version': '2' })],
      ['guard 404 (non-public path)', guard404],
    ] as const) {
      expect(r.headers['x-powered-by'], label).toBeUndefined();
      expect(r.headers['openwop-version'], label).toBeUndefined();
      expect(varyTokens(r), label).not.toContain('openwop-version');
    }
    const served = await rawGet(pagePath, 'wl.acme.test');
    expect(served.status).toBe(200);
    expect(served.body).toContain('White Label Home');

    // The platform origin is unchanged for the protocol, and never powered-by.
    const platform = await rawGet('/.well-known/openwop', `127.0.0.1:${PORT}`, { 'openwop-version': '2' });
    expect(platform.status).toBe(200);
    expect(platform.headers['openwop-version']).toBe('2.0');
    expect(platform.headers['x-powered-by']).toBeUndefined();
  });
});
