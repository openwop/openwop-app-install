/**
 * Connections broker (ADR 0024 Phase A) — provider registry + api_key/bearer
 * create path + the most-specific credential resolver (user → org → workspace).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetConnectionsStore,
  createSecretConnection,
  resolveConnectionCredential,
  upsertOAuthConnection,
  probeConnection,
} from '../src/features/connections/connectionsService.js';
import {
  __resetPendingAuth,
  beginAuthorization,
  consumePendingAuth,
  sweepExpiredPendingAuth,
} from '../src/features/connections/oauthFlow.js';
import {
  __resetInboundStore,
  setInboundConfig,
  removeInboundConfig,
  getInboundConfig,
  handleInboundEvent,
  verifySlackSignature,
} from '../src/features/connections/inboundWebhooks.js';
import { __resetTriggerBridgeStore } from '../src/host/triggerBridgeService.js';
import { createOrg, createMember, __resetAccessStores } from '../src/host/accessControlService.js';
import { createHmac } from 'node:crypto';

describe('Connections feature (sqlite memory app)', () => {
  let server: http.Server;
  const PORT = 18941;
  const BASE = `http://127.0.0.1:${PORT}`;
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __clearToggleStore();
    await __resetConnectionsStore();
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
    });
    const raw = res.status === 204 ? undefined : await res.json();
    return { status: res.status, body: raw as T };
  }

  it('is registered as a backend feature (additive)', () => {
    expect(BACKEND_FEATURES.some((f) => f.id === 'connections')).toBe(true);
  });

  it('serves unconditionally (no feature toggle — ADR 0024 § Correction); provider registry + api_key create work', async () => {
    // Connections graduated off its toggle (2026-06-11): the surface is always-on,
    // so an empty connection list is 200 (not the old 404-while-off), with no
    // admin-config enable step needed.
    expect((await jf('/v1/host/openwop-app/connections')).status).toBe(200);

    const providers = await jf<{ providers: { id: string; reach: string }[] }>('/v1/host/openwop-app/providers');
    expect(providers.body.providers.find((p) => p.id === 'google')?.reach).toBe('mcp');
    expect(providers.body.providers.find((p) => p.id === 'servicenow')?.reach).toBe('openapi');

    const created = await jf<{ connectionId: string; provider: string }>('/v1/host/openwop-app/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'servicenow', kind: 'api_key', secret: 'sn-secret-xyz', scope: 'user', displayName: 'My ServiceNow' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.provider).toBe('servicenow');
    // secret never echoed
    expect(JSON.stringify(created.body)).not.toContain('sn-secret-xyz');
  });

  it('rejects oauth2 secret-post and org-scope create (fail-closed, D2)', async () => {
    const oauthPost = await jf('/v1/host/openwop-app/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'google', kind: 'oauth2', secret: 'x', scope: 'user' }),
    });
    expect(oauthPost.status).toBe(400);
    const orgPost = await jf('/v1/host/openwop-app/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'servicenow', kind: 'api_key', secret: 'x', scope: 'org', orgId: 'o1' }),
    });
    expect(orgPost.status).toBe(403);
  });

  it('authorize is 409 when OAuth is unconfigured; oauthConfigured reflects host env (Phase B)', async () => {
    delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID;
    delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET;
    const before = await jf<{ providers: { id: string; oauthConfigured?: boolean }[] }>('/v1/host/openwop-app/providers');
    expect(before.body.providers.find((p) => p.id === 'google')?.oauthConfigured).toBe(false);
    const unconfigured = await jf('/v1/host/openwop-app/connections/google/authorize', { method: 'POST', body: '{}' });
    expect(unconfigured.status).toBe(409);
  });

  it('authorize mints a PKCE consent URL once OAuth client creds are present (Phase B)', async () => {
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET = 'test-client-secret';
    const providers = await jf<{ providers: { id: string; oauthConfigured?: boolean }[] }>('/v1/host/openwop-app/providers');
    expect(providers.body.providers.find((p) => p.id === 'google')?.oauthConfigured).toBe(true);

    const authz = await jf<{ authorizeUrl: string }>('/v1/host/openwop-app/connections/google/authorize', { method: 'POST', body: '{}' });
    expect(authz.status).toBe(200);
    const url = new URL(authz.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    // Google needs offline access to actually return a refresh token.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toContain('/v1/host/openwop-app/connections/google/callback');
  });

  it('callback with a bad state bounces the browser back with connectError (never a JSON 4xx)', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/connections/google/callback?state=nope&code=abc`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      redirect: 'manual',
    });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get('location')).toContain('connectError=google');
    expect(res.headers.get('location')).toContain('reason=invalid_state');
  });

  it('authorize with write:true requests the provider write scopes (Phase C re-consent)', async () => {
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID = 'cid';
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET = 'csecret';
    // The provider list advertises the offerable write scopes.
    const providers = await jf<{ providers: { id: string; writeScopes?: string[] }[] }>('/v1/host/openwop-app/providers');
    const googleWrite = providers.body.providers.find((p) => p.id === 'google')?.writeScopes ?? [];
    expect(googleWrite).toContain('https://www.googleapis.com/auth/gmail.send');

    const authz = await jf<{ authorizeUrl: string }>('/v1/host/openwop-app/connections/google/authorize', {
      method: 'POST',
      body: JSON.stringify({ write: true }),
    });
    const scope = new URL(authz.body.authorizeUrl).searchParams.get('scope') ?? '';
    expect(scope).toContain('https://www.googleapis.com/auth/gmail.send'); // write
    expect(scope).toContain('https://www.googleapis.com/auth/drive.readonly'); // still read
  });

  it('org-scoped create is fail-closed without host:connections:manage (Phase C D2)', async () => {
    // The default test tenant has no admin member ⇒ resolveEffectiveAccess is
    // empty ⇒ 403 forbidden_scope (not the blanket Phase B 403).
    const orgPost = await jf<{ details?: { requiredScope?: string } }>('/v1/host/openwop-app/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'servicenow', kind: 'api_key', secret: 'x', scope: 'org' }),
    });
    expect(orgPost.status).toBe(403);
  });
});

describe('Connection resolver (most-specific: user → org → workspace, D2)', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await __resetConnectionsStore();
  });

  it('prefers a user connection over a workspace default, with provenance', async () => {
    await createSecretConnection({ tenantId: 't1', provider: 'servicenow', kind: 'api_key', secret: 'WS', scope: 'workspace' });
    await createSecretConnection({ tenantId: 't1', provider: 'servicenow', kind: 'api_key', secret: 'USER', scope: 'user', userId: 'u1' });

    const forU1 = await resolveConnectionCredential({ tenantId: 't1', provider: 'servicenow', actingUserId: 'u1' });
    expect(forU1?.secret).toBe('USER');
    expect(forU1?.provenance.scopeAxis).toBe('user');
    expect(forU1?.provenance.actingUserId).toBe('u1');

    // a different user with no personal connection falls back to the workspace default
    const forU2 = await resolveConnectionCredential({ tenantId: 't1', provider: 'servicenow', actingUserId: 'u2' });
    expect(forU2?.secret).toBe('WS');
    expect(forU2?.provenance.scopeAxis).toBe('workspace');
  });

  it('is tenant-isolated — no connection leaks across tenants', async () => {
    const forOther = await resolveConnectionCredential({ tenantId: 't2', provider: 'servicenow', actingUserId: 'u1' });
    expect(forOther).toBeNull();
  });
});

describe('OAuth2 token material — store, resolve, refresh-on-expiry (ADR 0024 §4)', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID = 'cid';
    process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET = 'csecret';
    await __resetConnectionsStore();
    await __resetPendingAuth();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stub global fetch with one canned token-endpoint JSON response. */
  function stubTokenEndpoint(body: Record<string, unknown>, ok = true): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: ok ? 200 : 400, headers: { 'content-type': 'application/json' } }),
    );
  }

  it('resolves a still-valid oauth2 access token without refreshing', async () => {
    await upsertOAuthConnection({
      tenantId: 'toauth', provider: 'google', userId: 'u1',
      tokens: { accessToken: 'AT-1', refreshToken: 'RT-1', tokenType: 'Bearer', scopes: ['s'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await resolveConnectionCredential({ tenantId: 'toauth', provider: 'google', actingUserId: 'u1' });
    expect(res?.secret).toBe('AT-1');
    expect(res?.provenance.scopeAxis).toBe('user');
    expect(spy).not.toHaveBeenCalled(); // not expired ⇒ no token-endpoint call
  });

  it('refreshes transparently when the access token is past the skew window', async () => {
    await upsertOAuthConnection({
      tenantId: 'toauth2', provider: 'google', userId: 'u1',
      tokens: { accessToken: 'AT-old', refreshToken: 'RT-keep', tokenType: 'Bearer', scopes: ['s'], expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    stubTokenEndpoint({ access_token: 'AT-new', token_type: 'Bearer', expires_in: 3600 });
    const res = await resolveConnectionCredential({ tenantId: 'toauth2', provider: 'google', actingUserId: 'u1' });
    expect(res?.secret).toBe('AT-new');
    // A second resolve should now hit the cache/stored token, still 'AT-new'.
    vi.restoreAllMocks();
    const again = await resolveConnectionCredential({ tenantId: 'toauth2', provider: 'google', actingUserId: 'u1' });
    expect(again?.secret).toBe('AT-new');
  });

  it('flips to needs-reconsent (and probe reports not-ok) when refresh fails', async () => {
    const conn = await upsertOAuthConnection({
      tenantId: 'toauth3', provider: 'google', userId: 'u1',
      tokens: { accessToken: 'AT', refreshToken: 'RT-bad', tokenType: 'Bearer', scopes: ['s'], expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    stubTokenEndpoint({ error: 'invalid_grant' }, false);
    const res = await resolveConnectionCredential({ tenantId: 'toauth3', provider: 'google', actingUserId: 'u1' });
    expect(res).toBeNull();
    const probe = await probeConnection('toauth3', conn.connectionId);
    expect(probe?.ok).toBe(false);
    expect(probe?.status).toBe('needs-reconsent');
  });

  it('GCs abandoned pending-auths past their TTL but keeps fresh ones', async () => {
    await __resetPendingAuth();
    const { state } = await beginAuthorization({ provider: 'google', tenantId: 'tgc', userId: 'u1', reqOrigin: 'http://localhost:8080' });
    // A sweep at "now" leaves the fresh pending-auth untouched.
    expect(await sweepExpiredPendingAuth()).toBe(0);
    // A sweep well past the 10-minute TTL reaps it.
    expect(await sweepExpiredPendingAuth(Date.now() + 11 * 60_000)).toBe(1);
    expect(await consumePendingAuth(state)).toBeNull();
  });
});

describe('Org-shared connection: connections:use gate (ADR 0024 Phase C / D2)', () => {
  let orgId: string;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await __resetConnectionsStore();
    await __resetAccessStores();
    // u1 = owner (gets connections:use via admin scopes); u2 = viewer (no use).
    const org = await createOrg({ tenantId: 'torg', createdBy: 'u1', name: 'Acme', ownerSubject: 'u1' });
    orgId = org.orgId;
    await createMember({ tenantId: 'torg', orgId, subject: 'u2', displayName: 'Viewer', roles: ['viewer'] });
    await createSecretConnection({ tenantId: 'torg', provider: 'servicenow', kind: 'api_key', secret: 'ORG-SECRET', scope: 'org', orgId });
  });

  it('hands the org credential to a member WITH connections:use', async () => {
    const forOwner = await resolveConnectionCredential({ tenantId: 'torg', provider: 'servicenow', actingUserId: 'u1', orgId });
    expect(forOwner?.secret).toBe('ORG-SECRET');
    expect(forOwner?.provenance.scopeAxis).toBe('org');
    expect(forOwner?.provenance.scopeChecked).toBe(true);
  });

  it('withholds it from a member WITHOUT the scope, and from a non-member (fail-closed)', async () => {
    expect(await resolveConnectionCredential({ tenantId: 'torg', provider: 'servicenow', actingUserId: 'u2', orgId })).toBeNull();
    expect(await resolveConnectionCredential({ tenantId: 'torg', provider: 'servicenow', actingUserId: 'nobody', orgId })).toBeNull();
    // No acting user at all ⇒ also withheld.
    expect(await resolveConnectionCredential({ tenantId: 'torg', provider: 'servicenow' })).toBeNull();
  });
});

describe('Inbound provider webhooks (ADR 0024 §6 / Phase C)', () => {
  const PORT = 18942;
  const SIGNING = 'slack-signing-secret';
  let deps: { storage: import('../src/storage/storage.js').Storage; hostSuite: Parameters<typeof handleInboundEvent>[0]['hostSuite'] };
  let connectionId: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    deps = { storage: app.locals.storage, hostSuite: app.locals.hostSuite };
    await __resetConnectionsStore();
    await __resetInboundStore();
    await __resetTriggerBridgeStore();
    // A slack connection + its inbound config (workflowId intentionally unresolved
    // so the fire is a no-op — we're testing verify + dedup, not run execution).
    const conn = await upsertOAuthConnection({ tenantId: 'tin', provider: 'slack', userId: 'u1', tokens: { accessToken: 'AT', tokenType: 'Bearer', scopes: ['channels:read'] } });
    connectionId = conn.connectionId;
    await setInboundConfig({ tenantId: 'tin', connectionId, provider: 'slack', workflowId: 'wf-not-in-catalog', signingSecret: SIGNING });
  });

  function signed(body: string, now: number): { timestamp: string; signature: string } {
    const ts = String(Math.floor(now / 1000));
    const signature = `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex')}`;
    return { timestamp: ts, signature };
  }

  it('verifySlackSignature accepts a good signature and rejects tampering/staleness', () => {
    const now = Date.now();
    const body = '{"hello":"world"}';
    const verify = (h: { timestamp: string; signature: string }, rawBody: string) =>
      verifySlackSignature({ signingSecret: SIGNING, timestampHeader: h.timestamp, signatureHeader: h.signature, rawBody, now }).ok;
    const good = signed(body, now);
    expect(verify(good, body)).toBe(true);
    expect(verify(good, '{"tampered":true}')).toBe(false);
    // Stale timestamp (> 5 min) is rejected even with an otherwise-valid HMAC.
    expect(verify(signed(body, now - 6 * 60_000), body)).toBe(false);
  });

  it('answers the url_verification handshake on a signed challenge', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'CH-123' });
    const out = await handleInboundEvent(deps, { connectionId, rawBody: raw, body: JSON.parse(raw), headers: signed(raw, now), now });
    expect(out).toEqual({ status: 'challenge', challenge: 'CH-123' });
  });

  it('accepts a signed event_callback then dedups a redelivery of the same event_id', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ type: 'event_callback', event_id: 'Ev100', event: { type: 'message' } });
    const headers = signed(raw, now);
    const first = await handleInboundEvent(deps, { connectionId, rawBody: raw, body: JSON.parse(raw), headers, now });
    expect(first.status).toBe('accepted');
    if (first.status === 'accepted') expect(first.deduped).toBe(false);
    // Same event id within the window ⇒ deduped, no second fire.
    const second = await handleInboundEvent(deps, { connectionId, rawBody: raw, body: JSON.parse(raw), headers, now });
    expect(second.status).toBe('accepted');
    if (second.status === 'accepted') expect(second.deduped).toBe(true);
  });

  it('rejects a bad signature as unauthorized, and an unknown connection as not_found', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ type: 'event_callback', event_id: 'Ev200' });
    const bad = await handleInboundEvent(deps, { connectionId, rawBody: raw, body: JSON.parse(raw), headers: { timestamp: String(Math.floor(now / 1000)), signature: 'v0=deadbeef' }, now });
    expect(bad.status).toBe('unauthorized');
    const missing = await handleInboundEvent(deps, { connectionId: 'conn:nope', rawBody: raw, body: JSON.parse(raw), headers: signed(raw, now), now });
    expect(missing.status).toBe('not_found');
  });

  it('teardown drops the config + signing secret so inbound stops accepting', async () => {
    expect(await getInboundConfig('tin', connectionId)).not.toBeNull();
    expect(await removeInboundConfig('tin', connectionId)).toBe(true);
    expect(await getInboundConfig('tin', connectionId)).toBeNull();
    // A correctly-signed event no longer fires anything — config is gone.
    const now = Date.now();
    const raw = JSON.stringify({ type: 'event_callback', event_id: 'Ev300' });
    const out = await handleInboundEvent(deps, { connectionId, rawBody: raw, body: JSON.parse(raw), headers: signed(raw, now), now });
    expect(out.status).toBe('not_found');
  });
});
