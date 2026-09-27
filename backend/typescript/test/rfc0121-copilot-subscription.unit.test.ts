/**
 * ADR 0757 — GitHub Copilot, the RFC 0121 cleared `subscription` provider.
 * Unit coverage for the §B.9 gate, the loopback-only token egress, the OAuth
 * connect flow's state/principal binding and least scope, and the dispatch arm.
 */

import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

const egress = vi.hoisted(() => ({ calls: [] as Array<{ url: string; body: string }>, reply: { status: 200, json: { access_token: 'gho_TESTTOKEN123' } as Record<string, unknown> } }));
vi.mock('../src/host/webhookEgressGuard.js', async (orig) => {
  const actual = await orig<typeof import('../src/host/webhookEgressGuard.js')>();
  return {
    ...actual,
    guardedEgressFetch: vi.fn(async (url: string, init: { body?: string }) => {
      egress.calls.push({ url, body: String(init?.body ?? '') });
      return { ok: egress.reply.status < 400, status: egress.reply.status, json: async () => egress.reply.json };
    }),
  };
});

import { copilotEndpoint, copilotSubscriptionConfigured, isLoopbackHttpUrl } from '../src/aiProviders/copilotSubscription.js';
import { subscriptionAdvertisedProviders, buildProviderAuthModes, advertisedSubscriptionOnlyProviders } from '../src/aiProviders/aiProvidersHost.js';
import { beginCopilotAuthorization, completeCopilotAuthorization, __resetCopilotPendingAuth } from '../src/byok/copilotOAuth.js';
import { resolveSecret, clearAllSecrets, configureSecretResolver, removeSecret } from '../src/byok/secretResolver.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureKmsClient, createLocalAesKmsClient } from '../src/byok/kmsEncryption.js';
import { dispatchChat } from '../src/providers/dispatch.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const ORIGIN = 'http://localhost:8080';
function configure(): void {
  process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID = 'Iv1.testclient';
  process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET = 'test-secret';
  process.env.OPENWOP_COPILOT_ENDPOINT = 'http://127.0.0.1:8791/v1';
}

beforeAll(async () => {
  const storage = await openSqliteStorage('memory://');
  initHostExtPersistence(storage);
  configureSecretResolver({ storage, dataDir: mkdtempSync(join(tmpdir(), 'openwop-copilot-')) });
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
});
afterEach(async () => {
  for (const k of ['OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID', 'OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET', 'OPENWOP_COPILOT_ENDPOINT', 'OPENWOP_SUBSCRIPTION_AT_OWN_RISK', 'OPENWOP_SUBSCRIPTION_PROVIDERS']) delete process.env[k];
  egress.calls.length = 0;
  egress.reply = { status: 200, json: { access_token: 'gho_TESTTOKEN123' } };
  await __resetCopilotPendingAuth();
  // clearAllSecrets() lists host-global refs only; tenant-scoped rows are removed explicitly.
  for (const tenantId of ['user:abc', 'user:evil']) await removeSecret('subscription:github.copilot', { tenantId });
  await clearAllSecrets();
});

describe('§B.9 — advertised only when BOTH the OAuth client and a loopback sidecar are configured', () => {
  it('is dark by default', () => {
    expect(copilotSubscriptionConfigured()).toBe(false);
    expect(subscriptionAdvertisedProviders()).not.toContain('github.copilot');
    expect(advertisedSubscriptionOnlyProviders()).toEqual([]);
  });
  it('is dark with the OAuth client but no sidecar, and with a sidecar but no OAuth client', () => {
    process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID = 'x';
    process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET = 'y';
    expect(copilotSubscriptionConfigured()).toBe(false);
    delete process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID;
    process.env.OPENWOP_COPILOT_ENDPOINT = 'http://127.0.0.1:8791/v1';
    expect(copilotSubscriptionConfigured()).toBe(false);
  });
  it('lights when both are set — independent of the ADR 0180 at-own-risk flags', () => {
    configure();
    expect(subscriptionAdvertisedProviders()).toEqual(['github.copilot']);
    expect(advertisedSubscriptionOnlyProviders()).toEqual(['github.copilot']);
  });
  it('a cleared provider advertises subscription ONLY (never apiKey) and is force-included in byok (§B.7)', () => {
    const { byok, authModes } = buildProviderAuthModes(['anthropic'], ['github.copilot']);
    expect(byok).toContain('github.copilot');
    expect(authModes['github.copilot']).toEqual(['subscription']);
  });
});

describe('the user token can only ever reach a LOOPBACK sidecar', () => {
  it('accepts loopback http(s) and refuses everything else', () => {
    for (const ok of ['http://127.0.0.1:8791/v1', 'http://localhost:8791/v1', 'http://[::1]:8791/v1']) expect(isLoopbackHttpUrl(ok)).toBe(true);
    for (const bad of ['https://copilot.example/v1', 'http://10.0.0.5:8791/v1', 'http://127.0.0.1.evil.example/v1', 'http://user:pw@127.0.0.1/v1', 'file:///etc/passwd', 'not a url']) expect(isLoopbackHttpUrl(bad)).toBe(false);
  });
  it('a non-loopback OPENWOP_COPILOT_ENDPOINT keeps the provider dark', () => {
    configure();
    process.env.OPENWOP_COPILOT_ENDPOINT = 'https://copilot.example/v1';
    expect(copilotEndpoint()).toBeNull();
    expect(copilotSubscriptionConfigured()).toBe(false);
  });
  it('dispatchChat(copilot) refuses a non-loopback base URL before any network call', async () => {
    await expect(dispatchChat({ provider: 'copilot', model: 'gpt-5', apiKey: 'gho_x', baseUrl: 'https://copilot.example/v1', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow('copilot_endpoint_not_loopback');
  });
  it('dispatchChat(copilot) streams from a loopback sidecar, sending the token ONLY as its bearer', async () => {
    let seenAuth = '';
    const server = http.createServer((req, res) => {
      seenAuth = String(req.headers.authorization ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'there' }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const out = await dispatchChat({ provider: 'copilot', model: 'gpt-5', apiKey: 'gho_abc', baseUrl: `http://127.0.0.1:${port}/v1`, messages: [{ role: 'user', content: 'hi' }] });
      expect(out.completion).toBe('Hi there');
      expect(seenAuth).toBe('Bearer gho_abc');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('OAuth connect flow — least scope, single-use state, principal-bound', () => {
  const who = { principalId: 'u-1', personalTenant: 'user:abc' };

  it('refuses when not configured, when anonymous, and when the caller has no personal user: tenant', async () => {
    await expect(beginCopilotAuthorization({ ...who, reqOrigin: ORIGIN })).rejects.toMatchObject({ code: 'host_capability_missing' });
    configure();
    await expect(beginCopilotAuthorization({ principalId: undefined, personalTenant: 'user:abc', reqOrigin: ORIGIN })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(beginCopilotAuthorization({ principalId: 'u-1', personalTenant: 'ws:shared', reqOrigin: ORIGIN })).rejects.toMatchObject({ code: 'credential_scope_forbidden' });
  });

  it('requests NO scope, uses PKCE S256, and a fixed callback path', async () => {
    configure();
    const { authorizeUrl } = await beginCopilotAuthorization({ ...who, reqOrigin: ORIGIN });
    const u = new URL(authorizeUrl);
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.has('scope')).toBe(false);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('client_id')).toBe('Iv1.testclient');
    // The CANONICAL vendor root (ADR 0652), not the /v1 twin that retires with v1.
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/host/openwop-app/subscription/github.copilot/callback`);
  });

  it('the callback stores the token at the ORIGINATING user tenant only, and the state cannot be replayed', async () => {
    configure();
    const state = new URL((await beginCopilotAuthorization({ ...who, reqOrigin: ORIGIN })).authorizeUrl).searchParams.get('state')!;
    const out = await completeCopilotAuthorization({ state, code: 'c1', error: undefined, ...who, reqOrigin: ORIGIN });
    expect(out).toEqual({ ok: true, returnTo: '/keys' });
    expect(await resolveSecret('subscription:github.copilot', { tenantId: 'user:abc' })).toBe('gho_TESTTOKEN123');
    expect(egress.calls[0]!.url).toBe('https://github.com/login/oauth/access_token');
    expect(egress.calls[0]!.body).toMatch(/code_verifier=/);
    // Replay of the same state is refused and exchanges nothing.
    const replay = await completeCopilotAuthorization({ state, code: 'c1', error: undefined, ...who, reqOrigin: ORIGIN });
    expect(replay).toMatchObject({ ok: false, reason: 'invalid_state' });
    expect(egress.calls).toHaveLength(1);
  });

  it('a DIFFERENT principal completing the callback stores nothing (login-CSRF)', async () => {
    configure();
    const state = new URL((await beginCopilotAuthorization({ ...who, reqOrigin: ORIGIN })).authorizeUrl).searchParams.get('state')!;
    const out = await completeCopilotAuthorization({ state, code: 'c1', error: undefined, principalId: 'attacker', personalTenant: 'user:evil', reqOrigin: ORIGIN });
    expect(out).toMatchObject({ ok: false, reason: 'principal_mismatch' });
    expect(egress.calls).toHaveLength(0);
    expect(await resolveSecret('subscription:github.copilot', { tenantId: 'user:abc' })).toBeNull();
    expect(await resolveSecret('subscription:github.copilot', { tenantId: 'user:evil' })).toBeNull();
  });

  it('an expired state, a denied consent and a refused exchange each store nothing', async () => {
    configure();
    const mint = async (): Promise<string> => new URL((await beginCopilotAuthorization({ ...who, reqOrigin: ORIGIN })).authorizeUrl).searchParams.get('state')!;
    expect(await completeCopilotAuthorization({ state: await mint(), code: 'c', error: undefined, ...who, reqOrigin: ORIGIN, now: Date.now() + 11 * 60_000 })).toMatchObject({ ok: false, reason: 'invalid_state' });
    expect(await completeCopilotAuthorization({ state: await mint(), code: undefined, error: 'access_denied', ...who, reqOrigin: ORIGIN })).toMatchObject({ ok: false, reason: 'denied' });
    egress.reply = { status: 400, json: { error: 'bad_verification_code' } };
    expect(await completeCopilotAuthorization({ state: await mint(), code: 'c', error: undefined, ...who, reqOrigin: ORIGIN })).toMatchObject({ ok: false, reason: 'exchange_failed' });
    expect(await resolveSecret('subscription:github.copilot', { tenantId: 'user:abc' })).toBeNull();
  });
});
