/**
 * ADR 1098 — unlisted (quote-only) products.
 *
 *  - Admin CRUD: `unlisted` is a closed-world boolean on create and PATCH.
 *  - Public lanes: the storefront list hides an unlisted product, its detail 404s,
 *    and the public checkout refuses it with the same answer as a missing product.
 *  - Quotes: an unlisted product still goes on a quote, and the public share-link
 *    accept converts it into an order.
 *  - The ad catalog feed never carries it.
 *  - Census: every source file that reads products is classified, so a new public
 *    lane cannot read the catalog without choosing a rule (`isPubliclyListed`,
 *    `refuseUnlistedProduct`, or a stated operator reason).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createLink } from '../src/features/sharing/sharingService.js';
import { buildProductFeed } from '../src/features/campaign-connectors/catalogFeed.js';
import { isPubliclyListed, refuseUnlistedProduct, type Product, type Order } from '../src/features/commerce/commerceService.js';
import type { Quote } from '../src/features/commerce/quotes.js';
import type { Contact } from '../src/features/crm/contactsService.js';

function portOf(s: { address(): string | AddressInfo | null }): number {
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
  for (const id of ['users', 'commerce', 'crm', 'sharing']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface ApiError { error?: string; message?: string; details?: Record<string, unknown> }
interface Res<T> { status: number; body: T }
function parseBody<T>(text: string): T {
  try { return JSON.parse(text === '' ? 'null' : text); } catch { return JSON.parse('null'); }
}
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: parseBody<T>(await res.text()) };
  };
  return { get: <T = ApiError>(p: string) => call<T>('GET', p), post: <T = ApiError>(p: string, b?: unknown) => call<T>('POST', p, b), patch: <T = ApiError>(p: string, b?: unknown) => call<T>('PATCH', p, b) };
}
interface LoginBody { user?: { userId: string; tenantId?: string } }
async function shopOwner() {
  const owner = client();
  const r = await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `u1098-${Date.now()}-${n++}@acme.test` });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Studio' });
  return { owner, orgId: org.body.orgId, tenantId: r.body.user?.tenantId ?? '', userId: r.body.user?.userId ?? '' };
}
const c = (orgId: string, s = ''): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${s}`;
const pub = (orgId: string, s = ''): string => `/host/openwop-app/public-store/${encodeURIComponent(orgId)}${s}`;

describe('ADR 1098 — unlisted products, route behaviour', () => {
  it('admin CRUD: unlisted is a closed-world boolean on create and PATCH', async () => {
    const { owner, orgId } = await shopOwner();
    const made = await owner.post<Product>(c(orgId, '/products'), { type: 'service', name: 'Design retainer', price: 2500, currency: 'USD', unlisted: true });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.unlisted).toBe(true);
    const listed = await owner.post<Product>(c(orgId, '/products'), { type: 'service', name: 'Consult', price: 100, currency: 'USD' });
    expect(listed.body.unlisted).toBeUndefined(); // absent ⇒ listed; nothing stored
    const bad = await owner.patch<ApiError>(c(orgId, `/products/${encodeURIComponent(made.body.productId)}`), { unlisted: 'yes' });
    expect(bad.status).toBe(400);
    expect(bad.body.details).toMatchObject({ field: 'unlisted' });
    const badCreate = await owner.post<ApiError>(c(orgId, '/products'), { type: 'service', name: 'X', price: 1, currency: 'USD', unlisted: 1 });
    expect(badCreate.status).toBe(400);
    const relisted = await owner.patch<Product>(c(orgId, `/products/${encodeURIComponent(made.body.productId)}`), { unlisted: false });
    expect(relisted.status).toBe(200);
    expect(relisted.body.unlisted).toBeUndefined();
    const again = await owner.patch<Product>(c(orgId, `/products/${encodeURIComponent(made.body.productId)}`), { unlisted: true });
    expect(again.body.unlisted).toBe(true);
    // The operator list still shows it, with the flag.
    const all = await owner.get<{ products: Product[] }>(c(orgId, '/products'));
    expect(all.body.products.find((p) => p.productId === made.body.productId)?.unlisted).toBe(true);
  });

  it('public lanes: the storefront hides it, its detail 404s, and checkout refuses it like a missing product', async () => {
    const { owner, orgId } = await shopOwner();
    const hidden = await owner.post<Product>(c(orgId, '/products'), { type: 'service', name: 'Retainer', price: 2500, currency: 'USD', unlisted: true });
    const shown = await owner.post<Product>(c(orgId, '/products'), { type: 'service', name: 'Consult', price: 100, currency: 'USD' });
    const guest = client();
    const list = await guest.get<{ products: { productId: string }[] }>(pub(orgId, '/products'));
    expect(list.status).toBe(200);
    const ids = list.body.products.map((p) => p.productId);
    expect(ids).toContain(shown.body.productId);
    expect(ids).not.toContain(hidden.body.productId);
    const detail = await guest.get<ApiError>(pub(orgId, `/products/${encodeURIComponent(hidden.body.productId)}`));
    expect(detail.status).toBe(404);
    const missing = await guest.post<ApiError>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: 'prod:does-not-exist', quantity: 1 }] });
    const co = await guest.post<ApiError>(pub(orgId, '/checkout'), { email: `g-${n++}@x.test`, lines: [{ productId: hidden.body.productId, quantity: 1 }] });
    // Same answer as a product that does not exist, so a public caller learns nothing.
    // (The envelope redacts a high-entropy id inside a message, so compare the shape.)
    expect(co.status).toBe(400);
    expect(co.status).toBe(missing.status);
    expect(co.body.error).toBe(missing.body.error);
    expect(co.body.message).toMatch(/^Product not found: /);
    expect(missing.body.message).toMatch(/^Product not found: /);
  });

  it('quotes: an unlisted product goes on a quote and the public share-link accept converts it', async () => {
    const { owner, orgId, tenantId, userId } = await shopOwner();
    const contact = await owner.post<Contact>('/host/openwop-app/crm/contacts', { name: 'Client', email: `cl-${n++}@x.test` });
    const p = await owner.post<Product>(c(orgId, '/products'), { type: 'service', name: 'Design retainer', price: 2500, currency: 'USD', unlisted: true });
    const q = await owner.post<Quote>(c(orgId, '/quotes'), { contactId: contact.body.contactId, lines: [{ productId: p.body.productId, quantity: 1 }] });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect((await owner.post<Quote>(c(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/send`))).body.status).toBe('sent');
    const link = await createLink(tenantId, orgId, userId, { resourceType: 'commerce_quote', resourceId: q.body.quoteId });
    const accepted = await client().post<{ orderId?: string; total?: number } & ApiError>(pub(orgId, `/quotes/${encodeURIComponent(q.body.quoteId)}/accept`), { token: link.token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.total).toBe(2500);
    const order = await owner.get<Order>(c(orgId, `/orders/${encodeURIComponent(accepted.body.orderId ?? '')}`));
    expect(order.body.items[0]).toMatchObject({ productId: p.body.productId, priceSource: 'quote' });
  });

  it('the ad catalog feed never carries an unlisted product', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    const hidden = await owner.post<Product>(c(orgId, '/products'), { type: 'service', name: 'Retainer', price: 2500, currency: 'USD', unlisted: true });
    const shown = await owner.post<Product>(c(orgId, '/products'), { type: 'service', name: 'Consult', price: 100, currency: 'USD' });
    const feed = await buildProductFeed(tenantId, orgId, 'https://shop.example');
    const text = JSON.stringify(feed);
    expect(text).not.toContain(hidden.body.productId);
    expect(text).toContain(shown.body.productId);
  });
});

describe('ADR 1098 — the predicate and the refusal', () => {
  it('isPubliclyListed is active AND not unlisted', () => {
    expect(isPubliclyListed({ active: true })).toBe(true);
    expect(isPubliclyListed({ active: true, unlisted: false })).toBe(true);
    expect(isPubliclyListed({ active: true, unlisted: true })).toBe(false);
    expect(isPubliclyListed({ active: false })).toBe(false);
  });
  it('refuseUnlistedProduct is a typed 400 with reason product_unlisted', () => {
    expect(() => refuseUnlistedProduct({ productId: 'p1' }, 'Funnel offer')).not.toThrow();
    let err: unknown;
    try { refuseUnlistedProduct({ productId: 'p1', unlisted: true }, 'Funnel offer'); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'validation_error', httpStatus: 400, details: { reason: 'product_unlisted', productId: 'p1' } });
  });
});

// ── Census: every product reader picks a rule ────────────────────────────────
// `public` lanes filter through `isPubliclyListed`; `outward` references refuse
// through `refuseUnlistedProduct`; `operator` lanes keep unlisted products on
// purpose, for the stated reason. A NEW file that reads products fails here until
// it is classified.
const LANES: Record<string, { rule: 'public' | 'outward' | 'operator'; why?: string }> = {
  'features/commerce/commerceService.ts': { rule: 'public', why: 'defines the readers; createOrderCore activeOnly refuses unlisted' },
  'features/commerce/routes.ts': { rule: 'public', why: 'public-store list and detail; admin routes are member lanes' },
  'features/commerce/ucp/routes.ts': { rule: 'public' },
  'features/campaign-connectors/catalogFeed.ts': { rule: 'public' },
  'features/discovery/discoveryService.ts': { rule: 'public' },
  'features/recommendations/recommendationsService.ts': { rule: 'public' },
  'features/funnels/funnelsService.ts': { rule: 'outward' },
  'features/campaign-orchestration/routes.ts': { rule: 'outward' },
  'features/campaign-orchestration/variants/variantSetService.ts': { rule: 'outward' },
  'features/campaign-orchestration/campaignLinks.ts': { rule: 'operator', why: 'existence re-check and the member-facing links view; the write route refuses unlisted' },
  'features/discovery/productEmbeddingIndex.ts': { rule: 'operator', why: 'internal index; searchProducts bounds fusion to its isPubliclyListed base set' },
  'features/commerce/quotes.ts': { rule: 'operator', why: 'quote-only products are what quotes are for' },
  'features/commerce/agentTools.ts': { rule: 'operator', why: 'member chat tools; the projection carries the flag' },
  'features/commerce/surface.ts': { rule: 'operator', why: 'workflow surface for members; the projection carries the flag' },
  'features/commerce/subscriptions.ts': { rule: 'operator', why: 'workspace:write subscribe route' },
  'features/commerce/productMedia.ts': { rule: 'operator', why: 'admin media' },
  'features/commerce/dataExport.ts': { rule: 'operator', why: 'operator export' },
  'features/commerce/ucp/referenceUcpMerchant.ts': { rule: 'operator', why: 'reference merchant seed and its own fixture catalog' },
  'host/commerceShowcaseSeed.ts': { rule: 'operator', why: 'demo seed' },
  'host/demoCommerceDepthSeed.ts': { rule: 'operator', why: 'demo seed' },
  'host/demoContentMarketingSeed.ts': { rule: 'operator', why: 'demo seed' },
  'host/demoMerchandisingSeed.ts': { rule: 'operator', why: 'demo seed' },
  'features/promotions/promotionsService.ts': { rule: 'operator', why: 'promotion targeting by id; pricing applies only to lines an order lane already admitted' },
};
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
describe('ADR 1098 — every product reader is classified', () => {
  const readers = walk(SRC).filter((p) => /\b(listProducts|getProduct|getProductInTenant)\s*\(/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(SRC, p).split('\\').join('/')).sort();
  it('finds the readers it expects (the census is not vacuous)', () => {
    expect(readers.length).toBeGreaterThan(15);
  });
  it('every reader is in the classification table', () => {
    expect(readers.filter((r) => !LANES[r])).toEqual([]);
  });
  it('the table names no file that no longer reads products', () => {
    expect(Object.keys(LANES).filter((k) => !readers.includes(k))).toEqual([]);
  });
  it('public lanes filter through isPubliclyListed, outward lanes refuse through refuseUnlistedProduct', () => {
    for (const [file, lane] of Object.entries(LANES)) {
      const text = readFileSync(join(SRC, file), 'utf8');
      if (lane.rule === 'public') expect(text, file).toMatch(/isPubliclyListed/);
      if (lane.rule === 'outward') expect(text, file).toMatch(/refuseUnlistedProduct\(/);
      if (lane.rule === 'operator') expect(lane.why, file).toBeTruthy();
    }
  });
});
