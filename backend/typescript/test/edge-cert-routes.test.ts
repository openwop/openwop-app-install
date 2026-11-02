/**
 * ADR 0906 P3 — the new domain routes over HTTP (createApp + cookie jar):
 * the list carries the edge summary, delete reports its outcome, status and
 * retry are org-scoped (another org's hostname 404s), and force-delete on a
 * row that is not stuck releasing is refused.
 *
 * Tracker TST-CXA-3. The org scope is witnessed with a SAME-TENANT second org
 * (a cross-tenant caller is refused by the tenant check first): red when
 * `getDomain` drops its `orgId` comparison (customDomains.ts). Also red when the
 * unready-provider reason is dropped from the edge summary, or force-delete is
 * allowed on a row that is not stuck releasing.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

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

/** The fields these cases read, across the domain routes' JSON bodies. */
interface Body {
  orgId?: string;
  user?: { tenantId?: string };
  edge?: { provider: string; ready: boolean; reason?: string };
  domain?: { hostname: string };
  outcome?: string;
  error?: string;
  message?: string;
}
interface Res { status: number; body: Body }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out: Body = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post('/host/openwop-app/test/login', { email: `cd-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/host/openwop-app/orgs', { name: 'Domain Co' });
  return { user, orgId: org.body.orgId ?? '', tenantId: login.body.user?.tenantId ?? '' };
}

const mgmt = (orgId: string, sfx = ''): string => `/host/openwop-app/custom-domains/orgs/${encodeURIComponent(orgId)}/domains${sfx}`;


describe('ADR 0906 P3 — domain routes', () => {
  it('list carries the edge summary (manual by default)', async () => {
    const { user, orgId } = await marketer();
    const res = await user.get(mgmt(orgId));
    expect(res.status).toBe(200);
    expect(res.body.edge).toEqual({ provider: 'manual', ready: true });
  });

  it('an unready provider is reported with its reason, not hidden', async () => {
    process.env.OPENWOP_CUSTOM_DOMAIN_EDGE = 'gcp-certificate-manager';
    try {
      const { user, orgId } = await marketer();
      const res = await user.get(mgmt(orgId));
      expect(res.body.edge).toMatchObject({ provider: 'gcp-certificate-manager', ready: false });
      expect(res.body.edge?.reason).toBe('OPENWOP_CUSTOM_DOMAIN_CERT_MAP is not set');
    } finally { delete process.env.OPENWOP_CUSTOM_DOMAIN_EDGE; }
  });

  it('status + retry are org-scoped; delete reports its outcome; force needs a stuck release', async () => {
    const a = await marketer();
    const b = await marketer();
    expect((await a.user.post(mgmt(a.orgId), { hostname: 'shop.p3brand.test' })).status).toBe(201);
    const status = await a.user.get(mgmt(a.orgId, '/shop.p3brand.test/status'));
    expect(status.status).toBe(200);
    expect(status.body.domain?.hostname).toBe('shop.p3brand.test');
    // SAME tenant, OTHER org: the caller is a member of both, so only the org
    // comparison in getDomain can refuse.
    const other = await a.user.post('/host/openwop-app/orgs', { name: 'Other Co' });
    expect(other.status).toBe(201);
    const otherOrgId = other.body.orgId ?? '';
    for (const res of [
      await a.user.get(mgmt(otherOrgId, '/shop.p3brand.test/status')),
      await a.user.post(mgmt(otherOrgId, '/shop.p3brand.test/retry')),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'not_found', message: 'Domain not found.' });
    }
    // Cross-tenant as well.
    for (const res of [
      await b.user.get(mgmt(b.orgId, '/shop.p3brand.test/status')),
      await b.user.post(mgmt(b.orgId, '/shop.p3brand.test/retry')),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'not_found', message: 'Domain not found.' });
    }
    const force = await a.user.del(mgmt(a.orgId, '/shop.p3brand.test?force=1'));
    expect(force.status).toBe(409);
    expect(force.body).toMatchObject({ error: 'conflict', message: 'Force removal is only available after 3 failed release attempts.' });
    const del = await a.user.del(mgmt(a.orgId, '/shop.p3brand.test'));
    expect(del.status).toBe(200);
    expect(del.body.outcome).toBe('deleted');
    const after = await a.user.get(mgmt(a.orgId));
    expect(JSON.stringify(after.body)).not.toContain('shop.p3brand.test');
  });
});
