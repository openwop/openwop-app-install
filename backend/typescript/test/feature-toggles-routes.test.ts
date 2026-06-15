/**
 * Feature-toggle HTTP surface (host-extension, ADR 0001 §3).
 *
 * Proves the wiring end-to-end against a real app: the admin save endpoint
 * persists, the assignments endpoint resolves the saved config for the caller,
 * a saved A/B split yields a sticky variant, and the surface is auth-gated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { registerToggleDefault, __resetToggleDefaults } from '../src/host/featureToggles/registry.js';

describe('feature-toggle routes (sqlite memory app)', () => {
  let server: http.Server;
  const PORT = 18861;
  const BASE = `http://127.0.0.1:${PORT}`;
  const TOKEN = 'dev-token'; // wildcard bearer ⇒ superadmin

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    __resetToggleDefaults();
    registerToggleDefault({ id: 'demo.crm', status: 'off', bucketUnit: 'user', salt: 'crm', category: 'Business Tools', label: 'CRM' });
    const app = await createApp({
      port: PORT,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      server = app.listen(PORT, res);
    });
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}, auth = true): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string> ?? {}) };
    if (auth) headers.authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}${path}`, { ...init, headers });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  it('lists the declared default toggle before any override is saved', async () => {
    const { status, body } = await jsonFetch<{ configs: { id: string; status: string }[] }>('/v1/host/openwop-app/feature-toggles/admin/configs');
    expect(status).toBe(200);
    expect(body.configs.find((c) => c.id === 'demo.crm')?.status).toBe('off');
  });

  it('admin save → assignments reflects the override', async () => {
    const saved = await jsonFetch('/v1/host/openwop-app/feature-toggles/admin/configs/demo.crm', {
      method: 'PUT',
      body: JSON.stringify({ status: 'on', bucketUnit: 'user', salt: 'crm', label: 'CRM' }),
    });
    expect(saved.status).toBe(200);

    const { body } = await jsonFetch<{ assignments: { id: string; enabled: boolean; variant: string | null }[] }>(
      '/v1/host/openwop-app/feature-toggles/assignments',
    );
    const crm = body.assignments.find((a) => a.id === 'demo.crm');
    expect(crm?.enabled).toBe(true);
    expect(crm?.variant).toBeNull(); // no variants ⇒ plain on
  });

  it('a saved A/B split yields a sticky, enabled variant', async () => {
    await jsonFetch('/v1/host/openwop-app/feature-toggles/admin/configs/demo.crm', {
      method: 'PUT',
      body: JSON.stringify({
        status: 'on',
        bucketUnit: 'user',
        salt: 'crm',
        variants: [{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }],
      }),
    });
    const read = async () =>
      (await jsonFetch<{ id: string; variant: string | null; enabled: boolean }>('/v1/host/openwop-app/feature-toggles/assignments/demo.crm')).body;
    const first = await read();
    expect(first.enabled).toBe(true);
    expect(['A', 'B']).toContain(first.variant);
    expect((await read()).variant).toBe(first.variant); // sticky for the same caller
  });

  it('rejects a save whose variant weights do not sum to 100', async () => {
    const { status, body } = await jsonFetch<{ error?: string; message?: string }>(
      '/v1/host/openwop-app/feature-toggles/admin/configs/demo.crm',
      { method: 'PUT', body: JSON.stringify({ status: 'on', variants: [{ key: 'A', weight: 30 }, { key: 'B', weight: 30 }] }) },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('validation_error');
    expect(body.message ?? '').toMatch(/sum to exactly 100/);
  });

  it('the admin surface is auth-gated (no bearer ⇒ 401)', async () => {
    const { status } = await jsonFetch('/v1/host/openwop-app/feature-toggles/admin/configs', {}, false);
    expect(status).toBe(401);
  });
});
