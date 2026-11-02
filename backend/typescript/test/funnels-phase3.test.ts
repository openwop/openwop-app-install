/**
 * Funnels Phase 3 (ADR 0294 / Funnel A) — derived analytics rollups + the
 * revenue join:
 *  - rebuild derives per-step/day views+completions from the CDP event spine
 *    and revenue/orders from funnelRef-stamped, non-canceled orders (refunds
 *    subtract; canceled orders excluded);
 *  - the rollup is a self-correcting FULL recompute (stale day rows dropped);
 *  - the authed stats route orders steps funnel-order, computes conversion,
 *    tolerates removed-step history, and 404s across tenants;
 *  - createOrder accepts the additive funnelRef contract (both ids or nothing).
 *
 * TST-DEB-5 — red when: repeat views are not deduped per visitor, a canceled
 * order joins, a refund stops subtracting, a deleted funnel's day rows survive a
 * rebuild, a partial funnelRef is stamped, or the completion CTA accepts a
 * non-http(s)/non-internal URL or ignores an explicit null clear. Amounts are
 * cent-sensitive (74.99 × 1 + 74.99 × 2 − 25.37 refunded = 199.60 = 19960 minor
 * units), so a dropped cent or an un-subtracted refund changes the asserted value.
 * Cross-tenant stats is a DOUBLE GUARD (the org gate `assertOrgScope` answers
 * "Organization not found." before the stats read's own tenant scope); the case
 * asserts the outer guard's exact refusal.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createProduct, createOrder, cancelOrder, markAsPaid, partialRefundOrder } from '../src/features/commerce/commerceService.js';
import { rebuildFunnelStats, getFunnelStats } from '../src/features/funnels/funnelStats.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'funnels', 'cdp', 'commerce']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface StepRow { stepId: string; kind: string; views: number; completions: number; conversion: number; orders: number; revenue: number; revenueByCurrency: Record<string, number> }
interface StatsBody { steps: StepRow[]; eventWindow: number }
interface Cta { label: string; url: string }
interface FunnelBody { funnel: { funnelId: string; completionCta?: Cta } }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const text = res.status === 204 ? '' : await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
}
const row = (stats: Res<StatsBody>, stepId: string): StepRow => {
  const r = stats.body.steps.find((s) => s.stepId === stepId);
  expect(r, `no stats row for ${stepId}`).toBeDefined();
  return r!;
};
/** Major → integer minor units, read off the RESPONSE (never computed by the rollup). */
const cents = (major: number): number => Math.round(major * 100);

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post<{ user?: { tenantId: string } }>('/host/openwop-app/test/login', { email: `fp3-${Date.now()}-${n++}@acme.test` });
  const org = await user.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Funnel Co' });
  return { user, orgId: org.body.orgId, tenantId: login.body.user?.tenantId ?? '' };
}

const authed = (orgId: string, suffix = ''): string => `/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels${suffix}`;
const pub = (orgId: string, suffix = ''): string => `/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels${suffix}`;

async function publishedPage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<string> {
  const created = await user.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${created.body.pageId}/publish`);
  return created.body.pageId;
}

describe('funnels Phase 3 — rollups + revenue join', () => {
  it('derives step views/completions from events and revenue from funnelRef orders; route computes conversion', async () => {
    const { user, orgId, tenantId } = await marketer();
    const landing = await publishedPage(user, orgId, 'P3 Landing');
    const checkout = await publishedPage(user, orgId, 'P3 Checkout');
    const created = await user.post<FunnelBody>(authed(orgId), {
      name: 'Revenue Path', slug: 'revenue-path',
      steps: [
        { stepId: 'p3-landing', kind: 'landing', pageId: landing },
        { stepId: 'p3-checkout', kind: 'checkout', pageId: checkout },
      ],
    });
    const funnelId = created.body.funnel.funnelId;
    await user.post(authed(orgId, `/${funnelId}/publish`));

    // visitor traffic: 3 views of landing (2 visitors), 1 completion → checkout
    const v = client();
    const vk = `p3v-${Date.now()}`;
    await v.get(pub(orgId, `/revenue-path?vk=${vk}`));
    await v.get(pub(orgId, `/revenue-path?vk=${vk}2`));
    await v.get(pub(orgId, `/revenue-path?vk=${vk}`));
    await v.get(pub(orgId, `/revenue-path/next?from=p3-landing&vk=${vk}`)); // completes landing, views checkout

    // orders: two stamped orders (74.99 + 149.98), the second partly refunded
    // (−25.37); one canceled (excluded); one unstamped (never joins).
    const prod = await createProduct({ tenantId, orgId, createdBy: 'u', type: 'digital', name: 'Course', price: 74.99, currency: 'USD' });
    await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }], funnelRef: { funnelId, stepId: 'p3-checkout' } });
    const refunded = await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 2 }], funnelRef: { funnelId, stepId: 'p3-checkout' } });
    await markAsPaid(tenantId, orgId, refunded.orderId, 'demo:p3', { actor: 'test' });
    const afterRefund = await partialRefundOrder(tenantId, orgId, refunded.orderId, 25.37, { refundKey: 'p3-refund-1', actor: 'test' });
    expect(cents(afterRefund!.refundedAmount ?? 0)).toBe(2537);
    const canceled = await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }], funnelRef: { funnelId, stepId: 'p3-checkout' } });
    await cancelOrder(tenantId, orgId, canceled.orderId);
    // unstamped order — never joins
    await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }] });

    const rows = await rebuildFunnelStats(tenantId, orgId);
    expect(rows).toBeGreaterThan(0); // the per-step numbers below are the claim

    const stats = await user.get<StatsBody>(authed(orgId, `/${funnelId}/stats`));
    expect(stats.status).toBe(200);
    const landingRow = row(stats, 'p3-landing');
    const checkoutRow = row(stats, 'p3-checkout');
    // VP-R2-1 (round 2): counts are DISTINCT VISITORS, not raw events — the
    // fixture's 3 landing views come from 2 visitors (one repeat), and raw
    // counting is what double-counted the old client's double-load and the
    // sink+/next completion pair.
    expect(landingRow.views).toBe(2);
    expect(landingRow.completions).toBe(1);
    expect(landingRow.conversion).toBeCloseTo(0.5, 2);
    expect(checkoutRow.views).toBe(1);
    expect(checkoutRow.orders).toBe(2);                 // canceled excluded
    expect(cents(checkoutRow.revenue)).toBe(19960);     // 7499 + 14998 − 2537
    // VP-R2-4 — revenue carries its currency dimension (the sum stays bare).
    expect(Object.keys(checkoutRow.revenueByCurrency)).toEqual(['USD']);
    expect(cents(checkoutRow.revenueByCurrency.USD!)).toBe(19960);
    expect(stats.body.eventWindow).toBeGreaterThan(0);

    // rebuild route (write scope) works and is idempotent
    const rb = await user.post(authed(orgId, `/${funnelId}/stats/rebuild`));
    expect(rb.status).toBe(200);
    const again = await user.get<StatsBody>(authed(orgId, `/${funnelId}/stats`));
    expect(cents(row(again, 'p3-checkout').revenue)).toBe(19960);
  });

  it('full recompute drops stale day rows and tolerates removed steps; cross-tenant 404', async () => {
    const { user, orgId, tenantId } = await marketer();
    const page = await publishedPage(user, orgId, 'P3 Solo');
    const created = await user.post<FunnelBody>(authed(orgId), {
      name: 'Prunable', slug: 'prunable',
      steps: [{ stepId: 'pr-a', kind: 'landing', pageId: page }],
    });
    const funnelId = created.body.funnel.funnelId;
    await user.post(authed(orgId, `/${funnelId}/publish`));
    const v = client();
    await v.get(pub(orgId, `/prunable?vk=prune-${Date.now()}`));
    await rebuildFunnelStats(tenantId, orgId);
    expect((await getFunnelStats(tenantId, orgId, funnelId)).length).toBe(1);

    // remove the step (edit to a different one) — history shows as kind:'removed'
    const page2 = await publishedPage(user, orgId, 'P3 Solo B');
    await user.post(authed(orgId, `/${funnelId}/unpublish`));
    await user.patch(authed(orgId, `/${funnelId}`), { steps: [{ stepId: 'pr-b', kind: 'landing', pageId: page2 }] });
    const stats = await user.get<StatsBody>(authed(orgId, `/${funnelId}/stats`));
    const removed = row(stats, 'pr-a');
    expect(removed.kind).toBe('removed');
    expect(removed.views).toBe(1);

    // GC-FN-1 — DELETING the funnel must let the next rebuild drop its day
    // rows (they were permanent orphans before the fix)
    await user.del(authed(orgId, `/${funnelId}`));
    await rebuildFunnelStats(tenantId, orgId);
    expect((await getFunnelStats(tenantId, orgId, funnelId)).length).toBe(0);

    // another tenant cannot read stats (membership/tenant guard)
    const { user: stranger } = await marketer();
    const foreign = await stranger.get<{ error: string; message: string }>(authed(orgId, `/${funnelId}/stats`));
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ error: 'not_found', message: 'Organization not found.' });
  });

  it('funnelRef contract: partial stamps are dropped (both ids or nothing)', async () => {
    const { orgId, tenantId } = await marketer();
    const prod = await createProduct({ tenantId, orgId, createdBy: 'u', type: 'digital', name: 'Thing', price: 10, currency: 'USD' });
    const o1 = await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }], funnelRef: { funnelId: 'only-one' } });
    expect(o1.funnelRef).toBeUndefined();
    const o2 = await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }], funnelRef: { funnelId: 'f', stepId: 's' } });
    expect(o2.funnelRef).toEqual({ funnelId: 'f', stepId: 's' });
  });
});

describe('R2 VP-R2-3 — completionCta coercion (R2R F4: invalid is a 400, never silent data loss)', () => {
  it('saves a valid CTA, serves it on complete, 400s garbage, preserves on omit, clears on null', async () => {
    const { user, orgId } = await marketer();
    const pageId = await publishedPage(user, orgId, 'CTA Landing');
    const created = await user.post<FunnelBody>(authed(orgId), {
      name: 'CTA Funnel', slug: 'cta-funnel',
      steps: [{ stepId: 'only', kind: 'landing', pageId }],
    });
    const funnelId = created.body.funnel.funnelId;

    // valid saves (label bounded at 80 by cleanString truncation)
    const ok = await user.patch<FunnelBody>(authed(orgId, `/${funnelId}`), { completionCta: { label: 'Get the guide', url: 'https://example.com/guide' } });
    expect(ok.status).toBe(200);
    expect(ok.body.funnel.completionCta).toEqual({ label: 'Get the guide', url: 'https://example.com/guide' });

    // served on the public complete payload
    await user.post(authed(orgId, `/${funnelId}/publish`));
    const next = await client().get<{ complete: boolean; completionCta?: Cta }>(pub(orgId, '/cta-funnel/next?from=only'));
    expect(next.body.complete).toBe(true);
    expect(next.body.completionCta).toEqual({ label: 'Get the guide', url: 'https://example.com/guide' });

    // garbage is a 400 AND the stored CTA survives (no silent delete)
    for (const bad of [
      { label: 'Evil', url: 'javascript:alert(1)' },
      { label: 'Proto', url: '//evil.example' },
      { label: '', url: 'https://example.com' },
      { label: 'No url', url: '' },
      { label: 'Ftp', url: 'ftp://example.com' },
    ]) {
      const r = await user.patch(authed(orgId, `/${funnelId}`), { completionCta: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const after = await user.get<FunnelBody>(authed(orgId, `/${funnelId}`));
    expect(after.body.funnel.completionCta).toEqual({ label: 'Get the guide', url: 'https://example.com/guide' });

    // omit preserves; null clears
    const untouched = await user.patch<FunnelBody>(authed(orgId, `/${funnelId}`), { name: 'CTA Funnel Renamed?' });
    expect(untouched.body.funnel.completionCta).toEqual({ label: 'Get the guide', url: 'https://example.com/guide' });
    const cleared = await user.patch<FunnelBody>(authed(orgId, `/${funnelId}`), { completionCta: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.funnel.completionCta).toBeUndefined();
  });
});
