/**
 * ADR 0419 Phase 1 — paid feature bundles (platform→tenant entitlements over the
 * ADR 0176 billing rail). Verifies: the host bundle reader, the priceId⇄bundleId
 * config (phantom-bundle rejection), the entitlement webhook branch (bundle events
 * NEVER clobber the plan subscription; metadata + priceId + subId-reverse-lookup
 * correlation), resolveEntitlements' plan∪bundle union, and the bundle-checkout
 * route (bundleId-not-priceId; unpriced ⇒ 404). Isolated env — its own app boot.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { bundleFeatureIds, knownBundleIds } from '../src/host/featureBundles.js';
import {
  __resetBilling, processStripeEvent, resolveEntitlements, getSubscription,
  getBundleEntitlements, activeBundleIds, bundleForPrice, priceForBundle, bundleDisplay,
} from '../src/features/billing/billingService.js';

let server: http.Server;
let BASE: string;
let cookie = '';

// price_crm → the real 'crm' bundle; price_ghost → a non-existent bundle (must be dropped).
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro' });
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_crm: 'crm', price_content: 'content', price_ghost: 'not-a-real-bundle' });
  process.env.OPENWOP_BILLING_BUNDLE_ONETIME = JSON.stringify(['content']); // content = one-time; crm = recurring
  process.env.OPENWOP_BILLING_BUNDLE_DISPLAY = JSON.stringify({ crm: { price: '$29', cadence: '/mo', blurb: 'Sales pipeline' } });
  // A NARROWED plan so the bundle union is observable (unrestricted '*' short-circuits it).
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'], pro: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'billing', 'analytics', 'crm', 'csm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'buyer@acme.test', tenantId: 't-buyer' }),
  });
  const h = login.headers as { getSetCookie?: () => string[] };
  for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
    const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1];
  }
});
afterAll(async () => {
  // Clean up every env var this file set — a leaked OPENWOP_BILLING_PLAN_FEATURES
  // would narrow plans for LATER test files in the same worker, making the
  // now-gated analytics/email 403 in unrelated suites (agents/strategy demo seeds).
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_BILLING_PLAN_PRICES;
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_BUNDLE_ONETIME;
  delete process.env.OPENWOP_BILLING_BUNDLE_DISPLAY;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => { await __resetBilling(); });

const subEvent = (id: string, type: string, opts: { priceId?: string; metadata?: Record<string, string>; status?: string }) => ({
  id, type,
  data: { object: {
    id: 'sub_bundle_1', status: opts.status ?? 'active',
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    items: { data: [{ price: { id: opts.priceId ?? 'price_crm' } }] },
  } },
});

describe('ADR 0419 — host bundle reader + config maps', () => {
  it('resolves bundle→featureIds and known bundle ids', () => {
    expect(knownBundleIds()).toContain('crm');
    expect(bundleFeatureIds('crm')).toEqual(expect.arrayContaining(['crm', 'csm']));
    expect(bundleFeatureIds('not-a-real-bundle')).toEqual([]);
  });
  it('maps priceId⇄bundleId and DROPS a phantom-bundle config entry', () => {
    expect(bundleForPrice('price_crm')).toBe('crm');
    expect(priceForBundle('crm')).toBe('price_crm');
    expect(bundleForPrice('price_ghost')).toBeUndefined(); // bundle id not in the catalog
  });
  it('exposes honest display copy (config-driven)', () => {
    expect(bundleDisplay('crm')).toEqual({ price: '$29', cadence: '/mo', blurb: 'Sales pipeline' });
    expect(bundleDisplay('marketing')).toBeUndefined();
  });
});

describe('ADR 0419 — webhook activates entitlements WITHOUT clobbering the plan', () => {
  it('a bundle subscription event (metadata) activates the grant and leaves the plan sub untouched', async () => {
    const before = await getSubscription('t-buyer');
    const r = await processStripeEvent('t-buyer', subEvent('evt_b1', 'customer.subscription.created', { metadata: { tenantId: 't-buyer', bundleId: 'crm' } }));
    expect(r.status).toBe('applied');
    expect(await activeBundleIds('t-buyer')).toEqual(['crm']);
    const after = await getSubscription('t-buyer');
    expect(after.status).toBe(before.status); // plan row NOT overwritten to 'active'
    expect(after.stripeSubscriptionId).toBeUndefined();
  });
  it('correlates by priceId when metadata is absent (fallback)', async () => {
    await processStripeEvent('t-buyer', subEvent('evt_b2', 'customer.subscription.created', { priceId: 'price_crm' }));
    expect(await activeBundleIds('t-buyer')).toEqual(['crm']);
  });
  it('deactivates on .deleted (even via subId reverse-lookup with no metadata/price)', async () => {
    await processStripeEvent('t-buyer', subEvent('evt_b3', 'customer.subscription.created', { metadata: { tenantId: 't-buyer', bundleId: 'crm' } }));
    const del = { id: 'evt_b4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_bundle_1', status: 'canceled', items: { data: [{}] } } } };
    const r = await processStripeEvent('t-buyer', del);
    expect(r.status).toBe('applied');
    expect(await activeBundleIds('t-buyer')).toEqual([]);
    expect((await getBundleEntitlements('t-buyer')).bundles.crm.status).toBe('canceled');
  });
  it('a PLAN subscription event still updates the plan sub only (no bundle grant)', async () => {
    const r = await processStripeEvent('t-buyer', subEvent('evt_p1', 'customer.subscription.updated', { priceId: 'price_pro', metadata: { tenantId: 't-buyer' } }));
    expect(r.status).toBe('applied');
    expect((await getSubscription('t-buyer')).planTier).toBe('pro');
    expect(await activeBundleIds('t-buyer')).toEqual([]);
  });
});

describe('ADR 0419 — resolveEntitlements union', () => {
  it('locks SELLABLE features but never non-sellable ones, and a bundle grant widens it', async () => {
    const base = await resolveEntitlements('t-buyer', true);
    const allowed = base.allowedFeatures as string[];
    // Under the narrowed 'free' plan the sellable bundle features are excluded (lockable)…
    expect(allowed).not.toContain('crm');
    expect(allowed).not.toContain('analytics');
    // …but NON-sellable features are ALWAYS included — a narrowed plan must never lock
    // a core/standalone feature (the "marketplace store locked itself" regression;
    // ADR 0419 § Correction). `billing` + `marketplace` are non-sellable toggles.
    expect(allowed).toContain('billing');
    expect(allowed).toContain('marketplace');
    // Buying the crm bundle unions its (sellable) features in.
    await processStripeEvent('t-buyer', subEvent('evt_u1', 'customer.subscription.created', { metadata: { tenantId: 't-buyer', bundleId: 'crm' } }));
    const withBundle = await resolveEntitlements('t-buyer', true);
    expect(withBundle.allowedFeatures).toEqual(expect.arrayContaining(['billing', 'marketplace', 'crm', 'csm', 'analytics', 'email']));
  });
  it('billing OFF stays unrestricted (bundle read skipped)', async () => {
    expect((await resolveEntitlements('t-buyer', false)).allowedFeatures).toBe('*');
  });
});

describe('ADR 0419 — bundle store projection (GET /billing/bundles)', () => {
  const getStore = () => fetch(`${BASE}/v1/host/openwop-app/billing/bundles`, { headers: { cookie } });
  it('reports forSale/owned/priceDisplay per bundle with NO Stripe id on the boundary', async () => {
    const res = await getStore();
    expect(res.status).toBe(200);
    const body = await res.json() as { bundles: Array<{ bundleId: string; forSale: boolean; owned: boolean; priceDisplay?: { price?: string } }> };
    const crm = body.bundles.find((b) => b.bundleId === 'crm');
    expect(crm).toMatchObject({ forSale: true, owned: false, priceDisplay: { price: '$29' } });
    const marketing = body.bundles.find((b) => b.bundleId === 'marketing');
    expect(marketing).toMatchObject({ forSale: false, owned: false }); // no configured price
    expect(JSON.stringify(body)).not.toMatch(/sub_|stripeSubscriptionId/); // money data stays host-side
  });
  it('flips owned:true after the entitlement activates', async () => {
    await processStripeEvent('t-buyer', subEvent('evt_s1', 'customer.subscription.created', { metadata: { tenantId: 't-buyer', bundleId: 'crm' } }));
    const body = await (await getStore()).json() as { bundles: Array<{ bundleId: string; owned: boolean }> };
    expect(body.bundles.find((b) => b.bundleId === 'crm')?.owned).toBe(true);
  });
});

describe('ADR 0419 — public bundle pricing (marketing, Stripe-id-free)', () => {
  it('lists FOR-SALE bundles with display copy, no Stripe id, unpriced excluded', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/public/bundle-pricing`); // anon, no cookie
    expect(res.status).toBe(200);
    const body = await res.json() as { bundles: Array<{ bundleId: string; label: string; priceDisplay?: { price?: string } }> };
    expect(body.bundles.find((b) => b.bundleId === 'crm')).toMatchObject({ label: 'CRM', priceDisplay: { price: '$29' } });
    expect(body.bundles.find((b) => b.bundleId === 'marketing')).toBeUndefined(); // no configured price
    expect(JSON.stringify(body)).not.toMatch(/price_crm|stripe/i); // money data stays host-side
  });
  it('returns [] when NO bundle is priced (honest-when-unconfigured — never a fabricated figure)', async () => {
    const savedPrices = process.env.OPENWOP_BILLING_BUNDLE_PRICES;
    const savedDisplay = process.env.OPENWOP_BILLING_BUNDLE_DISPLAY;
    delete process.env.OPENWOP_BILLING_BUNDLE_PRICES; // memoized on the raw string ⇒ re-parses to {}
    delete process.env.OPENWOP_BILLING_BUNDLE_DISPLAY;
    try {
      const res = await fetch(`${BASE}/v1/host/openwop-app/public/bundle-pricing`); // anon
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ bundles: [] });
    } finally {
      if (savedPrices !== undefined) process.env.OPENWOP_BILLING_BUNDLE_PRICES = savedPrices;
      if (savedDisplay !== undefined) process.env.OPENWOP_BILLING_BUNDLE_DISPLAY = savedDisplay;
    }
  });
});

describe('ADR 0419 — bundle checkout route', () => {
  const buy = (bundleId: string) => fetch(`${BASE}/v1/host/openwop-app/billing/bundles/${bundleId}/checkout`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  });
  it('a for-sale bundle returns a checkout session (demo, no Stripe key)', async () => {
    const res = await buy('crm');
    expect(res.status).toBe(201);
    const body = await res.json() as { priceId: string; mode: string };
    expect(body.priceId).toBe('price_crm'); // server resolved the configured price
    expect(body.mode).toBe('demo');
  });
  it('a bundle with no configured price is not for sale (404)', async () => {
    expect((await buy('marketing')).status).toBe(404);
  });
});

describe('ADR 0419 P4 — one-time-unlock bundles fulfil on checkout.session.completed', () => {
  const checkoutCompleted = (id: string, bundleId?: string) => ({
    id, type: 'checkout.session.completed',
    data: { object: { id: 'cs_x', ...(bundleId ? { metadata: { tenantId: 't-buyer', bundleId } } : {}) } },
  });
  it('a ONE-TIME bundle activates via checkout.session.completed (no subscription)', async () => {
    const r = await processStripeEvent('t-buyer', checkoutCompleted('evt_ot1', 'content'));
    expect(r.status).toBe('applied');
    expect(await activeBundleIds('t-buyer')).toEqual(['content']);
  });
  it('a RECURRING bundle does NOT double-fulfil on checkout.session.completed (only its subscription events activate)', async () => {
    const r = await processStripeEvent('t-buyer', checkoutCompleted('evt_ot2', 'crm'));
    expect(r.status).toBe('ignored'); // crm is recurring → the one-time branch skips it
    expect(await activeBundleIds('t-buyer')).toEqual([]);
  });
});

describe('ADR 0419 R2 — the CRM bundle is FULLY gated (crm+csm, every authz choke)', () => {
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  it('every authenticated crm+csm sub-registrar 403s a non-entitled tenant, then passes once CRM is owned', async () => {
    const orgId = (await (await authed('/v1/host/openwop-app/orgs', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) })).json() as { orgId: string }).orgId;
    // One representative AUTHENTICATED route per choke (entitlement fires at/after the
    // shared gate) — proves no sub-registrar was missed.
    const routes: Array<[string, RequestInit?]> = [
      ['/v1/host/openwop-app/crm/contacts'],                                   // routes.ts requireEnabled
      ['/v1/host/openwop-app/crm/runs/none'],                                  // routes.ts runs (entitlement-first)
      ['/v1/host/openwop-app/crm/contacts/none/convert', { method: 'POST', body: JSON.stringify({ orgId }) }], // routes.ts convert (inline authz)
      [`/v1/host/openwop-app/crm/orgs/${orgId}/companies`],                    // orgRoutes authorize
      [`/v1/host/openwop-app/crm/orgs/${orgId}/sign-requests`],                // signRoutes authz
      [`/v1/host/openwop-app/crm/orgs/${orgId}/booking-links`],               // bookingRoutes authz
      [`/v1/host/openwop-app/crm/gmail-sync?orgId=${orgId}`],                  // gmailSyncRoutes helper
      ['/v1/host/openwop-app/csm/accounts'],                                   // csm requireEnabled
    ];
    for (const [path, init] of routes) {
      expect((await authed(path, init)).status, `${path} must 403 without entitlement`).toBe(403);
    }
    // Buy the CRM bundle (crm+csm+analytics+email union into allowedFeatures).
    await processStripeEvent('t-buyer', subEvent('evt_r2', 'customer.subscription.created', { metadata: { tenantId: 't-buyer', bundleId: 'crm' } }));
    for (const [path, init] of routes) {
      expect((await authed(path, init)).status, `${path} must NOT 403 once owned`).not.toBe(403);
    }
  });
  it('a PUBLIC crm route (e-sign by recipient) is NOT gated on the operator plan (ADR 0176 exemption)', async () => {
    // Unauthed public route, bogus token ⇒ 404, never a 401/403 plan error.
    const res = await fetch(`${BASE}/v1/host/openwop-app/public-sign/nonexistent-token`);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe('ADR 0419 P3 — the entitlement gate BITES (analytics, a crm-bundle feature)', () => {
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  it('403s a non-entitled tenant, then passes once the crm bundle is owned', async () => {
    const org = await authed('/v1/host/openwop-app/orgs', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) });
    const orgId = (await org.json() as { orgId: string }).orgId;
    // Free plan (PLAN_FEATURES = {free:['billing']}) does NOT entitle analytics ⇒ 403.
    expect((await authed(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`)).status).toBe(403);
    // Buy CRM (analytics ∈ crm bundle) ⇒ resolveEntitlements unions it in ⇒ no longer 403.
    await processStripeEvent('t-buyer', subEvent('evt_g1', 'customer.subscription.created', { metadata: { tenantId: 't-buyer', bundleId: 'crm' } }));
    expect((await authed(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`)).status).not.toBe(403);
  });
});
