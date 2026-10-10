/**
 * CORRECTED 2026-10-06 (PR #4481 review): prod sets OPENWOP_BILLING_PLAN_FEATURES and
 * lists newly priced bundles on the FREE plan as a complimentary notice period. So
 * `includedInPlan` means an ENTITLED PAID plan covers the bundle; a free-list cover is
 * `freeForNow`; and `purchasable` says whether checkout would actually succeed (the
 * server refuses any plan cover, the free plan included, with a 409).
 *
 * ADR 0820 §7 UI — the store facts the redesigned feature store renders beside
 * `owned` / `includedInPlan` (`features/billing/billingService.ts` `bundleStore`):
 *
 *  - `freeForNow`: a PRICED bundle the workspace neither owns nor has through its
 *    plan, whose features it may use today anyway because no plan allowlist
 *    narrows it (the paywall is off). The moment an operator narrows the plan,
 *    the same bundle stops being free — the positive control in each test.
 *  - `trialDays`: the trial a checkout of this bundle would open with FOR THIS
 *    workspace — absent for a one-time bundle and after any grant row, exactly the
 *    `trialFor` eligibility, so the store never promises a trial checkout refuses.
 *
 * Isolated env — its own app boot.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __resetBilling, bundleStore, importBillingState, processStripeEvent } from '../src/features/billing/billingService.js';

const ENV_KEYS = [
  'OPENWOP_BILLING_BUNDLE_PRICES', 'OPENWOP_BILLING_PLAN_FEATURES', 'OPENWOP_BILLING_TRIAL_DAYS',
  'OPENWOP_BILLING_BUNDLE_ONETIME', 'OPENWOP_SUPERADMIN_TENANTS',
];
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_crm: 'crm', price_job: 'job-search', price_agents: 'agents' });
  process.env.OPENWOP_BILLING_TRIAL_DAYS = JSON.stringify({ 'bundle:crm': 7, 'bundle:job-search': 5 });
  process.env.OPENWOP_BILLING_BUNDLE_ONETIME = JSON.stringify(['job-search']);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => { delete process.env.OPENWOP_BILLING_PLAN_FEATURES; delete process.env.OPENWOP_SUPERADMIN_TENANTS; await __resetBilling(); });
const seedPlan = (tenantId: string, planTier: 'pro' | 'team', status: 'active' | 'canceled') =>
  importBillingState({ subscriptions: [{ tenantId, planTier, status, updatedAt: new Date().toISOString() }] });

const store = async (tenantId: string) => new Map((await bundleStore(tenantId)).map((b) => [b.bundleId, b]));

describe('freeForNow — priced, but nothing paywalls it yet', () => {
  it('with no plan allowlist a priced bundle is free for now; narrowing the free plan ends it (control)', async () => {
    const open = await store('t-free');
    expect(open.get('crm')).toMatchObject({ forSale: true, owned: false, includedInPlan: false, freeForNow: true });
    // An UNPRICED bundle is not "free for now" — it is simply not sold.
    expect(open.get('studio')?.forSale).toBe(false);
    expect(open.get('studio')?.freeForNow).toBe(false);

    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
    const narrowed = await store('t-free');
    expect(narrowed.get('crm')?.freeForNow).toBe(false);
    expect(narrowed.get('crm')?.includedInPlan).toBe(false);
  });

  it('PROD SHAPE — the FREE plan list covers a priced bundle (complimentary period): freeForNow, NOT included, NOT purchasable', async () => {
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing', 'bundle:crm'], pro: ['bundle:crm', 'bundle:agents'] });
    const s = await store('t-free');
    expect(s.get('crm')).toMatchObject({ forSale: true, includedInPlan: false, freeForNow: true, purchasable: false });
    // Control: same tenant, a priced bundle the free list does not cover — buyable.
    expect(s.get('agents')).toMatchObject({ includedInPlan: false, freeForNow: false, purchasable: true });
  });

  it('an ENTITLED paid plan that covers the bundle reads includedInPlan (and a lapsed one does not)', async () => {
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'], pro: ['bundle:agents'] });
    await seedPlan('t-pro', 'pro', 'active');
    const s = await store('t-pro');
    expect(s.get('agents')).toMatchObject({ includedInPlan: true, freeForNow: false, purchasable: false });
    expect(s.get('crm')).toMatchObject({ includedInPlan: false, freeForNow: false, purchasable: true }); // control
    await seedPlan('t-lapsed', 'pro', 'canceled');
    expect((await store('t-lapsed')).get('agents')).toMatchObject({ includedInPlan: false, freeForNow: false, purchasable: true });
  });

  it('no plan allowlist at all ⇒ free for now AND still purchasable (the server has nothing to refuse)', async () => {
    expect((await store('t-open')).get('crm')).toMatchObject({ freeForNow: true, includedInPlan: false, purchasable: true });
  });

  it('the superadmin bypass never makes a bundle "free for now" (control: the same config for a free-list cover does)', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = 't-op';
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing', 'bundle:agents'] });
    const s = await store('t-op');
    expect(s.get('crm')).toMatchObject({ freeForNow: false, includedInPlan: false, purchasable: true });
    expect(s.get('agents')?.freeForNow).toBe(true);
  });

  it('an owned bundle is owned, never freeForNow', async () => {
    await processStripeEvent('t-own', {
      id: 'evt_own', type: 'customer.subscription.created',
      data: { object: { id: 'sub_own', status: 'active', metadata: { tenantId: 't-own', bundleId: 'crm' }, items: { data: [{ price: { id: 'price_crm' } }] } } },
    });
    const s = await store('t-own');
    expect(s.get('crm')).toMatchObject({ owned: true, freeForNow: false, purchasable: false });
    expect(s.get('agents')?.freeForNow).toBe(true); // control: the unowned one still is
  });
});

describe('trialDays — the trial THIS workspace would get', () => {
  it('a recurring bundle with configured days shows them; a one-time bundle and an unconfigured one do not', async () => {
    const s = await store('t-trial');
    expect(s.get('crm')?.trialDays).toBe(7);
    expect(s.get('job-search')?.trialDays).toBeUndefined(); // one-time: checkout never trials
    expect(s.get('agents')?.trialDays).toBeUndefined(); // no days configured
  });

  it('after any grant row for the bundle the trial is gone (no endless trials)', async () => {
    await processStripeEvent('t-had', {
      id: 'evt_had', type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_had', status: 'canceled', metadata: { tenantId: 't-had', bundleId: 'crm' }, items: { data: [{ price: { id: 'price_crm' } }] } } },
    });
    expect((await store('t-had')).get('crm')?.trialDays).toBeUndefined();
    expect((await store('t-new')).get('crm')?.trialDays).toBe(7); // control: a fresh workspace
  });
});
