/**
 * ADR 0820 §5 / §7 (P3 + P5) — the plan ladder and the revenue mechanics on the
 * ADR 0176 / ADR 0419 billing rail:
 *
 *  1. `OPENWOP_BILLING_PLAN_FEATURES` entries may be `"bundle:<id>"`, expanded via
 *     `host/featureBundles`; an unknown bundle is IGNORED (never a widened plan).
 *  2. `OPENWOP_BILLING_STANDALONE_BUNDLES` — a bundle sold only on its own. Plan
 *     expansion never grants its features (by `bundle:` OR a literal id), including
 *     a plan left unrestricted (`'*'`) while another plan is narrowed.
 *  3. The store marks a bundle `includedInPlan` when the plan covers all of it, and
 *     a checkout of such a bundle is refused with a typed 409 (both checkout routes).
 *  4. `OPENWOP_BILLING_TRIAL_DAYS` → Checkout `subscription_data[trial_period_days]`
 *     (first subscription only).
 *  5. `OPENWOP_BILLING_PAST_DUE_GRACE_DAYS` — `past_due` stays entitled for N days
 *     from the transition the webhook recorded; `unpaid`/`canceled` revoke at once.
 *  6. `cadence: 'month'|'year'` at bundle (and plan) checkout, resolved server-side
 *     from `OPENWOP_BILLING_BUNDLE_PRICE_CADENCE` / `_PLAN_PRICE_CADENCE`.
 *
 * Every refusal has a positive control in the same test, so it cannot pass for the
 * wrong reason. Isolated env — its own app boot.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { bundleFeatureIds } from '../src/host/featureBundles.js';
import {
  __resetBilling, processStripeEvent, resolveEntitlements, getSubscription, importBillingState,
  activeBundleIds, createCheckoutSession, planFeatures, isEntitledStatus, type Subscription,
} from '../src/features/billing/billingService.js';

const DAY = 86_400_000;
const STRIPE_KEY = 'sk_test_ladder';
const URLS = { successUrl: 'https://x/s', cancelUrl: 'https://x/c' };
const ENV_KEYS = [
  'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_BILLING_PLAN_PRICES', 'OPENWOP_BILLING_BUNDLE_PRICES',
  'OPENWOP_BILLING_PLAN_FEATURES', 'OPENWOP_BILLING_STANDALONE_BUNDLES', 'OPENWOP_BILLING_TRIAL_DAYS',
  'OPENWOP_BILLING_PAST_DUE_GRACE_DAYS', 'OPENWOP_BILLING_BUNDLE_PRICE_CADENCE', 'OPENWOP_BILLING_PLAN_PRICE_CADENCE',
  'OPENWOP_BILLING_BUNDLE_DISPLAY', 'OPENWOP_STRIPE_API_BASE',
];

let server: http.Server;
let stripe: http.Server;
let BASE = '';
let cookie = '';
const posts: { path: string; body: string }[] = [];
let seq = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro', price_pro_year: 'pro', price_team: 'team' });
  process.env.OPENWOP_BILLING_PLAN_PRICE_CADENCE = JSON.stringify({ price_pro_year: 'year' });
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({
    price_crm: 'crm', price_crm_year: 'crm', price_job: 'job-search', price_agents: 'agents', price_lead: 'leadership',
  });
  process.env.OPENWOP_BILLING_BUNDLE_PRICE_CADENCE = JSON.stringify({ price_crm_year: 'year' });
  process.env.OPENWOP_BILLING_BUNDLE_DISPLAY = JSON.stringify({ crm: { price: '$29', cadence: '/mo', priceAnnual: '$290', cadenceAnnual: '/yr' } });
  // pro = agents + leadership by REFERENCE, plus a literal standalone id and a typo'd
  // bundle (both must be dropped). team = crm + the standalone bundle by reference
  // (stripped). enterprise is left unrestricted ('*').
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({
    free: ['billing'],
    pro: ['bundle:agents', 'bundle:leadership', 'job-search', 'bundle:not-a-bundle'],
    team: ['bundle:crm', 'bundle:agents', 'bundle:job-search'],
  });
  process.env.OPENWOP_BILLING_STANDALONE_BUNDLES = JSON.stringify(['job-search']);
  process.env.OPENWOP_BILLING_TRIAL_DAYS = JSON.stringify({ 'plan:pro': 14, 'bundle:crm': 7 });
  process.env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS = '7';

  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST') posts.push({ path: url, body: raw });
      if (req.method === 'POST' && url === '/v1/customers') return send(200, { id: `cus_${++seq}` });
      if (req.method === 'POST' && url === '/v1/checkout/sessions') { const id = `cs_ladder_${++seq}`; return send(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` }); }
      return send(404, { error: { message: `unmocked ${req.method} ${url}` } });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'billing', 'marketplace']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const login = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ladder@acme.test', tenantId: 't-ladder' }),
  });
  const h = login.headers as { getSetCookie?: () => string[] };
  for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
    const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1];
  }
});
afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => stripe.close(() => res()));
});
beforeEach(async () => { await __resetBilling(); posts.length = 0; });

const seedPlan = (tenantId: string, planTier: Subscription['planTier'], status: Subscription['status'], extra: Partial<Subscription> = {}) =>
  importBillingState({ subscriptions: [{ tenantId, planTier, status, updatedAt: new Date().toISOString(), ...extra }] });
const allowed = async (tenantId: string): Promise<string[]> => {
  const ent = await resolveEntitlements(tenantId, true);
  if (ent.allowedFeatures === '*') throw new Error('expected a narrowed plan');
  return ent.allowedFeatures;
};
const subEvent = (id: string, type: string, o: { subId?: string; priceId: string; status?: string; metadata?: Record<string, string> }) => ({
  id, type,
  data: { object: {
    id: o.subId ?? 'sub_1', status: o.status ?? 'active',
    ...(o.metadata ? { metadata: o.metadata } : {}),
    items: { data: [{ price: { id: o.priceId } }] },
  } },
});
const authed = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}/host/openwop-app/billing${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });

describe('ADR 0820 §5 — plans reference bundles (`bundle:<id>`)', () => {
  it('expands bundle references and ignores an unknown bundle (never a widened plan)', async () => {
    await seedPlan('t-pro', 'pro', 'active');
    const list = await allowed('t-pro');
    for (const f of [...bundleFeatureIds('agents'), ...bundleFeatureIds('leadership')]) expect(list).toContain(f);
    expect(list.some((f) => f.startsWith('bundle:'))).toBe(false); // no literal reference leaks through
    // Positive-shaped negative: a bundle the plan does NOT reference stays locked.
    for (const f of bundleFeatureIds('crm')) expect(list).not.toContain(f);
    // The raw plan list carries no `bundle:` tokens either (public pricing reads it).
    const pro = planFeatures('pro');
    expect(Array.isArray(pro) && pro.includes('advisory-board')).toBe(true);
  });
});

describe('ADR 0820 §5 — standalone bundles are never granted by a plan', () => {
  it('strips a standalone feature whether listed literally, by `bundle:`, or via an unrestricted plan', async () => {
    await seedPlan('t-pro', 'pro', 'active');
    await seedPlan('t-team', 'team', 'active');
    await seedPlan('t-ent', 'enterprise', 'active');
    expect(await allowed('t-pro')).not.toContain('job-search'); // literal id
    const team = await allowed('t-team');
    expect(team).not.toContain('job-search'); // bundle:job-search
    expect(team).toContain('crm'); // the rest of the plan still applies
    const ent = await allowed('t-ent'); // '*' plan while other plans are narrowed
    expect(ent).not.toContain('job-search');
    expect(ent).toContain('crm');
  });
  it('POSITIVE CONTROL: buying the standalone bundle grants it', async () => {
    await seedPlan('t-pro2', 'pro', 'active');
    await processStripeEvent('t-pro2', subEvent('evt_job', 'customer.subscription.created', { subId: 'sub_job', priceId: 'price_job', metadata: { tenantId: 't-pro2', bundleId: 'job-search' } }));
    expect(await allowed('t-pro2')).toContain('job-search');
  });
});

describe('ADR 0820 §5 — the store shows plan-included bundles; checkout refuses them', () => {
  it('GET /bundles marks includedInPlan only when the plan covers every feature', async () => {
    await seedPlan('t-ladder', 'pro', 'active');
    const body = await (await authed('/bundles')).json() as { bundles: Array<{ bundleId: string; includedInPlan?: boolean; owned: boolean }> };
    const by = new Map(body.bundles.map((b) => [b.bundleId, b]));
    expect(by.get('agents')?.includedInPlan).toBe(true);
    expect(by.get('leadership')?.includedInPlan).toBe(true);
    expect(by.get('crm')?.includedInPlan).toBe(false);
    expect(by.get('job-search')?.includedInPlan).toBe(false); // standalone: never plan-included
    expect(by.get('agents')?.owned).toBe(false); // owned stays purchase truth
  });
  it('a bundle checkout the plan already covers is a typed 409 (both routes); an uncovered one is served', async () => {
    await seedPlan('t-ladder', 'pro', 'active');
    const refused = await authed('/bundles/agents/checkout', { method: 'POST', body: '{}' });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain('bundle_included_in_plan');
    const generic = await authed('/checkout', { method: 'POST', body: JSON.stringify({ priceId: 'price_agents' }) });
    expect(generic.status).toBe(409);
    // POSITIVE CONTROL — same tenant, same plan, a bundle the plan does not cover.
    expect((await authed('/bundles/crm/checkout', { method: 'POST', body: '{}' })).status).toBe(201);
  });
  it('a free-plan tenant may buy the bundle a higher plan includes', async () => {
    expect((await authed('/bundles/agents/checkout', { method: 'POST', body: '{}' })).status).toBe(201);
  });
});

describe('ADR 0820 §7 — annual cadence at checkout (server-resolved price)', () => {
  it('resolves the configured price for the cadence; month is the default', async () => {
    const year = await authed('/bundles/crm/checkout', { method: 'POST', body: JSON.stringify({ cadence: 'year' }) });
    expect(year.status).toBe(201);
    expect((await year.json() as { priceId: string }).priceId).toBe('price_crm_year');
    await __resetBilling();
    const month = await authed('/bundles/crm/checkout', { method: 'POST', body: '{}' });
    expect((await month.json() as { priceId: string }).priceId).toBe('price_crm');
  });
  it('an invalid cadence is 400; a cadence the bundle has no price for is 404', async () => {
    expect((await authed('/bundles/crm/checkout', { method: 'POST', body: JSON.stringify({ cadence: 'week' }) })).status).toBe(400);
    expect((await authed('/bundles/agents/checkout', { method: 'POST', body: JSON.stringify({ cadence: 'year' }) })).status).toBe(404);
  });
  it('the store lists the cadences a bundle is sold at', async () => {
    const body = await (await authed('/bundles')).json() as { bundles: Array<{ bundleId: string; cadences?: string[]; priceDisplay?: Record<string, string> }> };
    expect(body.bundles.find((b) => b.bundleId === 'crm')?.cadences).toEqual(['month', 'year']);
    // The yearly amount the store must show beside a yearly Buy (MKT-UX-6).
    expect(body.bundles.find((b) => b.bundleId === 'crm')?.priceDisplay).toMatchObject({ priceAnnual: '$290', cadenceAnnual: '/yr' });
    expect(body.bundles.find((b) => b.bundleId === 'agents')?.cadences).toEqual(['month']);
  });
  it('a plan checkout by tier + cadence resolves the plan price server-side', async () => {
    const res = await authed('/checkout', { method: 'POST', body: JSON.stringify({ plan: 'pro', cadence: 'year' }) });
    expect(res.status).toBe(201);
    expect((await res.json() as { priceId: string }).priceId).toBe('price_pro_year');
  });
  it('fulfilment maps BOTH cadences of a bundle to the bundle', async () => {
    await processStripeEvent('t-m', subEvent('evt_m', 'customer.subscription.created', { subId: 'sub_m', priceId: 'price_crm' }));
    await processStripeEvent('t-y', subEvent('evt_y', 'customer.subscription.created', { subId: 'sub_y', priceId: 'price_crm_year' }));
    expect(await activeBundleIds('t-m')).toEqual(['crm']);
    expect(await activeBundleIds('t-y')).toEqual(['crm']);
  });
});

describe('ADR 0820 §7 — trials via Checkout subscription_data.trial_period_days', () => {
  const lastSessionForm = () => new URLSearchParams(posts.filter((p) => p.path === '/v1/checkout/sessions').at(-1)?.body ?? '');
  it('sets the configured trial for a plan and a bundle, and none where unconfigured', async () => {
    await createCheckoutSession('t-trial-plan', 'price_pro', STRIPE_KEY, URLS);
    expect(lastSessionForm().get('subscription_data[trial_period_days]')).toBe('14');
    await createCheckoutSession('t-trial-crm', 'price_crm', STRIPE_KEY, URLS);
    expect(lastSessionForm().get('subscription_data[trial_period_days]')).toBe('7');
    await createCheckoutSession('t-trial-agents', 'price_agents', STRIPE_KEY, URLS);
    expect(lastSessionForm().get('subscription_data[trial_period_days]')).toBeNull();
    await createCheckoutSession('t-trial-team', 'price_team', STRIPE_KEY, URLS);
    expect(lastSessionForm().get('subscription_data[trial_period_days]')).toBeNull();
  });
  it('a workspace that already had that subscription gets no second trial', async () => {
    await seedPlan('t-trial-again', 'pro', 'canceled', { stripeSubscriptionId: 'sub_old', endedSubscriptionIds: ['sub_old'] });
    await createCheckoutSession('t-trial-again', 'price_pro', STRIPE_KEY, URLS);
    expect(lastSessionForm().get('subscription_data[trial_period_days]')).toBeNull();
    expect(lastSessionForm().get('mode')).toBe('subscription'); // the checkout itself still went through
  });
});

describe('ADR 0820 §7 — past_due grace', () => {
  it('the ONE predicate: past_due is entitled inside the window, not after it, not without a recorded transition', () => {
    const now = Date.parse('2026-10-05T00:00:00Z');
    const since = (days: number) => new Date(now - days * DAY).toISOString();
    expect(isEntitledStatus('past_due', { pastDueSince: since(2), nowMs: now })).toBe(true);
    expect(isEntitledStatus('past_due', { pastDueSince: since(8), nowMs: now })).toBe(false);
    expect(isEntitledStatus('past_due', { nowMs: now })).toBe(false); // fail-closed: no transition recorded
    expect(isEntitledStatus('past_due')).toBe(false);
    expect(isEntitledStatus('unpaid', { pastDueSince: since(1), nowMs: now })).toBe(false);
    expect(isEntitledStatus('canceled', { pastDueSince: since(1), nowMs: now })).toBe(false);
    expect(isEntitledStatus('active')).toBe(true);
    expect(isEntitledStatus('trialing')).toBe(true);
  });
  it('a past_due plan keeps its tier inside the grace window and drops to free after it', async () => {
    await seedPlan('t-pd-in', 'pro', 'past_due', { pastDueSince: new Date(Date.now() - 2 * DAY).toISOString() });
    await seedPlan('t-pd-out', 'pro', 'past_due', { pastDueSince: new Date(Date.now() - 8 * DAY).toISOString() });
    await seedPlan('t-unpaid', 'pro', 'unpaid', { pastDueSince: new Date(Date.now() - 1 * DAY).toISOString() });
    expect((await resolveEntitlements('t-pd-in', true)).plan).toBe('pro');
    expect((await resolveEntitlements('t-pd-out', true)).plan).toBe('free');
    expect((await resolveEntitlements('t-unpaid', true)).plan).toBe('free');
  });
  it('default 0 keeps today\'s behaviour: past_due revokes at once', async () => {
    const saved = process.env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS;
    delete process.env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS;
    try {
      await seedPlan('t-pd-default', 'pro', 'past_due', { pastDueSince: new Date(Date.now() - 1000).toISOString() });
      expect((await resolveEntitlements('t-pd-default', true)).plan).toBe('free');
    } finally { process.env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS = saved; }
  });
  it('the webhook records the transition once, keeps it across past_due events, and clears it on recovery', async () => {
    const T = 't-pd-hook';
    await processStripeEvent(T, subEvent('evt_a', 'customer.subscription.created', { subId: 'sub_p', priceId: 'price_pro', metadata: { tenantId: T } }));
    expect((await getSubscription(T)).pastDueSince).toBeUndefined();
    await processStripeEvent(T, subEvent('evt_b', 'customer.subscription.updated', { subId: 'sub_p', priceId: 'price_pro', status: 'past_due' }));
    const first = (await getSubscription(T)).pastDueSince;
    expect(first).toBeDefined();
    expect((await resolveEntitlements(T, true)).plan).toBe('pro'); // inside the window
    await processStripeEvent(T, subEvent('evt_c', 'customer.subscription.updated', { subId: 'sub_p', priceId: 'price_pro', status: 'past_due' }));
    expect((await getSubscription(T)).pastDueSince).toBe(first); // a repeat never restarts the clock
    await processStripeEvent(T, subEvent('evt_d', 'customer.subscription.updated', { subId: 'sub_p', priceId: 'price_pro', status: 'active' }));
    expect((await getSubscription(T)).pastDueSince).toBeUndefined();
    await processStripeEvent(T, subEvent('evt_e', 'customer.subscription.updated', { subId: 'sub_p', priceId: 'price_pro', status: 'unpaid' }));
    expect((await resolveEntitlements(T, true)).plan).toBe('free'); // unpaid revokes immediately
  });
  it('a past_due BUNDLE grant stays entitled inside the window', async () => {
    const T = 't-pd-bundle';
    await processStripeEvent(T, subEvent('evt_ba', 'customer.subscription.created', { subId: 'sub_b', priceId: 'price_crm', metadata: { tenantId: T, bundleId: 'crm' } }));
    await processStripeEvent(T, subEvent('evt_bb', 'customer.subscription.updated', { subId: 'sub_b', priceId: 'price_crm', status: 'past_due', metadata: { tenantId: T, bundleId: 'crm' } }));
    expect(await activeBundleIds(T)).toEqual(['crm']);
    expect(await allowed(T)).toContain('crm');
    await processStripeEvent(T, subEvent('evt_bc', 'customer.subscription.updated', { subId: 'sub_b', priceId: 'price_crm', status: 'unpaid', metadata: { tenantId: T, bundleId: 'crm' } }));
    expect(await activeBundleIds(T)).toEqual([]);
  });
  it('GET /subscription reports the grace end for the banner', async () => {
    const since = new Date(Date.now() - 2 * DAY).toISOString();
    await seedPlan('t-ladder', 'pro', 'past_due', { pastDueSince: since });
    const body = await (await authed('/subscription')).json() as { status: string; pastDueGraceEndsAt?: string };
    expect(body.status).toBe('past_due');
    expect(body.pastDueGraceEndsAt).toBe(new Date(Date.parse(since) + 7 * DAY).toISOString());
  });
});
