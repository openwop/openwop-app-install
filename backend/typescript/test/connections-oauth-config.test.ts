/**
 * Host-managed OAuth client config (ADR 0024 § host-managed OAuth client config).
 * Route-boundary tests — the things only observable through HTTP: the superadmin
 * gate, the secret-is-never-echoed invariant, the `oauthConfigured` flip that
 * actually enables the Connect button, and that the sibling prefix neither
 * shadows nor is shadowed by `/connections/:id`.
 *
 * Tracker TST-CJC-3 (grade-tests w68). Red when: the PUT drops its
 * `requireSuperadmin` (an AUTHENTICATED same-tenant non-superadmin gets a write — the
 * gate itself is reached, not refused earlier as anonymous); a non-OAuth provider is
 * accepted; `oauthConfigured` stops reflecting the stored client; or a delete of
 * nothing stops being a 404.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetConnectionsStore } from '../src/features/connections/connectionsService.js';
import { __resetOAuthClientStore } from '../src/features/connections/oauthClientStore.js';

describe('Host OAuth client config (superadmin surface)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token'; // wildcard bearer ⇒ superadmin
  const SAVED = {
    OPENWOP_AUTH_DISABLE_COOKIES: process.env.OPENWOP_AUTH_DISABLE_COOKIES,
    OPENWOP_TEST_AUTH_ENABLED: process.env.OPENWOP_TEST_AUTH_ENABLED,
    OPENWOP_SESSION_SECRET: process.env.OPENWOP_SESSION_SECRET,
  };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    // Cookies ON so a real signed-in (non-superadmin) user can reach the gate.
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    // Ensure no ambient env creds + no dev-open bypass leak into the gate test.
    delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID;
    delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __clearToggleStore();
    await __resetConnectionsStore();
    await __resetOAuthClientStore();
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A signed-in, same-shape, NON-superadmin user (cookie session, no bearer). */
  async function signedInUser(): Promise<(m: string, p: string, b?: unknown) => Promise<{ status: number; body: { error?: string; message?: string } }>> {
    let cookie = '';
    const call = async (m: string, p: string, b?: unknown): Promise<{ status: number; body: { error?: string; message?: string } }> => {
      const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]!; }
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as { error?: string; message?: string } };
    };
    const login = await call('POST', '/host/openwop-app/test/login', { email: `oauthcfg-${Date.now()}@a.test`, tenantId: `org:oauthcfg-${Date.now()}` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    expect(cookie, 'the login set a session cookie').not.toBe('');
    return call;
  }

  /** Request helper. `auth: false` sends no bearer ⇒ a non-superadmin (anon) caller. */
  async function jf<T = unknown>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<{ status: number; body: T; text: string }> {
    const { auth = true, ...rest } = init;
    const headers: Record<string, string> = { 'content-type': 'application/json', ...((rest.headers as Record<string, string>) ?? {}) };
    if (auth) headers.authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}${path}`, { ...rest, headers });
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    return { status: res.status, body: body as T, text };
  }

  const SECRET = 'goog-client-secret-super-sensitive-xyz';

  it('a non-superadmin caller is denied (fail-closed)', async () => {
    const put = await jf('/host/openwop-app/connections-oauth-clients/google', {
      method: 'PUT',
      auth: false,
      body: JSON.stringify({ clientId: 'id', clientSecret: 'sec' }),
    });
    expect(put.status).toBeGreaterThanOrEqual(401); // 401 (no principal) or 403 (not superadmin) — never a 2xx write
    expect(put.status).toBeLessThan(500);
    // The gate itself: an AUTHENTICATED user who is not a superadmin is refused by
    // requireSuperadmin (an anonymous caller may be refused earlier, by auth).
    const asUser = await signedInUser();
    const userPut = await asUser('PUT', '/host/openwop-app/connections-oauth-clients/google', { clientId: 'id', clientSecret: 'sec' });
    expect(userPut.status).toBe(403);
    expect(userPut.body.error).toBe('forbidden');
    expect(userPut.body.message).toMatch(/requires a superadmin principal/);
  });

  it('rejects a non-OAuth provider (servicenow = api_key) and an unknown provider', async () => {
    const sn = await jf('/host/openwop-app/connections-oauth-clients/servicenow', {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'id', clientSecret: 'sec' }),
    });
    expect(sn.status).toBe(400);
    expect((sn.body as { error?: string }).error).toBe('validation_error');
    const nope = await jf('/host/openwop-app/connections-oauth-clients/nope', {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'id', clientSecret: 'sec' }),
    });
    expect(nope.status).toBe(404);
    expect((nope.body as { error?: string }).error).toBe('not_found');
  });

  it('configuring a provider flips its oauthConfigured flag — and never echoes the secret', async () => {
    // Before: google is NOT configured (no env, no store).
    const before = await jf<{ providers: { id: string; oauthConfigured?: boolean }[] }>('/host/openwop-app/providers');
    expect(before.body.providers.find((p) => p.id === 'google')?.oauthConfigured).toBe(false);

    // Configure it via the admin surface.
    const put = await jf('/host/openwop-app/connections-oauth-clients/google', {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'google-client-id-123', clientSecret: SECRET }),
    });
    expect(put.status).toBe(204);
    expect(put.text).not.toContain(SECRET); // PUT echoes nothing

    // After: the Connect button's honesty flag is now true.
    const after = await jf<{ providers: { id: string; oauthConfigured?: boolean }[] }>('/host/openwop-app/providers');
    expect(after.body.providers.find((p) => p.id === 'google')?.oauthConfigured).toBe(true);

    // The admin list shows clientId + metadata but NEVER the secret.
    const list = await jf<{ clients: { provider: string; clientId: string; configured: boolean }[] }>('/host/openwop-app/connections-oauth-clients');
    const g = list.body.clients.find((c) => c.provider === 'google');
    expect(g?.clientId).toBe('google-client-id-123');
    expect(g?.configured).toBe(true);
    expect(list.text).not.toContain(SECRET); // the secret is never on any read surface
  });

  it('delete removes the config — oauthConfigured falls back to false (no env set)', async () => {
    // Seeds its own config (never relies on the case above having run first).
    const put = await jf('/host/openwop-app/connections-oauth-clients/google', {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'google-client-id-del', clientSecret: SECRET }),
    });
    expect(put.status).toBe(204);
    const del = await jf('/host/openwop-app/connections-oauth-clients/google', { method: 'DELETE' });
    expect(del.status).toBe(204);
    const after = await jf<{ providers: { id: string; oauthConfigured?: boolean }[] }>('/host/openwop-app/providers');
    expect(after.body.providers.find((p) => p.id === 'google')?.oauthConfigured).toBe(false);
    // deleting again → 404 (idempotent-aware: nothing to remove)
    const del2 = await jf('/host/openwop-app/connections-oauth-clients/google', { method: 'DELETE' });
    expect(del2.status).toBe(404);
  });

  it('the sibling prefix does not shadow /connections/:id (a real connection id still routes)', async () => {
    // `connections-oauth-clients` must not be captured by `/connections/:id` — a
    // GET for a (non-existent) connection id returns the connection surface's own
    // shape, not the oauth-client list. We assert it does NOT 200 as a client list.
    const r = await jf<{ clients?: unknown }>('/host/openwop-app/connections-oauth-clients');
    expect(Array.isArray(r.body.clients)).toBe(true); // the admin route is reached, not a :id handler
    // …and `/connections/:id` still reaches the CONNECTION surface (its own 404).
    const c = await jf<{ error?: string; message?: string }>('/host/openwop-app/connections/conn:nope', { method: 'DELETE' });
    expect(c.status).toBe(404);
    expect(c.body.error).toBe('not_found');
    expect(c.body.message).toBe('Connection not found.');
  });
});
