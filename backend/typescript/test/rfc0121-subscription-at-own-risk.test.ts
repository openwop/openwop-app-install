/**
 * RFC 0121 AT-OWN-RISK un-park (ADR 0180) — extends the ADR 0179 scope-safety rail.
 *
 * Boots the real app and exercises:
 *   1. Discovery lights up `subscription` for a CONFIGURED provider ONLY when BOTH
 *      gates are on (OPENWOP_SUBSCRIPTION_AT_OWN_RISK=true AND the provider is in
 *      OPENWOP_SUBSCRIPTION_PROVIDERS), and §B.7 force-includes it in byok. With
 *      the at-own-risk flag OFF (public-demo default) it stays DARK.
 *   2. The bind seam: a user-scope bind WITH a credential value but WITHOUT
 *      acknowledgedRisk is rejected (validation_error); WITH consent the value is
 *      stored at user scope and NOT echoed; tenant/workspace stay
 *      credential_scope_forbidden regardless of consent (§B.8 unconditional).
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { resolveSecret, clearAllSecrets } from '../src/byok/secretResolver.js';
import { getSetCookies } from './headerCookies.js';
import { configureKmsClient, createLocalAesKmsClient } from '../src/byok/kmsEncryption.js';
import { randomBytes } from 'node:crypto';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // Cookies DISABLED by default so the bearer `dev-token` cases (incl. no-auth →
  // 401) behave exactly as before. The happy-path STORE test toggles cookies on
  // for itself and logs in as a real durable user, because §B.8 (PACK-1) stores
  // a personal subscription at the caller's OWN `user:` tenant — which the admin
  // `dev-token` (personalTenant='default') cannot be. (`OPENWOP_AUTH_DISABLE_COOKIES`
  // is read live per-request, so the per-test toggle is honored.)
  // Public-demo cookie-per-visitor posture (the real prod default): needed so
  // /test/login mints a real durable-user session — a personal subscription is
  // stored at the caller's OWN `user:` tenant (§B.8 / PACK-1), which the admin
  // `dev-token` (personalTenant='default') cannot be. Bearer `dev-token` still
  // works for the other cases (bearer wins when present). The middleware is
  // boot-wired from the posture, so it must be set BEFORE createApp.
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_DEPLOY_POSTURE = 'cookie-per-visitor';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  // Local AES KMS so a signed-in (durable-user) secret store can encrypt at rest.
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});
afterEach(async () => {
  delete process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK;
  delete process.env.OPENWOP_SUBSCRIPTION_PROVIDERS;
  await clearAllSecrets();
});

const BIND = '/v1/host/openwop-app/credentials/bind';
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

function errCode(json: unknown): string | undefined {
  const j = json as { error?: unknown; code?: unknown };
  if (typeof j?.code === 'string') return j.code;
  if (typeof j?.error === 'string') return j.error;
  const e = j?.error as { code?: unknown } | undefined;
  if (e && typeof e.code === 'string') return e.code;
  return undefined;
}

async function authModes(): Promise<{ byok: string[]; authModes: Record<string, string[]> }> {
  const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
    aiProviders?: { byok?: string[]; authModes?: Record<string, string[]> };
  };
  return { byok: doc.aiProviders?.byok ?? [], authModes: doc.aiProviders?.authModes ?? {} };
}

describe('RFC 0121 AT-OWN-RISK — discovery advertisement (two-gate)', () => {
  it('stays DARK by default (both gates off) — the public-demo posture', async () => {
    const { authModes: modes } = await authModes();
    for (const m of Object.values(modes)) expect(m).not.toContain('subscription');
  });

  it('stays DARK when only OPENWOP_SUBSCRIPTION_PROVIDERS is set (no at-own-risk acceptance)', async () => {
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'openai';
    const { authModes: modes } = await authModes();
    for (const m of Object.values(modes)) expect(m).not.toContain('subscription');
  });

  it('stays DARK when only the at-own-risk flag is set (no provider list)', async () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    const { authModes: modes } = await authModes();
    for (const m of Object.values(modes)) expect(m).not.toContain('subscription');
  });

  it('advertises subscription for a configured provider when BOTH gates are on, and §B.7 force-includes it in byok', async () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'openai';
    const { byok, authModes: modes } = await authModes();
    expect(modes.openai).toContain('subscription');
    expect(modes.openai).toContain('apiKey');
    expect(byok).toContain('openai'); // §B.7 force-include
    // Non-configured providers stay apiKey-only.
    expect(modes.anthropic).toEqual(['apiKey']);
  });
});

describe('RFC 0121 AT-OWN-RISK — bind seam consent gate (ADR 0180)', () => {
  it('user-scope bind WITH a value but WITHOUT acknowledgedRisk → validation_error (rejected)', async () => {
    const res = await post(BIND, { provider: 'openai', mode: 'subscription', scope: 'user', value: 'sk-personal-secret' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(errCode(json)).toBe('validation_error');
    // The message names the ToS / account-suspension risk.
    expect(JSON.stringify(json)).toMatch(/terms of service|account suspension/i);
    // Nothing stored.
    expect(await resolveSecret('subscription:openai', { tenantId: 'default' })).toBeNull();
  });

  it('user-scope bind WITH consent → stored at the caller\'s OWN user tenant, secret NOT echoed', async () => {
    // §B.8 storage rail (PACK-1): the personal subscription is written at the
    // caller's OWN `user:`-scoped tenant, NEVER the shared active tenant. Run as a
    // real durable user (the `dev-token` admin principal is intentionally rejected —
    // covered by the 401/scope-rail cases). Explicit `user:` tenant so we can assert
    // exactly where it landed.
    const OWNER = 'user:rfc0121-owner';
    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rfc0121-owner@x.test', tenantId: OWNER }),
    });
    expect(login.status).toBe(201);
    let cookie = '';
    for (const ck of getSetCookies(login.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    expect(cookie).not.toBe('');

    const secret = 'sk-personal-secret-xyz';
    const res = await fetch(`${BASE}${BIND}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'openai', mode: 'subscription', scope: 'user', acknowledgedRisk: true, value: secret }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { bound: boolean; scope: string; credentialRef: string };
    expect(json).toMatchObject({ bound: true, scope: 'user', credentialRef: 'subscription:openai' });
    // NEVER echo the secret material.
    expect(JSON.stringify(json)).not.toContain(secret);
    // Stored at the caller's OWN user tenant — resolvable there, and NOT at the
    // shared `default` tenant (the cross-user-sharing §B.8 forbids).
    expect(await resolveSecret('subscription:openai', { tenantId: OWNER })).toBe(secret);
    expect(await resolveSecret('subscription:openai', { tenantId: 'default' })).toBeNull();
  });

  it('tenant scope stays credential_scope_forbidden EVEN WITH consent (§B.8 unconditional)', async () => {
    const res = await post(BIND, { provider: 'openai', mode: 'subscription', scope: 'tenant', acknowledgedRisk: true, value: 'sk-secret' });
    expect(res.status).toBe(403);
    expect(errCode(await res.json())).toBe('credential_scope_forbidden');
    expect(await resolveSecret('subscription:openai', { tenantId: 'default' })).toBeNull();
  });

  it('workspace scope stays credential_scope_forbidden even with consent', async () => {
    const res = await post(BIND, { provider: 'openai', mode: 'subscription', scope: 'workspace', acknowledgedRisk: true, value: 'sk-secret' });
    expect(res.status).toBe(403);
    expect(errCode(await res.json())).toBe('credential_scope_forbidden');
  });

  it('user-scope bind with NO value stays the acquisition-free scope-rail probe → 200', async () => {
    const res = await post(BIND, { provider: 'openai', mode: 'subscription', scope: 'user' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bound: true, scope: 'user' });
  });

  // UNPARK-1 — fail-closed end-to-end: a NON-owning caller's credential-STORING
  // bind must be rejected and write NOTHING. Under the public-demo
  // cookie-per-visitor posture (booted above) a no-session request is an ANON
  // visitor — it carries a `session:`-scoped principal, not a durable `user:` one
  // — so the §B.8 storage rail (`assertSubscriptionStorageTenant`) rejects it with
  // `credential_scope_forbidden`/403 rather than the no-principal 401 (which fires
  // only under a bearer-enforced posture with no anon sessions). Either way the
  // observable security contract is identical: a non-`user:` principal → NO store.
  it('anon visitor (no durable user session) → credential_scope_forbidden, nothing stored', async () => {
    const secret = 'sk-anon-should-not-store';
    const res = await fetch(`${BASE}${BIND}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // NO authorization header → anon visitor
      body: JSON.stringify({ provider: 'openai', mode: 'subscription', scope: 'user', acknowledgedRisk: true, value: secret }),
    });
    expect(res.status).toBe(403);
    expect(errCode(await res.json())).toBe('credential_scope_forbidden');
    // Fail-closed: the rejected anon bind wrote nothing to the shared/anon scope.
    expect(await resolveSecret('subscription:openai', { tenantId: 'default' })).toBeNull();
  });
});

describe('ADR 0756 — anthropic + google are prohibited on the at-own-risk path', () => {
  it('discovery never advertises subscription for anthropic or google, even with BOTH gates on', async () => {
    process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK = 'true';
    process.env.OPENWOP_SUBSCRIPTION_PROVIDERS = 'anthropic,google,openai';
    const { authModes: modes } = await authModes();
    expect(modes.anthropic ?? []).not.toContain('subscription');
    expect(modes.google ?? []).not.toContain('subscription');
    expect(modes.openai).toContain('subscription'); // the permitted one still lights
  });

  it('a value-bearing bind for anthropic is refused credential_forbidden EVEN WITH consent, and stores nothing', async () => {
    const OWNER = 'user:rfc0121-prohibited';
    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rfc0121-prohibited@x.test', tenantId: OWNER }),
    });
    expect(login.status).toBe(201);
    let cookie = '';
    for (const ck of getSetCookies(login.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    for (const provider of ['anthropic', 'google']) {
      const res = await fetch(`${BASE}${BIND}`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ provider, mode: 'subscription', scope: 'user', acknowledgedRisk: true, value: 'sk-personal' }),
      });
      expect(res.status).toBe(403);
      expect(errCode(await res.json())).toBe('credential_forbidden');
      expect(await resolveSecret(`subscription:${provider}`, { tenantId: OWNER })).toBeNull();
    }
  });

  it('the empty-value §B.8 scope probe stays provider-agnostic (stores nothing) — anthropic still 200 / tenant still 403', async () => {
    const ok = await post(BIND, { provider: 'anthropic', mode: 'subscription', scope: 'user' });
    expect(ok.status).toBe(200);
    const forbidden = await post(BIND, { provider: 'anthropic', mode: 'subscription', scope: 'tenant' });
    expect(forbidden.status).toBe(403);
    expect(errCode(await forbidden.json())).toBe('credential_scope_forbidden');
  });
});

describe('ADR 0757 — GitHub Copilot (the cleared provider) on the booted host', () => {
  const configure = (): void => {
    process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID = 'Iv1.testclient';
    process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET = 'test-secret';
    process.env.OPENWOP_COPILOT_ENDPOINT = 'http://127.0.0.1:8791/v1';
  };
  const unconfigure = (): void => {
    for (const k of ['OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID', 'OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET', 'OPENWOP_COPILOT_ENDPOINT']) delete process.env[k];
  };

  it('is dark by default', async () => {
    const { byok, authModes: modes } = await authModes();
    expect(byok).not.toContain('github.copilot');
    expect(modes['github.copilot']).toBeUndefined();
  });

  it('when configured: in supported, in byok (§B.7), authModes subscription-ONLY, every authModes key ⊆ supported', async () => {
    configure();
    try {
      const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
        aiProviders?: { supported?: string[]; byok?: string[]; authModes?: Record<string, string[]> };
      };
      const ai = doc.aiProviders ?? {};
      expect(ai.supported).toContain('github.copilot');
      expect(ai.byok).toContain('github.copilot');
      expect(ai.authModes?.['github.copilot']).toEqual(['subscription']);
      for (const k of Object.keys(ai.authModes ?? {})) expect(ai.supported).toContain(k);
      for (const k of ai.byok ?? []) expect(ai.supported).toContain(k);
    } finally {
      unconfigure();
    }
  });

  it('a pasted token for github.copilot is refused (connect flow only); the empty §B.8 probe still answers', async () => {
    configure();
    try {
      const pasted = await post(BIND, { provider: 'github.copilot', mode: 'subscription', scope: 'user', acknowledgedRisk: true, value: 'ghp_broadscope' });
      expect(pasted.status).toBe(400);
      expect(errCode(await pasted.json())).toBe('validation_error');
      const probe = await post(BIND, { provider: 'github.copilot', mode: 'subscription', scope: 'user' });
      expect(probe.status).toBe(200);
    } finally {
      unconfigure();
    }
  });

  it('the CANONICAL callback path (the registered redirect URI) reaches the route: a bad state redirects with copilot=error', async () => {
    configure();
    try {
      const res = await fetch(`${BASE}/host/openwop-app/subscription/github.copilot/callback?state=nope&code=x`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location') ?? '', BASE);
      expect(loc.searchParams.get('copilot')).toBe('error');
      expect(loc.searchParams.get('reason')).toBe('invalid_state');
    } finally {
      unconfigure();
    }
  });

  it('authorize: 404 when not configured; a caller without a personal user: tenant is refused', async () => {
    const url = `${BASE}/v1/host/openwop-app/subscription/github.copilot/authorize`;
    const dark = await fetch(url, { method: 'POST', headers: H, body: '{}' });
    expect(dark.status).toBe(404);
    configure();
    try {
      // The admin `dev-token` principal's personal tenant is `default`, not `user:` (§B.8 storage rail).
      const res = await fetch(url, { method: 'POST', headers: H, body: '{}' });
      expect(res.status).toBe(403);
      expect(errCode(await res.json())).toBe('credential_scope_forbidden');
    } finally {
      unconfigure();
    }
  });
});
