/**
 * CSM feature (ADR 0001 §6 Phase 6) — the second feature, proving the contract
 * is additive (wired by appending to BACKEND_FEATURES only) and works for a
 * plain on/off feature with no variants/packs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetCsmStore } from '../src/features/csm/accountsService.js';

describe('CSM feature (sqlite memory app)', () => {
  let server: http.Server;
  const PORT = 18891;
  const BASE = `http://127.0.0.1:${PORT}`;
  const TOKEN = 'sample-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __clearToggleStore();
    await __resetCsmStore();
    await new Promise<void>((res) => {
      server = app.listen(PORT, res);
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string> ?? {}) },
    });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  it('is registered as a backend feature (additive — appended to BACKEND_FEATURES)', () => {
    expect(BACKEND_FEATURES.some((f) => f.id === 'csm')).toBe(true);
  });

  it('404s while off, CRUD works once enabled', async () => {
    expect((await jf('/v1/host/sample/csm/accounts')).status).toBe(404);
    const on = await jf('/v1/host/sample/feature-toggles/admin/configs/csm', {
      method: 'PUT',
      body: JSON.stringify({ status: 'on', bucketUnit: 'tenant', salt: 'csm' }),
    });
    expect(on.status).toBe(200);

    const created = await jf<{ accountId: string; healthScore: number }>('/v1/host/sample/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme', healthScore: 42 }),
    });
    expect(created.status).toBe(201);
    expect(created.body.healthScore).toBe(42);

    const list = await jf<{ accounts: { accountId: string }[] }>('/v1/host/sample/csm/accounts');
    expect(list.body.accounts.some((a) => a.accountId === created.body.accountId)).toBe(true);
  });
});
