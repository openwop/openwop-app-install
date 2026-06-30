/**
 * App-brand routes (ADR 0170 Phase 4). Asserts: the anonymous SPA reads the app
 * identity (pre-auth); a super admin reads + edits it (host authority); a
 * non-superadmin is 403; the public read exposes ONLY the identity subset (never
 * voice/governance/createdBy) and is hardwired to the reserved brand so a tenant
 * marketing brand's identity can never be served; PUT sanitizes injection; ETag/304.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // only the wildcard bearer is superadmin
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://localhost:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const ab = (method: string, body?: unknown) =>
  fetch(`${BASE}/v1/host/openwop-app/app-brand`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const publicBrand = (headers: Record<string, string> = {}) =>
  fetch(`${BASE}/v1/host/openwop-app/public-brand`, { headers });

async function normalClient(): Promise<(m: string, p: string, b?: unknown) => Promise<Response>> {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m2 = /(__session=[^;]+)/.exec(ck); if (m2) cookie = m2[1]; }
    return res;
  };
  const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `ab-${n++}@x.test` });
  expect(login.status).toBe(201);
  return call;
}

describe('app-brand — public read (anonymous, pre-auth)', () => {
  it('serves the app identity to an anonymous visitor', async () => {
    const res = await publicBrand();
    expect(res.status).toBe(200);
    const body = await j<{ identity: Record<string, unknown> }>(res);
    expect(body).toHaveProperty('identity'); // sparse {} on a fresh install
  });

  it('reflects a super-admin edit and supports ETag/304', async () => {
    await ab('PUT', { identity: { productName: 'Acme', colors: { accent: 'oklch(58% 0.13 250)' } } });
    const res = await publicBrand();
    const body = await j<{ identity: { productName?: string } }>(res);
    expect(body.identity.productName).toBe('Acme');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    const again = await publicBrand({ 'if-none-match': etag ?? '' });
    expect(again.status).toBe(304);
  });

  it('exposes ONLY the identity subset — never voice/governance/createdBy', async () => {
    await ab('PUT', { identity: { productName: 'Acme' } });
    const body = await j<Record<string, unknown>>(await publicBrand());
    expect(Object.keys(body)).toEqual(['identity']);
    expect(body).not.toHaveProperty('brand');
    expect(body).not.toHaveProperty('voiceProfile');
    expect(body).not.toHaveProperty('governance');
    expect(body).not.toHaveProperty('createdBy');
  });
});

describe('app-brand — superadmin authority', () => {
  it('a super admin reads the full app brand and edits identity (with sanitization)', async () => {
    expect((await ab('GET')).status).toBe(200);
    const edited = await j<{ brand: { identity?: { colors?: Record<string, string>; productName?: string } } }>(
      await ab('PUT', { identity: { productName: 'Brandy', colors: { accent: '#abc', bad: 'red;}evil{' } } }),
    );
    expect(edited.brand.identity?.productName).toBe('Brandy');
    expect(edited.brand.identity?.colors).toEqual({ accent: '#abc' }); // injection + unknown key dropped
  });

  it('forbids a non-superadmin (403) on read and write', async () => {
    const call = await normalClient();
    expect((await call('GET', '/v1/host/openwop-app/app-brand')).status).toBe(403);
    expect((await call('PUT', '/v1/host/openwop-app/app-brand', { identity: { productName: 'Hijack' } })).status).toBe(403);
  });
});

describe('app-brand — isolation (reserved brand only)', () => {
  it('a tenant marketing brand is never reachable as the app brand', async () => {
    const call = await normalClient();
    const org = await j<{ orgId: string }>(await (await call('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' })));
    // create a tenant brand WITH an identity — it must stay inert (never drive the chrome)
    const created = await call('POST', '/v1/host/openwop-app/brand/brands', {
      orgId: org.orgId, name: 'Tenant', identity: { productName: 'TENANT-SHOULD-NOT-LEAK' },
    });
    expect(created.status).toBe(201);
    // /public-brand returns the reserved app brand, NOT the tenant brand
    const pub = await j<{ identity: { productName?: string } }>(await publicBrand());
    expect(pub.identity.productName).not.toBe('TENANT-SHOULD-NOT-LEAK');
    // and a normal user cannot reach the reserved brand id through the tenant routes
    expect((await call('GET', '/v1/host/openwop-app/brand/brands/brand:host-app')).status).toBe(404);
  });
});
