/**
 * The OAuth client admin read returns, per provider, the redirect URI the
 * server itself SENDS on the authorize request (`oauthFlow.redirectUri`), so the
 * admin panel shows what the operator must register, never a client-side guess.
 *
 * casavoga-b0 found it: the panel built `window.location.origin + '/api/host/…'`
 * while the server sent `OPENWOP_OAUTH_CALLBACK_BASE_URL` + `/v1` + `/host/…`,
 * so a copied URI failed at the provider. Pinned under both the versioned
 * default and OPENWOP_OAUTH_REDIRECT_UNVERSIONED=true, with a configured base.
 *
 * Sabotage: building the route's value any other way than `redirectUri(p.id,
 * origin)` (e.g. dropping the `/v1` branch) reds the matching case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { redirectUri } from '../src/features/connections/oauthFlow.js';
import { listProviders } from '../src/features/connections/providerRegistry.js';

let BASE: string;
let server: http.Server;
let cookie = '';
async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const login = await fetch(`${BASE}/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `oauth-hint-${Date.now()}@acme.test` }) });
  for (const ck of getSetCookies(login.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { vi.unstubAllEnvs(); });

async function asSuperadmin(): Promise<void> {
  const personal = (await get<{ personal: string }>('/host/openwop-app/me/workspaces')).body.personal;
  vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', personal);
}

describe('the OAuth client admin read carries the server’s own redirect URIs', () => {
  it.each([
    ['versioned (the default)', ''],
    ['unversioned (OPENWOP_OAUTH_REDIRECT_UNVERSIONED=true)', 'true'],
  ])('%s: each provider’s URI is exactly redirectUri()', async (_label, unversioned) => {
    await asSuperadmin();
    vi.stubEnv('OPENWOP_OAUTH_CALLBACK_BASE_URL', 'https://casavoga.example');
    vi.stubEnv('OPENWOP_OAUTH_REDIRECT_UNVERSIONED', unversioned);
    const r = await get<{ redirectUris: Record<string, string> }>('/host/openwop-app/connections-oauth-clients');
    expect(r.status).toBe(200);
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) expect(r.body.redirectUris[p.id], p.id).toBe(redirectUri(p.id, 'http://unused'));
    const google = providers.find((p) => p.id === 'google') ?? providers[0]!;
    expect(r.body.redirectUris[google.id]).toBe(`https://casavoga.example${unversioned ? '' : '/v1'}/host/openwop-app/connections/${google.id}/callback`);
  });

  it('is superadmin-only', async () => {
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', '');
    expect((await get('/host/openwop-app/connections-oauth-clients')).status).toBe(403);
  });
});
