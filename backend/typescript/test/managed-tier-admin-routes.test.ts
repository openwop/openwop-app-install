/**
 * ADR 0990 D3 — the free-tier provider setting routes. Route-level because the
 * superadmin gate, the no-key refusal and the round-trip into the core resolver
 * are only observable through the HTTP boundary.
 *
 * Covers: a non-superadmin is refused on every verb; a provider with no key is
 * refused 409 (so a save can never switch the free tier off by accident); a
 * valid save serves at once (`effective.source: 'setting'`) and DELETE returns
 * to the env default; no response carries a key.
 *
 * Sabotage-witnessed: with the key check removed from `saveConfig`, the 409 case
 * goes red (the save lands and the free tier reports not ready). Re-witnessed in
 * grade-tests wave 78, plus: `requireSuperadmin` dropped from each verb reds the
 * non-superadmin case; the provider, model and cap checks each red the 422 case (each
 * body is refused by its OWN field); the test-message cooldown dropped reds the last case.
 *
 * The non-superadmin case uses a SIGNED-IN, non-superadmin user (a test/login cookie),
 * as well as an anonymous caller: an authz claim needs an authenticated caller who
 * lacks the right, and the refusal is read by its message, not only its status.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';

interface View {
  config: { provider: string; model: string; dailyTokenCap: number | null } | null;
  effective: { provider: string | null; model: string | null; source: string | null; ready: boolean };
  providers: Array<{ provider: string; ready: boolean; keySource: string | null; vaultRef: string }>;
  vaultUsable: boolean;
}

describe('managed-tier settings routes (ADR 0990)', () => {
  let server: http.Server;
  let BASE: string;
  const PATH = '/host/openwop-app/managed-tier/settings';
  const admin = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['MINIMAX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENWOP_MANAGED_PROVIDER', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SESSION_SECRET']) saved[k] = process.env[k];
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.MINIMAX_API_KEY = 'sk-minimax-route-test';
    process.env.OPENAI_API_KEY = 'sk-openai-route-test';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENWOP_MANAGED_PROVIDER;
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('refuses a non-superadmin on every verb', async () => {
    const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `mtr-member-${Date.now()}@acme.test` }),
    });
    expect(login.status, await login.clone().text()).toBe(201);
    const cookie = getSetCookies(login.headers).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean);
    expect(cookie, 'a session cookie').toBeTruthy();
    const body = JSON.stringify({ provider: 'openai', model: 'gpt-5.6-terra' });
    for (const auth of [null, cookie!]) {
      const json: Record<string, string> = { 'content-type': 'application/json', ...(auth ? { cookie: auth } : {}) };
      for (const [method, path] of [['GET', PATH], ['PUT', PATH], ['DELETE', PATH], ['POST', `${PATH}/test`]] as const) {
        const res = await fetch(`${BASE}${path}`, { method, headers: json, ...(method === 'PUT' || method === 'POST' ? { body } : {}) });
        const label = `${method} ${auth ? 'signed-in member' : 'anonymous'}`;
        expect(res.status, label).toBe(403);
        expect(((await res.json()) as { message?: string }).message, label).toContain('requires a superadmin principal');
      }
    }
    // Nothing the refused calls sent took effect.
    const view = (await (await fetch(`${BASE}${PATH}`, { headers: admin })).json()) as View;
    expect(view.config).toBeNull();
  });

  it('GET reports the env default and which providers have a key, never a key', async () => {
    const res = await fetch(`${BASE}${PATH}`, { headers: admin });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('route-test');
    const view = JSON.parse(text) as View;
    expect(view.config).toBeNull();
    expect(view.effective).toMatchObject({ provider: 'minimax', source: 'default' });
    const ready = Object.fromEntries(view.providers.map((p) => [p.provider, p.keySource]));
    expect(ready).toEqual({ minimax: 'env', anthropic: null, openai: 'env', google: null });
  });

  it('refuses a provider with no key (409) and leaves the free tier where it was', async () => {
    const res = await fetch(`${BASE}${PATH}`, { method: 'PUT', headers: admin, body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5-5' }) });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('free-tier:anthropic');
    const view = (await (await fetch(`${BASE}${PATH}`, { headers: admin })).json()) as View;
    expect(view.config).toBeNull();
    expect(view.effective.provider).toBe('minimax');
  });

  it('refuses an unsupported provider or a malformed model (422)', async () => {
    for (const [body, field] of [
      [{ provider: 'mistral', model: 'm' }, 'provider'],
      [{ provider: 'openai', model: 'has spaces' }, 'model'],
      [{ provider: 'openai', model: 'gpt-5.6-terra', dailyTokenCap: -1 }, 'dailyTokenCap'],
    ] as const) {
      const res = await fetch(`${BASE}${PATH}`, { method: 'PUT', headers: admin, body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await res.json(), JSON.stringify(body)).toMatchObject({ error: 'validation_error', details: { field } });
    }
  });

  it('a valid save serves at once; DELETE returns to the env default', async () => {
    const put = await fetch(`${BASE}${PATH}`, { method: 'PUT', headers: admin, body: JSON.stringify({ provider: 'openai', model: 'gpt-5.6-luna', dailyTokenCap: 50000 }) });
    expect(put.status).toBe(200);
    const view = (await put.json()) as View;
    expect(view.config).toMatchObject({ provider: 'openai', model: 'gpt-5.6-luna', dailyTokenCap: 50000 });
    expect(view.effective).toEqual({ provider: 'openai', model: 'gpt-5.6-luna', source: 'setting', ready: true });

    const del = await fetch(`${BASE}${PATH}`, { method: 'DELETE', headers: admin });
    expect(del.status).toBe(200);
    expect(((await del.json()) as View).effective).toMatchObject({ provider: 'minimax', source: 'default', ready: true });
  });

  it('a test message for a provider with no key reports it, and a second one inside the cooldown is 429', async () => {
    const body = JSON.stringify({ provider: 'google', model: 'gemini-3.8-flash' });
    const first = await fetch(`${BASE}${PATH}/test`, { method: 'POST', headers: admin, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: false, code: 'managed_key_missing' });
    const second = await fetch(`${BASE}${PATH}/test`, { method: 'POST', headers: admin, body });
    expect(second.status).toBe(429);
  });
});
