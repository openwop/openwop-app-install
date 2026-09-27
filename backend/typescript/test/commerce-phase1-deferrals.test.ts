/**
 * ADR 0238 — Phase 1 commerce deferrals:
 *  - DEF-7 partial refunds: happy path (paid → partially_refunded, refundedAmount),
 *    idempotency by refundKey, over-refund guard, repeat partials → refunded,
 *    the refund ledger, and that the shipped full-refund path is untouched;
 *  - DEF-1 tax/shipping seam: a flat governance tax rate + flat shipping fold into
 *    the order (taxTotal/shippingCost/taxLines) at create; no config ⇒ byte-identical
 *    (no tax/shipping fields); the summary nets partial refunds.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm']) {
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
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `p1-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = r.body.user?.tenantId ?? '';
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;

async function paidOrder(owner: ReturnType<typeof client>, orgId: string, price = 100): Promise<string> {
  const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Guide', price, currency: 'USD' });
  const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
  const paid = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
  expect(paid.status).toBe(200);
  return o.body.orderId;
}

describe('DEF-7 — partial refunds', () => {
  it('applies a partial refund: status → partially_refunded, refundedAmount set, ledger recorded', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    const r = await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 30, refundKey: 'k1' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('partially_refunded');
    expect(r.body.refundedAmount).toBe(30);
    const led = await owner.get(c(orgId, `/orders/${encodeURIComponent(orderId)}/refunds`));
    expect(led.body.refunds).toHaveLength(1);
    expect(led.body.refunds[0].amount).toBe(30);
  });

  it('is idempotent by refundKey — a retry does not double-refund', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 40, refundKey: 'dup' });
    const again = await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 40, refundKey: 'dup' });
    expect(again.status).toBe(200);
    expect(again.body.refundedAmount).toBe(40); // NOT 80
    const led = await owner.get(c(orgId, `/orders/${encodeURIComponent(orderId)}/refunds`));
    expect(led.body.refunds).toHaveLength(1);
  });

  it('rejects an over-refund (amount beyond the remaining balance)', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 80, refundKey: 'a' });
    const over = await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 30, refundKey: 'b' });
    expect(over.status).toBe(409);
  });

  it('repeat partials accumulate and flip to refunded when the full charge is reached', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 60, refundKey: 'x' });
    const last = await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 40, refundKey: 'y' });
    expect(last.status).toBe(200);
    expect(last.body.status).toBe('refunded');
    expect(last.body.refundedAmount).toBe(100);
  });

  it('leaves the shipped full-refund path intact (paid → refunded, restores)', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    const r = await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/refund`), {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('refunded');
    expect(r.body.refundedAmount).toBe(100);
  });

  it('concurrent same-refundKey requests fold exactly once (no double-count)', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    const [a, b] = await Promise.all([
      owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 50, refundKey: 'race' }),
      owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 50, refundKey: 'race' }),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    const led = await owner.get(c(orgId, `/orders/${encodeURIComponent(orderId)}/refunds`));
    expect(led.body.refunds).toHaveLength(1); // one ledger row
    const list = await owner.get(c(orgId, '/orders'));
    const fresh = (list.body.orders as any[]).find((o) => o.orderId === orderId);
    expect(fresh.refundedAmount).toBe(50); // NOT 100
  });

  it('concurrent DIFFERENT-key partials cannot over-refund a manual order (no Stripe backstop)', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100); // demo:pi ⇒ provider none
    const [a, b] = await Promise.all([
      owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 100, refundKey: 'k-a' }),
      owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 100, refundKey: 'k-b' }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const rejected = [a, b].filter((r) => r.status === 409);
    expect(oks).toHaveLength(1);   // exactly one succeeds
    expect(rejected).toHaveLength(1); // the other is clamped
    const list = await owner.get(c(orgId, '/orders'));
    const fresh = (list.body.orders as any[]).find((o) => o.orderId === orderId);
    expect(fresh.refundedAmount).toBe(100); // never 200
  });

  it('rejects a partial refund with a missing/invalid amount', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    const bad = await owner.post(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 0, refundKey: 'z' });
    expect(bad.status).toBe(400);
  });
});

describe('DEF-1 — tax/shipping seam (flat/manual default)', () => {
  it('no provider + no flat config ⇒ order carries NO tax/shipping (byte-identical)', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Plain', price: 50, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(o.body.taxTotal).toBeUndefined();
    expect(o.body.shippingCost).toBeUndefined();
    expect(o.body.total).toBe(50);
  });

  it('a flat governance tax rate + flat shipping fold into the order at create', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { flatTaxRatePercent: 10, flatShippingMinor: 500 } }, 'test');
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Boxed', price: 100, currency: 'USD', inventory: 5 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: { line1: '1 Main', city: 'Town', country: 'US' } });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(o.body.taxTotal).toBe(10);      // 10% of 100
    expect(o.body.shippingCost).toBe(5);   // 500 minor = $5
    expect(o.body.taxLines?.[0]?.amount).toBe(10);
  });
});
