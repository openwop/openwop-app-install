/**
 * Strategy §8 follow-up (ADR 0820 §7 note, the funnel digest):
 *
 *   1. Checkouts started / completed are DAILY COUNTS in `paywall:funnel-counts`,
 *      written where the `billing:checkout` ledger is written. A completed
 *      checkout counts ONCE — the count rides the ledger row's `fulfilledAt`
 *      compare-and-swap, so a redelivered event (same id) or a second event for
 *      the same session (completed + async_payment_succeeded) adds nothing.
 *   2. Bundle grants started / ended are counted on the CAS that changes the
 *      grant, so a redelivered subscription event never double-counts churn.
 *   3. The weekly summary is OFF by default, and sent ONCE per ISO week even when
 *      two runners (two instances, a redeploy) race on the same week.
 *   4. The week-over-week arithmetic: a change with no previous value is null.
 *
 * Unit-level: real memory storage (claimOnce + the durable collections), a mock
 * Stripe API for the live checkout leg.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetBilling, createCheckoutSession, processStripeEvent, listCheckoutsSince } from '../src/features/billing/billingService.js';
import { __resetPaywallFunnel, listPaywallCounts, type PaywallCountRow } from '../src/host/paywallFunnel.js';
import {
  processWeeklyFunnelSummary, weekOverWeek, buildWeekOverWeek, isoWeekOf, WEEKLY_SUMMARY_ENV,
} from '../src/features/billing/funnelWeeklySummary.js';
import type { FunnelReport } from '../src/features/billing/funnelReport.js';

const KEY = 'sk_test_digest';
const T = 't-digest';
let stripe: http.Server;
let storage: Storage;
const paid = new Set<string>();
let seq = 0;

const sum = (rs: PaywallCountRow[], metric: string, product?: string) =>
  rs.filter((r) => r.metric === metric && (!product || r.product === product)).reduce((n, r) => n + r.count, 0);

beforeAll(async () => {
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_crm: 'crm', price_agents: 'agents' });
  process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_pro: 'pro' });
  stripe = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && url === '/v1/customers') return send(200, { id: `cus_${++seq}` });
      if (req.method === 'POST' && url === '/v1/checkout/sessions') { const id = `cs_dig_${++seq}`; return send(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` }); }
      const sm = /^\/v1\/checkout\/sessions\/([^?]+)/.exec(url);
      if (req.method === 'GET' && sm) { const id = decodeURIComponent(sm[1]!); return send(200, { id, payment_status: paid.has(id) ? 'paid' : 'unpaid', customer: 'cus_x', metadata: { tenantId: T } }); }
      return send(404, { error: { message: `unmocked ${req.method} ${url}` } });
    });
  });
  await new Promise<void>((r) => stripe.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_STRIPE_API_BASE = `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const k of ['OPENWOP_BILLING_BUNDLE_PRICES', 'OPENWOP_BILLING_PLAN_PRICES', 'OPENWOP_STRIPE_API_BASE', WEEKLY_SUMMARY_ENV, 'OPENWOP_SUPERADMIN_TENANTS']) delete process.env[k];
  await new Promise<void>((r) => stripe.close(() => r()));
});
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetBilling();
  await __resetPaywallFunnel();
});
afterEach(() => { __resetHostExtPersistence(); delete process.env[WEEKLY_SUMMARY_ENV]; });

const urls = { successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no' };
const completed = (id: string, sessionId: string, type = 'checkout.session.completed') => ({
  id, type, data: { object: { id: sessionId, payment_status: 'paid', customer: 'cus_x', metadata: { tenantId: T } } },
});

describe('checkout counts', () => {
  it('a live checkout counts started once at creation; a demo one counts apart', async () => {
    const live = await createCheckoutSession(T, 'price_crm', KEY, urls);
    expect(live.mode).toBe('live');
    await createCheckoutSession('t-demo', 'price_agents', null);
    const rows = await listPaywallCounts(1);
    expect(sum(rows, 'checkout-started', 'bundle:crm')).toBe(1);
    expect(rows.find((r) => r.metric === 'checkout-started')).toMatchObject({ tenantId: T, bundleId: 'crm', product: 'bundle:crm' });
    expect(sum(rows, 'checkout-demo', 'bundle:agents')).toBe(1);
    expect(sum(rows, 'checkout-started', 'bundle:agents')).toBe(0);
    // the ledger row is marked counted, so the read never adds it a second time
    const [ledgerRow] = (await listCheckoutsSince('1970-01-01')).filter((c) => c.product === 'bundle:crm');
    expect(ledgerRow).toMatchObject({ startedCounted: true });
  });

  it('a completed checkout counts ONCE under redelivery and a second event for the same session', async () => {
    const s = await createCheckoutSession(T, 'price_crm', KEY, urls);
    paid.add(s.sessionId);
    // three DIFFERENT events for one session racing (the event-id dedup cannot help),
    // the same event id redelivered concurrently, then sequential redeliveries
    await Promise.all([
      processStripeEvent(T, completed('evt_dig_1', s.sessionId), { stripeKey: KEY }),
      processStripeEvent(T, completed('evt_dig_2', s.sessionId, 'checkout.session.async_payment_succeeded'), { stripeKey: KEY }),
      processStripeEvent(T, completed('evt_dig_3', s.sessionId), { stripeKey: KEY }),
      processStripeEvent(T, completed('evt_dig_1', s.sessionId), { stripeKey: KEY }),
    ]);
    await processStripeEvent(T, completed('evt_dig_1', s.sessionId), { stripeKey: KEY });
    await processStripeEvent(T, completed('evt_dig_4', s.sessionId), { stripeKey: KEY });
    const rows = await listPaywallCounts(1);
    expect(sum(rows, 'checkout-completed', 'bundle:crm')).toBe(1);
    expect(sum(rows, 'checkout-started', 'bundle:crm')).toBe(1);
  });

  it('an unpaid completion counts nothing (positive control: the paid one above counts)', async () => {
    const s = await createCheckoutSession(T, 'price_crm', KEY, urls);
    await processStripeEvent(T, { ...completed('evt_dig_unpaid', s.sessionId), data: { object: { id: s.sessionId, payment_status: 'unpaid', metadata: { tenantId: T } } } }, { stripeKey: KEY });
    expect(sum(await listPaywallCounts(1), 'checkout-completed')).toBe(0);
  });
});

describe('grant transitions (churn going forward)', () => {
  const sub = (id: string, type: string, status: string) => ({
    id, type, data: { object: { id: 'sub_dig', status, metadata: { tenantId: T, bundleId: 'crm' }, items: { data: [{ price: { id: 'price_crm' } }] } } },
  });
  it('a grant counts started once, a cancellation once, under redelivery', async () => {
    await processStripeEvent(T, sub('evt_g1', 'customer.subscription.created', 'active'));
    await processStripeEvent(T, sub('evt_g2', 'customer.subscription.updated', 'active')); // no transition
    await processStripeEvent(T, sub('evt_g1', 'customer.subscription.created', 'active')); // redelivery
    let rows = await listPaywallCounts(1);
    expect(sum(rows, 'grant-started', 'bundle:crm')).toBe(1);
    expect(sum(rows, 'grant-ended', 'bundle:crm')).toBe(0);
    await processStripeEvent(T, sub('evt_g3', 'customer.subscription.deleted', 'canceled'));
    await processStripeEvent(T, sub('evt_g4', 'customer.subscription.deleted', 'canceled')); // a second delete event
    rows = await listPaywallCounts(1);
    expect(sum(rows, 'grant-ended', 'bundle:crm')).toBe(1);
    expect(sum(rows, 'grant-started', 'bundle:crm')).toBe(1);
  });

  it('a past_due recovery on the same subscription is not a new grant', async () => {
    await processStripeEvent(T, sub('evt_r1', 'customer.subscription.created', 'active'));
    await processStripeEvent(T, sub('evt_r2', 'customer.subscription.updated', 'past_due'));
    await processStripeEvent(T, sub('evt_r3', 'customer.subscription.updated', 'active'));
    const rows = await listPaywallCounts(1);
    expect(sum(rows, 'grant-started')).toBe(1);
    expect(sum(rows, 'grant-ended')).toBe(0);
  });
});

describe('weekly summary', () => {
  // Monday 2026-10-12 09:00Z: the summary covers ISO week 2026-W41 (Mon 10-05 … Sun 10-11).
  const MONDAY = new Date('2026-10-12T09:00:00.000Z');

  it('the week key is deterministic: the ISO week that just ended', () => {
    expect(isoWeekOf(new Date('2026-10-11T23:59:59.000Z'))).toBe('2026-W41');
    expect(isoWeekOf(new Date('2026-10-05T00:00:00.000Z'))).toBe('2026-W41');
    expect(isoWeekOf(new Date('2027-01-01T00:00:00.000Z'))).toBe('2026-W53');
  });

  it('is OFF by default: nothing is claimed or sent', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = 'user:op-digest';
    const sent: unknown[] = [];
    expect(await processWeeklyFunnelSummary({ storage, emit: async (n) => { sent.push(n); } }, MONDAY)).toBe('disabled');
    expect(sent).toEqual([]);
    // and turning it on later still sends that week (nothing was claimed while off)
    process.env[WEEKLY_SUMMARY_ENV] = 'true';
    expect(await processWeeklyFunnelSummary({ storage, emit: async (n) => { sent.push(n); } }, MONDAY)).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('two concurrent runners send ONCE per week; the next week sends again', async () => {
    process.env[WEEKLY_SUMMARY_ENV] = 'true';
    process.env.OPENWOP_SUPERADMIN_TENANTS = 'user:op-digest, ws:ops-team';
    const sent: Array<{ tenantId: string; recipientRole?: string; type: string; metadata?: Record<string, unknown> }> = [];
    const emit = async (n: (typeof sent)[number]) => { sent.push(n); };
    const outcomes = await Promise.all([
      processWeeklyFunnelSummary({ storage, emit }, MONDAY),
      processWeeklyFunnelSummary({ storage, emit }, new Date(MONDAY.getTime() + 1000)),
    ]);
    expect(outcomes.sort()).toEqual(['already-sent', 'sent']);
    // one notification per listed operator workspace; a shared one is role-addressed
    expect(sent.map((n) => n.tenantId).sort()).toEqual(['user:op-digest', 'ws:ops-team']);
    expect(sent.find((n) => n.tenantId === 'ws:ops-team')?.recipientRole).toBe('admin');
    expect(sent[0]!.metadata).toMatchObject({ week: '2026-W41' });
    // later in the same week (a redeploy): nothing more
    expect(await processWeeklyFunnelSummary({ storage, emit }, new Date('2026-10-15T12:00:00.000Z'))).toBe('already-sent');
    expect(sent).toHaveLength(2);
    // the next week
    expect(await processWeeklyFunnelSummary({ storage, emit }, new Date('2026-10-19T01:00:00.000Z'))).toBe('sent');
    expect(sent).toHaveLength(4);
  });

  it('with no operator listed, nothing is claimed (a later listing still gets the week)', async () => {
    process.env[WEEKLY_SUMMARY_ENV] = 'true';
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    const sent: unknown[] = [];
    expect(await processWeeklyFunnelSummary({ storage, emit: async (n) => { sent.push(n); } }, MONDAY)).toBe('no-recipients');
    process.env.OPENWOP_SUPERADMIN_TENANTS = 'user:op-digest';
    expect(await processWeeklyFunnelSummary({ storage, emit: async (n) => { sent.push(n); } }, MONDAY)).toBe('sent');
  });

  it('reads the counts of the two weeks it compares', async () => {
    const s = await createCheckoutSession(T, 'price_crm', KEY, urls);
    expect(s.mode).toBe('live');
    const wow = await weekOverWeek(new Date());
    expect(wow.current.totals.checkoutsStarted).toBe(1);
    expect(wow.previous.totals.checkoutsStarted).toBe(0);
    expect(wow.change.checkoutsStarted).toBeNull(); // nothing to compare with
  });
});

describe('week-over-week arithmetic', () => {
  const report = (t: Partial<FunnelReport['totals']>, bundles: Array<{ bundleId: string; grantsStarted: number; grantsEnded: number }> = []): FunnelReport => ({
    days: 7, since: 's', until: 'u', features: [], checkouts: [], plans: [],
    bundles: bundles.map((b) => ({ ...b, impressions: 0, clicks: 0, refusals: 0, refusedTenants: 0, checkoutsStarted: 0, checkoutsCompleted: 0, activeGrants: 0, clickThroughRate: null, checkoutCompletionRate: null })),
    totals: { impressions: 0, clicks: 0, refusals: 0, checkoutsStarted: 0, checkoutsCompleted: 0, demoCheckouts: 0, grantsStarted: 0, grantsEnded: 0, ...t },
  });
  it('change = (now − before) ÷ before, null with no previous value', () => {
    const w = buildWeekOverWeek('2026-W41', report({ impressions: 120, clicks: 6, refusals: 3 }, [{ bundleId: 'crm', grantsStarted: 2, grantsEnded: 1 }]),
      report({ impressions: 100, clicks: 8, refusals: 0 }, [{ bundleId: 'agents', grantsStarted: 1, grantsEnded: 0 }]));
    expect(w.change.impressions).toBe(0.2);
    expect(w.change.clicks).toBe(-0.25);
    expect(w.change.refusals).toBeNull();
    expect(w.bundles).toEqual([
      { bundleId: 'agents', grantsStarted: 0, grantsEnded: 0, previousGrantsStarted: 1, previousGrantsEnded: 0 },
      { bundleId: 'crm', grantsStarted: 2, grantsEnded: 1, previousGrantsStarted: 0, previousGrantsEnded: 0 },
    ]);
  });
});
