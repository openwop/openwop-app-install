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
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import type { Order, Product, RefundLedgerEntry } from '../src/features/commerce/commerceService.js';

function portOf(s: http.Server): number {
  const a = s.address();
  if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
  return a.port;
}
let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${portOf(server)}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The host error envelope (`middleware/errorEnvelope.ts`). */
interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
interface Res<T> { status: number; body: T }
interface Client {
  get: <T = ErrBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrBody>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  // The ONE deserialization boundary: `res.json()` is untyped, so each call site names the
  // body it expects (the product's exported row type where one exists, else a narrow local
  // interface). A 204 / non-JSON body reads as `null`.
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    const text = await res.text();
    let out: T;
    try { out = JSON.parse(text || 'null'); } catch { out = JSON.parse('null'); }
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}
/** Login + org bodies (the test-auth and orgs routes). */
interface LoginBody extends ErrBody { user: { userId: string; tenantId: string } }
interface OrgBody extends ErrBody { orgId: string }
async function shopOwner(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `p1-${Date.now()}-${n++}@acme.test` });
  const tenantId = r.body.user.tenantId;
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId };
}
/** Money truth reads the PERSISTED row (a fresh GET), never the write's own response. */
async function storedOrder(owner: Client, orgId: string, orderId: string): Promise<Order> {
  const r = await owner.get<Order>(`/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/orders/${encodeURIComponent(orderId)}`);
  expect(r.status).toBe(200);
  return r.body;
}
const c = (orgId: string, suffix = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;

async function paidOrder(owner: Client, orgId: string, price = 100, extra: Record<string, unknown> = { type: 'digital' }): Promise<string> {
  const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), { name: 'Guide', price, currency: 'USD', ...extra });
  const o = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
  const paid = await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
  expect(paid.status).toBe(200);
  return o.body.orderId;
}

describe('DEF-7 — partial refunds', () => {
  it('applies a partial refund: status → partially_refunded, refundedAmount set, ledger recorded', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    const r = await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 30, refundKey: 'k1' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('partially_refunded');
    expect(r.body.refundedAmount).toBe(30);
    expect(await storedOrder(owner, orgId, orderId)).toMatchObject({ status: 'partially_refunded', refundedAmount: 30 });
    const led = await owner.get<{ refunds: RefundLedgerEntry[] }>(c(orgId, `/orders/${encodeURIComponent(orderId)}/refunds`));
    expect(led.body.refunds).toHaveLength(1);
    expect(led.body.refunds[0].amount).toBe(30);
  });

  it('is idempotent by refundKey — a retry does not double-refund', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 40, refundKey: 'dup' });
    const again = await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 40, refundKey: 'dup' });
    expect(again.status).toBe(200);
    expect(again.body.refundedAmount).toBe(40); // NOT 80
    expect((await storedOrder(owner, orgId, orderId)).refundedAmount).toBe(40);
    const led = await owner.get<{ refunds: RefundLedgerEntry[] }>(c(orgId, `/orders/${encodeURIComponent(orderId)}/refunds`));
    expect(led.body.refunds).toHaveLength(1);
  });

  it('rejects an over-refund (amount beyond the remaining balance)', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 80, refundKey: 'a' });
    const over = await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 30, refundKey: 'b' });
    expect(over.status).toBe(409);
    // Two guards answer 409 here (the up-front remaining check and the in-CAS clamp,
    // which says "would exceed the order charge"); the message pins the up-front one.
    expect(over.body.message).toMatch(/exceeds the 20 USD remaining/);
    expect((await storedOrder(owner, orgId, orderId)).refundedAmount).toBe(80);
  });

  it('repeat partials accumulate and flip to refunded when the full charge is reached', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 60, refundKey: 'x' });
    const last = await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 40, refundKey: 'y' });
    expect(last.status).toBe(200);
    expect(last.body.status).toBe('refunded');
    expect(last.body.refundedAmount).toBe(100);
    expect(await storedOrder(owner, orgId, orderId)).toMatchObject({ status: 'refunded', refundedAmount: 100 });
  });

  it('leaves the shipped full-refund path intact (paid → refunded, restores)', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100, { type: 'physical', inventory: 5 });
    const stock = async (): Promise<number | undefined> => (await owner.get<{ products: Product[] }>(c(orgId, '/products'))).body.products[0]?.inventory;
    expect(await stock()).toBe(4); // reserved at create
    const r = await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/refund`), {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('refunded');
    expect(r.body.refundedAmount).toBe(100);
    expect(await storedOrder(owner, orgId, orderId)).toMatchObject({ status: 'refunded', refundedAmount: 100 });
    expect(await stock()).toBe(5); // a full refund is a return — stock restored
  });

  // Ceiling: these two races are real concurrency but the interleaving is not forced
  // (round-1 probes on the claim CAS and the in-CAS clamp were vacuous here). The forced
  // windows — both callers held at the ledger-claim CAS — live in
  // commerce-refund-crash-window.test.ts ("DEF-7 forced window").
  it('concurrent same-refundKey requests fold exactly once (no double-count)', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    const [a, b] = await Promise.all([
      owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 50, refundKey: 'race' }),
      owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 50, refundKey: 'race' }),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    const led = await owner.get<{ refunds: RefundLedgerEntry[] }>(c(orgId, `/orders/${encodeURIComponent(orderId)}/refunds`));
    expect(led.body.refunds).toHaveLength(1); // one ledger row
    const list = await owner.get<{ orders: Order[] }>(c(orgId, '/orders'));
    const fresh = list.body.orders.find((o) => o.orderId === orderId)!;
    expect(fresh.refundedAmount).toBe(50); // NOT 100
  });

  it('concurrent DIFFERENT-key partials cannot over-refund a manual order (no Stripe backstop)', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100); // demo:pi ⇒ provider none
    const [a, b] = await Promise.all([
      owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 100, refundKey: 'k-a' }),
      owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 100, refundKey: 'k-b' }),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const rejected = [a, b].filter((r) => r.status === 409);
    expect(oks).toHaveLength(1);   // exactly one succeeds
    expect(rejected).toHaveLength(1); // the other is clamped
    const list = await owner.get<{ orders: Order[] }>(c(orgId, '/orders'));
    const fresh = list.body.orders.find((o) => o.orderId === orderId)!;
    expect(fresh.refundedAmount).toBe(100); // never 200
  });

  it('rejects a partial refund with a missing/invalid amount', async () => {
    const { owner, orgId } = await shopOwner();
    const orderId = await paidOrder(owner, orgId, 100);
    const bad = await owner.post<Order & ErrBody>(c(orgId, `/orders/${encodeURIComponent(orderId)}/partial-refund`), { amount: 0, refundKey: 'z' });
    expect(bad.status).toBe(400);
    // The route's guard answers first; the service repeats it ("must be greater than zero").
    expect(bad.body.message).toMatch(/`amount` \(> 0\) is required/);
  });
});

describe('DEF-1 — tax/shipping seam (flat/manual default)', () => {
  it('no provider + no flat config ⇒ order carries NO tax/shipping (byte-identical)', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'digital', name: 'Plain', price: 50, currency: 'USD' });
    const o = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(o.body.taxTotal).toBeUndefined();
    expect(o.body.shippingCost).toBeUndefined();
    expect(o.body.total).toBe(50);
  });

  it('a flat governance tax rate + flat shipping fold into the order at create', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { flatTaxRatePercent: 10, flatShippingMinor: 500 } }, 'test');
    const p = await owner.post<Product & ErrBody>(c(orgId, '/products'), { type: 'physical', name: 'Boxed', price: 100, currency: 'USD', inventory: 5 });
    const o = await owner.post<Order & ErrBody>(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }], shippingAddress: { line1: '1 Main', city: 'Town', country: 'US' } });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(o.body.taxTotal).toBe(10);      // 10% of 100
    expect(o.body.shippingCost).toBe(5);   // 500 minor = $5
    expect(o.body.taxLines?.[0]?.amount).toBe(10);
  });
});
