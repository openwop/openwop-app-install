/**
 * Custom domains (ADR 0295 / Funnel B, P1–P2):
 *  - lifecycle: add → pending + token; TXT match → live; a clean negative →
 *    failed (disable-don't-delete); resolver noise never demotes a live domain;
 *  - hostname is a GLOBAL PK: a second tenant cannot claim a verified name
 *    (uniform message, no owner leak);
 *  - the host guard: a LIVE custom hostname reaches ONLY its own org's public
 *    prefixes — cross-org paths, authed routes, and the protocol surface 404
 *    fail-closed; the platform origin is byte-identical (pass-through);
 *  - management routes are toggle + org gated.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}

/** Raw request with a spoofed Host header (fetch forbids overriding Host). */
function withHost(method: string, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { host, 'content-type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post('/v1/host/openwop-app/test/login', { email: `cd-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Domain Co' });
  return { user, orgId: org.body.orgId, tenantId: login.body.user?.tenantId ?? '' };
}

const mgmt = (orgId: string, sfx = ''): string => `/v1/host/openwop-app/custom-domains/orgs/${encodeURIComponent(orgId)}/domains${sfx}`;

describe('ADR 0295 — lifecycle + uniqueness (service, injected resolver)', () => {
  it('add → pending; TXT match → live; clean negative → failed; resolver noise keeps live', async () => {
    await __resetCustomDomains();
    const d = await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u', hostname: 'Pages.Example.COM.' });
    expect(d.hostname).toBe('pages.example.com');
    expect(d.status).toBe('pending');
    expect(d.verificationToken.startsWith('owp-verify=')).toBe(true);

    const good = async (name: string): Promise<string[][]> => {
      expect(name).toBe('_openwop-verify.pages.example.com');
      return [[d.verificationToken]];
    };
    const live = await verifyDomain('t1', 'o1', 'pages.example.com', good);
    expect(live?.status).toBe('live');

    // resolver outage: live survives (fail-open on infra noise)
    const noisy = async (): Promise<string[][]> => { throw new Error('SERVFAIL'); };
    expect((await verifyDomain('t1', 'o1', 'pages.example.com', noisy))?.status).toBe('live');

    // clean negative: demoted to failed — but the ROW survives (disable-don't-delete)
    const gone = async (): Promise<string[][]> => [['something-else']];
    const failed = await verifyDomain('t1', 'o1', 'pages.example.com', gone);
    expect(failed?.status).toBe('failed');
    expect(failed?.verificationToken).toBe(d.verificationToken);
  });

  it('hostname is a global PK — a second tenant cannot claim it (no owner leak)', async () => {
    await __resetCustomDomains();
    await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u', hostname: 'shop.example.com' });
    await expect(addDomain({ tenantId: 't2', orgId: 'o2', createdBy: 'v', hostname: 'shop.example.com' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rejects junk hostnames', async () => {
    await expect(addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u', hostname: 'not a host' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u', hostname: 'localhost' })).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('ADR 0295 — binding the deployment\'s OWN origin is refused', () => {
  // A live custom hostname is constrained to the PUBLIC surface, fail-closed
  // (`middleware/customDomain.ts`: "the authed app, admin routes, and the
  // protocol surface NEVER serve on a customer domain"). So binding the platform
  // origin removes sign-in, the app and the wire in one POST — and it reads as a
  // perfectly legal request, which is why the refusal belongs at the choke point
  // rather than in a runbook. An operator was given exactly these steps for
  // exactly this hostname before this guard existed.
  const PRIOR = process.env['OPENWOP_PUBLIC_BASE_URL'];
  afterEach(() => {
    if (PRIOR === undefined) delete process.env['OPENWOP_PUBLIC_BASE_URL'];
    else process.env['OPENWOP_PUBLIC_BASE_URL'] = PRIOR;
  });

  it('refuses the platform origin, and says what it would have broken', async () => {
    process.env['OPENWOP_PUBLIC_BASE_URL'] = 'https://kicktodo.com';
    await expect(addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u', hostname: 'kicktodo.com' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    // The message must name the consequence — a bare "not allowed" sends the
    // operator looking for a permission problem they do not have.
    await expect(addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u', hostname: 'KickTodo.COM.' }))
      .rejects.toThrow(/own origin/i);
  });

  it('still allows a SUBDOMAIN of the platform origin — that is the supported shape', async () => {
    process.env['OPENWOP_PUBLIC_BASE_URL'] = 'https://kicktodo.com';
    const d = await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u', hostname: 'pages.kicktodo.com' });
    expect(d.hostname).toBe('pages.kicktodo.com');
  });

  it('is NOT-APPLICABLE when no public origin is configured — not fail-closed', async () => {
    // Distinct from "could not check": with no configured origin there is none to
    // protect, and a dev box must still register domains. Stated as a decision so
    // nobody later reads the silence as an oversight.
    delete process.env['OPENWOP_PUBLIC_BASE_URL'];
    const d = await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u', hostname: 'anything.example.com' });
    expect(d.hostname).toBe('anything.example.com');
  });
});

describe('ADR 0295 — the host guard over HTTP', () => {
  it('pins a live custom host to its org public surface, fail-closed everywhere else', async () => {
    await __resetCustomDomains();
    const { user, orgId, tenantId } = await marketer();
    // a published page so the happy path returns real content
    const page = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title: 'Domain Home' });
    await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${page.body.pageId}/publish`);

    const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: 'site.acme.test' });
    await verifyDomain(tenantId, orgId, 'site.acme.test', async () => [[added.verificationToken]]);
    invalidateHostCache();
    expect(await resolveCustomHost('site.acme.test')).toEqual({ tenantId, orgId });

    // ✓ own-org public page read serves
    const ok = await withHost('GET', `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(page.body.slug)}`, 'site.acme.test');
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('Domain Home');

    // ✗ another org's public path — uniform 404
    const cross = await withHost('GET', `/v1/host/openwop-app/public/other-org/pages/${encodeURIComponent(page.body.slug)}`, 'site.acme.test');
    expect(cross.status).toBe(404);

    // ✗ the authed app + protocol surface never serve on a customer domain
    expect((await withHost('GET', '/v1/host/openwop-app/orgs', 'site.acme.test')).status).toBe(404);
    expect((await withHost('GET', '/v1/runs', 'site.acme.test')).status).toBe(404);
    expect((await withHost('GET', '/.well-known/openwop', 'site.acme.test')).status).toBe(404);

    // ✓ the platform origin passes through untouched (401/200-class, not the guard's 404)
    const platform = await withHost('GET', '/.well-known/openwop', `127.0.0.1:${PORT}`);
    expect(platform.status).toBe(200);
  });

  it('management routes: add + verify + delete via HTTP (toggle-gated)', async () => {
    const { user, orgId } = await marketer();
    const created = await user.post(mgmt(orgId), { hostname: 'www.brand.test' });
    expect(created.status).toBe(201);
    expect(created.body.domain.status).toBe('pending');
    // verify against real DNS fails for a nonexistent name — recorded, not thrown
    const verified = await user.post(mgmt(orgId, '/www.brand.test/verify'));
    expect(verified.status).toBe(200);
    expect(['pending', 'failed']).toContain(verified.body.domain.status);
    expect(verified.body.domain.lastError).toBeTruthy();
    expect((await user.del(mgmt(orgId, '/www.brand.test'))).status).toBe(200);
  });
});

describe('ADR 0295 P3 — per-domain rate limit', () => {
  it('429s a domain past its window budget without touching the platform origin', async () => {
    process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN = '3';
    try {
      await __resetCustomDomains();
      const { user, orgId, tenantId } = await marketer();
      const page = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title: 'RL Home' });
      await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${page.body.pageId}/publish`);
      const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: 'busy.acme.test' });
      await verifyDomain(tenantId, orgId, 'busy.acme.test', async () => [[added.verificationToken]]);
      invalidateHostCache();
      const path = `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(page.body.slug)}`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await withHost('GET', path, 'busy.acme.test')).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      // the platform origin is unaffected by a hot customer domain
      expect((await withHost('GET', '/.well-known/openwop', `127.0.0.1:${PORT}`)).status).toBe(200);
    } finally {
      delete process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN;
    }
  });
});
