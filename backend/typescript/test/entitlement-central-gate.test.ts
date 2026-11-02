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
 *
 * TST-DAB-1. Double guard (recorded): crm/csm keep a per-choke `checkEntitlement`
 * besides the central choke, so the crm case reds on the shared VERDICT
 * (`entitlementGuard`), not on the central `if`. Honest ceiling: the central
 * gate's `req.principal` exemption has no anonymous HTTP path here — public lanes
 * (the funnel case) opt out of `requireFeatureEnabled` entirely (ADR 0819 §1) and
 * authed paths 401 an anonymous caller in middleware first. The public case
 * therefore witnesses the PUBLIC LANE's own plan-free toggle read.
 *
 * Red when (sabotage-witnessed, wave 70): the central `requireFeatureEnabled`
 * paywall is skipped; the entitlement verdict stops refusing an unlisted
 * feature; `isSellableBundleFeature` widens to a core feature; a toggle-off
 * feature answers 403 instead of 404; the public funnel lane reads the
 * plan-gated `resolveOne` instead of the plain toggle.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { isSellableBundleFeature } from '../src/host/featureBundles.js';
import { __resetBilling, processStripeEvent } from '../src/features/billing/billingService.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createFunnel, publishFunnel } from '../src/features/funnels/funnelsService.js';

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
  for (const id of ['users', 'billing', 'webinars', 'cdp', 'destination-sync', 'crm', 'funnels', 'cms']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
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
interface ErrorBody { error?: string; message?: string }

/** The PLAN refusal — not a 403 from some other gate. */
async function expectPlanRefusal(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as ErrorBody;
  expect(body.error).toBe('forbidden');
  expect(body.message).toBe('Your plan (free) does not include this feature.');
}

/** Past the plan gate once owned: exactly the route's own answer (200 unless
 *  named), never the plan refusal or another gate's. */
async function expectServed(res: Response, own: { status: number; message?: string } = { status: 200 }): Promise<void> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  expect(res.status, JSON.stringify(body)).toBe(own.status);
  if (own.message !== undefined) expect(body.message).toBe(own.message);
}

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
    const orgId = (await (await authed('/host/openwop-app/orgs', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) })).json() as { orgId: string }).orgId;
    // webinars ∈ Marketing bundle, no per-feature entitlement code — gated centrally.
    await expectPlanRefusal(await authed(`/host/openwop-app/webinars/orgs/${orgId}/events`));
    await processStripeEvent('t-central', subEvent('evt_c1', 'marketing'));
    await expectServed(await authed(`/host/openwop-app/webinars/orgs/${orgId}/events`));
  });
});

describe('ADR 0419 Option D — public routes are EXEMPT (ADR 0176 shopper rule)', () => {
  it('a public (unauthed, no principal) route is never 403d on the operator plan', async () => {
    // A REAL published funnel (funnels ∈ the Marketing bundle, NOT owned by
    // t-central on the narrowed plan): an anonymous visitor is still served.
    const org = await createOrg({ tenantId: 't-central', createdBy: 'central@acme.test', name: 'Public Org' });
    const page = await createPage({ tenantId: 't-central', orgId: org.orgId, title: 'Landing', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    await transitionPage('t-central', org.orgId, page.pageId, 'publish', 'u');
    const f = await createFunnel({ tenantId: 't-central', orgId: org.orgId, createdBy: 'u', name: 'Pub', slug: 'pub-funnel', steps: [{ kind: 'landing', pageId: page.pageId }] });
    expect((await publishFunnel('t-central', org.orgId, f.funnelId))?.status).toBe('published');
    const res = await fetch(`${BASE}/host/openwop-app/public/${org.orgId}/funnels/pub-funnel`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { funnel: { slug: string } }).funnel.slug).toBe('pub-funnel');
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
    const path = '/host/openwop-app/crm/contacts';
    await expectPlanRefusal(await authed(path));
    await processStripeEvent('t-central', subEvent('evt_crm1', 'crm'));
    await expectServed(await authed(path));
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
    const path = '/host/openwop-app/cdp/identity/resolve?type=email&value=a@b.test';
    await expectPlanRefusal(await authed(path));
    await processStripeEvent('t-central', subEvent('evt_cdp1', 'customer-data-platform'));
    // The route itself answers: no customer is known for that email (its own 404).
    await expectServed(await authed(path), { status: 404, message: 'No customer resolves to that identifier.' });
  });

  it('destination-sync 403s a non-entitled authed tenant, then passes once the bundle is owned', async () => {
    expect(isSellableBundleFeature('destination-sync')).toBe(true);
    const path = '/host/openwop-app/destination-sync/syncs';
    await expectPlanRefusal(await authed(path));
    await processStripeEvent('t-central', subEvent('evt_ds1', 'customer-data-platform'));
    await expectServed(await authed(path));
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
      const r1 = await authed('/host/openwop-app/cdp/identity/resolve?type=email&value=a@b.test');
      expect(r1.status).toBe(404);
      expect(JSON.stringify(await r1.json())).toContain('CDP is not enabled for this tenant.');
      const r2 = await authed('/host/openwop-app/destination-sync/syncs');
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
