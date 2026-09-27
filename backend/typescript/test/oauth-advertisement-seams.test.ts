/**
 * RFC 0199 advertisement + seams (ADR 0753 P5).
 *
 * The advert is honest only under three conditions (operator opt-in, an https
 * public base for connectUrl, no grantable built-in held out of §B); each is
 * falsified here. The seams must configure-then-call the PRODUCTION builder
 * (R9), so the URL they return is asserted to carry what the builder adds.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/webhookEgressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/webhookEgressGuard.js')>();
  return {
    ...actual,
    // The synthetic issuer's metadata: promises `iss` (RFC 9207).
    guardedEgressFetch: vi.fn(async (url: string) => String(url).startsWith('https://as.suite.example/.well-known/oauth-authorization-server')
      ? new Response(JSON.stringify({ issuer: 'https://as.suite.example', authorization_response_iss_parameter_supported: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('nope', { status: 404 })),
  };
});

import { createApp } from '../src/index.js';
import { __resetOAuthAdvertisement, oauthAdvertised, refreshOAuthAdvertisement } from '../src/features/connections/oauthAdvertisement.js';
import { getProvider } from '../src/features/connections/providerRegistry.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  for (const k of ['OPENWOP_OAUTH_ADVERTISE', 'OPENWOP_OAUTH_CALLBACK_BASE_URL', 'OPENWOP_OAUTH_GOOGLE_CLIENT_ID', 'OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET', 'OPENWOP_TEST_SEAM_ENABLED']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => {
  __resetOAuthAdvertisement();
  process.env.OPENWOP_OAUTH_ADVERTISE = 'true';
  process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = 'https://host.example';
  delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID;
  delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET;
});

async function v2Discovery(): Promise<Record<string, unknown>> {
  __resetOAuthAdvertisement();
  const r = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
  return (await r.json()) as Record<string, unknown>;
}

describe('ADR 0753 D11 — the oauth advert is honest or absent', () => {
  it('advertised: the v2 family carries credentialInterrupt and the suite\'s synthetic providers (seams mounted)', async () => {
    const d = await v2Discovery();
    const oauth = d.oauth as { credentialInterrupt?: unknown; grants?: string[]; providers?: { id: string }[]; witness?: string };
    expect(oauth).toBeDefined();
    expect(oauth.credentialInterrupt).toBe(true);
    expect(oauth.grants).toContain('authorization_code');
    expect(oauth.witness).toBe('witnessable-gated');
    expect(oauth.providers?.map((p) => p.id)).toEqual(expect.arrayContaining(['synthetic', 'synthetic-noiss', 'synthetic-noiss-b']));
  });

  it('absent without the operator opt-in', async () => {
    delete process.env.OPENWOP_OAUTH_ADVERTISE;
    expect(await oauthAdvertised()).toBe(false);
    expect((await v2Discovery()).oauth).toBeUndefined();
  });

  it('absent without an https public base (connectUrl could not be honoured)', async () => {
    process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = 'http://host.example';
    expect(await oauthAdvertised()).toBe(false);
  });

  it('absent while a built-in held out of §B (google) is GRANTABLE here — the claim would be false for it', async () => {
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID = 'cid';
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET = 'cs';
    expect(await oauthAdvertised()).toBe(false);
    expect((await v2Discovery()).oauth).toBeUndefined();
  });

  it('lists a real provider only when its OAuth client is configured', async () => {
    process.env.OPENWOP_OAUTH_SLACK_CLIENT_ID = 'cid';
    process.env.OPENWOP_OAUTH_SLACK_CLIENT_SECRET = 'cs';
    const snap = await refreshOAuthAdvertisement(Date.now() + 60_000);
    expect(snap.providers.some((p) => p.id === 'slack')).toBe(true);
    expect(snap.providers.some((p) => p.id === 'dropbox')).toBe(false);
    delete process.env.OPENWOP_OAUTH_SLACK_CLIENT_ID;
    delete process.env.OPENWOP_OAUTH_SLACK_CLIENT_SECRET;
  });
});

describe('ADR 0753 D12 — seams configure, the production builder builds (R9)', () => {
  const start = (body: Record<string, unknown>, headers: Record<string, string> = H): Promise<Response> =>
    fetch(`${BASE}/conformance/seams/sample/oauth/authorize-start`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('synthetic provider: 201 with the production URL (S256, state, fixed redirect URI — the probe ignored), and iss read from metadata', async () => {
    const r = await start({ provider: 'synthetic', authUrl: 'https://as.suite.example/authorize', tokenUrl: 'https://as.suite.example/token', issuer: 'https://as.suite.example', redirectUri: 'https://evil.example/cb' });
    expect(r.status, await r.clone().text()).toBe(201);
    const url = new URL(((await r.json()) as { authorizationUrl: string }).authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://as.suite.example/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')?.length).toBeGreaterThanOrEqual(22);
    expect(url.searchParams.get('redirect_uri')).toBe('https://host.example/v1/host/openwop-app/connections/synthetic/callback');
    expect(getProvider('synthetic')?.issResponseParameter).toBe(true);
  });

  it('issuer-less synthetic providers get DISTINCT redirect URIs (RFC 9700 §4.4.2.2)', async () => {
    const a = new URL(((await (await start({ provider: 'synthetic-noiss', authUrl: 'https://as.suite.example/authorize', tokenUrl: 'https://as.suite.example/token' })).json()) as { authorizationUrl: string }).authorizationUrl);
    const b = new URL(((await (await start({ provider: 'synthetic-noiss-b', authUrl: 'https://as.suite.example/authorize', tokenUrl: 'https://as.suite.example/token' })).json()) as { authorizationUrl: string }).authorizationUrl);
    expect(a.searchParams.get('redirect_uri')).not.toBe(b.searchParams.get('redirect_uri'));
  });

  it('refuses to re-point a real provider (only synthetic ids, or a connection pack)', async () => {
    expect((await start({ provider: 'google', authUrl: 'https://evil.example/a', tokenUrl: 'https://evil.example/t' })).status).toBe(400);
    expect(getProvider('google')?.endpoints?.authorize).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('refuses an anonymous caller', async () => {
    const r = await start({ provider: 'synthetic', authUrl: 'https://as.suite.example/authorize', tokenUrl: 'https://as.suite.example/token' }, { 'content-type': 'application/json' });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect(r.status).toBeLessThan(404);
  });

  it('expire-refresh: 404 when the caller holds no credential for the provider', async () => {
    const r = await fetch(`${BASE}/conformance/seams/sample/oauth/expire-refresh`, { method: 'POST', headers: H, body: JSON.stringify({ provider: 'synthetic' }) });
    expect(r.status).toBe(404);
  });
});

describe('ADR 0753 D6 — OPENWOP_OAUTH_DISABLED_PROVIDERS makes a held provider ungrantable (and the advert honest)', () => {
  it('a configured-but-disabled google no longer blocks the oauth advert, and cannot start a grant', async () => {
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID = 'cid';
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET = 'cs';
    expect(await oauthAdvertised()).toBe(false);
    process.env.OPENWOP_OAUTH_DISABLED_PROVIDERS = 'google';
    try {
      expect(await oauthAdvertised()).toBe(true);
      const { isOAuthConfigured } = await import('../src/features/connections/oauthFlow.js');
      expect(await isOAuthConfigured('google')).toBe(false);
      const r = await fetch(`${BASE}/v1/host/openwop-app/connections/google/authorize`, { method: 'POST', headers: H, body: '{}' });
      expect(r.status).toBe(409);
    } finally {
      delete process.env.OPENWOP_OAUTH_DISABLED_PROVIDERS;
    }
  });
});
