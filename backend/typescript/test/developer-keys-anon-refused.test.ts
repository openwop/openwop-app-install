/**
 * ADR 0771 finding — `developer-keys` said "issuing a credential is not
 * anonymous", but its guard was `req.userId ?? req.principal?.principalId`, and
 * an anonymous session carries `principalId: session:<sid>`. So an anonymous
 * visitor could mint an API key. The key was confined to its anonymous tenant
 * (no escalation), but the route's own claim was false. Route-level, because the
 * anonymous principal only exists after the real auth middleware.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function cookieClient() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown) => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) as any, hasCookie: () => cookie !== '' };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), hasCookie: () => cookie !== '' };
}

describe('developer-keys refuses an anonymous session', () => {
  it('an anonymous session cannot mint a key (401), and nothing is issued', async () => {
    const anon = cookieClient();
    await anon.get('/host/openwop-app/roster');
    expect(anon.hasCookie(), 'the anonymous session must exist, or this leg proves nothing').toBe(true);
    const r = await anon.post('/host/openwop-app/developer-keys', { name: 'x' });
    expect(r.status, JSON.stringify(r.body)).toBe(401);
    expect(r.body?.token).toBeUndefined();
  });

  it('control: a signed-in session still mints one', async () => {
    const c = cookieClient();
    expect((await c.post('/host/openwop-app/test/login', { email: `k-${Date.now()}@a.test`, tenantId: `org:k-${Date.now()}` })).status).toBe(201);
    const r = await c.post('/host/openwop-app/developer-keys', { name: 'ci', scopes: ['runs:read'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(typeof r.body?.token).toBe('string');
  });
});
