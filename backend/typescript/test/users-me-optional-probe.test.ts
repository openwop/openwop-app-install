/**
 * Issue 5991 — the SPA's session probe on public pages logs no failed request.
 *
 * Every page load (public ones included) asks `GET /users/me`. For a visitor who is
 * not signed in that was a 401, and the browser logs one console error per load.
 * `?optional=1` makes "not signed in" a 204, uncached. Pinned: the plain route still
 * 401s; the probe 204s with `no-store`; a signed-in caller gets their record either way;
 * `?optional=1` changes no other route (PATCH /users/me, /users/me/security, revoke).
 * Red when the optional branch is removed (401 again) or widened past sign_in_required.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let server: http.Server;
let BASE = '';
const ME = '/host/openwop-app/users/me';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('users'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('issue 5991 — GET /users/me?optional=1', () => {
  it('no session: the plain route is 401, the probe is an uncached 204', async () => {
    const plain = await fetch(`${BASE}${ME}`);
    expect(plain.status).toBe(401);
    const probe = await fetch(`${BASE}${ME}?optional=1`);
    expect(probe.status).toBe(204);
    expect(probe.headers.get('cache-control')).toContain('no-store');
    expect(await probe.text()).toBe('');
  });

  it('a signed-in caller gets their record from the probe too', async () => {
    const login = await fetch(`${BASE}/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `probe-${Date.now()}@acme.test` }) });
    expect(login.status).toBe(201);
    const cookie = getSetCookies(login.headers).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
    const { user } = (await login.json()) as { user: { userId: string } };
    const probe = await fetch(`${BASE}${ME}?optional=1`, { headers: { cookie } });
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { userId: string }).userId).toBe(user.userId);
  });

  it('the parameter is opt-in to this one read: every other /users/me route still refuses an anonymous caller', async () => {
    const json = { 'content-type': 'application/json' };
    const cases: Array<[string, string, RequestInit]> = [
      ['PATCH', `${ME}?optional=1`, { method: 'PATCH', headers: json, body: JSON.stringify({ displayName: 'x' }) }],
      ['GET', `${ME}/security?optional=1`, {}],
      ['POST', `${ME}/sessions/revoke?optional=1`, { method: 'POST', headers: json, body: '{}' }],
    ];
    for (const [method, path, init] of cases) {
      const r = await fetch(`${BASE}${path}`, init);
      expect([401, 403], `${method} ${path} answered ${r.status}`).toContain(r.status);
    }
  });
});
