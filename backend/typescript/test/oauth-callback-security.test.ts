/**
 * The Connections OAuth callback's two security properties (RFC 0199 §A.2–§A.3).
 *
 * 1. SINGLE-USE `state` IS AN ATOMIC CLAIM. `consumePendingAuth` used to read the
 *    pending grant and then delete it without checking whether the delete removed
 *    anything, so two concurrent callbacks with the same `state` could both pass
 *    and both exchange the code. Now exactly one concurrent caller wins.
 * 2. SAME-USER BINDING. The callback took its identity from `state` alone and never
 *    compared it with the signed-in user, so a browser authenticated as user B
 *    could complete a consent user A started and bind A's grant under the wrong
 *    session (login-CSRF / account binding). An authenticated callback whose
 *    Subject differs from the initiator is now refused and stores nothing.
 * 3. MIX-UP DEFENSE (§A.4, ADR 0753 D2). Google's metadata promises `iss`, so a
 *    wrong OR missing `iss` is refused before any token request.
 *
 * Every refusal is a 4xx (ADR 0753 D1) and is shown to send ZERO token requests:
 * the token endpoint is the guarded-egress chokepoint, counted here. Each refusal
 * asserts its exact `reason` (several refusals share a 400), and the success case
 * reads the stored connection back rather than trusting the redirect text.
 *
 * Sabotage witnesses: claiming by read instead of by delete reds §A.2; dropping
 * the same-Subject check (connections/routes.ts) reds the mismatch case; dropping
 * the `iss` gate reds all three §A.4 cases; trimming a trailing slash before the
 * compare reds the slash case; accepting a missing `iss` reds the missing case;
 * not escaping the refusal target reds the markup case.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tokenRequests: string[] = [];
vi.mock('../src/host/webhookEgressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/webhookEgressGuard.js')>();
  return {
    ...actual,
    guardedEgressFetch: vi.fn(async (url: string) => {
      tokenRequests.push(String(url));
      return new Response(JSON.stringify({ access_token: 'at-test', refresh_token: 'rt-test', expires_in: 3600, scope: 'openid' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  };
});

import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { authorizationResponseIssuerOk, beginAuthorization, callbackRefusalPage, consumePendingAuth } from '../src/features/connections/oauthFlow.js';
import { listConnections } from '../src/features/connections/connectionsService.js';

let server: http.Server;
let BASE = '';
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET = 'test-client-secret';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

/** The Subject this suite's bearer authenticates as, read from the host itself. */
async function bearerSubject(): Promise<string> {
  // A grant started through the real authorize route records the caller's Subject.
  const r = await fetch(`${BASE}/host/openwop-app/connections/google/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: '{}',
  });
  const { authorizeUrl } = (await r.json()) as { authorizeUrl: string };
  const state = new URL(authorizeUrl).searchParams.get('state')!;
  const pending = await consumePendingAuth(state);
  expect(pending?.userId, 'the authorize route records the initiating Subject').toBeTruthy();
  return pending!.userId!;
}

const GOOGLE_ISS = 'https://accounts.google.com';

interface CallbackResult {
  status: number;
  /** Where the browser is sent (the 302 `location`, or the refusal page's meta-refresh target). */
  target: string;
  reason: string | null;
  connectError: string | null;
  connected: string | null;
}

/** Drive the real callback. `iss: null` omits the parameter. */
async function callback(state: string, iss: string | null = GOOGLE_ISS, provider = 'google'): Promise<CallbackResult> {
  const q = new URLSearchParams({ state, code: 'abc', ...(iss !== null ? { iss } : {}) });
  const res = await fetch(`${BASE}/host/openwop-app/connections/${provider}/callback?${q}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    redirect: 'manual',
  });
  const target = res.status < 400
    ? res.headers.get('location') ?? ''
    : (/content="0;url=([^"]+)"/.exec(await res.text())?.[1] ?? '').replace(/&amp;/g, '&');
  const params = target ? new URL(target).searchParams : new URLSearchParams();
  return { status: res.status, target, reason: params.get('reason'), connectError: params.get('connectError'), connected: params.get('connected') };
}

/** The google connections stored for one user in the `default` tenant. */
async function googleConnectionsOf(userId: string) {
  return (await listConnections('default', userId)).filter((c) => c.provider === 'google' && c.userId === userId);
}

beforeEach(() => {
  tokenRequests.length = 0;
});

describe('RFC 0199 §A.2 — single-use state is an atomic claim', () => {
  it('two concurrent consumes of one state: exactly one wins', async () => {
    const { state } = await beginAuthorization({ provider: 'google', tenantId: 't-race', userId: 'u-race', reqOrigin: 'http://localhost:8080' });
    const results = await Promise.all([consumePendingAuth(state), consumePendingAuth(state), consumePendingAuth(state)]);
    expect(results.filter((r) => r !== null).length, 'one claim, never two exchanges').toBe(1);
  });
});

describe('RFC 0199 §A.3 — the callback completes only for the initiating Subject', () => {
  it('an authenticated callback whose Subject DIFFERS from the initiator is refused (403 subject_mismatch), with no token request', async () => {
    const { state } = await beginAuthorization({ provider: 'google', tenantId: 'default', userId: 'someone-else', reqOrigin: 'http://localhost:8080' });
    const r = await callback(state);
    expect(r.status).toBe(403);
    expect(r.connectError).toBe('google');
    expect(r.reason).toBe('subject_mismatch');
    expect(tokenRequests).toHaveLength(0);
    // It stores nothing for either party.
    expect(await googleConnectionsOf('someone-else')).toEqual([]);
    // The refused callback consumed the state: it cannot be retried under the right user.
    expect(await consumePendingAuth(state)).toBeNull();
  });

  it('the SAME Subject with the right `iss` completes: exactly one token request, connected', async () => {
    const me = await bearerSubject();
    // Only this case completes a grant in this file, so `me` holds no google row yet.
    expect(await googleConnectionsOf(me)).toEqual([]);
    const { state } = await beginAuthorization({ provider: 'google', tenantId: 'default', userId: me, reqOrigin: 'http://localhost:8080' });
    const r = await callback(state);
    expect(r.status).toBe(302);
    expect(r.connected).toBe('google');
    expect(r.reason).toBeNull();
    // Exactly one egress, and it is Google's token endpoint.
    expect(tokenRequests).toEqual(['https://oauth2.googleapis.com/token']);
    // Connected means stored: one google connection, bound to the initiating Subject.
    expect((await googleConnectionsOf(me)).map((c) => c.userId)).toEqual([me]);
  });
});

describe('RFC 0199 §A.4 — mix-up defense (RFC 9207 `iss`)', () => {
  it('a WRONG `iss` is refused before any token request', async () => {
    const me = await bearerSubject();
    const { state } = await beginAuthorization({ provider: 'google', tenantId: 'default', userId: me, reqOrigin: 'http://localhost:8080' });
    const r = await callback(state, 'https://evil.example');
    expect(r.status).toBe(400);
    expect(r.connectError).toBe('google');
    expect(r.reason).toBe('iss_mismatch');
    expect(tokenRequests).toHaveLength(0);
  });

  it('a slash-suffixed `iss` is NOT the configured issuer (the check is exact; the RFC owner ruled the equivalence only for §B.3(c))', async () => {
    const me = await bearerSubject();
    const { state } = await beginAuthorization({ provider: 'google', tenantId: 'default', userId: me, reqOrigin: 'http://localhost:8080' });
    const r = await callback(state, `${GOOGLE_ISS}/`);
    expect(r.status).toBe(400);
    expect(r.reason).toBe('iss_mismatch');
    expect(tokenRequests).toHaveLength(0);
  });

  it('a MISSING `iss` is refused for a provider whose metadata promises one', async () => {
    const me = await bearerSubject();
    const { state } = await beginAuthorization({ provider: 'google', tenantId: 'default', userId: me, reqOrigin: 'http://localhost:8080' });
    const r = await callback(state, null);
    expect(r.status).toBe(400);
    expect(r.connectError).toBe('google');
    expect(r.reason).toBe('iss_mismatch');
    expect(tokenRequests).toHaveLength(0);
  });
});

describe('ADR 0753 D1 — the refusal page cannot be turned into markup', () => {
  it('escapes the target as an attribute and renders nothing else of the request', () => {
    const html = callbackRefusalPage('https://app.example/x?a="><script>alert(1)</script>&b=\'');
    expect(html).not.toContain('<script');
    // the injected quote cannot close the attribute: exactly one `url=` attribute value, closed once
    expect(html.match(/url=[^"]*"/g)).toHaveLength(1);
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('authorizationResponseIssuerOk: an issuer-less provider is not interpreted', () => {
    expect(authorizationResponseIssuerOk('slack', undefined)).toBe(true);
    expect(authorizationResponseIssuerOk('slack', 'https://anything.example')).toBe(true);
    expect(authorizationResponseIssuerOk('google', ['https://accounts.google.com'])).toBe(false);
  });
});
