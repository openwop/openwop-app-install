/**
 * Site-config routes (ADR 0027) — the runtime, superadmin-managed public
 * front-page pointer that replaces the build-time VITE_OPENWOP_FRONTPAGE_* env.
 * Drives over HTTP: the PUBLIC unauthed read, the superadmin gate on read/write,
 * and orgId validation. Superadmin = the wildcard bearer (admin key), matching
 * test/feature-toggles-superadmin.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_SUPERADMIN_TENANTS; // only the wildcard bearer is superadmin
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  delete process.env.OPENWOP_FRONTPAGE_DEFAULT_ENABLED; // default-on (ADR 0027)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const pub = () => fetch(`${BASE}/v1/host/openwop-app/public-site-config`); // NO auth
const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** A signed-in but NON-superadmin caller (personal tenant), via the test seam. */
async function normalClient(): Promise<(method: string, path: string, body?: unknown) => Promise<Response>> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    if (sc.length) cookie = sc.map((c: string) => c.split(';')[0]).join('; ');
    return res;
  };
  const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `sc-${n++}@x.test` });
  expect(login.status).toBe(201);
  return call;
}

describe('site-config — public read (unauthenticated)', () => {
  it('is ON by default and points at the fixed system site', async () => {
    const res = await pub();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, orgId: 'host-site', slug: 'home' });
  });
});

describe('site-config — superadmin gate', () => {
  it('a non-superadmin is forbidden on read and write (403)', async () => {
    const call = await normalClient();
    expect((await call('GET', '/v1/host/openwop-app/site-config')).status).toBe(403);
    expect((await call('PUT', '/v1/host/openwop-app/site-config', { enabled: false })).status).toBe(403);
  });
});

describe('site-config — superadmin toggle', () => {
  it('toggles the on/off switch; public pointer follows', async () => {
    // disable → public pointer hides
    expect((await admin('PUT', '/v1/host/openwop-app/site-config', { enabled: false })).status).toBe(200);
    expect(await j(await pub())).toEqual({ enabled: false });
    expect((await j<{ enabled: boolean }>(await admin('GET', '/v1/host/openwop-app/site-config'))).enabled).toBe(false);

    // re-enable → fixed system pointer returns
    expect((await admin('PUT', '/v1/host/openwop-app/site-config', { enabled: true })).status).toBe(200);
    expect(await j(await pub())).toEqual({ enabled: true, orgId: 'host-site', slug: 'home' });
  });
});
