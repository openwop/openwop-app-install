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
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createProduct, createOrder, cancelOrder } from '../src/features/commerce/commerceService.js';
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

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post('/v1/host/openwop-app/test/login', { email: `fp3-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Funnel Co' });
  return { user, orgId: org.body.orgId, tenantId: login.body.user?.tenantId ?? '' };
}

const authed = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels${suffix}`;
const pub = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels${suffix}`;

async function publishedPage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<string> {
  const created = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${created.body.pageId}/publish`);
  return created.body.pageId;
}

describe('funnels Phase 3 — rollups + revenue join', () => {
  it('derives step views/completions from events and revenue from funnelRef orders; route computes conversion', async () => {
    const { user, orgId, tenantId } = await marketer();
    const landing = await publishedPage(user, orgId, 'P3 Landing');
    const checkout = await publishedPage(user, orgId, 'P3 Checkout');
    const created = await user.post(authed(orgId), {
      name: 'Revenue Path', slug: 'revenue-path',
      steps: [
        { stepId: 'p3-landing', kind: 'landing', pageId: landing },
        { stepId: 'p3-checkout', kind: 'checkout', pageId: checkout },
      ],
    });
    const funnelId: string = created.body.funnel.funnelId;
    await user.post(authed(orgId, `/${funnelId}/publish`));

    // visitor traffic: 3 views of landing (2 visitors), 1 completion → checkout
    const v = client();
    const vk = `p3v-${Date.now()}`;
    await v.get(pub(orgId, `/revenue-path?vk=${vk}`));
    await v.get(pub(orgId, `/revenue-path?vk=${vk}2`));
    await v.get(pub(orgId, `/revenue-path?vk=${vk}`));
    await v.get(pub(orgId, `/revenue-path/next?from=p3-landing&vk=${vk}`)); // completes landing, views checkout

    // orders: two stamped orders (75 + 150), one canceled (excluded)
    const prod = await createProduct({ tenantId, orgId, createdBy: 'u', type: 'digital', name: 'Course', price: 75, currency: 'USD' });
    await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }], funnelRef: { funnelId, stepId: 'p3-checkout' } });
    await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 2 }], funnelRef: { funnelId, stepId: 'p3-checkout' } });
    const canceled = await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }], funnelRef: { funnelId, stepId: 'p3-checkout' } });
    await cancelOrder(tenantId, orgId, canceled.orderId);
    // unstamped order — never joins
    await createOrder({ tenantId, orgId, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }] });

    const rows = await rebuildFunnelStats(tenantId, orgId);
    expect(rows).toBeGreaterThan(0);

    const stats = await user.get(authed(orgId, `/${funnelId}/stats`));
    expect(stats.status).toBe(200);
    const landingRow = stats.body.steps.find((s: { stepId: string }) => s.stepId === 'p3-landing');
    const checkoutRow = stats.body.steps.find((s: { stepId: string }) => s.stepId === 'p3-checkout');
    // VP-R2-1 (round 2): counts are DISTINCT VISITORS, not raw events — the
    // fixture's 3 landing views come from 2 visitors (one repeat), and raw
    // counting is what double-counted the old client's double-load and the
    // sink+/next completion pair.
    expect(landingRow.views).toBe(2);
    expect(landingRow.completions).toBe(1);
    expect(landingRow.conversion).toBeCloseTo(0.5, 2);
    expect(checkoutRow.views).toBe(1);
    expect(checkoutRow.orders).toBe(2);           // canceled excluded
    expect(checkoutRow.revenue).toBe(225);        // 75 + 150
    // VP-R2-4 — revenue carries its currency dimension (the sum stays bare).
    expect(checkoutRow.revenueByCurrency).toEqual({ USD: 225 });
    expect(stats.body.eventWindow).toBeGreaterThan(0);

    // rebuild route (write scope) works and is idempotent
    const rb = await user.post(authed(orgId, `/${funnelId}/stats/rebuild`));
    expect(rb.status).toBe(200);
    const again = await user.get(authed(orgId, `/${funnelId}/stats`));
    expect(again.body.steps.find((s: { stepId: string }) => s.stepId === 'p3-checkout').revenue).toBe(225);
  });

  it('full recompute drops stale day rows and tolerates removed steps; cross-tenant 404', async () => {
    const { user, orgId, tenantId } = await marketer();
    const page = await publishedPage(user, orgId, 'P3 Solo');
    const created = await user.post(authed(orgId), {
      name: 'Prunable', slug: 'prunable',
      steps: [{ stepId: 'pr-a', kind: 'landing', pageId: page }],
    });
    const funnelId: string = created.body.funnel.funnelId;
    await user.post(authed(orgId, `/${funnelId}/publish`));
    const v = client();
    await v.get(pub(orgId, `/prunable?vk=prune-${Date.now()}`));
    await rebuildFunnelStats(tenantId, orgId);
    expect((await getFunnelStats(tenantId, orgId, funnelId)).length).toBe(1);

    // remove the step (edit to a different one) — history shows as kind:'removed'
    const page2 = await publishedPage(user, orgId, 'P3 Solo B');
    await user.post(authed(orgId, `/${funnelId}/unpublish`));
    await user.patch(authed(orgId, `/${funnelId}`), { steps: [{ stepId: 'pr-b', kind: 'landing', pageId: page2 }] });
    const stats = await user.get(authed(orgId, `/${funnelId}/stats`));
    const removed = stats.body.steps.find((s: { stepId: string }) => s.stepId === 'pr-a');
    expect(removed.kind).toBe('removed');
    expect(removed.views).toBe(1);

    // GC-FN-1 — DELETING the funnel must let the next rebuild drop its day
    // rows (they were permanent orphans before the fix)
    await user.del(authed(orgId, `/${funnelId}`));
    await rebuildFunnelStats(tenantId, orgId);
    expect((await getFunnelStats(tenantId, orgId, funnelId)).length).toBe(0);

    // another tenant cannot read stats (membership/tenant guard)
    const { user: stranger } = await marketer();
    expect([403, 404]).toContain((await stranger.get(authed(orgId, `/${funnelId}/stats`))).status);
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
    const created = await user.post(authed(orgId), {
      name: 'CTA Funnel', slug: 'cta-funnel',
      steps: [{ stepId: 'only', kind: 'landing', pageId }],
    });
    const funnelId: string = created.body.funnel.funnelId;

    // valid saves (label bounded at 80 by cleanString truncation)
    const ok = await user.patch(authed(orgId, `/${funnelId}`), { completionCta: { label: 'Get the guide', url: 'https://example.com/guide' } });
    expect(ok.status).toBe(200);
    expect(ok.body.funnel.completionCta).toEqual({ label: 'Get the guide', url: 'https://example.com/guide' });

    // served on the public complete payload
    await user.post(authed(orgId, `/${funnelId}/publish`));
    const next = await client().get(pub(orgId, '/cta-funnel/next?from=only'));
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
    const after = await user.get(authed(orgId, `/${funnelId}`));
    expect(after.body.funnel.completionCta).toEqual({ label: 'Get the guide', url: 'https://example.com/guide' });

    // omit preserves; null clears
    const untouched = await user.patch(authed(orgId, `/${funnelId}`), { name: 'CTA Funnel Renamed?' });
    expect(untouched.body.funnel.completionCta).toBeTruthy();
    const cleared = await user.patch(authed(orgId, `/${funnelId}`), { completionCta: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.funnel.completionCta).toBeUndefined();
  });
});
