/**
 * ADR 0952 D6 (P7) — the product feed GENERATED from the one commerce catalog,
 * its signed public URL, and the API push to Meta Catalog / Google Merchant
 * Center against a local fixture server. No real platform, no token.
 *
 * Pins:
 *  - Feed items come only from active catalog products with a price and a real
 *    catalog image; the rest are listed with a reason. Variants are one item each
 *    under `item_group_id`, with ids inside Google's 50-character cap. Cost and
 *    raw inventory never reach the feed.
 *  - The public URL is HMAC-signed over a versioned payload: rotate kills every
 *    earlier URL; a bad signature, a disabled feed, an unknown org and the toggle
 *    off all answer the same 404. Never a shared-cache header.
 *  - The push is `unsupported` until sandbox-verified, sends only CHANGED items,
 *    removes items that left the catalog, and moves its ledger only on items the
 *    platform accepted (a refused item is retried next time).
 *  - Merchant prices are `amountMicros` (exact, via BigInt); Meta availability is
 *    written with a space.
 *  - The node never reports success-with-nothing.
 *
 * Sabotage that turns it red: drop the version from the signature check; let a
 * refused item move the ledger; push unchanged items; skip removals; put the
 * cost in an item; send a variant id over 50 characters.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';

vi.mock('../src/host/hostEventDispatcher.js', async (orig) => ({ ...(await orig<typeof import('../src/host/hostEventDispatcher.js')>()), emitHostEvent: async () => {} }));

import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getOrg } from '../src/host/accessControlService.js';
import { createProduct, updateProduct } from '../src/features/commerce/commerceService.js';
import { buildProductFeed, renderFeedXml, pushCatalog, saveFeedSettings, variantItemId } from '../src/features/campaign-connectors/catalogFeed.js';
import { buildMerchantProductInput } from '../src/host/adsWire.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { getFeedSettings } from '../src/features/campaign-connectors/catalogFeed.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-connectors.nodes/index.mjs';

let BASE = '';
let server: http.Server;
let fixture: http.Server;
let storage: Storage;
interface Hit { method: string; path: string; body: Record<string, unknown> }
let hits: Hit[] = [];
/** Meta retailer ids the fixture refuses in `validation_status`. */
let metaRefuse = new Set<string>();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['campaign-connectors', 'commerce']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await __resetConnectionsStore();
  fixture = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      hits.push({ method: req.method ?? '', path: url.pathname, body });
      res.setHeader('content-type', 'application/json');
      if (/^\/meta\/\d+\/items_batch$/.test(url.pathname)) {
        const reqs = body.requests as Array<{ data: { id: string } }>;
        const bad = reqs.filter((r) => metaRefuse.has(r.data.id)).map((r) => ({ retailer_id: r.data.id, errors: [{ message: 'image too small' }] }));
        res.end(JSON.stringify({ handles: ['h1'], validation_status: bad })); return;
      }
      if (url.pathname.startsWith('/gmc/')) { res.end('{}'); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  const fx = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  process.env.OPENWOP_META_API_BASE = `${fx}/meta`;
  process.env.OPENWOP_GOOGLE_MERCHANT_API_BASE = `${fx}/gmc`;
  for (const id of ['meta-ads', 'google-merchant']) {
    registerProvider({ id, label: id, kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
  }
});
afterAll(async () => {
  for (const k of ['OPENWOP_META_API_BASE', 'OPENWOP_GOOGLE_MERCHANT_API_BASE', 'OPENWOP_ADS_VERIFIED_CATALOG_PUSH']) delete process.env[k];
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => fixture.close(() => r()));
});
beforeEach(() => { hits = []; metaRefuse = new Set(); process.env.OPENWOP_ADS_VERIFIED_CATALOG_PUSH = 'meta,google'; });

let n = 0;
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text: string; headers: Headers }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
    const text = await res.text();
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
async function newOrg(): Promise<{ c: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const c = client();
  expect((await c.post('/host/openwop-app/test/login', { email: `feed-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme & Co' });
  const orgId = (org.body as { orgId: string }).orgId;
  const row = await getOrg(orgId);
  if (!row) throw new Error('org missing');
  return { c, orgId, tenantId: row.tenantId };
}
const FEED = (orgId: string): string => `/host/openwop-app/campaign-connectors/orgs/${orgId}/catalog-feed`;

describe('ADR 0952 P7 — the feed is generated from the commerce catalog', () => {
  it('includes only sellable products, one item per variant, and never cost', async () => {
    const { tenantId, orgId } = await newOrg();
    const shirt = await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'physical', name: 'Shirt', description: 'Cotton <b>tee</b>', price: 25, cost: 7, currency: 'USD', imageAssetTokens: ['img-1', 'img-2'], inventory: 0, categories: ['Apparel', 'Tops'] });
    await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'digital', name: 'Ebook', price: 1500, currency: 'JPY', imageAssetTokens: ['img-3'] });
    const noImg = await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'physical', name: 'Bare', price: 5, currency: 'USD' });
    const free = await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'physical', name: 'Free', price: 0, currency: 'USD', imageAssetTokens: ['img-4'] });
    const off = await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'physical', name: 'Retired', price: 5, currency: 'USD', imageAssetTokens: ['img-5'] });
    await updateProduct(tenantId, orgId, off.productId, { active: false });
    const mug = await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'physical', name: 'Mug', price: 12, currency: 'EUR', imageAssetTokens: ['img-6'], variants: [{ name: 'Red', price: 12.5, inventory: 3 }, { name: 'Blue', inventory: 0 }] });

    const feed = await buildProductFeed(tenantId, orgId, 'https://shop.example');
    expect(feed.excluded).toEqual(expect.arrayContaining([{ productId: noImg.productId, reason: 'no_image' }, { productId: free.productId, reason: 'no_price' }]));
    expect(feed.items.map((i) => i.title)).not.toContain('Retired');
    const s = feed.items.find((i) => i.id === shirt.productId);
    expect(s).toMatchObject({ availability: 'out_of_stock', price: '25.00 USD', condition: 'new', product_type: 'apparel > tops', identifier_exists: 'no', link: `https://shop.example/store/${orgId}` });
    expect(s?.image_link).toMatch(/^https:\/\/shop\.example\/.*\/assets\/img-1$/);
    expect(s?.additional_image_link).toHaveLength(1);
    expect(feed.items.find((i) => i.title === 'Ebook')).toMatchObject({ availability: 'in_stock', price: '1500 JPY' });
    const mugs = feed.items.filter((i) => i.item_group_id === mug.productId);
    expect(mugs.map((i) => [i.title, i.price, i.availability])).toEqual([['Mug - Red', '12.50 EUR', 'in_stock'], ['Mug - Blue', '12.00 EUR', 'out_of_stock']]);
    for (const i of feed.items) expect(i.id.length).toBeLessThanOrEqual(50); // Google's id cap
    expect(mugs[0]?.id).toBe(variantItemId(mug.productId, mug.variants[0]!.variantId));
    expect(JSON.stringify(feed)).not.toMatch(/"cost"|inventory/);

    const xml = renderFeedXml(feed, { title: 'Acme & Co', brand: 'Acme & Co', link: 'https://shop.example/store/x' });
    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(xml).toContain('<description>Cotton &lt;b&gt;tee&lt;/b&gt;</description>');
    expect(xml).toContain('<g:brand>Acme &amp; Co</g:brand>');
    expect(xml).not.toContain('<b>');
  });
});

describe('ADR 0952 P7 — the signed public URL', () => {
  it('serves only the current signed URL; rotate, disable, toggle off and a bad signature are the same 404', async () => {
    const { c, tenantId, orgId } = await newOrg();
    await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'digital', name: 'Guide', price: 9, currency: 'USD', imageAssetTokens: ['img-g'] });
    const before = await c.get(FEED(orgId));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: false, items: 1 });
    expect((before.body as { feedUrl?: string }).feedUrl).toBeUndefined();

    const on = await c.put(FEED(orgId), { enabled: true, metaCatalogId: '123456' });
    expect(on.status).toBe(200);
    const url1 = new URL((on.body as { feedUrl: string }).feedUrl);
    const path1 = `${url1.pathname}${url1.search}`;
    const ok = await fetch(`${BASE}${path1}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/application\/xml/);
    expect(ok.headers.get('cache-control')).toMatch(/^private/);
    expect(await ok.text()).toContain('<title>Guide</title>');

    const notFound = async (p: string): Promise<void> => { const r = await fetch(`${BASE}${p}`); expect(r.status, p).toBe(404); expect(await r.text()).not.toContain('Guide'); };
    await notFound(path1.replace(/sig=[^&]+/, 'sig=AAAA'));
    await notFound(path1.replace(/v=\d+/, 'v=9'));
    await notFound(`/host/openwop-app/public/org-nope/catalog/feed.xml${url1.search}`);

    const rot = await c.post(`${FEED(orgId)}/rotate`);
    const url2 = new URL((rot.body as { feedUrl: string }).feedUrl);
    expect(url2.search).not.toBe(url1.search);
    await notFound(path1); // the rotated-away URL is dead
    expect((await fetch(`${BASE}${url2.pathname}${url2.search}`)).status).toBe(200);

    const d = getToggleDefault('campaign-connectors');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    try { await notFound(`${url2.pathname}${url2.search}`); } finally { if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }

    // INTWF-1: every item links to the store, which 404s while commerce does not serve.
    const cm = getToggleDefault('commerce');
    if (cm) await saveConfig({ ...cm, status: 'off' }, 'test');
    try { await notFound(`${url2.pathname}${url2.search}`); } finally { if (cm) await saveConfig({ ...cm, status: 'on' }, 'test'); }
    expect((await fetch(`${BASE}${url2.pathname}${url2.search}`)).status).toBe(200);

    await c.put(FEED(orgId), { enabled: false });
    await notFound(`${url2.pathname}${url2.search}`);
  });

  it('a save never builds on a failed read (it would reset the version and revive old URLs)', async () => {
    const t = `feed-ro-${n++}`;
    await saveFeedSettings(t, 'o', { enabled: true }, { rotate: true });
    await saveFeedSettings(t, 'o', {}, { rotate: true });
    expect((await getFeedSettings(t, 'o')).version).toBe(3);
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockRejectedValueOnce(new Error('storage down'));
    try {
      await expect(saveFeedSettings(t, 'o', { enabled: true })).rejects.toThrow(/storage down/);
    } finally { spy.mockRestore(); }
    expect((await getFeedSettings(t, 'o')).version).toBe(3);
    // A failed read serves the feed as OFF.
    const spy2 = vi.spyOn(DurableCollection.prototype, 'get').mockRejectedValueOnce(new Error('storage down'));
    try { expect((await getFeedSettings(t, 'o')).enabled).toBe(false); } finally { spy2.mockRestore(); }
  });

  it('validates settings and refuses a non-member', async () => {
    const { c, orgId } = await newOrg();
    expect((await c.put(FEED(orgId), { metaCatalogId: 'abc' })).status).toBe(400);
    expect((await c.put(FEED(orgId), { merchantDataSource: 'accounts/1/feeds/2' })).status).toBe(400);
    expect((await c.put(FEED(orgId), { merchantAccountId: '42', merchantDataSource: 'accounts/42/dataSources/7' })).body).toMatchObject({ merchantAccountId: '42', merchantDataSource: 'accounts/42/dataSources/7' });
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `stranger-${Date.now()}@x.test` });
    expect([403, 404]).toContain((await stranger.get(FEED(orgId))).status);
    expect([403, 404]).toContain((await stranger.post(`${FEED(orgId)}/push`, { platform: 'meta' })).status);
  });
});

describe('ADR 0952 P7 — API push (fixture-only)', () => {
  async function setup(userId: string) {
    // An anonymous-session tenant: a signed-in one needs KMS to hold a secret. The
    // org has no row, so the brand falls back to its id.
    const tenantId = `feed-push-${n++}`; const orgId = `org-push-${n++}`;
    for (const p of ['meta-ads', 'google-merchant']) await createSecretConnection({ tenantId, provider: p, kind: 'bearer', secret: 'TOK', scope: 'user', userId });
    const runId = `feed-run-${n++}`;
    await storage.insertRun({ runId, workflowId: 'w', tenantId, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    const deps = { storage, tenantId, runId, actingUserId: userId, orgId };
    return { tenantId, orgId, deps };
  }

  it('is unsupported until verified, and disabled until the feed is on', async () => {
    const { tenantId, orgId, deps } = await setup('u-a');
    expect(await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example')).toEqual({ outcome: 'disabled' });
    await saveFeedSettings(tenantId, orgId, { enabled: true, metaCatalogId: '777' });
    await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'digital', name: 'A', price: 3, currency: 'USD', imageAssetTokens: ['i'] });
    delete process.env.OPENWOP_ADS_VERIFIED_CATALOG_PUSH;
    expect(await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example')).toEqual({ outcome: 'unsupported' });
    expect(hits).toHaveLength(0);
    expect(await pushCatalog(deps, tenantId, orgId, 'google', 'https://shop.example')).toEqual({ outcome: 'unsupported' });
  });

  it('Meta: sends only changed items, removes items that left, and retries a refused item', async () => {
    const { tenantId, orgId, deps } = await setup('u-b');
    await saveFeedSettings(tenantId, orgId, { enabled: true, metaCatalogId: '777' });
    const a = await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'digital', name: 'A', price: 3, currency: 'USD', imageAssetTokens: ['i1'] });
    const b = await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'physical', name: 'B', price: 4, currency: 'USD', imageAssetTokens: ['i2'], inventory: 2 });
    metaRefuse = new Set([b.productId]);

    const first = await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example');
    expect(first).toMatchObject({ outcome: 'pushed', sent: 1, failed: 1, unchanged: 0, removed: 0 });
    const body = hits[0]?.body as { item_type: string; allow_upsert: boolean; requests: Array<{ method: string; data: Record<string, unknown> }> };
    expect(hits[0]?.path).toBe('/meta/777/items_batch');
    expect(body).toMatchObject({ item_type: 'PRODUCT_ITEM', allow_upsert: true });
    expect(body.requests.find((r) => r.data.id === b.productId)?.data).toMatchObject({ availability: 'in stock', price: '4.00 USD', brand: orgId, condition: 'new' });

    hits = []; metaRefuse = new Set();
    const second = await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example');
    expect(second).toMatchObject({ outcome: 'pushed', sent: 1, unchanged: 1, failed: 0 });
    expect((hits[0]?.body as { requests: Array<{ data: { id: string } }> }).requests.map((r) => r.data.id)).toEqual([b.productId]); // only the refused one again

    hits = [];
    expect(await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example')).toMatchObject({ outcome: 'pushed', sent: 0, unchanged: 2 });
    expect(hits).toHaveLength(0); // nothing changed, nothing sent

    await updateProduct(tenantId, orgId, a.productId, { active: false });
    await updateProduct(tenantId, orgId, b.productId, { price: 5 });
    hits = [];
    expect(await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example')).toMatchObject({ outcome: 'pushed', sent: 1, removed: 1 });
    const reqs = (hits[0]?.body as { requests: Array<{ method: string; data: { id: string } }> }).requests;
    expect(reqs).toEqual([expect.objectContaining({ method: 'UPDATE', data: expect.objectContaining({ id: b.productId, price: '5.00 USD' }) }), { method: 'DELETE', data: { id: a.productId } }]);

    hits = [];
    expect(await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example')).toMatchObject({ sent: 0, removed: 0, unchanged: 1 });
    expect(hits).toHaveLength(0); // the removal moved the ledger: not deleted twice
  });

  it('INTWF-1: commerce off refuses the push typed and NEVER pushes an empty feed (that would delete the platform catalog)', async () => {
    const { tenantId, orgId, deps } = await setup('u-off');
    await saveFeedSettings(tenantId, orgId, { enabled: true, metaCatalogId: '779' });
    await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'digital', name: 'A', price: 3, currency: 'USD', imageAssetTokens: ['i1'] });
    expect(await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example')).toMatchObject({ outcome: 'pushed', sent: 1 });
    const cm = getToggleDefault('commerce');
    if (!cm) throw new Error('no commerce toggle');
    await saveConfig({ ...cm, status: 'off' }, 'test');
    try {
      hits = [];
      expect(await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example')).toEqual({ outcome: 'commerce_off' });
      expect(hits).toHaveLength(0); // no DELETE of item A, no call at all
      const out = await nodePack['feature.campaign-connectors.nodes.push-catalog-feed']({
        inputs: { orgId, platform: 'meta' },
        features: { 'campaign-connectors': { importCsv: async () => ({}), pushCatalog: async () => ({ outcome: 'commerce_off' }) } },
      });
      expect(out).toMatchObject({ status: 'failed', error: { code: 'commerce_off' } });
    } finally { await saveConfig({ ...cm, status: 'on' }, 'test'); }
    // Back on: the ledger was untouched, so nothing is re-sent or removed.
    hits = [];
    expect(await pushCatalog(deps, tenantId, orgId, 'meta', 'https://shop.example')).toMatchObject({ outcome: 'pushed', sent: 0, removed: 0, unchanged: 1 });
    expect(hits).toHaveLength(0);
  });

  it('Google: Merchant API productInputs with exact amountMicros, and DELETE by name', async () => {
    const { tenantId, orgId, deps } = await setup('u-c');
    expect(await (async () => { await saveFeedSettings(tenantId, orgId, { enabled: true }); return pushCatalog(deps, tenantId, orgId, 'google', 'https://shop.example'); })()).toMatchObject({ outcome: 'pushed', sent: 0 });
    const p = await createProduct({ tenantId, orgId, createdBy: 'u1', type: 'digital', name: 'G', price: 19.99, currency: 'USD', imageAssetTokens: ['g1'] });
    expect(await pushCatalog(deps, tenantId, orgId, 'google', 'https://shop.example')).toEqual({ outcome: 'not_configured', missing: 'merchantAccountId' });
    await saveFeedSettings(tenantId, orgId, { merchantAccountId: '42', merchantDataSource: 'accounts/42/dataSources/7', contentLanguage: 'de', feedLabel: 'DE' });
    expect(await pushCatalog(deps, tenantId, orgId, 'google', 'https://shop.example')).toMatchObject({ outcome: 'pushed', sent: 1 });
    expect(hits[0]?.path).toBe('/gmc/accounts/42/productInputs:insert');
    expect(hits[0]?.body).toMatchObject({ offerId: p.productId, contentLanguage: 'de', feedLabel: 'DE', productAttributes: { price: { amountMicros: '19990000', currencyCode: 'USD' }, availability: 'IN_STOCK', condition: 'NEW', identifierExists: false, brand: orgId } });

    await updateProduct(tenantId, orgId, p.productId, { active: false });
    hits = [];
    expect(await pushCatalog(deps, tenantId, orgId, 'google', 'https://shop.example')).toMatchObject({ removed: 1 });
    expect(hits[0]).toMatchObject({ method: 'DELETE', path: `/gmc/accounts/42/productInputs/${encodeURIComponent(`de~DE~${p.productId}`)}` });
  });

  it('amountMicros is exact for 0, 2 and 3 decimal currencies', () => {
    const item = (price: string) => ({ id: 'x', title: 't', description: 'd', link: 'l', image_link: 'i', availability: 'in_stock' as const, price, condition: 'new' as const, brand: 'b' });
    const micros = (price: string) => (buildMerchantProductInput(item(price), { contentLanguage: 'en', feedLabel: 'US' })?.productAttributes as { price: { amountMicros: string } }).price.amountMicros;
    expect(micros('1500 JPY')).toBe('1500000000');
    expect(micros('0.29 USD')).toBe('290000'); // 0.29 * 1e6 in floats is 289999.99…
    expect(micros('12.345 KWD')).toBe('12345000');
    expect(buildMerchantProductInput(item('12 dollars'), { contentLanguage: 'en', feedLabel: 'US' })).toBeNull();
  });
});

describe('ADR 0952 P7 — push-catalog-feed node', () => {
  const run = (out: Record<string, unknown>) => nodePack['feature.campaign-connectors.nodes.push-catalog-feed']({ features: { 'campaign-connectors': { importCsv: async () => ({}), pushCatalog: async () => out } }, inputs: { orgId: 'o1', platform: 'meta' } });
  it('is never success-with-nothing', async () => {
    expect((await run({ outcome: 'unsupported' })).error?.code).toBe('connector_not_configured');
    expect((await run({ outcome: 'no_connection' })).error?.code).toBe('no_connection');
    expect((await run({ outcome: 'pushed', sent: 0, removed: 0, failed: 2, failures: [{ id: 'a', op: 'upsert', outcome: 'failed', error: 'bad image' }] })).error?.code).toBe('push_failed');
    expect(await run({ outcome: 'pushed', sent: 1, removed: 0, failed: 1, failures: [] })).toMatchObject({ status: 'success' });
    expect(await run({ outcome: 'disabled' })).toMatchObject({ status: 'success', outputs: { outcome: 'disabled' } });
    const noOrg = await nodePack['feature.campaign-connectors.nodes.push-catalog-feed']({ features: { 'campaign-connectors': { importCsv: async () => ({}), pushCatalog: async () => ({}) } }, inputs: {} });
    expect(noOrg.error?.code).toBe('validation_error');
  });
});
