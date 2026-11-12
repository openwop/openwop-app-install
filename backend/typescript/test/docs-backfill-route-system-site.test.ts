/**
 * The docs KB backfill route has to reach the system site's docs.
 *
 * `POST /host/openwop-app/docs/orgs/:orgId/backfill` scoped through
 * `requireOrgScope`, which looks the org up in the CALLER's tenant. The host's
 * own docs live on the reserved system-site org in `SYSTEM_SITE_TENANT`, so the
 * route answered `404 Organization not found` for everyone, superadmin included.
 * MEASURED in prod 2026-11-11: the operator's signed-in run did nothing. The
 * service-level test (`system-site-docs.test.ts`) calls `backfillDocsKb`
 * directly and never sees the route's scope, which is why this stayed green.
 *
 * Route-level, four arms:
 *  - a superadmin backfills the system site (200, and the KB holds the pages);
 *  - the docs toggle is read for the system site's tenant, not the caller's home;
 *  - anyone else gets the same uniform 404 a foreign org gets;
 *  - a member-manager of a real org still backfills their own org.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { SYSTEM_SITE_ORG, SYSTEM_SITE_TENANT } from '../src/host/systemSite.js';
import { listDocuments } from '../src/features/kb/kbService.js';
import { assertFlatErrorEnvelope } from './helpers/errorEnvelope.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['docs']) {
    const t = getToggleDefault(id);
    expect(t, `${id} toggle must be declared`).toBeTruthy();
    if (t) await saveConfig({ ...t, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body { orgId: string; personal: string; pages: number; removedOrphans: number }
interface Res { status: number; body: Body }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as Body };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function signedIn(tag: string): Promise<Client> {
  const c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `${tag}-${Date.now()}-${n++}@acme.test`, tenantId: `org:docsbf-${tag}-${Date.now()}-${n++}` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  return c;
}
const backfill = (orgId: string): string => `/host/openwop-app/docs/orgs/${encodeURIComponent(orgId)}/backfill`;

describe('docs KB backfill route reaches the system site', () => {
  it('a superadmin backfills the system site, and the KB holds what it reports', async () => {
    const c = await signedIn('sa');
    const who = await c.get('/host/openwop-app/me/workspaces');
    expect(who.status, JSON.stringify(who.body)).toBe(200);
    process.env.OPENWOP_SUPERADMIN_TENANTS = who.body.personal;
    try {
      const r = await c.post(backfill(SYSTEM_SITE_ORG));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // The boot seed lands the docs corpus (16+ pages) on the system site.
      expect(r.body.pages).toBeGreaterThanOrEqual(16);
      const docs = await listDocuments(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, `mgd-docs-${SYSTEM_SITE_ORG}`);
      expect(docs.length).toBe(r.body.pages);
    } finally {
      delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    }
  });

  it('reads the docs toggle for the system site, not the superadmin\'s home tenant', async () => {
    const c = await signedIn('sa-off');
    const who = await c.get('/host/openwop-app/me/workspaces');
    expect(who.status, JSON.stringify(who.body)).toBe(200);
    const home = who.body.personal;
    const d = getToggleDefault('docs');
    if (!d) throw new Error('docs toggle must be declared');
    process.env.OPENWOP_SUPERADMIN_TENANTS = home;
    try {
      // Docs OFF for the caller's home tenant, ON for the system site: the
      // backfill acts on the system site's data, so it runs.
      await saveConfig({ ...d, status: 'on', tenantOverrides: { [home]: { status: 'off' } } }, 'test');
      const ok = await c.post(backfill(SYSTEM_SITE_ORG));
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      // And the reverse: ON at home, OFF for the system site, refuses.
      await saveConfig({ ...d, status: 'on', tenantOverrides: { [SYSTEM_SITE_TENANT]: { status: 'off' } } }, 'test');
      const off = await c.post(backfill(SYSTEM_SITE_ORG));
      expect(off.status, JSON.stringify(off.body)).toBe(404);
      expect(assertFlatErrorEnvelope(off.body, 'system-site docs off').details?.feature).toBe('docs');
    } finally {
      delete process.env.OPENWOP_SUPERADMIN_TENANTS;
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });

  it('a non-superadmin gets the same 404 a foreign org yields', async () => {
    const c = await signedIn('member');
    const r = await c.post(backfill(SYSTEM_SITE_ORG));
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(assertFlatErrorEnvelope(r.body, 'system-site backfill refusal').error).toBe('not_found');
  });

  it('a member-manager of a real org still backfills their own org', async () => {
    const c = await signedIn('owner');
    const org = await c.post('/host/openwop-app/orgs', { name: 'Acme Docs' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const r = await c.post(backfill(org.body.orgId));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ pages: 0, removedOrphans: 0 });
  });
});
