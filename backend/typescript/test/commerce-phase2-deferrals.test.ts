/**
 * ADR 0239 — Phase 2 commerce deferrals:
 *  - DEF-6 per-currency commerceSummary: money figures bucket per currency; a
 *    mixed-currency org no longer sums nonsense into one total;
 *  - DEF-5 reservation due-index: the expiry sweep releases expired reservations
 *    via the due-index (paid/canceled orders are off it);
 *  - DEF-3 product search: multi-token AND + relevance ranking.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { sweepExpiredReservations } from '../src/features/commerce/commerceService.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
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
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `p2-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId: r.body.user?.tenantId ?? '' };
}
const c = (orgId: string, s = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;

describe('DEF-6 — per-currency summary', () => {
  it('buckets money per currency; the headline mirrors the highest-GMV currency', async () => {
    const { owner, orgId } = await shopOwner();
    const usd = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'USD Guide', price: 100, currency: 'USD' });
    const eur = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'EUR Guide', price: 30, currency: 'EUR' });
    for (const p of [usd, usd, eur]) { // 2 USD orders (200), 1 EUR order (30)
      const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
      await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    }
    const sum = (await owner.get(c(orgId, '/reports/summary'))).body;
    const byCcy = Object.fromEntries((sum.byCurrency as any[]).map((b) => [b.currency, b]));
    expect(byCcy.USD.gmv).toBe(200);
    expect(byCcy.EUR.gmv).toBe(30);
    expect(sum.currency).toBe('USD'); // primary = highest GMV
    expect(sum.gmv).toBe(200);        // headline mirrors primary, NOT 230 summed nonsense
  });
});

describe('DEF-5 — reservation due-index sweep', () => {
  it('releases an expired pending reservation and restores its stock', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Boxed', price: 10, currency: 'USD', inventory: 5 });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 2 }] });
    expect(o.body.status).toBe('pending');
    // Stock reserved at create: 5 → 3.
    let prod = (await owner.get(c(orgId, `/products?q=Boxed`))).body.products[0];
    expect(prod.inventory).toBe(3);
    // Sweep far in the future ⇒ the reservation is due.
    const released = await sweepExpiredReservations(Date.now() + 1000 * 60 * 60 * 24);
    expect(released).toBeGreaterThanOrEqual(1);
    const fresh = (await owner.get(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}`))).body;
    expect(fresh.status).toBe('canceled');
    prod = (await owner.get(c(orgId, `/products?q=Boxed`))).body.products[0];
    expect(prod.inventory).toBe(5); // restored
  });

  it('does not touch a PAID order (off the due-index)', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Paid Guide', price: 10, currency: 'USD' });
    const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
    await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
    await sweepExpiredReservations(Date.now() + 1000 * 60 * 60 * 24);
    const fresh = (await owner.get(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}`))).body;
    expect(fresh.status).toBe('paid'); // untouched
  });
});

describe('DEF-3 — product search relevance', () => {
  it('multi-token AND matches across fields and ranks name hits highest', async () => {
    const { owner, orgId } = await shopOwner();
    await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Red Shirt', price: 20, currency: 'USD', tags: ['cotton'] });
    await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Shirt', price: 15, currency: 'USD', tags: ['red', 'linen'] });
    await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Blue Hat', price: 12, currency: 'USD', tags: ['wool'] });
    const hits = (await owner.get(c(orgId, `/products?q=${encodeURIComponent('red shirt')}`))).body.products as any[];
    const names = hits.map((h) => h.name);
    expect(names).toContain('Red Shirt');  // both tokens in name
    expect(names).toContain('Shirt');       // "shirt" in name, "red" in tags — AND satisfied
    expect(names).not.toContain('Blue Hat'); // neither token
    expect(names[0]).toBe('Red Shirt');      // name-weighted rank wins
  });
});
