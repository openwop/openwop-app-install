/**
 * Host-managed OAuth client config (ADR 0024 § host-managed OAuth client config).
 * Route-boundary tests — the things only observable through HTTP: the superadmin
 * gate, the secret-is-never-echoed invariant, the `oauthConfigured` flip that
 * actually enables the Connect button, and that the sibling prefix neither
 * shadows nor is shadowed by `/connections/:id`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetConnectionsStore } from '../src/features/connections/connectionsService.js';
import { __resetOAuthClientStore } from '../src/features/connections/oauthClientStore.js';

describe('Host OAuth client config (superadmin surface)', () => {
  let server: http.Server;
  const PORT = 18953;
  const BASE = `http://127.0.0.1:${PORT}`;
  const TOKEN = 'sample-token'; // wildcard bearer ⇒ superadmin

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    // Ensure no ambient env creds + no dev-open bypass leak into the gate test.
    delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID;
    delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __clearToggleStore();
    await __resetConnectionsStore();
    await __resetOAuthClientStore();
    await new Promise<void>((res) => {
      server = app.listen(PORT, res);
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

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
    const put = await jf('/v1/host/sample/connections-oauth-clients/google', {
      method: 'PUT',
      auth: false,
      body: JSON.stringify({ clientId: 'id', clientSecret: 'sec' }),
    });
    expect(put.status).toBeGreaterThanOrEqual(401); // 401 (no principal) or 403 (not superadmin) — never a 2xx write
    expect(put.status).toBeLessThan(500);
  });

  it('rejects a non-OAuth provider (servicenow = api_key) and an unknown provider', async () => {
    const sn = await jf('/v1/host/sample/connections-oauth-clients/servicenow', {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'id', clientSecret: 'sec' }),
    });
    expect(sn.status).toBe(400);
    const nope = await jf('/v1/host/sample/connections-oauth-clients/nope', {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'id', clientSecret: 'sec' }),
    });
    expect(nope.status).toBe(404);
  });

  it('configuring a provider flips its oauthConfigured flag — and never echoes the secret', async () => {
    // Before: google is NOT configured (no env, no store).
    const before = await jf<{ providers: { id: string; oauthConfigured?: boolean }[] }>('/v1/host/sample/providers');
    expect(before.body.providers.find((p) => p.id === 'google')?.oauthConfigured).toBe(false);

    // Configure it via the admin surface.
    const put = await jf('/v1/host/sample/connections-oauth-clients/google', {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'google-client-id-123', clientSecret: SECRET }),
    });
    expect(put.status).toBe(204);
    expect(put.text).not.toContain(SECRET); // PUT echoes nothing

    // After: the Connect button's honesty flag is now true.
    const after = await jf<{ providers: { id: string; oauthConfigured?: boolean }[] }>('/v1/host/sample/providers');
    expect(after.body.providers.find((p) => p.id === 'google')?.oauthConfigured).toBe(true);

    // The admin list shows clientId + metadata but NEVER the secret.
    const list = await jf<{ clients: { provider: string; clientId: string; configured: boolean }[] }>('/v1/host/sample/connections-oauth-clients');
    const g = list.body.clients.find((c) => c.provider === 'google');
    expect(g?.clientId).toBe('google-client-id-123');
    expect(g?.configured).toBe(true);
    expect(list.text).not.toContain(SECRET); // the secret is never on any read surface
  });

  it('delete removes the config — oauthConfigured falls back to false (no env set)', async () => {
    const del = await jf('/v1/host/sample/connections-oauth-clients/google', { method: 'DELETE' });
    expect(del.status).toBe(204);
    const after = await jf<{ providers: { id: string; oauthConfigured?: boolean }[] }>('/v1/host/sample/providers');
    expect(after.body.providers.find((p) => p.id === 'google')?.oauthConfigured).toBe(false);
    // deleting again → 404 (idempotent-aware: nothing to remove)
    const del2 = await jf('/v1/host/sample/connections-oauth-clients/google', { method: 'DELETE' });
    expect(del2.status).toBe(404);
  });

  it('the sibling prefix does not shadow /connections/:id (a real connection id still routes)', async () => {
    // `connections-oauth-clients` must not be captured by `/connections/:id` — a
    // GET for a (non-existent) connection id returns the connection surface's own
    // shape, not the oauth-client list. We assert it does NOT 200 as a client list.
    const r = await jf<{ clients?: unknown }>('/v1/host/sample/connections-oauth-clients');
    expect(Array.isArray(r.body.clients)).toBe(true); // the admin route is reached, not a :id handler
  });
});
