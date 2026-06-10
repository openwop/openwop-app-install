/**
 * Feature-toggle superadmin gate — fail-closed (ADR 0001 §3.2, code-review #1).
 *
 * The admin surface must deny an authenticated NON-superadmin by default: no
 * OPENWOP_SUPERADMIN_TENANTS allowlist match and no explicit dev opt-in ⇒ 403,
 * regardless of NODE_ENV. The wildcard bearer (admin key) is allowed; the
 * explicit OPENWOP_FEATURE_TOGGLES_DEV_OPEN opt-in re-opens it for local dev.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('feature-toggle superadmin gate (fail-closed)', () => {
  let server: http.Server;
  const PORT = 18895;
  const BASE = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    // Cookie auth ON so a cookieless request mints an authenticated anon
    // session (a NON-superadmin principal) for this same request.
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(PORT, res);
    });
  });
  afterAll(async () => {
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    await new Promise<void>((res) => server.close(() => res()));
  });

  const adminPath = '/v1/host/sample/feature-toggles/admin/configs';

  it('denies an authenticated non-superadmin (anon session) by default — 403', async () => {
    const res = await fetch(`${BASE}${adminPath}`); // no bearer ⇒ anon cookie session
    expect(res.status).toBe(403);
  });

  it('allows the wildcard bearer (admin key) — 200', async () => {
    const res = await fetch(`${BASE}${adminPath}`, { headers: { authorization: 'Bearer sample-token' } });
    expect(res.status).toBe(200);
  });

  it('the explicit dev opt-in re-opens it for any authed caller — 200', async () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    try {
      const res = await fetch(`${BASE}${adminPath}`); // anon session, now allowed
      expect(res.status).toBe(200);
    } finally {
      delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    }
  });
});
