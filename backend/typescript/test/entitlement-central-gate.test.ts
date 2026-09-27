/**
 * ADR 0419 (Option D) — the CENTRAL paid-bundle paywall. `requireFeatureEnabled`
 * (the one choke every gated route funnels through — inline OR via authorizeOrgScope)
 * enforces the plan/bundle entitlement for SELLABLE-BUNDLE features on AUTHENTICATED
 * requests, via the host entitlement seam. This gates every bundle feature by
 * construction (priced⟹gated is structural — no per-feature grind), WITHOUT
 * over-gating core (bundle-scoped) and WITHOUT 403ing public callers (no principal).
 *
 * `webinars` is a Marketing-bundle feature that has NO per-feature entitlement code —
 * it gates purely through the central seam, proving the mechanism's breadth.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { isSellableBundleFeature } from '../src/host/featureBundles.js';
import { __resetBilling, processStripeEvent } from '../src/features/billing/billingService.js';

let server: http.Server;
let BASE: string;
let cookie = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_mktg: 'marketing' });
  // Narrow the plan so bundle features are NOT entitled until bought (billing on).
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'], pro: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'billing', 'webinars', 'cdp', 'destination-sync', 'crm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'central@acme.test', tenantId: 't-central' }),
  });
  const h = login.headers as { getSetCookie?: () => string[] };
  for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
    const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1];
  }
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => { await __resetBilling(); });

const authed = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
const subEvent = (id: string, bundleId: string) => ({
  id, type: 'customer.subscription.created',
  data: { object: { id: 'sub_x', status: 'active', metadata: { tenantId: 't-central', bundleId }, items: { data: [{ price: { id: 'price_mktg' } }] } } },
});

describe('ADR 0419 Option D — central gate scoping', () => {
  it('gates ONLY sellable-bundle features, never core/standalone', () => {
    expect(isSellableBundleFeature('crm')).toBe(true);       // CRM bundle
    expect(isSellableBundleFeature('webinars')).toBe(true);  // Marketing bundle
    expect(isSellableBundleFeature('orgs')).toBe(false);     // core
    expect(isSellableBundleFeature('cms')).toBe(false);      // core
    expect(isSellableBundleFeature('billing')).toBe(false);  // core
    expect(isSellableBundleFeature('voice')).toBe(false);    // standalone
  });
});

describe('ADR 0419 Option D — the central gate BITES a feature with no per-feature code (webinars)', () => {
  it('403s a non-entitled authed tenant, then passes once the Marketing bundle is owned', async () => {
    const orgId = (await (await authed('/v1/host/openwop-app/orgs', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) })).json() as { orgId: string }).orgId;
    // webinars ∈ Marketing bundle, no per-feature entitlement code — gated centrally.
    expect((await authed(`/v1/host/openwop-app/webinars/orgs/${orgId}/events`)).status).toBe(403);
    await processStripeEvent('t-central', subEvent('evt_c1', 'marketing'));
    expect((await authed(`/v1/host/openwop-app/webinars/orgs/${orgId}/events`)).status).not.toBe(403);
  });
});

describe('ADR 0419 Option D — public routes are EXEMPT (ADR 0176 shopper rule)', () => {
  it('a public (unauthed, no principal) route is never 403d on the operator plan', async () => {
    // funnels public read — a bogus slug 404s; the point is it is NOT a 401/403 plan error.
    const res = await fetch(`${BASE}/v1/host/openwop-app/public/some-org/funnels/nonexistent`);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe('ADR 0446 D.1 — the per-choke entitlement call still gates after the host-seam swap', () => {
  // crm/csm/analytics/email swapped their per-choke `requireEntitledFeature` (direct
  // billing import) for the host seam `checkEntitlement`. Behavior must be identical:
  // the seam delegates to the billing-registered `requireEntitledFeature`. This proves
  // a real per-choke route still 403s a non-entitled tenant and passes once owned —
  // i.e. the swap did NOT quietly turn the gate into a no-op.
  it('GET /crm/contacts 403s a non-entitled tenant, then passes once the CRM bundle is owned', async () => {
    expect(isSellableBundleFeature('crm')).toBe(true);
    const path = '/v1/host/openwop-app/crm/contacts';
    expect((await authed(path)).status).toBe(403);
    await processStripeEvent('t-central', subEvent('evt_crm1', 'crm'));
    expect((await authed(path)).status).not.toBe(403);
  });
});

describe('ADR 0419 §Correction (2026-07-19) — the two features the original audit MISSED', () => {
  // ADR 0419 asserted "an audit found ONLY crm/csm" bypass the central choke with a
  // local resolveOne gate, and concluded "any bundle can be priced honestly". Both
  // were false: `cdp` and `destination-sync` bypassed it too, and both are in the
  // SELLABLE `customer-data-platform` bundle — so pricing that bundle sold nothing.
  // These cases pin that they now gate centrally.
  it('cdp 403s a non-entitled authed tenant, then passes once customer-data-platform is owned', async () => {
    expect(isSellableBundleFeature('cdp')).toBe(true);
    const path = '/v1/host/openwop-app/cdp/identity/resolve?type=email&value=a@b.test';
    expect((await authed(path)).status).toBe(403);
    await processStripeEvent('t-central', subEvent('evt_cdp1', 'customer-data-platform'));
    expect((await authed(path)).status).not.toBe(403);
  });

  it('destination-sync 403s a non-entitled authed tenant, then passes once the bundle is owned', async () => {
    expect(isSellableBundleFeature('destination-sync')).toBe(true);
    const path = '/v1/host/openwop-app/destination-sync/syncs';
    expect((await authed(path)).status).toBe(403);
    await processStripeEvent('t-central', subEvent('evt_ds1', 'customer-data-platform'));
    expect((await authed(path)).status).not.toBe(403);
  });

  it('toggle-OFF still 404s (not 403) — the 404 body is unchanged by the choke swap', async () => {
    // The local gates produced `not_found` 404 with {feature}; requireFeatureEnabled
    // produces the same shape with labels 'CDP' / 'Destination Sync'. A toggle-off
    // feature must look ABSENT, never like a billing refusal.
    for (const id of ['cdp', 'destination-sync'] as const) {
      const d = getToggleDefault(id);
      if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    }
    try {
      const r1 = await authed('/v1/host/openwop-app/cdp/identity/resolve?type=email&value=a@b.test');
      expect(r1.status).toBe(404);
      expect(JSON.stringify(await r1.json())).toContain('CDP is not enabled for this tenant.');
      const r2 = await authed('/v1/host/openwop-app/destination-sync/syncs');
      expect(r2.status).toBe(404);
      expect(JSON.stringify(await r2.json())).toContain('Destination Sync is not enabled for this tenant.');
    } finally {
      for (const id of ['cdp', 'destination-sync']) {
        const d = getToggleDefault(id);
        if (d) await saveConfig({ ...d, status: 'on' }, 'test');
      }
    }
  });
});
