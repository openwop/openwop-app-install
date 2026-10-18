/**
 * ADR 0873 D12 — `GET …/feature-toggles/assignments` echoes the subject it resolved
 * for, and that subject's tenant is the ACTIVE one.
 *
 * The SPA keys last-known offline entitlement grants on this echo. The first cut
 * keyed them on `/me`'s `tenantId`, which is the caller's HOME tenant
 * (`resolveCallerUser`), while `/billing/entitlements` answers for the ACTIVE
 * workspace (`tenantOf`). After a switch into a shared `ws:` workspace the two
 * differ, so a grant earned in one workspace would have rendered a feature offline
 * in another (ADR 0508's home-vs-active family). This test drives the production
 * path, sign in, create a real `ws:` workspace, switch into it, and asserts the
 * echo follows the switch while `/me` does not, which is why `/me` cannot be the key.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

const ASSIGNMENTS = '/host/openwop-app/feature-toggles/assignments';

describe('assignments echo the ACTIVE tenant they resolved for (ADR 0873 D12)', () => {
  it('follows a workspace switch, where /me keeps the home tenant', async () => {
    const c = client();
    const login = await c.post('/host/openwop-app/test/login', { email: `d12-${Date.now()}@acme.test` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);

    const home = await c.get(ASSIGNMENTS);
    expect(home.status).toBe(200);
    expect(Array.isArray(home.body.assignments)).toBe(true);
    const homeTenant: string = home.body.caller.tenantId;
    const principal: string = home.body.caller.principalId;
    expect(homeTenant).toMatch(/^user:/);
    expect(typeof principal).toBe('string');

    const ws = await c.post('/host/openwop-app/workspaces', { name: 'D12 shared' });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    expect(ws.body.workspaceId).toMatch(/^ws:/);
    const sw = await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws.body.workspaceId)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);

    const active = await c.get(ASSIGNMENTS);
    expect(active.status).toBe(200);
    expect(active.body.caller).toEqual({ tenantId: ws.body.workspaceId, principalId: principal });

    // The reason the key is this echo and not /me: /me stays on the home tenant.
    const me = await c.get('/host/openwop-app/users/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.tenantId).toBe(homeTenant);
    expect(me.body.tenantId).not.toBe(active.body.caller.tenantId);
  });
});
