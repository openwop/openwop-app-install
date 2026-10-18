/**
 * Commerce Connect (ADR 0385 Phase 1) — route + webhook-handler harness.
 * Verifies: toggle gating (404 off), demo-mode onboarding (honest sentinel, no
 * Stripe), the sync bridge, the Connect webhook handler (reverse-index tenant
 * resolution, per-tenant toggle gate, event.id CAS dedup, account-state
 * application, deauthorization), and that the billing webhook fails closed (503
 * not_configured) while the platform secrets cannot resolve.
 *
 * HONEST CEILINGS, stated so a green run is not over-read:
 *  - "resume mints no second account" cannot fail in the DEMO lane: the demo
 *    account id is deterministic (`acct_demo_<tenant>`), so even a deleted resume
 *    branch re-mints the identical id. The live-lane resume (a second Express
 *    account) is covered by commerce-connect-disputes › "CC-1 …" and the live-lane
 *    suite. Deleting the resume branch IS caught here — by the deauthorization
 *    case, whose re-onboarding refusal lives inside that branch.
 *  - Dual-secret signature routing is covered by commerce-connect-live-lane ›
 *    "a CONNECT-secret-signed account event reaches the handler".
 *  - The GEN-CC-1 anon refusal below is ALSO asserted by
 *    commerce-connect-anon-fold-guard.test.ts (measured: both go red when the
 *    fold predicate is broken). It is kept here because this file is protected.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { handleConnectEvent, getSeller, startOnboarding, syncSellerFromStripe, __resetCommerceConnect } from '../src/features/commerce-connect/connectService.js';
import type { SellerAccount } from '../src/features/commerce-connect/stores.js';
import type { OnboardingStart } from '../src/features/commerce-connect/onboarding.js';

/** The bound TCP port, narrowed without a cast (`address()` is `string | AddressInfo | null`). */
function portOf(s: { address(): string | AddressInfo | null }): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The ONE untyped boundary: `JSON.parse` returns the declared `T` (the call
 *  site's statement of the shape it reads). An empty or non-JSON body is `null`. */
function parseBody<T>(text: string): T {
  try { return JSON.parse(text === '' ? 'null' : text); } catch { return JSON.parse('null'); }
}
/** The canonical error envelope a refused call carries. */
interface ApiError { error: string; message?: string; details?: Record<string, unknown> }
/** A response whose body shape the CALL SITE names (`owner.post<Product>(…)`);
 *  unread bodies stay `unknown`, so a field read without a named shape fails tsc. */
interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: parseBody<T>(await res.text()) };
  };
  return { get: <T = unknown>(p: string) => call<T>('GET', p), post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

interface LoginBody { user: { userId: string; tenantId?: string }; tenantId?: string }
async function login(c: ReturnType<typeof client>): Promise<{ userId: string; tenantId: string }> {
  const r = await c.post<LoginBody>('/host/openwop-app/test/login', { email: `cc-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId, tenantId: r.body.user.tenantId ?? r.body.tenantId ?? '' };
}

async function enableToggle(): Promise<void> {
  await saveConfig({ id: 'commerce-connect', label: 'Commerce Connect (seller marketplace)', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
}
async function disableToggle(): Promise<void> {
  await saveConfig({ id: 'commerce-connect', label: 'Commerce Connect (seller marketplace)', description: 'test', category: 'Admin', status: 'off', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
}

const CC = '/host/openwop-app/commerce-connect';

describe('commerce-connect routes — toggle gate + demo onboarding', () => {
  it('404s every route while the toggle is off (backend authority)', async () => {
    await disableToggle();
    try {
      const c = client();
      await login(c);
      expect((await c.get(`${CC}/seller`)).status).toBe(404);
      expect((await c.post(`${CC}/seller/onboard`, {})).status).toBe(404);
      expect((await c.post(`${CC}/seller/sync`, {})).status).toBe(404);
    } finally {
      await enableToggle();
    }
  });

  it('demo onboarding (keyless): honest sentinel, deterministic acct id, resume mints no second account', async () => {
    await enableToggle();
    const c = client();
    await login(c);
    expect((await c.get(`${CC}/seller`)).body).toEqual({ seller: null });

    const started = await c.post<OnboardingStart>(`${CC}/seller/onboard`, {});
    expect(started.status).toBe(201);
    expect(started.body.mode).toBe('demo');
    expect(started.body.url).toBe('demo:connect-onboarding');
    expect(started.body.seller.stripeAccountId).toMatch(/^acct_demo_/);
    expect(started.body.seller.onboardingState).toBe('pending');

    // resume — same account, same sentinel (no duplicate)
    const resumed = await c.post<OnboardingStart>(`${CC}/seller/onboard`, {});
    expect(resumed.status).toBe(201);
    expect(resumed.body.seller.stripeAccountId).toBe(started.body.seller.stripeAccountId);

    // sync bridge — demo flips to enabled (showcase; no Stripe to consult)
    const synced = await c.post<{ seller: SellerAccount }>(`${CC}/seller/sync`, {});
    expect(synced.status).toBe(200);
    expect(synced.body.seller.onboardingState).toBe('enabled');
    expect(synced.body.seller.chargesEnabled).toBe(true);

    // tenant isolation: a different tenant sees no seller
    const other = client();
    await login(other);
    expect((await other.get(`${CC}/seller`)).body).toEqual({ seller: null });
  });

  it('sync without onboarding → 404 (fail-closed, not a fabricated row)', async () => {
    await enableToggle();
    const c = client();
    await login(c);
    expect((await c.post(`${CC}/seller/sync`, {})).status).toBe(404);
  });
});

describe('handleConnectEvent — reverse index, per-tenant toggle, CAS dedup', () => {
  const accountEvent = (id: string, account: string, over: Record<string, unknown> = {}) => ({
    id, type: 'account.updated', account,
    data: { object: { id: account, charges_enabled: true, payouts_enabled: true, country: 'US', capabilities: { card_payments: 'active', transfers: 'active' }, ...over } },
  });

  it('applies account.updated to the indexed tenant; unknown account is unhandled', async () => {
    await __resetCommerceConnect();
    await enableToggle();
    await startOnboarding('tenant-a', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' }); // demo lane (keyless)
    const acct = (await getSeller('tenant-a'))!.stripeAccountId;

    expect(await handleConnectEvent({ event: accountEvent('evt_cc_1', acct) })).toEqual({ handled: true });
    const seller = (await getSeller('tenant-a'))!;
    expect(seller).toMatchObject({ onboardingState: 'enabled', chargesEnabled: true, payoutsEnabled: true, region: 'US' });
    expect(seller.capabilities.sort()).toEqual(['card_payments', 'transfers']);

    expect(await handleConnectEvent({ event: accountEvent('evt_cc_2', 'acct_unknown') })).toEqual({ handled: false });
  });

  it('dedupes on event.id (a re-delivered event does not re-apply)', async () => {
    await __resetCommerceConnect();
    await enableToggle();
    await startOnboarding('tenant-b', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    const acct = (await getSeller('tenant-b'))!.stripeAccountId;

    expect((await handleConnectEvent({ event: accountEvent('evt_dup', acct) })).handled).toBe(true);
    // second delivery, SAME event id but different payload — must not apply
    expect((await handleConnectEvent({ event: accountEvent('evt_dup', acct, { charges_enabled: false }) })).handled).toBe(true);
    expect((await getSeller('tenant-b'))!.chargesEnabled).toBe(true);
  });

  it('declines events for a tenant whose toggle is OFF (per-tenant gate, boot registration is global)', async () => {
    await __resetCommerceConnect();
    await enableToggle();
    await startOnboarding('tenant-c', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    const acct = (await getSeller('tenant-c'))!.stripeAccountId;
    await disableToggle();
    try {
      expect(await handleConnectEvent({ event: accountEvent('evt_off', acct) })).toEqual({ handled: false });
      expect((await getSeller('tenant-c'))!.chargesEnabled).toBe(false); // nothing applied
    } finally {
      await enableToggle();
    }
  });

  it('deauthorization flips state fail-closed and blocks re-onboarding', async () => {
    await __resetCommerceConnect();
    await enableToggle();
    await startOnboarding('tenant-d', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    // Enabled FIRST, so the flags the deauth must clear are actually set — a
    // never-synced demo seller already reads false/false and proves nothing.
    await syncSellerFromStripe('tenant-d');
    expect(await getSeller('tenant-d')).toMatchObject({ chargesEnabled: true, payoutsEnabled: true });
    const acct = (await getSeller('tenant-d'))!.stripeAccountId;
    await handleConnectEvent({ event: { id: 'evt_deauth', type: 'account.application.deauthorized', account: acct, data: { object: {} } } });
    const seller = (await getSeller('tenant-d'))!;
    expect(seller).toMatchObject({ onboardingState: 'deauthorized', chargesEnabled: false, payoutsEnabled: false });
    await expect(startOnboarding('tenant-d', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('capability.updated adjusts the capability list', async () => {
    await __resetCommerceConnect();
    await enableToggle();
    await startOnboarding('tenant-e', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    const acct = (await getSeller('tenant-e'))!.stripeAccountId;
    await handleConnectEvent({ event: { id: 'evt_cap1', type: 'capability.updated', account: acct, data: { object: { id: 'transfers', status: 'active' } } } });
    expect((await getSeller('tenant-e'))!.capabilities).toContain('transfers');
    await handleConnectEvent({ event: { id: 'evt_cap2', type: 'capability.updated', account: acct, data: { object: { id: 'transfers', status: 'inactive' } } } });
    expect((await getSeller('tenant-e'))!.capabilities).not.toContain('transfers');
  });
});

describe('billing webhook — Connect branch + dual-secret verification', () => {
  const sign = (secret: string, body: string, tsMs: number) => {
    const t = Math.floor(tsMs / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  };

  it('is fail-closed 503 not_configured while the platform secrets are unresolvable (ephemeral BYOK)', async () => {
    // The webhook resolves host-level (unscoped) secrets; in the test's ephemeral
    // BYOK mode an unscoped resolve returns null → the route answers 503
    // not_configured. That IS the fail-closed contract; assert it here, and the
    // signature/dispatch logic is covered by the unit layers above.
    const body = JSON.stringify({ id: 'evt_http_1', type: 'account.updated', account: 'acct_x', data: { object: {} } });
    const res = await fetch(`${BASE}/host/openwop-app/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign('whsec_connect', body, Date.now()) },
      body,
    });
    expect(res.status).toBe(503);
    expect(parseBody<ApiError>(await res.text()).error).toBe('not_configured');
  });
});

describe('GEN-CC-1 structural guard — anonymous tenants can never become sellers', () => {
  // Redundant with commerce-connect-anon-fold-guard › "refuses an anon tenant and
  // writes no seller row" (both red under the same sabotage); kept — protected file.
  it('rejects an anon: tenant fail-closed (the fold-eligible class); demo/signed-in tenants unaffected', async () => {
    await enableToggle();
    // the fold-eligible class is refused before any row is written — by the FOLD
    // guard (reason anon_tenant), not by some other 403
    await expect(startOnboarding('anon:sid-123', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' }))
      .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'anon_tenant' } });
    expect(await getSeller('anon:sid-123')).toBeNull(); // no stranded row
    // a normal tenant still onboards (the demo showcase keeps working)
    const ok = await startOnboarding('tenant-guard-ok', { refreshUrl: 'http://x/r', returnUrl: 'http://x/t' });
    expect(ok.seller.stripeAccountId).toMatch(/^acct_demo_/);
    expect(await getSeller('tenant-guard-ok')).not.toBeNull();
  });
});
