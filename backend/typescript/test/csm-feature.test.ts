/**
 * CSM feature (ADR 0001 §6 Phase 6) — the second feature, proving the contract
 * is additive (wired by appending to BACKEND_FEATURES only) and works for a
 * plain on/off feature with no variants/packs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetCsmStore,
  createAccount,
  getAccountForTenant,
  setAccountHealthForTenant,
} from '../src/features/csm/accountsService.js';
import { buildCsmSurface } from '../src/features/csm/surface.js';

describe('CSM feature (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __clearToggleStore();
    await __resetCsmStore();
    await new Promise<void>((res) => {
      server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
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
    expect((await jf('/v1/host/openwop-app/csm/accounts')).status).toBe(404);
    const on = await jf('/v1/host/openwop-app/feature-toggles/admin/configs/csm', {
      method: 'PUT',
      body: JSON.stringify({ status: 'on', bucketUnit: 'tenant', salt: 'csm' }),
    });
    expect(on.status).toBe(200);

    const created = await jf<{ accountId: string; healthScore: number }>('/v1/host/openwop-app/csm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme', healthScore: 42 }),
    });
    expect(created.status).toBe(201);
    expect(created.body.healthScore).toBe(42);

    const list = await jf<{ accounts: { accountId: string }[] }>('/v1/host/openwop-app/csm/accounts');
    expect(list.body.accounts.some((a) => a.accountId === created.body.accountId)).toBe(true);
  });

  it('advertises the ctx.features.csm surface at /.well-known/openwop (ADR 0014)', async () => {
    const disco = await jf<{ hostExtensions?: { featureSurfaces?: string[] } }>('/.well-known/openwop');
    expect(disco.status).toBe(200);
    // The surface is registered at boot (csmFeature.surface), so it's advertised
    // regardless of toggle state; per-tenant gating is enforced at use, not here.
    expect(disco.body.hostExtensions?.featureSurfaces).toContain('host.sample.csm');
  });
});

describe('CSM extension surface (ADR 0014 — ctx.features.csm + nodes)', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await __resetCsmStore();
  });

  it('getAccountForTenant is tenant-guarded (cross-tenant id → null)', async () => {
    const a = await createAccount({ tenantId: 't1', name: 'Acme', healthScore: 30 });
    expect((await getAccountForTenant('t1', a.accountId))?.accountId).toBe(a.accountId);
    expect(await getAccountForTenant('t2', a.accountId)).toBeNull(); // CTI-1: no cross-tenant probe
  });

  it('setAccountHealthForTenant is tenant-guarded + idempotent (replay-safe)', async () => {
    const a = await createAccount({ tenantId: 't1', name: 'Beta', healthScore: 80 });
    expect(await setAccountHealthForTenant('t2', a.accountId, { healthScore: 10 })).toBeNull();
    const r1 = await setAccountHealthForTenant('t1', a.accountId, { healthScore: 12 });
    const r2 = await setAccountHealthForTenant('t1', a.accountId, { healthScore: 12 });
    expect(r1?.healthScore).toBe(12);
    expect(r2?.healthScore).toBe(12); // same inputs → same result (fork/replay never duplicates)
  });

  it('buildCsmSurface projects internal fields + tenant-isolates', async () => {
    await __resetCsmStore();
    const a = await createAccount({ tenantId: 't1', name: 'Gamma', healthScore: 5 });
    await createAccount({ tenantId: 't2', name: 'Other', healthScore: 5 });
    const surf = buildCsmSurface({ tenantId: 't1' });
    const { accounts } = (await surf.listAccounts({})) as { accounts: Record<string, unknown>[] };
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountId).toBe(a.accountId);
    expect(accounts[0].tenantId).toBeUndefined(); // internal column projected out
    const got = (await surf.getAccount({ accountId: a.accountId })) as { account: Record<string, unknown> | null };
    expect(got.account?.name).toBe('Gamma');
  });

  it('feature.csm.nodes read/set run over a stub ctx.features.csm', async () => {
    await __resetCsmStore();
    const mod = await import('../../../packs/feature.csm.nodes/index.mjs');
    const a = await createAccount({ tenantId: 't1', name: 'Delta', healthScore: 90 });
    const surf = buildCsmSurface({ tenantId: 't1' });
    const ctx = (inputs: Record<string, unknown>) => ({ features: { csm: surf }, inputs });
    const read = await mod.nodes['feature.csm.nodes.health-read'](ctx({}));
    expect(read.status).toBe('success');
    const set = await mod.nodes['feature.csm.nodes.health-set'](ctx({ accountId: a.accountId, healthScore: 20 }));
    expect(set.status).toBe('success');
    expect((await getAccountForTenant('t1', a.accountId))?.healthScore).toBe(20);
  });
});
