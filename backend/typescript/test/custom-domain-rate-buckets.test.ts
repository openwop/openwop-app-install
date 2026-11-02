/**
 * Custom-domain rate limits are per client, not per host (ADR 0295 P3, corrected
 * by the ADR 1015 pilot, 2026-11-01).
 *
 * The incident: one scanner sent ~1,240 probe requests (`.env`, `.git-credentials`,
 * …) to a freshly certified customer domain in one minute. Every request, 404s
 * included, was charged to ONE per-host bucket, so real visitors got 429 on `/`.
 *
 *   - A path the host does not serve is charged only to the client's own "miss"
 *     bucket: a prober throttles itself and nobody else.
 *   - A served request is charged to the client's share of the host first, then
 *     to the host-wide ceiling: one IP cannot spend the host's budget, and a
 *     flood from many IPs is still capped.
 *   - The client is `host/clientIp.ts` (the trusted-proxy walk). The custom-domain
 *     load balancer is a trusted hop, so visitors behind it are told apart.
 *
 * Red on the old guard: the scanner case (B's `/` is 429) and the share case (one
 * IP's flood blocks B). Sabotage-checked in the PR: charging misses to the page
 * bucket, or dropping the per-IP share, turns those red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { addDomain, verifyDomain, invalidateHostCache, __resetCustomDomains } from '../src/host/customDomains.js';
import { __resetCustomDomainRateLimitsForTests } from '../src/middleware/customDomain.js';
import { clientIp } from '../src/host/clientIp.js';

let BASE: string; let PORT = 0; let server: http.Server;
const LIMIT_ENV = [
  'OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN', 'OPENWOP_CUSTOM_DOMAIN_IP_REQS_PER_MIN', 'OPENWOP_CUSTOM_DOMAIN_MISS_IP_REQS_PER_MIN',
  'OPENWOP_CUSTOM_DOMAIN_LB_IP',
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of LIMIT_ENV) saved[k] = process.env[k];
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
afterEach(() => {
  for (const k of LIMIT_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  __resetCustomDomainRateLimitsForTests();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body { user?: { tenantId?: string }; orgId: string; pageId: string; slug: string }
function client() {
  let cookie = '';
  return async (path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text === '' ? '{}' : text) as Body };
  };
}

/** A GET on `host` as the client at `xff` (the socket peer is loopback, a
 *  trusted hop, so `clientIp` reads the forwarded chain like it does behind the
 *  load balancer). */
function get(path: string, host: string, xff: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { host, 'x-forwarded-for': xff } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

let seq = 0;
async function boundSite(host: string): Promise<void> {
  const post = client();
  const login = await post('/host/openwop-app/test/login', { email: `cdb-${Date.now()}-${seq++}@acme.test` });
  expect(login.status).toBe(201);
  const tenantId = login.body.user?.tenantId ?? '';
  const org = await post('/host/openwop-app/orgs', { name: 'Bucket Co' });
  const orgId = org.body.orgId;
  const page = await post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title: 'Home' });
  expect(page.status).toBe(201);
  expect((await post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${page.body.pageId}/publish`)).status).toBe(200);
  const added = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: host });
  await verifyDomain(tenantId, orgId, host, async () => [[added.verificationToken]]);
  invalidateHostCache();
}

const A = '203.0.113.7';
const B = '198.51.100.20';
const PROBES = ['/.env', '/.git-credentials', '/phpinfo.php', '/wp-login.php', '/root/.netrc', '/admin', '/config.js', '/.aws/credentials'];

describe('custom-domain rate limits are per client', () => {
  it('a scanner burst from one IP leaves another IP\'s `/` at 200', async () => {
    await __resetCustomDomains();
    await boundSite('scan.acme.test');
    process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN = '5';
    process.env.OPENWOP_CUSTOM_DOMAIN_IP_REQS_PER_MIN = '5';
    process.env.OPENWOP_CUSTOM_DOMAIN_MISS_IP_REQS_PER_MIN = '4';
    const statuses: number[] = [];
    for (let round = 0; round < 3; round++) for (const p of PROBES) statuses.push(await get(p, 'scan.acme.test', A));
    expect(statuses.slice(0, 4)).toEqual([404, 404, 404, 404]);
    expect(new Set(statuses.slice(4)), 'the prober is throttled on its own misses').toEqual(new Set([429]));
    // The probes (24 of them, against a host ceiling of 5) charged nothing to the
    // page budget: the real visitor loads the site.
    expect(await get('/', 'scan.acme.test', B)).toBe(200);
    expect(await get('/', 'scan.acme.test', B)).toBe(200);
  });

  it('one IP flooding pages exhausts only its own share', async () => {
    await __resetCustomDomains();
    await boundSite('share.acme.test');
    process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN = '20';
    process.env.OPENWOP_CUSTOM_DOMAIN_IP_REQS_PER_MIN = '3';
    for (let i = 0; i < 3; i++) expect(await get('/', 'share.acme.test', A)).toBe(200);
    expect(await get('/', 'share.acme.test', A), 'A spent its share').toBe(429);
    expect(await get('/', 'share.acme.test', A)).toBe(429);
    expect(await get('/', 'share.acme.test', B), 'B is unaffected').toBe(200);
  });

  it('the host ceiling still caps a flood spread over many IPs', async () => {
    await __resetCustomDomains();
    await boundSite('flood.acme.test');
    process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN = '5';
    process.env.OPENWOP_CUSTOM_DOMAIN_IP_REQS_PER_MIN = '2';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const ip = `192.0.2.${10 + i}`;
      statuses.push(await get('/', 'flood.acme.test', ip));
    }
    // Six distinct IPs, each well inside its own share of 2: the host ceiling of 5 binds.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(await get('/', 'flood.acme.test', '192.0.2.99'), 'the host stays capped for a new IP too').toBe(429);
  });

  it('visitors behind the custom-domain load balancer are told apart', () => {
    const LB = '34.149.148.86';
    const req = (xff: string): Request => ({ socket: { remoteAddress: '169.254.1.1' }, header: (n: string) => (n.toLowerCase() === 'x-forwarded-for' ? xff : undefined) }) as unknown as Request;
    process.env.OPENWOP_CUSTOM_DOMAIN_LB_IP = LB;
    expect(clientIp(req(`${A}, ${LB}`))).toBe(A);
    expect(clientIp(req(`${B}, ${LB}`))).toBe(B);
    // A forged left-hand entry is still never read.
    expect(clientIp(req(`6.6.6.6, ${A}, ${LB}`))).toBe(A);
    // Unconfigured, the LB is the farthest untrusted hop: everyone would share it.
    delete process.env.OPENWOP_CUSTOM_DOMAIN_LB_IP;
    expect(clientIp(req(`${A}, ${LB}`))).toBe(LB);
  });
});
