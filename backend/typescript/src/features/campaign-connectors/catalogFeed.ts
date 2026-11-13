/**
 * ADR 0952 D6 (P7) — a product feed GENERATED from the one commerce catalog.
 *
 * Team-lead decision Q4 (2026-10-20, David can override): no second product
 * store. The feed is built on request from `iterateCatalog` (ADR 0410's catalog,
 * read one page at a time since ADR 1110),
 * served at a SIGNED public URL that Google Merchant Center and Meta Catalog can
 * fetch on a schedule, and pushed by API through `host/catalogPushAdapter.ts`
 * (fixture-only until the accounts exist).
 *
 * Fields follow Google's product data specification
 * (https://support.google.com/merchants/answer/7052112): id, title, description,
 * link, image_link, additional_image_link, availability, price, condition,
 * item_group_id, product_type, identifier_exists. Meta's catalog accepts the same
 * RSS 2.0 + `g:` namespace feed. Only what the public store already shows goes in:
 * never cost, raw inventory or non-public fields.
 *
 * Only active products with a price and at least one real catalog image
 * (`imageAssetTokens`, the product's own media) are included; the rest are
 * listed with a reason. Each item carries a content hash, so a push sends only
 * items that changed.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { readSessionSecret } from '../../middleware/cookieSession.js';
import { vendorPublicUrl } from '../featureRoute.js';
import { catalogSize, iterateCatalog, isPubliclyListed, type Product } from '../commerce/commerceService.js';
import { OpenwopError } from '../../types.js';
import { isoExponent, adsCatalogPushEnabled } from '../../host/adsWire.js';
import { pushCatalogItems, type CatalogPlatform, type CatalogPushResult, type ItemResult } from '../../host/catalogPushAdapter.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { getOrg } from '../../host/accessControlService.js';
import { checkOwnerPublicAccess } from '../../host/publicLapse.js';

// ── Feed items (Google product data spec) ────────────────────────────────────

export interface FeedItem {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  additional_image_link?: string[];
  availability: 'in_stock' | 'out_of_stock';
  /** "12.34 USD": major units with the currency's own decimals, then the ISO code. */
  price: string;
  condition: 'new';
  item_group_id?: string;
  product_type?: string;
  /** No GTIN or MPN in this catalog, so the identifier is declared absent. */
  identifier_exists: 'no';
  /** sha256 of the canonical item: an unchanged item is not re-pushed. */
  contentHash: string;
}
export interface ExcludedItem { productId: string; reason: 'no_image' | 'no_price' | 'invalid_currency' }
export interface ProductFeed { items: FeedItem[]; excluded: ExcludedItem[] }

const TITLE_MAX = 150; // Google: title max 150 characters
const DESC_MAX = 5000; // Google: description max 5000 characters

function priceString(amountMajor: number, currency: string): string | null {
  const exp = isoExponent(currency);
  if (exp === null || !Number.isFinite(amountMajor) || amountMajor < 0) return null;
  return `${amountMajor.toFixed(exp)} ${currency}`;
}

/** Google caps `id` at 50 characters; a product id is 41 (`prod:` + uuid), a
 *  product + variant pair is not. So a variant's id is a stable digest of the
 *  pair, and `item_group_id` carries the product id that groups them. */
export function variantItemId(productId: string, variantId: string): string {
  return `pv-${createHash('sha256').update(`${productId}|${variantId}`).digest('hex').slice(0, 40)}`;
}

function hashItem(item: Omit<FeedItem, 'contentHash'>): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex');
}

/** ADR 1110 P3 — the feed items of a set of products (pure). `baseUrl` is the public
 *  origin. Callers pass listed products only (ADR 1098 — a quote-only product never
 *  reaches an ad catalog); this re-checks, so a stale caller cannot leak one. */
export function feedForProducts(products: readonly Product[], orgId: string, baseUrl: string): ProductFeed {
  const items: FeedItem[] = [];
  const excluded: ExcludedItem[] = [];
  const base = baseUrl.replace(/\/+$/, '');
  const assetUrl = (token: string): string => vendorPublicUrl(base, `/assets/${encodeURIComponent(token)}`);
  const link = `${base}/store/${encodeURIComponent(orgId)}`;
  for (const p of products) {
    if (!isPubliclyListed(p)) continue;
    if (!p.imageAssetTokens?.length) { excluded.push({ productId: p.productId, reason: 'no_image' }); continue; }
    if (!Number.isFinite(p.price) || p.price <= 0) { excluded.push({ productId: p.productId, reason: 'no_price' }); continue; }
    if (isoExponent(p.currency) === null) { excluded.push({ productId: p.productId, reason: 'invalid_currency' }); continue; }
    const shared = {
      title: p.name.slice(0, TITLE_MAX),
      description: (p.description ?? p.name).slice(0, DESC_MAX),
      link,
      image_link: assetUrl(p.imageAssetTokens[0] as string),
      ...(p.imageAssetTokens.length > 1 ? { additional_image_link: p.imageAssetTokens.slice(1, 11).map(assetUrl) } : {}),
      condition: 'new' as const,
      ...(p.categories?.length ? { product_type: p.categories.join(' > ') } : {}),
      identifier_exists: 'no' as const,
    };
    const availability = (v?: number): FeedItem['availability'] => (p.type === 'physical' ? ((v ?? p.inventory ?? 0) > 0 ? 'in_stock' : 'out_of_stock') : 'in_stock');
    if (p.variants?.length) {
      for (const v of p.variants) {
        const price = priceString(v.price ?? p.price, p.currency);
        if (!price) continue;
        const item = { id: variantItemId(p.productId, v.variantId), ...shared, title: `${p.name} - ${v.name}`.slice(0, TITLE_MAX), availability: availability(v.inventory), price, item_group_id: p.productId };
        items.push({ ...item, contentHash: hashItem(item) });
      }
    } else {
      const price = priceString(p.price, p.currency) as string;
      const item = { id: p.productId, ...shared, availability: availability(), price };
      items.push({ ...item, contentHash: hashItem(item) });
    }
  }
  return { items, excluded };
}

/** ADR 1110 P3 — the org's feed, one batch of products at a time (name order), so no
 *  caller holds the whole catalog: the public XML streams it, the push walks it, the
 *  settings view counts it. */
export async function* feedBatches(tenantId: string, orgId: string, baseUrl: string, batch = 500): AsyncGenerator<ProductFeed> {
  let products: Product[] = [];
  for await (const p of iterateCatalog(tenantId, orgId, batch)) {
    if (isPubliclyListed(p)) products.push(p);
    if (products.length >= batch) { yield feedForProducts(products, orgId, baseUrl); products = []; }
  }
  if (products.length > 0) yield feedForProducts(products, orgId, baseUrl);
}

/** Most items the settings view counts, and excluded products it lists. */
const FEED_COUNT_CAP = 10_000;
/** Most products the settings view reads to count the feed. */
const FEED_SCAN_CAP = 20_000;
/** Most changes (upserts + removals) one push sends, as one approved change set. */
let PUSH_CHANGE_CAP = 10_000;
/** Test-only: lower the push cap so a test can cross it without 10,000 products. */
export function __setPushChangeCapForTest(n: number | null): void { PUSH_CHANGE_CAP = n ?? 10_000; }
const EXCLUDED_LIST_CAP = 200;

/** ADR 1110 P3 — the settings view's figures, bounded: items counted up to
 *  `FEED_COUNT_CAP` (then `itemsCapped`), the first `EXCLUDED_LIST_CAP` exclusions and
 *  how many there were. */
export async function feedSummary(tenantId: string, orgId: string, baseUrl: string): Promise<{ items: number; itemsCapped: boolean; excluded: ExcludedItem[]; excludedTotal: number }> {
  let items = 0;
  let excludedTotal = 0;
  let products = 0;
  const excluded: ExcludedItem[] = [];
  for await (const b of feedBatches(tenantId, orgId, baseUrl)) {
    items += b.items.length;
    excludedTotal += b.excluded.length;
    products += b.items.length + b.excluded.length;
    for (const e of b.excluded) if (excluded.length < EXCLUDED_LIST_CAP) excluded.push(e);
    // Bounded by products READ, not items counted: a catalog where most products are
    // left out (no image) must not be walked to the end inside a settings request.
    if (items >= FEED_COUNT_CAP || products >= FEED_SCAN_CAP) return { items, itemsCapped: true, excluded, excludedTotal };
  }
  return { items, itemsCapped: false, excluded, excludedTotal };
}

/** ADR 1110 (round fix) — the largest catalog a push walks inside its request. Above it
 *  the push refuses (`catalog_too_large`): the signed feed URL, which the platforms fetch
 *  on their own schedule, is the lane for a catalog that size. */
export const PUSH_CATALOG_MAX = 20_000;

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

type FeedChannel = { title: string; link: string; brand: string };

/** RSS 2.0 with Google's `g:` namespace (accepted by Merchant Center and Meta). */
export function renderFeedXml(feed: ProductFeed, channel: FeedChannel): string {
  return `${feedXmlHead(channel)}${feedXmlItems(feed.items, channel.brand)}${FEED_XML_TAIL}`;
}

/** ADR 1110 P3 — the same document in three parts, so it can be streamed batch by batch. */
export function feedXmlHead(channel: FeedChannel): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${xml(channel.title)}</title><link>${xml(channel.link)}</link>`;
}
export const FEED_XML_TAIL = '</channel></rss>\n';
export function feedXmlItems(feedItems: readonly FeedItem[], brand: string): string {
  const tag = (k: string, v: string): string => `<g:${k}>${xml(v)}</g:${k}>`;
  const items = feedItems.map((i) => [
    '<item>',
    tag('id', i.id), `<title>${xml(i.title)}</title>`, `<description>${xml(i.description)}</description>`, `<link>${xml(i.link)}</link>`,
    tag('image_link', i.image_link), ...(i.additional_image_link ?? []).map((u) => tag('additional_image_link', u)),
    tag('availability', i.availability), tag('price', i.price), tag('condition', i.condition),
    ...(i.item_group_id ? [tag('item_group_id', i.item_group_id)] : []),
    ...(i.product_type ? [tag('product_type', i.product_type)] : []),
    tag('brand', brand), tag('identifier_exists', i.identifier_exists),
    '</item>',
  ].join(''));
  return items.join('');
}

// ── Feed settings + the signed public URL ────────────────────────────────────

export interface CatalogFeedSettings {
  key: string;
  tenantId: string;
  orgId: string;
  enabled: boolean;
  /** Bumped on rotate: every earlier signed URL stops working. */
  version: number;
  /** Meta Catalog the push targets (API push, fixture-only until verified). */
  metaCatalogId?: string;
  /** Google Merchant Center account + data source for the Merchant API push. */
  merchantAccountId?: string;
  merchantDataSource?: string;
  /** Merchant API product inputs require both (defaults en / US). */
  contentLanguage: string;
  feedLabel: string;
  updatedAt: string;
}
const settingsStore = new DurableCollection<CatalogFeedSettings>('campaign-connectors:catalog-feed', (s) => `${s.tenantId}::${s.orgId}`);
const settingsKey = (tenantId: string, orgId: string): string => `${tenantId}::${orgId}`;

/** A read error serves the feed as OFF (fail closed). A WRITE never builds on that
 *  fallback (`strict`): saving over a failed read would reset `version` to 1 and
 *  bring rotated-away URLs back to life. */
export async function getFeedSettings(tenantId: string, orgId: string, opts: { strict?: boolean } = {}): Promise<CatalogFeedSettings> {
  const read = settingsStore.get(settingsKey(tenantId, orgId));
  const row = opts.strict ? await read : await read.catch(() => undefined);
  if (row && row.tenantId === tenantId && row.orgId === orgId) return row;
  return { key: settingsKey(tenantId, orgId), tenantId, orgId, enabled: false, version: 1, contentLanguage: 'en', feedLabel: 'US', updatedAt: '' };
}

const ID_RE = /^[0-9]{1,30}$/;
const DS_RE = /^accounts\/[0-9]{1,30}\/dataSources\/[0-9]{1,30}$/;
export async function saveFeedSettings(
  tenantId: string, orgId: string,
  input: { enabled?: unknown; metaCatalogId?: unknown; merchantAccountId?: unknown; merchantDataSource?: unknown; contentLanguage?: unknown; feedLabel?: unknown },
  opts: { rotate?: boolean } = {},
): Promise<CatalogFeedSettings> {
  const prev = await getFeedSettings(tenantId, orgId, { strict: true });
  const opt = (v: unknown, re: RegExp, field: string, cur?: string): string | undefined => {
    if (v === undefined) return cur;
    if (v === null || v === '') return undefined;
    if (typeof v !== 'string' || !re.test(v)) throw new OpenwopError('validation_error', `\`${field}\` is not valid.`, 400, { field });
    return v;
  };
  const next: CatalogFeedSettings = {
    ...prev,
    enabled: input.enabled === undefined ? prev.enabled : input.enabled === true,
    version: prev.version + (opts.rotate ? 1 : 0),
    contentLanguage: opt(input.contentLanguage, /^[a-z]{2}$/, 'contentLanguage', prev.contentLanguage) ?? 'en',
    feedLabel: opt(input.feedLabel, /^[A-Z0-9_-]{1,20}$/, 'feedLabel', prev.feedLabel) ?? 'US',
    updatedAt: new Date().toISOString(),
  };
  const meta = opt(input.metaCatalogId, ID_RE, 'metaCatalogId', prev.metaCatalogId);
  const acct = opt(input.merchantAccountId, ID_RE, 'merchantAccountId', prev.merchantAccountId);
  const ds = opt(input.merchantDataSource, DS_RE, 'merchantDataSource', prev.merchantDataSource);
  delete next.metaCatalogId; delete next.merchantAccountId; delete next.merchantDataSource;
  if (meta) next.metaCatalogId = meta;
  if (acct) next.merchantAccountId = acct;
  if (ds) next.merchantDataSource = ds;
  await settingsStore.put(next);
  return next;
}

function feedSignature(tenantId: string, orgId: string, version: number): string {
  return createHmac('sha256', readSessionSecret()).update(`catalog-feed:${tenantId}:${orgId}:${version}`).digest('base64url');
}
export function signedFeedUrl(baseUrl: string, s: CatalogFeedSettings): string {
  return vendorPublicUrl(baseUrl, `/public/${encodeURIComponent(s.orgId)}/catalog/feed.xml?v=${s.version}&sig=${feedSignature(s.tenantId, s.orgId, s.version)}`);
}
/** Timing-safe; the version must be the CURRENT one, so a rotation kills old URLs. */
export function verifyFeedSignature(s: CatalogFeedSettings, version: unknown, sig: unknown): boolean {
  if (typeof sig !== 'string' || String(version) !== String(s.version)) return false;
  const want = Buffer.from(feedSignature(s.tenantId, s.orgId, s.version));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}


// ── API push: only CHANGED items, and removals ───────────────────────────────


interface PushLedgerRow { key: string; tenantId: string; orgId: string; platform: CatalogPlatform; itemId: string; hash: string; at: string }
const pushLedger = new DurableCollection<PushLedgerRow>('campaign-connectors:catalog-push', (r) => `${r.tenantId}::${r.orgId}::${r.platform}::${r.itemId}`);

export type CatalogPushOutcome =
  /** `excluded` lists at most EXCLUDED_LIST_CAP of `excludedTotal`; `remaining` is how many
   *  changes waited past PUSH_CHANGE_CAP for the next push (absent when none did). */
  | { outcome: 'pushed'; sent: number; unchanged: number; removed: number; failed: number; excluded: ExcludedItem[]; excludedTotal: number; failures: Array<Extract<ItemResult, { outcome: 'failed' }>>; remaining?: number }
  | { outcome: 'unsupported' | 'no_connection' | 'disabled' }
  /** The store does not serve (commerce off, or the owner lapsed): every listing would link to a dead store. */
  | { outcome: 'commerce_off' }
  /** ADR 1110 — over PUSH_CATALOG_MAX products: use the signed feed URL instead. */
  | { outcome: 'catalog_too_large'; max: number }
  | { outcome: 'not_configured'; missing: string }
  | Extract<CatalogPushResult, { outcome: 'refused' }>
  | Extract<CatalogPushResult, { outcome: 'requires_approval' }>;

/** Does this tenant's public store serve right now? The SAME check the store's
 *  own public routes use (`publicStoreOrg`: the commerce toggle plus the owner's
 *  plan lapse), so a feed never lists products the store would 404. */
export async function commerceServesStore(tenantId: string): Promise<boolean> {
  return (await checkOwnerPublicAccess('commerce', tenantId)).serve;
}

/** Push the org's feed to one platform. An item is sent only when its content
 *  changed since the last successful push; an item that left the feed (deleted,
 *  inactive, lost its image) is REMOVED from the platform catalog, so a product
 *  you stopped selling stops being advertised. Only successful items move the
 *  ledger, so a failed item is retried next time. */
export async function pushCatalog(deps: BrokeredEgressDeps, tenantId: string, orgId: string, platform: CatalogPlatform, baseUrl: string | undefined): Promise<CatalogPushOutcome> {
  const settings = await getFeedSettings(tenantId, orgId);
  if (!settings.enabled) return { outcome: 'disabled' };
  // A listing links to the store, and the store answers 404 while it does not
  // serve (`commerceServesStore`). Refuse BEFORE building the feed: an empty feed
  // here would turn every item into a removal and DELETE the client's whole
  // platform catalog because a toggle was flipped.
  if (!(await commerceServesStore(tenantId))) return { outcome: 'commerce_off' };
  if (!baseUrl) return { outcome: 'not_configured', missing: 'OPENWOP_PUBLIC_BASE_URL' };
  // Before anything else: an unverified platform never reports `pushed`, even
  // when there is nothing to send.
  if (!adsCatalogPushEnabled(platform)) return { outcome: 'unsupported' };
  if ((await catalogSize(tenantId, orgId)) > PUSH_CATALOG_MAX) return { outcome: 'catalog_too_large', max: PUSH_CATALOG_MAX };
  const org = await getOrg(orgId);
  const brand = org?.name ?? orgId; // the seller's own name: these are the org's own products
  const prefix = `${tenantId}::${orgId}::${platform}::`;
  const hashOf = (i: FeedItem): string => createHash('sha256').update(`${i.contentHash}:${brand}`).digest('hex');
  // ADR 1110 P3 — the feed is walked a batch at a time and the ledger read by key, so a
  // push never holds the catalog. One push sends at most PUSH_CHANGE_CAP changes as ONE
  // approved change set (the gate binds its hash: approve what you see); the rest wait
  // for the next push, which finds them still changed because only sent items move
  // the ledger.
  const upserts: FeedItem[] = [];
  const live = new Set<string>();
  let unchanged = 0;
  let remaining = 0;
  let excludedTotal = 0;
  const excluded: ExcludedItem[] = [];
  for await (const batch of feedBatches(tenantId, orgId, baseUrl)) {
    excludedTotal += batch.excluded.length;
    for (const e of batch.excluded) if (excluded.length < EXCLUDED_LIST_CAP) excluded.push(e);
    for (let i = 0; i < batch.items.length; i += 16) {
      const slice = batch.items.slice(i, i + 16);
      const rows = await Promise.all(slice.map((it) => pushLedger.get(`${prefix}${it.id}`)));
      slice.forEach((it, j) => {
        live.add(it.id);
        const row = rows[j];
        const same = row && row.tenantId === tenantId && row.orgId === orgId && row.hash === hashOf(it);
        if (same) unchanged += 1;
        else if (upserts.length < PUSH_CHANGE_CAP) upserts.push(it);
        else remaining += 1;
      });
    }
  }
  // Removals: ledger rows whose item left the feed, read a page at a time.
  const deletes: string[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await pushLedger.listByPrefixPage(prefix, { ...(afterId !== undefined ? { afterId } : {}), limit: 500 });
    for (const r of page.items) {
      if (r.tenantId !== tenantId || r.orgId !== orgId || live.has(r.itemId)) continue;
      if (upserts.length + deletes.length < PUSH_CHANGE_CAP) deletes.push(r.itemId); else remaining += 1;
    }
    if (!page.lastId) break;
    afterId = page.lastId;
  }
  const more = remaining > 0 ? { remaining } : {};
  if (upserts.length === 0 && deletes.length === 0) {
    return { outcome: 'pushed', sent: 0, unchanged, removed: 0, failed: 0, excluded, excludedTotal, failures: [], ...more };
  }
  const r = await pushCatalogItems(deps, platform, settings, upserts.map(({ contentHash: _h, identifier_exists: _x, ...i }) => ({ ...i, brand })), deletes);
  if (r.outcome !== 'pushed') return r.outcome === 'not_configured' || r.outcome === 'refused' || r.outcome === 'requires_approval' ? r : { outcome: r.outcome };
  const at = new Date().toISOString();
  const byId = new Map(upserts.map((i) => [i.id, i]));
  for (const res of r.results) {
    if (res.outcome !== 'ok') continue;
    const key = `${prefix}${res.id}`;
    if (res.op === 'delete') await pushLedger.delete(key).catch(() => undefined);
    else { const it = byId.get(res.id); if (it) await pushLedger.put({ key, tenantId, orgId, platform, itemId: res.id, hash: hashOf(it), at }); }
  }
  const failures = r.results.filter((x): x is Extract<ItemResult, { outcome: 'failed' }> => x.outcome === 'failed');
  return {
    outcome: 'pushed',
    sent: r.results.filter((x) => x.op === 'upsert' && x.outcome === 'ok').length,
    unchanged,
    removed: r.results.filter((x) => x.op === 'delete' && x.outcome === 'ok').length,
    failed: failures.length, excluded, excludedTotal, failures, ...more,
  };
}
