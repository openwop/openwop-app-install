/**
 * ADR 1097 — `GET …/billing/trial-offer`, the read behind the public `/start-trial`
 * entry. It says what a checkout of one plan tier or bundle would give the
 * caller's workspace BEFORE a session exists, so the page never claims a trial
 * the checkout will not send.
 *
 * Controls (each refusal has a positive control in the same file):
 *  1. PARITY — an `available` offer's days are exactly the
 *     `subscription_data[trial_period_days]` the ONE checkout then sends, and a
 *     `trial_used` offer matches a checkout that sends none (both read `trialFor`).
 *  2. STATES — not_for_sale / no_trial / trial_used / already_subscribed /
 *     included_in_plan, each from the real billing rows.
 *  3. CARD — `cardRequired` follows `OPENWOP_BILLING_TRIAL_CARD` per target.
 *  4. GATES — the billing toggle (404), the ONE billing-write authority
 *     (`host:billing:manage`: an editor is 403, an anon session is 403), and
 *     strict query validation (400). `checkout` is `demo` without a Stripe key.
 *
 * Sabotage witnesses (authoring, recorded in ADR 1097 §6): making `trialOffer`
 * skip the `trialFor` repeat check (use `configured` instead of `days`) reds the
 * `trial_used` case; dropping `requireBillingManage` from the route reds the
 * anon and editor cases.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { setSecret } from '../src/byok/secretResolver.js';
import {
  __resetBilling, importBillingState, createCheckoutSession, type Subscription,
} from '../src/features/billing/billingService.js';

const STRIPE_KEY = 'sk_test_trial_offer';
const ENV_KEYS = [
  'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_BILLING_PLAN_PRICES', 'OPENWOP_BILLING_PLAN_PRICE_CADENCE',
  'OPENWOP_BILLING_BUNDLE_PRICES', 'OPENWOP_BILLING_PLAN_FEATURES', 'OPENWOP_BILLING_TRIAL_DAYS',
  'OPENWOP_BILLING_TRIAL_CARD', 'OPENWOP_STRIPE_API_BASE',
];
const B = '/host/openwop-app/billing';

let server: http.Server;
let stripe: http.Server;
let BASE = '';
const sessionForms: URLSearchParams[] = [];
let seq = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro', price_pro_year: 'pro', price_team: 'team' });
  process.env.OPENWOP_BILLING_PLAN_PRICE_CADENCE = JSON.stringify({ price_pro_year: 'year' });
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_crm: 'crm', price_agents: 'agents' });
  // team includes crm, so a team workspace's crm offer is `included_in_plan`.
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'], team: ['billing', 'bundle:crm'] });
  process.env.OPENWOP_BILLING_TRIAL_DAYS = JSON.stringify({ 'plan:pro': 7, 'bundle:crm': 14 });
  process.env.OPENWOP_BILLING_TRIAL_CARD = JSON.stringify({ 'bundle:crm': 'if_required' });

  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && url === '/v1/customers') return send(200, { id: `cus_${++seq}` });
      if (req.method === 'POST' && url === '/v1/checkout/sessions') {
        sessionForms.push(new URLSearchParams(raw));
        const id = `cs_offer_${++seq}`;
        return send(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      return send(404, { error: { message: `unmocked ${req.method} ${url}` } });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'billing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => stripe.close(() => res()));
});
beforeEach(async () => { await __resetBilling(); sessionForms.length = 0; await setSecret('billing:stripe-key', ''); });

async function login(subject: string, tenantId: string, sharedWorkspace = false): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace }),
  });
  expect(res.status).toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
/** A solo user in their own personal workspace (admitted by the billing authority). */
const solo = (name: string) => login(`oidc:${name}`, `user:${name}`);
const offer = (cookie: string, query: string) => fetch(`${BASE}${B}/trial-offer?${query}`, { headers: { cookie } });
const offerJson = async (cookie: string, query: string) => {
  const res = await offer(cookie, query);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json() as Promise<{ status: string; target: string; cadence: string; trialDays?: number; cardRequired?: boolean; checkout: string }>;
};
const seedPlan = (tenantId: string, planTier: Subscription['planTier'], status: Subscription['status'], extra: Partial<Subscription> = {}) =>
  importBillingState({ subscriptions: [{ tenantId, planTier, status, updatedAt: new Date().toISOString(), ...extra }] });

describe('ADR 1097 — available offers match the checkout the ONE client sends', () => {
  it('plan:pro offers the configured 7 days with a card, and the live checkout sends exactly 7', async () => {
    await setSecret('billing:stripe-key', STRIPE_KEY);
    const cookie = await solo('to-pro');
    const o = await offerJson(cookie, 'plan=pro');
    expect(o).toMatchObject({ status: 'available', target: 'plan:pro', cadence: 'month', trialDays: 7, cardRequired: true, checkout: 'live' });
    const res = await fetch(`${BASE}${B}/checkout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'pro' }) });
    expect(res.status).toBe(201);
    expect((await res.json() as { trialDays?: number }).trialDays).toBe(7);
    expect(sessionForms.at(-1)?.get('subscription_data[trial_period_days]')).toBe(String(o.trialDays));
  });
  it('bundle:crm under TRIAL_CARD=if_required says no card is needed; the yearly plan cadence resolves too', async () => {
    const cookie = await solo('to-crm');
    expect(await offerJson(cookie, 'bundle=crm')).toMatchObject({ status: 'available', target: 'bundle:crm', trialDays: 14, cardRequired: false, checkout: 'demo' });
    expect(await offerJson(cookie, 'plan=pro&cadence=year')).toMatchObject({ status: 'available', cadence: 'year', trialDays: 7 });
  });
});

describe('ADR 1097 — every state that is not a trial is named, never claimed as one', () => {
  it('not_for_sale: an unpriced plan, an unknown bundle, a cadence with no price', async () => {
    const cookie = await solo('to-nfs');
    expect((await offerJson(cookie, 'plan=enterprise')).status).toBe('not_for_sale');
    expect((await offerJson(cookie, 'bundle=no-such-bundle')).status).toBe('not_for_sale');
    expect((await offerJson(cookie, 'bundle=crm&cadence=year')).status).toBe('not_for_sale');
  });
  it('no_trial: priced, but no trial configured for it', async () => {
    const cookie = await solo('to-none');
    const team = await offerJson(cookie, 'plan=team');
    expect(team.status).toBe('no_trial');
    expect(team.trialDays).toBeUndefined();
    expect((await offerJson(cookie, 'bundle=agents')).status).toBe('no_trial');
  });
  it('trial_used: a workspace that had the plan before gets no second trial, and neither does its checkout', async () => {
    await setSecret('billing:stripe-key', STRIPE_KEY);
    const cookie = await solo('to-used');
    await seedPlan('user:to-used', 'pro', 'canceled', { stripeSubscriptionId: 'sub_old', endedSubscriptionIds: ['sub_old'] });
    const o = await offerJson(cookie, 'plan=pro');
    expect(o.status).toBe('trial_used');
    expect(o.trialDays).toBeUndefined();
    // Parity: the checkout reads the same `trialFor` and sends no trial either.
    await createCheckoutSession('user:to-used', 'price_pro', STRIPE_KEY, { successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
    expect(sessionForms.at(-1)?.get('subscription_data[trial_period_days]')).toBeNull();
  });
  it('already_subscribed: an open plan, or an entitled bundle grant', async () => {
    const cookie = await solo('to-live');
    await seedPlan('user:to-live', 'pro', 'active', { stripeSubscriptionId: 'sub_live' });
    expect((await offerJson(cookie, 'plan=pro')).status).toBe('already_subscribed');
    expect((await offerJson(cookie, 'plan=team')).status).toBe('already_subscribed'); // a second plan is never sold
  });
  it('included_in_plan: the plan already grants the bundle (checkout would 409)', async () => {
    const cookie = await solo('to-incl');
    await seedPlan('user:to-incl', 'team', 'active', { stripeSubscriptionId: 'sub_team' });
    expect((await offerJson(cookie, 'bundle=crm')).status).toBe('included_in_plan');
  });
});

describe('ADR 1097 — the offer is gated exactly like checkout', () => {
  it('400 on neither, both, or an unknown plan; 400 on a bad cadence', async () => {
    const cookie = await solo('to-400');
    for (const q of ['', 'plan=pro&bundle=crm', 'plan=free', 'plan=platinum', 'plan=pro&cadence=week']) {
      expect((await offer(cookie, q)).status, q).toBe(400);
    }
    expect((await offer(cookie, 'plan=pro')).status).toBe(200); // positive control
  });
  it('an anonymous session is refused (sign in first)', async () => {
    const anon = await login('oidc:to-anon', 'anon:sid-1097');
    const res = await offer(anon, 'plan=pro');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('anonymous_session');
  });
  it('an EDITOR of a shared workspace is refused with host:billing:manage; an ADMIN is admitted', async () => {
    const ws = await createWorkspace({ name: 'ADR 1097 workspace', ownerSubject: 'oidc:to-owner' });
    const WS = ws.orgId ?? ws.tenantId;
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, 'oidc:to-admin'), roles: ['admin'] });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, 'oidc:to-editor'), roles: ['editor'] });
    const refused = await offer(await login('oidc:to-editor', WS, true), 'plan=pro');
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('host:billing:manage');
    expect((await offer(await login('oidc:to-admin', WS, true), 'plan=pro')).status).toBe(200);
  });
  it('404 while the billing toggle is off', async () => {
    const cookie = await solo('to-off');
    const d = getToggleDefault('billing')!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect((await offer(cookie, 'plan=pro')).status).toBe(404);
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
    expect((await offer(cookie, 'plan=pro')).status).toBe(200);
  });
});
