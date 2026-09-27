/**
 * Merchandising program (ADR 0273/0274/0275) — ROUTE harness: closes the biggest
 * verification gap in the code assessment (DEBT-1 / MA-1 / MB-2 / MC-2) — toggle
 * gating, authed CRUD, RBAC (viewer denied), the promotion hook firing through the
 * REAL commerce order route, and the PUBLIC IDOR invariants that are only observable
 * at the HTTP boundary:
 *   - `/public-recommendations/:orgId/resolve` ignores a client `contactId` and a
 *     segment-targeted placement is inert on the public route (no personalization leak);
 *   - `/public-discovery/:orgId/search` is active-only + honors the toggle.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
let n = 0;
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
async function ownerWithMember(role: string): Promise<{ owner: ReturnType<typeof client>; member: ReturnType<typeof client>; orgId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client(); await owner.post('/v1/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client(); const mr = await member.post('/v1/host/openwop-app/test/login', { email: `co-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' }); const orgId = org.body.orgId;
  await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: mr.body.user.userId, roles: [role] });
  return { owner, member, orgId };
}
const commerce = (orgId: string, s = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;
const reco = (orgId: string, s = ''): string => `/v1/host/openwop-app/recommendations/orgs/${encodeURIComponent(orgId)}${s}`;
const promo = (orgId: string, s = ''): string => `/v1/host/openwop-app/promotions/orgs/${encodeURIComponent(orgId)}${s}`;
const disc = (orgId: string, s = ''): string => `/v1/host/openwop-app/discovery/orgs/${encodeURIComponent(orgId)}${s}`;
const mkProduct = (cl: ReturnType<typeof client>, orgId: string, name: string, price: number, cats: string[] = ['photo']): Promise<Res> =>
  cl.post(commerce(orgId, '/products'), { type: 'physical', name, price, currency: 'USD', inventory: 100, categories: cats });

describe('recommendations — routes', () => {
  it('404s when off; owner can write, viewer cannot (RBAC)', async () => {
    await enable('recommendations', 'off');
    const { owner, member, orgId } = await ownerWithMember('viewer');
    expect((await owner.get(reco(orgId, '/placements'))).status).toBe(404);
    await enable('recommendations', 'on');
    const created = await owner.post(reco(orgId, '/placements'), { slot: 'pdp', source: 'upsell' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await member.post(reco(orgId, '/placements'), { slot: 'cart', source: 'cross_sell' })).status).toBe(403); // viewer denied
  });

  it('public resolve ignores a client contactId and returns active products only (upsell)', async () => {
    await enable('recommendations', 'on'); await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const a = await mkProduct(owner, orgId, 'Cheap', 50);
    await mkProduct(owner, orgId, 'Pricey', 120);
    await owner.post(reco(orgId, '/placements'), { slot: 'pdp', source: 'upsell' });
    const path = `/v1/host/openwop-app/public-recommendations/${encodeURIComponent(orgId)}/resolve?slot=pdp&productId=${a.body.productId}`;
    const plain = await owner.get(path);
    expect(plain.status).toBe(200);
    expect(plain.body.products.length).toBeGreaterThan(0); // Pricey (higher, same category)
    // Passing a contactId must NOT change the public result (no personalization surface).
    const withContact = await owner.get(`${path}&contactId=someone-elses-id`);
    expect(withContact.body.products.map((p: any) => p.productId)).toEqual(plain.body.products.map((p: any) => p.productId));
  });

  it('a segment-targeted placement is inert on the public route (no leak)', async () => {
    await enable('recommendations', 'on'); await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const a = await mkProduct(owner, orgId, 'Cheap', 50);
    await mkProduct(owner, orgId, 'Pricey', 120);
    await owner.post(reco(orgId, '/placements'), { slot: 'pdp', source: 'upsell', segmentId: 'seg-x' });
    const res = await owner.get(`/v1/host/openwop-app/public-recommendations/${encodeURIComponent(orgId)}/resolve?slot=pdp&productId=${a.body.productId}`);
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(0); // targeted ⇒ inert for an anonymous public caller
  });

  it('public resolve returns empty when the toggle is off (no error leak)', async () => {
    const { owner, orgId } = await ownerWithMember('owner');
    await enable('recommendations', 'off');
    const res = await owner.get(`/v1/host/openwop-app/public-recommendations/${encodeURIComponent(orgId)}/resolve?slot=pdp`);
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(0);
    await enable('recommendations', 'on');
  });
});

describe('promotions — routes + hook through the real order path', () => {
  it('404s off; owner writes; viewer denied; a cart_threshold discount applies through createOrder', async () => {
    await enable('promotions', 'off');
    const { owner, member, orgId } = await ownerWithMember('viewer');
    expect((await owner.get(promo(orgId, '/promotions'))).status).toBe(404);
    await enable('promotions', 'on'); await enable('commerce', 'on');
    const p = await owner.post(promo(orgId, '/promotions'), { name: '10% over $50', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, minSpend: 50 });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect((await member.post(promo(orgId, '/promotions'), { name: 'x', type: 'cart_threshold', reward: { kind: 'percentage', value: 5 }, minSpend: 1 })).status).toBe(403);
    // End-to-end: the promotion hook fires through the real commerce order route.
    const prod = await mkProduct(owner, orgId, 'Widget', 100);
    const order = await owner.post(commerce(orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.discount).toBe(10);
    expect(order.body.total).toBe(90);
  });

  it('the ROUTE carries `currency` — without it the whole denomination fix is inert', async () => {
    // R2 PRO2-P1 (review B2) — the service captured `currency` and the engine enforced
    // it, and the POST route dropped the field: every production row stayed
    // currency-less, took the `!p.currency` back-compat escape, and the engine behaved
    // exactly as before. A unit test on the service cannot see this; only the wire can.
    await enable('promotions', 'on'); await enable('commerce', 'on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const created = await owner.post(promo(orgId, '/promotions'), {
      name: 'USD only', type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 50, currency: 'USD',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.promotion.currency).toBe('USD');

    // …and the PATCH carries the loss budget, which was likewise unreachable (P-4/B3).
    const budgeted = await owner.post(promo(orgId, '/promotions'), {
      name: 'Leader', type: 'loss_leader', reward: { kind: 'percentage', value: 50 },
      scope: { all: true }, budget: { maxDiscount: 500 }, currency: 'USD',
    });
    expect(budgeted.status, JSON.stringify(budgeted.body)).toBe(201);
    const patched = await owner.patch(promo(orgId, `/promotions/${encodeURIComponent(budgeted.body.promotion.promotionId)}`), { budget: { maxDiscount: 200 } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.promotion.budget.maxDiscount).toBe(200);
  });
});

describe('discovery — routes', () => {
  it('404s off; owner writes; viewer denied; public search is active-only + toggle-honoring', async () => {
    await enable('discovery', 'off');
    const { owner, member, orgId } = await ownerWithMember('viewer');
    expect((await owner.get(disc(orgId, '/collections'))).status).toBe(404);
    await enable('discovery', 'on'); await enable('commerce', 'on');
    const col = await owner.post(disc(orgId, '/collections'), { name: 'Photo gear', type: 'dynamic', rule: { categories: ['photo'] } });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    expect((await member.post(disc(orgId, '/collections'), { name: 'x', type: 'manual' })).status).toBe(403);
    await mkProduct(owner, orgId, 'Camera', 100);
    const search = await owner.get(`/v1/host/openwop-app/public-discovery/${encodeURIComponent(orgId)}/search?q=Camera`);
    expect(search.status).toBe(200);
    expect(search.body.products.length).toBeGreaterThan(0);
    // R2 PD2-3 (review B1) — the honest counts must reach the WIRE. They were computed,
    // typed and consumed, and the route simply never sent them: the console's optional
    // fields fell back to `products.length` (the page cap) and rendered the original
    // defect. The frontend test mocks the client, so only a route-level assertion can
    // see this — "a mock of what you integrate with can't prove the integration".
    expect(search.body.total).toBe(search.body.products.length);
    expect(search.body.truncated).toBe(false);
    // …and the PUBLIC route must NOT leak how much the merchant's rules suppress.
    expect(search.body.hiddenByRules).toBeUndefined();
    // The OPERATOR route carries the full set, including the hidden-by-rules count.
    const opSearch = await owner.get(disc(orgId, '/search?q=Camera'));
    expect(opSearch.status).toBe(200);
    expect(opSearch.body.total).toBe(opSearch.body.products.length);
    expect(opSearch.body.hiddenByRules).toBe(0);
    await enable('discovery', 'off');
    const off = await owner.get(`/v1/host/openwop-app/public-discovery/${encodeURIComponent(orgId)}/search?q=Camera`);
    expect(off.body.products).toHaveLength(0);
    await enable('discovery', 'on');
  });
});
