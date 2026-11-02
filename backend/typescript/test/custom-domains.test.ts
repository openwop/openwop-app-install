/**
 * Custom domains (ADR 0295 / Funnel B, P1–P2) — TST-CUA-1.
 *  - lifecycle: add → pending + token; TXT match → live; a clean negative →
 *    failed (disable-don't-delete); resolver noise never demotes a live domain
 *    (red when the `miss` branch keeps the old status, or when the resolver-error
 *    branch demotes to failed);
 *  - hostname is a GLOBAL PK: a second tenant cannot claim a verified name
 *    (uniform message, no owner leak) — red when `addDomain` skips the existing-row check;
 *  - the host guard (`middleware/customDomain.ts`): a LIVE custom hostname reaches
 *    ONLY its own org's public prefixes. Another org IN THE SAME TENANT is refused
 *    with the guard's uniform 404 while the platform origin serves that same page
 *    (red when the `orgId !== bound.orgId` clause is dropped); authed routes and the
 *    protocol surface 404 fail-closed (red when the guard admits every path);
 *  - management routes add + verify + delete over HTTP, and 404 while the toggle is off.
 *
 * DNS is never resolved over the network: `node:dns/promises` `resolveTxt` is mocked
 * for this file (the service's default resolver), answering a clean miss.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dnsTxt = vi.hoisted(() => ({
  lookups: [] as string[],
  answer: [['something-else']] as string[][],
}));
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    resolveTxt: async (name: string): Promise<string[][]> => {
      dnsTxt.lookups.push(name);
      return dnsTxt.answer;
    },
  };
});

import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { addDomain, verifyDomain, resolveCustomHost, invalidateHostCache, __resetCustomDomains, type CustomDomain } from '../src/host/customDomains.js';

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

interface Res<T> { status: number; body: T }
interface LoginBody { user: { tenantId: string; userId: string } }
interface OrgBody { orgId: string }
interface PageBody { pageId: string; slug: string }
interface DomainBody { domain: CustomDomain }
interface DomainListBody { domains: CustomDomain[] }
interface ErrorBody { error: string; message: string }

function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
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

/** The guard's uniform refusal, exactly. */
function expectGuard404(r: { status: number; body: string }): void {
  expect(r.status).toBe(404);
  expect(JSON.parse(r.body) as ErrorBody).toMatchObject({ error: 'not_found', message: 'Not found.' });
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post<LoginBody>('/host/openwop-app/test/login', { email: `cd-${Date.now()}-${n++}@acme.test` });
  const org = await user.post<OrgBody>('/host/openwop-app/orgs', { name: 'Domain Co' });
  return { user, orgId: org.body.orgId, tenantId: login.body.user.tenantId };
}

async function publishedPage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<PageBody> {
  const page = await user.post<PageBody>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  expect(page.status, JSON.stringify(page.body)).toBe(201);
  await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${page.body.pageId}/publish`);
  return page.body;
}

const mgmt = (orgId: string, sfx = ''): string => `/host/openwop-app/custom-domains/orgs/${encodeURIComponent(orgId)}/domains${sfx}`;
const publicPath = (orgId: string, slug: string): string => `/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`;

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
      .rejects.toMatchObject({ code: 'validation_error', message: 'This hostname is already registered.' });
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
    const d = await addDomain({ tenantId: 't-sub', orgId: 'o1', createdBy: 'u', hostname: 'pages.kicktodo.com' });
    expect(d.hostname).toBe('pages.kicktodo.com');
  });

  it('is NOT-APPLICABLE when no public origin is configured — not fail-closed', async () => {
    // Distinct from "could not check": with no configured origin there is none to
    // protect, and a dev box must still register domains. Stated as a decision so
    // nobody later reads the silence as an oversight.
    delete process.env['OPENWOP_PUBLIC_BASE_URL'];
    const d = await addDomain({ tenantId: 't-na', orgId: 'o1', createdBy: 'u', hostname: 'anything.example.com' });
    expect(d.hostname).toBe('anything.example.com');
  });
});

describe('ADR 0295 — the host guard over HTTP', () => {
  it('pins a live custom host to its org public surface, fail-closed everywhere else', async () => {
    await __resetCustomDomains();
    const { user, orgId, tenantId } = await marketer();
    const page = await publishedPage(user, orgId, 'Domain Home');
    // A SECOND org in the SAME tenant, with its own published page: the org-pin
    // clause is the only thing between the bound host and this content.
    const other = (await user.post<OrgBody>('/host/openwop-app/orgs', { name: 'Sister Co' })).body.orgId;
    const otherPage = await publishedPage(user, other, 'Sister Home');

    const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: 'site.acme.test' });
    await verifyDomain(tenantId, orgId, 'site.acme.test', async () => [[added.verificationToken]]);
    invalidateHostCache();
    expect(await resolveCustomHost('site.acme.test')).toEqual({ tenantId, orgId });

    // ✓ own-org public page read serves
    const ok = await withHost('GET', publicPath(orgId, page.slug), 'site.acme.test');
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('Domain Home');

    // positive control: the sister org's page IS served on the platform origin…
    const sisterOnPlatform = await withHost('GET', publicPath(other, otherPage.slug), `127.0.0.1:${PORT}`);
    expect(sisterOnPlatform.status).toBe(200);
    expect(sisterOnPlatform.body).toContain('Sister Home');
    // ✗ …but never on the bound host — the guard's uniform 404
    const cross = await withHost('GET', publicPath(other, otherPage.slug), 'site.acme.test');
    expectGuard404(cross);
    expect(cross.body).not.toContain('Sister Home');

    // ✗ the authed app + protocol surface never serve on a customer domain
    expectGuard404(await withHost('GET', '/host/openwop-app/orgs', 'site.acme.test'));
    expectGuard404(await withHost('GET', '/runs', 'site.acme.test'));
    expectGuard404(await withHost('GET', '/.well-known/openwop', 'site.acme.test'));

    // ✓ the platform origin passes through untouched
    const platform = await withHost('GET', '/.well-known/openwop', `127.0.0.1:${PORT}`);
    expect(platform.status).toBe(200);
  });

  it('management routes: add + verify + delete via HTTP (toggle-gated)', async () => {
    const { user, orgId } = await marketer();
    const created = await user.post<DomainBody>(mgmt(orgId), { hostname: 'www.brand.test' });
    expect(created.status).toBe(201);
    expect(created.body.domain.status).toBe('pending');
    // verify reads the (mocked) DNS: a clean answer without the token → failed, recorded
    dnsTxt.lookups.length = 0;
    const verified = await user.post<DomainBody>(mgmt(orgId, '/www.brand.test/verify'));
    expect(verified.status).toBe(200);
    expect(dnsTxt.lookups).toEqual(['_openwop-verify.www.brand.test']);
    expect(verified.body.domain.status).toBe('failed');
    expect(verified.body.domain.lastError).toBe('verification TXT record not found');
    expect((await user.del(mgmt(orgId, '/www.brand.test'))).status).toBe(200);
    expect((await user.get<DomainListBody>(mgmt(orgId))).body.domains.map((d) => d.hostname)).not.toContain('www.brand.test');

    // toggle OFF → the management surface is gone
    const def = getToggleDefault('custom-domains');
    if (!def) throw new Error('no custom-domains toggle default');
    await saveConfig({ ...def, status: 'off' }, 'test');
    try {
      const off = await user.get<ErrorBody>(mgmt(orgId));
      expect(off.status).toBe(404);
      expect(off.body.error).toBe('not_found');
    } finally {
      await saveConfig({ ...def, status: 'on' }, 'test');
    }
    expect((await user.get<DomainListBody>(mgmt(orgId))).status).toBe(200);
  });
});

describe('ADR 0295 P3 — per-domain rate limit', () => {
  it('429s a domain past its window budget without touching the platform origin', async () => {
    process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN = '3';
    try {
      await __resetCustomDomains();
      const { user, orgId, tenantId } = await marketer();
      const page = await publishedPage(user, orgId, 'RL Home');
      const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: 'busy.acme.test' });
      await verifyDomain(tenantId, orgId, 'busy.acme.test', async () => [[added.verificationToken]]);
      invalidateHostCache();
      const statuses: number[] = [];
      let last = { status: 0, body: '' };
      for (let i = 0; i < 5; i++) { last = await withHost('GET', publicPath(orgId, page.slug), 'busy.acme.test'); statuses.push(last.status); }
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      expect((JSON.parse(last.body) as ErrorBody).error).toBe('rate_limited');
      // the platform origin is unaffected by a hot customer domain
      expect((await withHost('GET', '/.well-known/openwop', `127.0.0.1:${PORT}`)).status).toBe(200);
    } finally {
      delete process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN;
    }
  });
});
