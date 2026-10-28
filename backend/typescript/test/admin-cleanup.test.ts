/**
 * P0.5 admin cleanup endpoint (`routes/admin.ts`). TST-BQA-1.
 *   - Requires the admin Bearer token: 401 without one ('Missing Bearer admin
 *     token.'), 401 on a mismatch ('Admin token mismatch.'), 503 when
 *     OPENWOP_ADMIN_TOKEN is unset. Red when either 401 branch or the 503 guard
 *     is removed.
 *   - Wipes ephemeral BYOK secrets for tenants whose last activity is OLDER than
 *     the window, and drops them from the tracker. Red when the `ts >= cutoff`
 *     check keeps every seen tenant, or when the keep-set is ignored.
 *   - GET status reports the tracked-tenant count and performs NO cleanup: red
 *     when the status route wipes secrets of un-noted tenants.
 */

import { beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { registerAdminRoutes, noteTenantActivity, _resetTenantActivity } from '../src/routes/admin.js';
import {
  setSecret,
  resolveSecret,
  clearAllSecrets,
} from '../src/byok/secretResolver.js';

let server: http.Server | undefined;
let port: number;
const ADMIN_TOKEN = 'a'.repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;

async function startApp(): Promise<void> {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      port = (s.address() as { port: number }).port;
      resolve();
    });
    server = s;
  });
}

interface ErrorBody { error: string; message: string }

describe('P0.5 admin cleanup', () => {
  beforeEach(async () => {
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    process.env.OPENWOP_ADMIN_TOKEN = ADMIN_TOKEN;
    delete process.env.OPENWOP_CLEANUP_WINDOW_MS;
    await clearAllSecrets();
    _resetTenantActivity();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await startApp();
  });

  afterEach(() => { vi.useRealTimers(); });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    process.env.OPENWOP_BYOK_EPHEMERAL = '';
    process.env.OPENWOP_ADMIN_TOKEN = '';
  });

  it('rejects requests without admin token', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/host/openwop-app/admin/cleanup`, { method: 'POST' });
    expect(r.status).toBe(401);
    expect(((await r.json()) as ErrorBody).message).toBe('Missing Bearer admin token.');
  });

  it('rejects requests with wrong admin token', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/host/openwop-app/admin/cleanup`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(r.status).toBe(401);
    expect(((await r.json()) as ErrorBody).message).toBe('Admin token mismatch.');
  });

  it('503 when OPENWOP_ADMIN_TOKEN is unset', async () => {
    process.env.OPENWOP_ADMIN_TOKEN = '';
    try {
      const r = await fetch(`http://127.0.0.1:${port}/host/openwop-app/admin/cleanup`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(r.status).toBe(503);
      expect(((await r.json()) as ErrorBody).error).toBe('admin_disabled');
    } finally {
      process.env.OPENWOP_ADMIN_TOKEN = ADMIN_TOKEN;
    }
  });

  it('wipes ephemeral secrets for tenants outside the activity window', async () => {
    // Fake only Date: the stale tenant is SEEN, then ages past the 24 h window.
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-07-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    await setSecret('a', '1', { tenantId: 'anon:active' });
    await setSecret('b', '2', { tenantId: 'anon:also-active' });
    await setSecret('c', '3', { tenantId: 'anon:expired' });
    noteTenantActivity('anon:expired'); // seen at t0 …

    vi.setSystemTime(t0 + DAY_MS + 60_000); // … and 24 h + 1 min later it is stale
    noteTenantActivity('anon:active');
    noteTenantActivity('anon:also-active');

    const r = await fetch(`http://127.0.0.1:${port}/host/openwop-app/admin/cleanup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { wipedSecrets: number; activeTenants: number };
    expect(body.activeTenants).toBe(2);
    expect(body.wipedSecrets).toBe(1);

    // Active tenants keep their secrets.
    expect(await resolveSecret('a', { tenantId: 'anon:active' })).toBe('1');
    expect(await resolveSecret('b', { tenantId: 'anon:also-active' })).toBe('2');
    // Expired tenant's bucket is gone.
    expect(await resolveSecret('c', { tenantId: 'anon:expired' })).toBeNull();

    // …and the stale tenant was dropped from the tracker (3 noted → 2 tracked).
    const s = await fetch(`http://127.0.0.1:${port}/host/openwop-app/admin/cleanup/status`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(((await s.json()) as { trackedTenants: number }).trackedTenants).toBe(2);
  });

  it('GET status reports tracked tenant count without cleanup', async () => {
    await setSecret('a', '1', { tenantId: 'anon:t1' });
    // A tenant that was NEVER noted: a cleanup would wipe it, a status read must not.
    await setSecret('z', '9', { tenantId: 'anon:never-seen' });
    noteTenantActivity('anon:t1');
    const r = await fetch(`http://127.0.0.1:${port}/host/openwop-app/admin/cleanup/status`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { trackedTenants: number };
    expect(body.trackedTenants).toBe(1);
    // Secrets still there — status doesn't perform cleanup.
    expect(await resolveSecret('a', { tenantId: 'anon:t1' })).toBe('1');
    expect(await resolveSecret('z', { tenantId: 'anon:never-seen' })).toBe('9');
  });
});
