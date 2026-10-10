/**
 * Strategy §8 — the paywall funnel, end to end through `createApp`.
 *
 *   1. Plan refusals are COUNTED at the one verdict (`entitlementGuard`): an HTTP
 *      route's plan 403 as `route`, a `resolveOne` `blockedBy:'plan'` as `lane`.
 *      Positive control: an entitled tenant is served and adds nothing.
 *   2. The SPA beacon (`POST …/analytics/paywall`) accepts impressions + clicks
 *      only while nav telemetry is ON; OFF it 404s and stores nothing. A client
 *      cannot add a `refusal`.
 *   3. `GET …/billing/admin/funnel` is superadmin-only (a customer is 403'd, the
 *      operator is served the same rows) and joins counts, the checkout ledger
 *      and live grants.
 *   4. Counting never throws, even when storage does.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { resolveOne, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { processStripeEvent } from '../src/features/billing/billingService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import {
  __bufferedPaywallKeys, __resetPaywallFunnel, flushPaywallCounts, listPaywallCounts, notePaywallEvent,
  type PaywallCountRow,
} from '../src/host/paywallFunnel.js';
import type { FunnelReport } from '../src/features/billing/funnelReport.js';

let server: http.Server;
let BASE: string;
const OPERATOR = 'user:op-funnel';
const FREE = 't-free-funnel';
const PAID = 't-paid-funnel';
let operator = '';
let free = '';
let paid = '';

async function login(email: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, tenantId }),
  });
  const h = res.headers as { getSetCookie?: () => string[] };
  for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
    const m = /(__session=[^;]+)/.exec(c); if (m) return m[1]!;
  }
  throw new Error(`login for ${tenantId} set no session cookie (${res.status})`);
}
const get = (cookie: string, path: string) => fetch(`${BASE}${path}`, { headers: { cookie } });
const post = (cookie: string, path: string, body: unknown) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const toggle = async (id: string, status: 'on' | 'off') => {
  const d = getToggleDefault(id);
  if (!d) return; // e.g. `users` is not registered as a toggle on every build
  await saveConfig({ ...d, status }, 'test');
};
const rows = async (tenantId: string): Promise<PaywallCountRow[]> => (await listPaywallCounts(7)).filter((r) => r.tenantId === tenantId);
const sum = (rs: PaywallCountRow[], metric: string, surface?: string) =>
  rs.filter((r) => r.metric === metric && (!surface || r.surface === surface)).reduce((n, r) => n + r.count, 0);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
  process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_agents: 'agents' });
  process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'billing', 'twin-recall', 'analytics']) await toggle(id, 'on');
  operator = await login('op@host.test', OPERATOR);
  free = await login('free@acme.test', FREE);
  paid = await login('paid@acme.test', PAID);
  await processStripeEvent(PAID, {
    id: 'evt_funnel_paid', type: 'customer.subscription.created',
    data: { object: { id: 'sub_funnel_paid', status: 'active', metadata: { tenantId: PAID, bundleId: 'agents' }, items: { data: [{ price: { id: 'price_agents' } }] } } },
  });
  await __resetPaywallFunnel();
});

afterAll(async () => {
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SUPERADMIN_TENANTS', 'OPENWOP_BILLING_BUNDLE_PRICES', 'OPENWOP_BILLING_PLAN_FEATURES']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

const twinGrants = (cookie: string) => get(cookie, '/host/openwop-app/profiles/me/twin-grants');

describe('strategy §8 — plan refusals are counted at the verdict', () => {
  it('a route plan 403 counts once per refusal under `route`; an entitled tenant adds nothing', async () => {
    expect((await twinGrants(free)).status).toBe(403);
    expect((await twinGrants(free)).status).toBe(403);
    const served = await twinGrants(paid); // positive control
    expect(served.status).not.toBe(403);
    expect(served.status).toBeLessThan(500);
    const mine = await rows(FREE);
    expect(sum(mine, 'refusal', 'route')).toBe(2);
    expect(mine.find((r) => r.metric === 'refusal')).toMatchObject({ featureId: 'twin-recall', bundleId: 'agents' });
    expect(await rows(PAID)).toEqual([]);
  });

  it('a resolveOne blockedBy:plan counts under `lane`', async () => {
    const before = sum(await rows(FREE), 'refusal', 'lane');
    expect((await resolveOne('twin-recall', { tenantId: FREE }))?.blockedBy).toBe('plan');
    expect((await resolveOne('twin-recall', { tenantId: PAID }))?.enabled).toBe(true);
    expect(sum(await rows(FREE), 'refusal', 'lane')).toBe(before + 1);
    expect(await rows(PAID)).toEqual([]);
  });

  it('counting never throws: bad input is refused, and a storage fault is swallowed', async () => {
    const hostile = { get tenantId(): string { throw new Error('boom'); } } as unknown as Parameters<typeof notePaywallEvent>[0];
    expect(() => notePaywallEvent(hostile)).not.toThrow();
    expect(notePaywallEvent(hostile)).toBe(false);
    expect(notePaywallEvent({ tenantId: FREE, metric: 'refusal', featureId: 'Not An Id!', surface: 'route' })).toBe(false);
    expect(notePaywallEvent({ tenantId: '', metric: 'refusal', featureId: 'crm', surface: 'route' })).toBe(false);

    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockRejectedValue(new Error('storage down'));
    try {
      expect(notePaywallEvent({ tenantId: FREE, metric: 'refusal', featureId: 'crm', surface: 'lane' })).toBe(true);
      await expect(flushPaywallCounts()).resolves.toBeUndefined();
    } finally { spy.mockRestore(); }
    await flushPaywallCounts();
  });

  it('many refusals of one key are ONE buffered entry (the hot path writes nothing)', async () => {
    await flushPaywallCounts();
    for (let i = 0; i < 25; i++) notePaywallEvent({ tenantId: 't-burst', metric: 'refusal', featureId: 'crm', surface: 'lane' });
    expect(__bufferedPaywallKeys()).toBe(1);
    expect(sum(await rows('t-burst'), 'refusal')).toBe(25);
  });
});

describe('strategy §8 — the SPA paywall beacon rides nav telemetry', () => {
  const beacon = (cookie: string, events: unknown) => post(cookie, '/host/openwop-app/analytics/paywall', { events });
  const sample = [
    { metric: 'impression', featureId: 'twin-recall', surface: 'sidebar' },
    { metric: 'impression', featureId: 'twin-recall', surface: 'locked-page' },
    { metric: 'click', featureId: 'twin-recall', surface: 'sidebar' },
  ];

  it('telemetry OFF: 404, and nothing is stored', async () => {
    await toggle('workspace-nav-telemetry', 'off');
    const res = await beacon(free, sample);
    expect(res.status).toBe(404);
    expect(sum(await rows(FREE), 'impression') + sum(await rows(FREE), 'click')).toBe(0);
  });

  it('telemetry ON: impressions + clicks recorded for a tenant the plan refuses; a client refusal and junk are dropped', async () => {
    await toggle('workspace-nav-telemetry', 'on');
    const res = await beacon(free, [
      ...sample,
      { metric: 'refusal', featureId: 'twin-recall', surface: 'route' }, // server-only metric
      { metric: 'impression', featureId: '../etc', surface: 'sidebar' },
      { metric: 'impression', featureId: 'twin-recall', surface: 'somewhere' },
      'nope',
    ]);
    expect(res.status).toBe(202);
    expect((await res.json() as { recorded: number }).recorded).toBe(3);
    const mine = await rows(FREE);
    expect(sum(mine, 'impression')).toBe(2);
    expect(sum(mine, 'click', 'sidebar')).toBe(1);
    expect(sum(mine, 'refusal', 'route')).toBe(2); // unchanged by the client's attempt
  });
});

describe('strategy §8 — GET billing/admin/funnel (superadmin)', () => {
  const path = (days?: string) => `/host/openwop-app/billing/admin/funnel${days ? `?days=${days}` : ''}`;

  it('refuses a customer and serves the operator', async () => {
    expect((await get(free, path('7'))).status).toBe(403);
    expect((await get(paid, path('30'))).status).toBe(403);
    const res = await get(operator, path('7'));
    expect(res.status).toBe(200);
  });

  it('serves 7, 30 and 90 days; rejects any other window', async () => {
    const r90 = await get(operator, path('90'));
    expect(r90.status).toBe(200);
    const body = await r90.json() as FunnelReport;
    expect(body.days).toBe(90);
    // the window is 90 UTC days INCLUDING today: since = 00:00 of today − 89 days
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime();
    expect(body.since).toBe(new Date(today - 89 * 86_400_000).toISOString());
    for (const bad of ['60', '0', 'abc', '91']) expect((await get(operator, path(bad))).status).toBe(400);
  });

  it('a 90-day window counts a day-89 row and drops a day-90 row', async () => {
    const counts = new DurableCollection<PaywallCountRow>('paywall:funnel-counts', (r) => `${r.day}::${r.tenantId}::${r.metric}::${r.product ?? r.featureId}::${r.surface}`);
    const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const base = { tenantId: 't-old', featureId: '', bundleId: 'crm', surface: 'billing' as const, product: 'bundle:crm', updatedAt: new Date().toISOString() };
    await counts.put({ ...base, day: dayAgo(89), metric: 'checkout-started', count: 2 });
    await counts.put({ ...base, day: dayAgo(90), metric: 'checkout-started', count: 50 });
    await counts.put({ ...base, day: dayAgo(45), metric: 'checkout-completed', count: 1 });
    const r90 = await (await get(operator, path('90'))).json() as FunnelReport;
    const r30 = await (await get(operator, path('30'))).json() as FunnelReport;
    const crm90 = r90.checkouts.find((c) => c.product === 'bundle:crm')!;
    expect(crm90).toMatchObject({ started: 2, completed: 1 });
    expect(r30.checkouts.find((c) => c.product === 'bundle:crm')).toBeUndefined();
    for (const r of [dayAgo(89), dayAgo(90), dayAgo(45)]) await counts.delete(`${r}::t-old::checkout-started::bundle:crm::billing`).catch(() => undefined);
    await counts.delete(`${dayAgo(45)}::t-old::checkout-completed::bundle:crm::billing`);
  });

  it('GET …/admin/funnel/weekly is superadmin-only: a customer is refused, the operator served', async () => {
    const weekly = '/host/openwop-app/billing/admin/funnel/weekly';
    expect((await get(free, weekly)).status).toBe(403);
    expect((await get(paid, weekly)).status).toBe(403);
    const res = await get(operator, weekly);
    expect(res.status).toBe(200);
    const body = await res.json() as { week: string; current: { totals: Record<string, number> }; previous: unknown; change: Record<string, unknown> };
    expect(body.week).toMatch(/^\d{4}-W\d{2}$/);
    expect(body.current.totals).toHaveProperty('grantsEnded');
    expect(body.change).toHaveProperty('impressions');
  });

  it('joins paywall counts, the checkout ledger and live grants per bundle', async () => {
    // The checkout ledger is billing's own `billing:checkout` (re-opened here the way
    // the demo seeders do): one live session started and paid, one started only, one demo.
    const ledger = new DurableCollection<Record<string, unknown>>('billing:checkout', (s) => String(s.sessionId));
    const now = new Date().toISOString();
    await ledger.put({ sessionId: 'cs_f1', url: '', priceId: 'price_agents', mode: 'live', createdAt: now, tenantId: FREE, kind: 'bundle', fulfilledAt: now });
    await ledger.put({ sessionId: 'cs_f2', url: '', priceId: 'price_agents', mode: 'live', createdAt: now, tenantId: FREE, kind: 'bundle' });
    await ledger.put({ sessionId: 'cs_f3', url: '', priceId: 'price_agents', mode: 'demo', createdAt: now, tenantId: FREE, kind: 'bundle' });

    const report = await (await get(operator, path('7'))).json() as FunnelReport;
    const agents = report.bundles.find((b) => b.bundleId === 'agents')!;
    expect(agents).toMatchObject({
      impressions: 2, clicks: 1, checkoutsStarted: 2, checkoutsCompleted: 1, activeGrants: 1,
      clickThroughRate: 0.5, checkoutCompletionRate: 0.5,
    });
    expect(agents.refusals).toBeGreaterThanOrEqual(3); // 2 route + ≥1 lane
    expect(agents.refusedTenants).toBe(1); // only FREE was ever refused twin-recall
    expect(report.checkouts.find((c) => c.product === 'bundle:agents')).toMatchObject({ started: 2, completed: 1, demoStarted: 1 });
    const twin = report.features.find((f) => f.featureId === 'twin-recall')!;
    expect(twin.surfaces.sidebar).toEqual({ impressions: 1, clicks: 1, refusals: 0 });
    // no user/session identifier anywhere in the operator read
    expect(JSON.stringify(report)).not.toMatch(/free@acme|principal|userId|sessionId/);
  });
});
