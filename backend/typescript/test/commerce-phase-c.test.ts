/**
 * Ecommerce gap plan §5C Phase C — backend behavior:
 *  - C4 price lists: priority resolution, currency-mismatch skip, anonymous default,
 *    contract price flowing into orders with an explainable priceSource;
 *  - C5 reservations: reserve-on-create (oversell guard 409 + rollback), consume at
 *    paid (no double decrement), cancel restores, the movement ledger, and the
 *    expiry sweep releasing stock;
 *  - C3 quotes: negotiated snapshot pricing, send gate over the B3 threshold,
 *    post-sent revision pinning + demotion, share-link public accept converting at
 *    the negotiated price, staleness refusing loudly;
 *  - C2 public storefront: product detail, guest checkout (demo mode) with
 *    email-deduped contact creation, coupon totals;
 *  - C9 the one-read summary (GMV/AOV/top products/coupons/low stock).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { sweepExpiredReservations } from '../src/features/commerce/commerceService.js';
import { createLink, resolveShared } from '../src/features/sharing/sharingService.js';
import { listContacts } from '../src/features/crm/contactsService.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm', 'sharing']) {
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
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `pc-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = r.body.user?.tenantId ?? '';
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  return { owner, orgId: org.body.orgId, tenantId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;
const pub = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/public-store/${encodeURIComponent(orgId)}${suffix}`;

describe('C4 — price lists + explainable resolution', () => {
  it('resolves contract > variant > default with priority and currency discipline; orders carry priceSource', async () => {
    const { owner, orgId } = await shopOwner();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Acct Buyer', email: `b-${n++}@x.test` });
    const contactId: string = contact.body.contactId;
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Widget', price: 100, currency: 'USD', inventory: 20, variants: [{ name: 'Blue', sku: 'W-B', price: 95 }] });
    const productId: string = p.body.productId;
    const variantId: string = p.body.variants[0].variantId;

    // Two matching lists — the higher priority wins; a EUR list is skipped (no FX).
    await owner.post(c(orgId, '/price-lists'), { name: 'Base contract', currency: 'USD', priority: 1, contactIds: [contactId], entries: [{ productId, price: 80 }] });
    const gold = await owner.post(c(orgId, '/price-lists'), { name: 'Gold contract', currency: 'USD', priority: 5, contactIds: [contactId], entries: [{ productId, price: 70 }] });
    await owner.post(c(orgId, '/price-lists'), { name: 'EUR list', currency: 'EUR', priority: 99, contactIds: [contactId], entries: [{ productId, price: 1 }] });

    const won = await owner.get(c(orgId, `/price?productId=${encodeURIComponent(productId)}&contactId=${encodeURIComponent(contactId)}`));
    expect(won.status).toBe(200);
    expect(won.body).toMatchObject({ price: 70, currency: 'USD', source: `price-list:${gold.body.priceListId}`, priceListName: 'Gold contract', priority: 5 });

    // Anonymous → default; variant context → variant price.
    const anon = await owner.get(c(orgId, `/price?productId=${encodeURIComponent(productId)}`));
    expect(anon.body).toMatchObject({ price: 100, source: 'default' });
    const variant = await owner.get(c(orgId, `/price?productId=${encodeURIComponent(productId)}&variantId=${encodeURIComponent(variantId)}`));
    expect(variant.body).toMatchObject({ price: 95, source: 'variant' });

    // The contract price flows into the order with the explainable source.
    const o = await owner.post(c(orgId, '/orders'), { contactId, lines: [{ productId, quantity: 2 }] });
    expect(o.body.items[0]).toMatchObject({ unitPrice: 70, priceSource: `price-list:${gold.body.priceListId}` });
    expect(o.body.total).toBe(140);
  });
});

describe('C5 — reservations + the stock ledger', () => {
  it('reserves at create (oversell 409 + rollback), consumes at paid, restores on cancel, sweeps expiry', async () => {
    const { owner, orgId } = await shopOwner();
    const p = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Last Units', price: 10, currency: 'USD', inventory: 3 });
    const productId: string = p.body.productId;
    const inventory = async (): Promise<number> => (await owner.get(c(orgId, `/products/${encodeURIComponent(productId)}`))).body.inventory;

    // Reserve at create.
    const o1 = await owner.post(c(orgId, '/orders'), { lines: [{ productId, quantity: 2 }] });
    expect(o1.status).toBe(201);
    expect(o1.body.reservationExpiresAt).toBeTruthy();
    expect(await inventory()).toBe(1);

    // Oversell guard: 2 > 1 remaining → 409, nothing taken.
    const over = await owner.post(c(orgId, '/orders'), { lines: [{ productId, quantity: 2 }] });
    expect(over.status).toBe(409);
    expect(over.body.details?.code ?? over.body.details?.productId).toBeTruthy();
    expect(await inventory()).toBe(1);

    // Paying consumes the reservation — NO second decrement.
    const paid = await owner.post(c(orgId, `/orders/${encodeURIComponent(o1.body.orderId)}/pay`), { paymentIntentId: `demo:pi_c5_${n++}` });
    expect(paid.status).toBe(200);
    expect(await inventory()).toBe(1);

    // Cancel releases a pending reservation.
    const o2 = await owner.post(c(orgId, '/orders'), { lines: [{ productId, quantity: 1 }] });
    expect(await inventory()).toBe(0);
    await owner.post(c(orgId, `/orders/${encodeURIComponent(o2.body.orderId)}/cancel`));
    expect(await inventory()).toBe(1);

    // Expiry sweep: an unpaid pending order past its deadline auto-cancels + restores.
    const o3 = await owner.post(c(orgId, '/orders'), { lines: [{ productId, quantity: 1 }] });
    expect(await inventory()).toBe(0);
    const released = await sweepExpiredReservations(Date.now() + 25 * 60 * 60 * 1000);
    expect(released).toBeGreaterThanOrEqual(1);
    expect(await inventory()).toBe(1);
    const swept = await owner.get(c(orgId, `/orders/${encodeURIComponent(o3.body.orderId)}`));
    expect(swept.body.status).toBe('canceled');

    // The movement ledger tells the whole story.
    const moves = await owner.get(c(orgId, `/products/${encodeURIComponent(productId)}/movements`));
    const reasons = moves.body.movements.map((m: { reason: string }) => m.reason);
    expect(reasons).toContain('reserve');
    expect(reasons).toContain('release-cancel');
    expect(reasons).toContain('release-expired');
  });
});

describe('C3 — quote-to-order', () => {
  it('drafts with negotiated overrides, revises with pinned revisions, sends, and converts at snapshot prices via the public share link', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Q Buyer', email: `q-${n++}@x.test` });
    const p = await owner.post(c(orgId, '/products'), { type: 'service', name: 'Workshop', price: 75, currency: 'USD' });
    const productId: string = p.body.productId;

    // Draft with a negotiated per-line override; listPrice stays the resolved reference.
    const q = await owner.post(c(orgId, '/quotes'), { contactId: contact.body.contactId, lines: [{ productId, quantity: 4, unitPrice: 60 }], note: 'Team booking' });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body.lines[0]).toMatchObject({ listPrice: 75, unitPrice: 60 });
    expect(q.body.total).toBe(240);

    // Send, then revise: the sent snapshot pins as v1 and the quote demotes to draft v2.
    expect((await owner.post(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/send`))).body.status).toBe('sent');
    const revised = await owner.patch(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}`), { lines: [{ productId, quantity: 5, unitPrice: 55 }] });
    expect(revised.body).toMatchObject({ status: 'draft', version: 2, total: 275 });
    const revs = await owner.get(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/revisions`));
    expect(revs.body.revisions).toHaveLength(1);
    expect(revs.body.revisions[0].snapshot.total).toBe(240);

    // Re-send, mint the share link, accept publicly (demo mode — no Stripe key).
    await owner.post(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/send`));
    const link = await createLink(tenantId, orgId, 'test', { resourceType: 'commerce_quote', resourceId: q.body.quoteId });
    const accepted = await owner.post(pub(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/accept`), { token: link.token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.mode).toBe('demo');
    expect(accepted.body.total).toBe(275);
    const order = await owner.get(c(orgId, `/orders/${encodeURIComponent(accepted.body.orderId)}`));
    expect(order.body.items[0]).toMatchObject({ unitPrice: 55, priceSource: 'quote' });
    const qDone = await owner.get(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}`));
    expect(qDone.body).toMatchObject({ status: 'converted', convertedOrderId: accepted.body.orderId });

    // SHWF-3 / ADR 0644 D3 — the mint hook demands `status === 'sent'`, but the read
    // hooks did NOT re-check it, so a quote demoted back to `draft` by a revision (or
    // declined, or expired) kept resolving on the already-minted public link with its
    // stale price. The allowlist deliberately keeps `accepted` and `converted`: the
    // accept above flips `sent → converted`, so darkening everything-but-`sent` would
    // 404 the buyer's own confirmation page the instant they accept.
    expect((await resolveShared(link.token)).resource).toMatchObject({ kind: 'commerce_quote' });  // converted: still visible
    const q3 = await owner.post(c(orgId, '/quotes'), { lines: [{ productId, quantity: 2 }] });
    await owner.post(c(orgId, `/quotes/${encodeURIComponent(q3.body.quoteId)}/send`));
    const l3 = await createLink(tenantId, orgId, 'test', { resourceType: 'commerce_quote', resourceId: q3.body.quoteId });
    expect((await resolveShared(l3.token)).resource).toMatchObject({ kind: 'commerce_quote' });  // sent: visible
    await owner.patch(c(orgId, `/quotes/${encodeURIComponent(q3.body.quoteId)}`), { lines: [{ productId, quantity: 9 }] });
    expect((await owner.get(c(orgId, `/quotes/${encodeURIComponent(q3.body.quoteId)}`))).body.status).toBe('draft');
    await expect(resolveShared(l3.token)).rejects.toMatchObject({ code: 'not_found', details: { reason: 'resource-gone' } });

    // SHCD-1 / ADR 0644 D8 — the CAPABILITY-PROOF exemption, pinned. The view cap
    // is now enforced at the shared chokepoint for the READ lanes, and the obvious
    // "just enforce it everywhere" fix is an ATTACK on this flow: a `maxViews:1`
    // quote link spends its only view the moment the buyer OPENS the quote, so a
    // capped `assertLiveLinkFor` would refuse the Accept they were invited to make.
    // A cap limits how many times the offer can be READ, not whether the recipient
    // may act on it. Verified end to end below, viewing first.
    const q4 = await owner.post(c(orgId, '/quotes'), { lines: [{ productId, quantity: 1 }] });
    await owner.post(c(orgId, `/quotes/${encodeURIComponent(q4.body.quoteId)}/send`));
    const l4 = await createLink(tenantId, orgId, 'test', { resourceType: 'commerce_quote', resourceId: q4.body.quoteId, maxViews: 1 });
    await resolveShared(l4.token);                                             // spends the only view
    await expect(resolveShared(l4.token)).rejects.toMatchObject({ code: 'not_found' });  // read lane is now dark
    const acceptedAfterCap = await owner.post(pub(orgId, `/quotes/${encodeURIComponent(q4.body.quoteId)}/accept`), { token: l4.token });
    expect(acceptedAfterCap.status, JSON.stringify(acceptedAfterCap.body)).toBe(200);

    // A bogus/mismatched token never accepts.
    const q2 = await owner.post(c(orgId, '/quotes'), { lines: [{ productId, quantity: 1 }] });
    await owner.post(c(orgId, `/quotes/${encodeURIComponent(q2.body.quoteId)}/send`));
    const wrong = await owner.post(pub(orgId, `/quotes/${encodeURIComponent(q2.body.quoteId)}/accept`), { token: link.token });
    expect(wrong.status).toBe(404);
  });

  it('gates SEND at the order threshold and refuses stale acceptance', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    await setGovernancePolicy(tenantId, { commerce: { orderApprovalThresholdMinor: 10_000 } }, 'test'); // $100
    const p = await owner.post(c(orgId, '/products'), { type: 'service', name: 'Retainer', price: 500, currency: 'USD' });
    const q = await owner.post(c(orgId, '/quotes'), { lines: [{ productId: p.body.productId, quantity: 1 }] });

    // Over-threshold send parks a commerce-spend approval; approve → send passes.
    const blocked = await owner.post(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/send`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('approval_required');
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `commerce-quote-send:${q.body.quoteId}:v1`);
    expect(appr?.kind).toBe('commerce-spend');
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    expect((await owner.post(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/send`))).body.status).toBe('sent');
    await setGovernancePolicy(tenantId, { commerce: {} }, 'test');

    // Staleness: archiving the product refuses acceptance loudly.
    await owner.patch(c(orgId, `/products/${encodeURIComponent(p.body.productId)}`), { active: false });
    const stale = await owner.post(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/accept`));
    expect(stale.status).toBe(409);
    expect(stale.body.details?.code).toBe('quote_stale');
  });
});

describe('C2 — public storefront + guest checkout (demo mode)', () => {
  it('serves product detail, checks out a guest with a deduped CRM contact, and honors coupons', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Guide', price: 20, currency: 'USD', tags: ['books'], categories: ['guides'] });
    const productId: string = p.body.productId;
    await owner.post(c(orgId, '/coupons'), { code: 'TEN', type: 'percentage', value: 10 });

    const detail = await owner.get(pub(orgId, `/products/${encodeURIComponent(productId)}`));
    expect(detail.status).toBe(200);
    expect(detail.body.product).toMatchObject({ name: 'Guide', price: 20, categories: ['guides'], tags: ['books'] });
    expect(detail.body.product.inventory).toBeUndefined(); // operational fields never leak

    // Facet filters on the public list.
    expect((await owner.get(pub(orgId, '/products?category=guides'))).body.products).toHaveLength(1);
    expect((await owner.get(pub(orgId, '/products?category=nope'))).body.products).toHaveLength(0);

    // Guest checkout (keyless ⇒ demo) creates the order + a CRM contact.
    const buyer = `guest-${n++}@shop.test`;
    const co = await owner.post(pub(orgId, '/checkout'), { email: buyer, name: 'Guest G', couponCode: 'TEN', lines: [{ productId, quantity: 1 }] });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body).toMatchObject({ mode: 'demo', total: 18 });
    const order = await owner.get(c(orgId, `/orders/${encodeURIComponent(co.body.orderId)}`));
    expect(order.body.contactId).toBeTruthy();
    expect(order.body.createdBy).toBe('public:guest'); // grade-code B6: no email PII in the actor

    // Second checkout with the same email DEDUPES the contact.
    await owner.post(pub(orgId, '/checkout'), { email: buyer, lines: [{ productId, quantity: 1 }] });
    const matching = (await listContacts(tenantId)).filter((x) => x.email === buyer);
    expect(matching).toHaveLength(1);
  });
});

describe('C9 — the one-read revenue summary', () => {
  it('aggregates GMV/AOV/status counts/top products/coupon usage/low stock in one response', async () => {
    const { owner, orgId } = await shopOwner();
    const a = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Alpha', price: 10, currency: 'USD', inventory: 2, lowStockThreshold: 5 });
    const b = await owner.post(c(orgId, '/products'), { type: 'physical', name: 'Beta', price: 40, currency: 'USD', inventory: 50 });
    // R2 CM-P2-M2 — a fixed coupon must state the currency its value is in (an amount
    // with no currency is unbackfillable, and used to be stamped 'USD' by default).
    await owner.post(c(orgId, '/coupons'), { code: 'FIVE', type: 'fixed', value: 5, currency: 'USD' });

    const pay = async (lines: unknown, coupon?: string): Promise<void> => {
      const o = await owner.post(c(orgId, '/orders'), { lines, ...(coupon ? { couponCode: coupon } : {}) });
      expect(o.status, JSON.stringify(o.body)).toBe(201);
      const paid = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: `demo:pi_sum_${n++}` });
      expect(paid.status).toBe(200);
    };
    await pay([{ productId: a.body.productId, quantity: 1 }]);                        // 10
    await pay([{ productId: b.body.productId, quantity: 2 }], 'FIVE');                // 80 − 5 = 75
    await owner.post(c(orgId, '/orders'), { lines: [{ productId: b.body.productId, quantity: 1 }] }); // pending — not revenue

    const sum = await owner.get(c(orgId, '/reports/summary'));
    expect(sum.status).toBe(200);
    expect(sum.body.gmv).toBe(85);
    expect(sum.body.aov).toBe(42.5);
    expect(sum.body.orderCounts).toMatchObject({ paid: 2, pending: 1 });
    expect(sum.body.topProducts[0]).toMatchObject({ name: 'Beta', revenue: 80, units: 2 });
    expect(sum.body.couponUsage[0]).toMatchObject({ code: 'FIVE', orders: 1, discount: 5 });
    expect(sum.body.lowStock.some((x: { name: string }) => x.name === 'Alpha')).toBe(true);
  });
});
