/**
 * Order bumps at checkout (ADR 0296 / Funnel C, Phase 1):
 *  - the public guest checkout accepts `bumps` and prices them into the SAME
 *    single order/charge, with route-derived `origin:'bump'` line provenance;
 *  - a client cannot mark arbitrary cart lines as bumps (origin is never read
 *    from `lines`); bumps cap at 5;
 *  - the ADR 0294 funnel stamp rides the same request (`funnel:{funnelId,stepId}`
 *    → order.funnelRef, both-or-nothing);
 *  - promotions still evaluate over the WHOLE order (a bump can push the cart
 *    over a threshold promotion).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getOrder } from '../src/features/commerce/commerceService.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'promotions']) {
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

async function shop() {
  const owner = client();
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: `bump-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = login.body.user?.tenantId ?? '';
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Bump Shop' });
  const orgId: string = org.body.orgId;
  const c = (suffix: string): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;
  const main = await owner.post(c('/products'), { type: 'digital', name: 'Course', price: 100, currency: 'USD' });
  const bump = await owner.post(c('/products'), { type: 'digital', name: 'Workbook', price: 20, currency: 'USD' });
  return { owner, tenantId, orgId, mainId: main.body.productId as string, bumpId: bump.body.productId as string, c };
}

const checkout = (orgId: string): string => `/v1/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`;

describe('ADR 0296 P1 — order bumps in the public checkout', () => {
  it('prices accepted bumps into the single order with route-derived origin + the funnel stamp', async () => {
    const { tenantId, orgId, mainId, bumpId } = await shop();
    const guest = client();
    const res = await guest.post(checkout(orgId), {
      email: `guest-${n++}@x.test`,
      lines: [{ productId: mainId, quantity: 1 }],
      bumps: [{ productId: bumpId }],
      funnel: { funnelId: 'fn-1', stepId: 'st-checkout' },
    });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(120); // 100 + the 20 bump, ONE charge
    const order = await getOrder(tenantId, orgId, res.body.orderId);
    expect(order?.items).toHaveLength(2);
    const bumpLine = order?.items.find((i) => i.productId === bumpId);
    expect(bumpLine?.origin).toBe('bump');
    expect(order?.items.find((i) => i.productId === mainId)?.origin).toBeUndefined();
    expect(order?.funnelRef).toEqual({ funnelId: 'fn-1', stepId: 'st-checkout' });
  });

  it('never trusts client-marked line origins and caps bumps at 5', async () => {
    const { tenantId, orgId, mainId, bumpId } = await shop();
    const guest = client();
    const res = await guest.post(checkout(orgId), {
      email: `guest-${n++}@x.test`,
      // hostile client marks its own cart line as a bump — must be ignored
      lines: [{ productId: mainId, quantity: 1, origin: 'bump' }],
      bumps: Array.from({ length: 6 }, () => ({ productId: bumpId })),
    });
    expect(res.status).toBe(201);
    const order = await getOrder(tenantId, orgId, res.body.orderId);
    expect(order?.items.find((i) => i.productId === mainId)?.origin).toBeUndefined();
    const bumpLines = order?.items.filter((i) => i.origin === 'bump') ?? [];
    expect(bumpLines.reduce((s, i) => s + i.quantity, 0)).toBe(5); // 6th dropped
  });

  it('promotions evaluate over the whole order — a bump pushes the cart over a threshold', async () => {
    const { owner, tenantId, orgId, mainId, bumpId } = await shop();
    const promo = await owner.post(`/v1/host/openwop-app/promotions/orgs/${encodeURIComponent(orgId)}/promotions`, {
      name: '10% over $110', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, minSpend: 110,
    });
    expect(promo.status).toBe(201);
    const guest = client();
    // without the bump: 100 < 110 ⇒ no discount
    const bare = await guest.post(checkout(orgId), { email: `g-${n++}@x.test`, lines: [{ productId: mainId, quantity: 1 }] });
    expect(bare.body.total).toBe(100);
    // with the bump: 120 ≥ 110 ⇒ 10% off the whole order
    const bumped = await guest.post(checkout(orgId), { email: `g-${n++}@x.test`, lines: [{ productId: mainId, quantity: 1 }], bumps: [{ productId: bumpId }] });
    expect(bumped.body.total).toBe(108);
    const order = await getOrder(tenantId, orgId, bumped.body.orderId);
    expect(order?.appliedPromotions?.[0]?.type).toBe('cart_threshold');
  });
});
