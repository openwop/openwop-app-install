/**
 * RFC 0121 — subscription-scope SAFETY RAIL (acquisition-free host portion).
 *
 * Boots the real app via createApp and exercises:
 *   1. §B.8 bind-seam witness — POST /v1/host/sample/credentials/bind (and the
 *      app-canonical /v1/host/openwop-app/credentials/bind alias). A subscription
 *      binding at tenant/workspace scope MUST be rejected with the canonical
 *      `credential_scope_forbidden` code; only `user` scope is accepted (a stub —
 *      no credential resolved, nothing stored). The route MUST be wired (not 404).
 *   2. Discovery honest-off — aiProviders.authModes advertises `apiKey` for every
 *      byok provider and NO provider carries `subscription` by default (the
 *      advertisement stays DARK until a lawful acquisition mechanism is configured;
 *      deferred on RFC 0121 UQ1 / ToS-legal).
 *
 * The live `subscription` advertisement + any credential ACQUISITION mechanism are
 * deliberately NOT built here — this witnesses the acquisition-free rail only.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

const APP_PATH = '/v1/host/openwop-app/credentials/bind';
const SAMPLE_PATH = '/v1/host/sample/credentials/bind';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

/** Tolerant of `{error}` / `{code}` / `{error:{code}}` — mirrors the conformance driver. */
function errCode(json: unknown): string | undefined {
  const j = json as { error?: unknown; code?: unknown };
  if (typeof j?.code === 'string') return j.code;
  if (typeof j?.error === 'string') return j.error;
  const e = j?.error as { code?: unknown } | undefined;
  if (e && typeof e.code === 'string') return e.code;
  return undefined;
}

describe('RFC 0121 §B.8 — subscription-scope bind-seam witness', () => {
  it('is wired (NOT 404) under both the sample + app-canonical prefixes', async () => {
    for (const path of [SAMPLE_PATH, APP_PATH]) {
      const res = await post(path, { provider: 'anthropic', mode: 'subscription', scope: 'user' });
      expect(res.status).not.toBe(404);
    }
  });

  it('rejects a tenant-scope subscription binding with credential_scope_forbidden (403)', async () => {
    const res = await post(SAMPLE_PATH, { provider: 'anthropic', mode: 'subscription', scope: 'tenant' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBe(403);
    expect(errCode(await res.json())).toBe('credential_scope_forbidden');
  });

  it('rejects a workspace-scope subscription binding with credential_scope_forbidden', async () => {
    const res = await post(SAMPLE_PATH, { provider: 'anthropic', mode: 'subscription', scope: 'workspace' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(errCode(await res.json())).toBe('credential_scope_forbidden');
  });

  it('accepts a user-scope subscription binding (stub) → 200 { bound: true }', async () => {
    const res = await post(SAMPLE_PATH, { provider: 'anthropic', mode: 'subscription', scope: 'user' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bound: true, scope: 'user' });
  });

  it('validation_error when required fields are missing', async () => {
    const missingProvider = await post(SAMPLE_PATH, { mode: 'subscription', scope: 'user' });
    expect(missingProvider.status).toBe(400);
    expect(errCode(await missingProvider.json())).toBe('validation_error');

    const missingScope = await post(SAMPLE_PATH, { provider: 'anthropic', mode: 'subscription' });
    expect(missingScope.status).toBe(400);
    expect(errCode(await missingScope.json())).toBe('validation_error');
  });

  it('validation_error for a non-subscription mode (seam is subscription-scope-only for now)', async () => {
    const res = await post(SAMPLE_PATH, { provider: 'anthropic', mode: 'apiKey', scope: 'user' });
    expect(res.status).toBe(400);
    expect(errCode(await res.json())).toBe('validation_error');
  });
});

describe('RFC 0121 — discovery aiProviders.authModes stays honest-off', () => {
  it('advertises apiKey for every byok provider and NO subscription by default', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      aiProviders?: { byok?: string[]; authModes?: Record<string, string[]> };
    };
    const authModes = doc.aiProviders?.authModes ?? {};
    const byok = doc.aiProviders?.byok ?? [];
    // Every byok provider has a real apiKey mode.
    for (const p of byok) expect(authModes[p]).toContain('apiKey');
    // Honest-off: NO provider carries `subscription` in any default deployment.
    for (const modes of Object.values(authModes)) expect(modes).not.toContain('subscription');
  });
});
