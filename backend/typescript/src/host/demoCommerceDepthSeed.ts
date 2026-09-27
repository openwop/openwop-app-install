/**
 * `demo-commerce-depth` seeder (app-seeding-strategy.md §4 Phase 4, ADR 0031).
 *
 * Catalog depth on top of the existing `commerce-showcase` (which stays), under a
 * distinct marker `demo:commerce-depth`: 24 products across 6 categories (with
 * images from Phase 2, variants, typed facet fields, low-stock cases), 2 bundles,
 * 3 subscribe-and-save products + 5 ProductSubscriptions, 3 per-company wholesale
 * price lists, 4 coupons, 2 affiliates, 45 orders over 60 days with deliberate
 * co-purchase patterns (Phase-5 affinity mines these), and 8 quotes.
 * `dependsOn: ['demo-media','demo-crm']`.
 *
 * Mechanics: real services (no deterministic ids in commerce → idempotency by the
 * `createdBy` marker + natural key). Toggle-gated on `commerce`; skips honestly.
 * Order timestamps are backdated post-creation via a targeted `createdAt` patch
 * on the order store (the service has no backdate hook; inventory is still
 * reserved correctly through `createOrder`). Clear removes byproduct rows
 * (subscriptions, quotes, stock movements, refunds, payouts) that have no delete
 * API, so seeding strands no orphans.
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import {
  createProduct, listProducts, deleteProduct,
  createOrder, listOrders, deleteOrder, markAsPaid, updateFulfillment, refundOrder, partialRefundOrder,
  createCoupon, listCoupons, deleteCoupon,
} from '../features/commerce/commerceService.js';
import { createPriceList, listPriceLists, deletePriceList } from '../features/commerce/pricing.js';
import { createAffiliate, listAffiliates } from '../features/commerce/affiliate.js';
import { createProductFieldDef, listProductFieldDefs } from '../features/commerce/productFields.js';
import { subscribeToProduct, listProductSubscriptions, cancelSubscription } from '../features/commerce/subscriptions.js';
import { createQuote, sendQuote, acceptQuote, listQuotes } from '../features/commerce/quotes.js';
import { mediaServeTokenByKey } from './demoMediaSeed.js';
import {
  SOLSTICE_CATALOG, SOLSTICE_PRODUCT_FIELD_DEFS, SOLSTICE_PRICE_LISTS, SOLSTICE_COUPONS,
  SOLSTICE_AFFILIATES, SOLSTICE_ORDER_TEMPLATES, SOLSTICE_QUOTES, SOLSTICE_COMPANIES,
  DEMO_COMMERCE_ACTOR, demoCrmCompanyId, demoCrmContactId, demoCrmDealId, type CatalogProduct,
} from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoCommerceDepth');

// Direct handles for byproduct stores with no per-row delete API (clear + the
// order-createdAt backdate patch, which the service exposes no hook for).
const orderStore = new DurableCollection<{ orderId: string; tenantId: string; createdBy?: string; createdAt?: string }>('commerce:order', (o) => o.orderId, undefined, (o) => o.tenantId);
const subStore = new DurableCollection<{ subscriptionId: string; tenantId: string; createdBy?: string; productId?: string }>('commerce:product-sub', (s) => s.subscriptionId, undefined, (s) => s.tenantId);
const quoteStore = new DurableCollection<{ quoteId: string; tenantId: string; createdBy?: string }>('commerce:quote', (q) => q.quoteId, undefined, (q) => q.tenantId);
const quoteRevStore = new DurableCollection<{ revisionId: string; tenantId: string; quoteId?: string }>('commerce:quote-revision', (r) => r.revisionId, undefined, (r) => r.tenantId);
const affiliateStore = new DurableCollection<{ affiliateId: string; tenantId: string; code?: string }>('commerce:affiliate', (a) => a.affiliateId, undefined, (a) => a.tenantId);
const stockMovementStore = new DurableCollection<{ movementId: string; tenantId: string; productId?: string }>('commerce:stock-movement', (m) => m.movementId, undefined, (m) => m.tenantId);
// commerce:refund is keyed by refundLedgerId (refundId is the OPTIONAL Stripe id,
// absent for keyless demo refunds — review #1357 HIGH).
const refundStore = new DurableCollection<{ refundLedgerId: string; tenantId: string; orderId?: string }>('commerce:refund', (r) => r.refundLedgerId, undefined, (r) => r.tenantId);
const reservationDueStore = new DurableCollection<{ orderId: string; tenantId: string }>('commerce:reservation-due', (r) => r.orderId, undefined, (r) => r.tenantId);
const payoutStore = new DurableCollection<{ payoutId: string; tenantId: string; affiliateId?: string }>('commerce:payout', (p) => p.payoutId, undefined, (p) => p.tenantId);

// CRM ids are tenant-scoped (see solsticeDemo demoCrm*Id) — bound per call below.

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

export async function countDemoCommerceDepth(tenantId: string): Promise<number> {
  const orgId = await orgIdFor(tenantId);
  return (await listProducts(tenantId, orgId)).filter((p) => p.createdBy === DEMO_COMMERCE_ACTOR).length;
}

/** Coffee products get whole-bean / ground / 2 lb variants with SKUs. */
function variantsFor(p: CatalogProduct): { name: string; sku: string; price?: number; inventory?: number }[] {
  if (!p.coffee) return [];
  const base = p.slug.slice(0, 3).toUpperCase();
  return [
    { name: '12 oz — whole bean', sku: `SR-${base}-12WB`, price: p.price, inventory: Math.round(p.inventory * 0.6) },
    { name: '12 oz — ground', sku: `SR-${base}-12GR`, price: p.price, inventory: Math.round(p.inventory * 0.3) },
    { name: '2 lb — whole bean', sku: `SR-${base}-2LB`, price: Math.round(p.price * 2.3), inventory: Math.round(p.inventory * 0.1) },
  ];
}

export async function seedDemoCommerceDepth(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  const COMPANY_ID = (slug: string): string => demoCrmCompanyId(tenantId, slug);
  const CONTACT_ID = (companySlug: string, k: number): string => demoCrmContactId(tenantId, companySlug, k);
  const DEAL_ID = (slug: string): string => demoCrmDealId(tenantId, slug);
  if (!(await resolveOne('commerce', { tenantId }))?.enabled) {
    return { created: 0, details: { skipped: 'commerce feature is off' } };
  }
  const orgId = await orgIdFor(tenantId);
  const nowMs = Date.now();
  let created = 0;

  // 1) Product field defs (typed facets).
  const existingDefs = new Set((await listProductFieldDefs(tenantId, orgId)).map((d) => d.key));
  for (const def of SOLSTICE_PRODUCT_FIELD_DEFS) {
    if (existingDefs.has(def.key)) continue;
    await createProductFieldDef({ tenantId, orgId, key: def.key, label: def.label, type: def.type, options: def.options });
    created += 1;
  }

  // 2) Products — simple products first (bundles reference them). Idempotent by
  //    actor + name; image token resolved from the Phase-2 media library.
  const existing = (await listProducts(tenantId, orgId)).filter((p) => p.createdBy === DEMO_COMMERCE_ACTOR);
  const idByName = new Map<string, string>(existing.map((p) => [p.name, p.productId]));
  const idBySlug = new Map<string, string>();
  const ordered = [...SOLSTICE_CATALOG].sort((a, b) => Number(!!a.bundleOf) - Number(!!b.bundleOf));
  for (const p of ordered) {
    const found = idByName.get(p.name);
    if (found) { idBySlug.set(p.slug, found); continue; }
    const token = await mediaServeTokenByKey(tenantId, orgId, p.slug);
    const customFields: Record<string, string> = {};
    if (p.roast) customFields.roast = p.roast;
    if (p.origin) customFields.origin = p.origin;
    if (p.format) customFields.format = p.format;
    const product = await createProduct({
      tenantId, orgId, createdBy: DEMO_COMMERCE_ACTOR, type: 'physical',
      name: p.name, description: p.description, price: p.price, currency: 'USD',
      inventory: p.inventory, ...(p.lowStock ? { lowStockThreshold: 10 } : {}),
      categories: [p.category], variants: variantsFor(p),
      ...(token ? { imageAssetTokens: [token] } : {}),
      ...(Object.keys(customFields).length ? { customFields } : {}),
      ...(p.sub ? { subscription: { enabled: true, intervals: p.sub.intervals, savePercent: p.sub.savePercent } } : {}),
      ...(p.bundleOf ? { kind: 'bundle', components: p.bundleOf.map((c) => ({ productId: idBySlug.get(c.slug)!, quantity: c.quantity })) } : {}),
    });
    idBySlug.set(p.slug, product.productId);
    created += 1;
  }

  // 3) Coupons + affiliates (idempotent by code).
  const existingCodes = new Set((await listCoupons(tenantId, orgId)).map((c) => c.code));
  for (const c of SOLSTICE_COUPONS) {
    if (existingCodes.has(c.code)) continue;
    await createCoupon({ tenantId, orgId, code: c.code, type: c.type, value: c.value, ...(c.currency ? { currency: c.currency } : {}) });
    created += 1;
  }
  const existingAff = new Set((await listAffiliates(tenantId, orgId)).map((a) => a.code));
  for (const a of SOLSTICE_AFFILIATES) {
    if (existingAff.has(a.code)) continue;
    await createAffiliate({ tenantId, orgId, code: a.code, name: a.name, commissionType: a.commissionType, commissionRate: a.commissionRate });
    created += 1;
  }

  // 4) Per-company wholesale price lists (idempotent by name).
  const existingLists = new Set((await listPriceLists(tenantId, orgId)).filter((l) => l.createdBy === DEMO_COMMERCE_ACTOR).map((l) => l.name));
  for (const pl of SOLSTICE_PRICE_LISTS) {
    if (existingLists.has(pl.name)) continue;
    const entries = pl.productSlugs
      .map((slug) => ({ slug, productId: idBySlug.get(slug) }))
      .filter((e): e is { slug: string; productId: string } => !!e.productId)
      .map((e) => ({ productId: e.productId, price: Math.round((SOLSTICE_CATALOG.find((c) => c.slug === e.slug)!.price) * (1 - pl.savePercent / 100)) }));
    await createPriceList({ tenantId, orgId, createdBy: DEMO_COMMERCE_ACTOR, name: pl.name, currency: 'USD', entries, companyIds: [COMPANY_ID(pl.companySlug)], priority: 10 });
    created += 1;
  }

  // 5) Orders (45) — at-least-one-then-skip (order mutates inventory; per-order
  //    diffing isn't idempotent, so a mid-batch crash strands a partial set that a
  //    re-seed then skips — recover via clear + re-seed). Backdated over 60 days
  //    via a post-create createdAt patch.
  const hasOrders = (await listOrders(tenantId, orgId)).some((o) => o.createdBy === DEMO_COMMERCE_ACTOR);
  if (!hasOrders) {
    created += await seedOrders(tenantId, orgId, nowMs, idBySlug);
  }

  // 6) Subscriptions (5) — all-or-nothing; link to CRM contacts; some canceled.
  const hasSubs = (await listProductSubscriptions(tenantId, orgId)).some((s) => s.createdBy === DEMO_COMMERCE_ACTOR);
  if (!hasSubs) {
    const subPlan: { slug: string; interval: 'weekly' | 'monthly' | 'quarterly'; company: string; cancel?: boolean }[] = [
      { slug: 'house-blend', interval: 'monthly', company: 'morning-ritual-cafe' },
      { slug: 'house-blend', interval: 'weekly', company: 'corner-cup-coffee' },
      { slug: 'subscription-box', interval: 'monthly', company: 'fika-house' },
      { slug: 'subscription-box', interval: 'quarterly', company: 'daily-grind-co', cancel: true },
      { slug: 'espresso-blend', interval: 'monthly', company: 'sunbeam-roastery-bar' },
    ];
    for (const s of subPlan) {
      const productId = idBySlug.get(s.slug);
      if (!productId) continue;
      const { subscription } = await subscribeToProduct({ tenantId, orgId, createdBy: DEMO_COMMERCE_ACTOR, productId, interval: s.interval, contactId: CONTACT_ID(s.company, 0) });
      if (s.cancel) await cancelSubscription(tenantId, orgId, subscription.subscriptionId);
      created += 1;
    }
  }

  // 7) Quotes (8) — all-or-nothing; one 'accepted' converts to an order.
  const hasQuotes = (await listQuotes(tenantId, orgId)).some((q) => q.createdBy === DEMO_COMMERCE_ACTOR);
  if (!hasQuotes) {
    for (const q of SOLSTICE_QUOTES) {
      const lines = q.lines.map((l) => ({ productId: idBySlug.get(l.slug)!, quantity: l.quantity })).filter((l) => l.productId);
      if (!lines.length) continue;
      const quote = await createQuote({ tenantId, orgId, createdBy: DEMO_COMMERCE_ACTOR, lines, companyId: COMPANY_ID(q.companySlug), dealId: DEAL_ID(q.dealSlug), contactId: CONTACT_ID(q.companySlug, 0) });
      if (q.advanceTo === 'sent' || q.advanceTo === 'accepted') await sendQuote(tenantId, orgId, quote.quoteId, {});
      if (q.advanceTo === 'accepted') await acceptQuote(tenantId, orgId, quote.quoteId, { actor: DEMO_COMMERCE_ACTOR });
      created += 1;
    }
  }

  const details = { products: SOLSTICE_CATALOG.length, priceLists: SOLSTICE_PRICE_LISTS.length, coupons: SOLSTICE_COUPONS.length, quotes: SOLSTICE_QUOTES.length };
  log.info('demo_commerce_depth_seeded', { tenantId, created, ...details });
  return { created, details };
}

async function seedOrders(tenantId: string, orgId: string, nowMs: number, idBySlug: Map<string, string>): Promise<number> {
  let n = 0;
  for (let i = 0; i < 45; i += 1) {
    const tmpl = SOLSTICE_ORDER_TEMPLATES[i % SOLSTICE_ORDER_TEMPLATES.length]!;
    const lines = tmpl.slugs.map((slug) => ({ productId: idBySlug.get(slug)!, quantity: slug.includes('blend') || slug.includes('house') ? 2 : 1 })).filter((l) => l.productId);
    if (!lines.length) continue;
    const company = SOLSTICE_COMPANIES[i % SOLSTICE_COMPANIES.length]!;
    const order = await createOrder({
      tenantId, orgId, createdBy: DEMO_COMMERCE_ACTOR,
      contactId: demoCrmContactId(tenantId, company.slug, 0), lines,
      ...(i % 7 === 0 ? { couponCode: 'SOLSTICE-WELCOME20' } : {}),
      ...(i % 9 === 0 ? { affiliateCode: 'SOLSTICE-BARISTABLOG' } : {}),
      shippingAddress: { name: company.name, city: company.hqCity, country: 'US' },
    });
    // Lifecycle spread.
    const mod = i % 5;
    if (mod !== 3) await markAsPaid(tenantId, orgId, order.orderId, `demo:pi_depth_${i}`);
    if (mod === 2) for (const fs of ['processing', 'shipped', 'delivered'] as const) await updateFulfillment(tenantId, orgId, order.orderId, fs);
    if (i % 15 === 4) await refundOrder(tenantId, orgId, order.orderId, { actor: DEMO_COMMERCE_ACTOR });
    else if (i % 15 === 9) await partialRefundOrder(tenantId, orgId, order.orderId, Math.max(2, Math.round(order.total * 0.3)), { refundKey: `demo-${i}`, actor: DEMO_COMMERCE_ACTOR });
    // Backdate createdAt over the past 60 days (newest = i=44). Targeted patch —
    // inventory was already reserved correctly by createOrder; only the timestamp
    // moves, and the tenant index is keyed by orderId (unaffected).
    const row = await orderStore.get(order.orderId);
    if (row) { row.createdAt = new Date(nowMs - Math.round((60 * (44 - i)) / 44) * 86400_000).toISOString(); await orderStore.put(row); }
    n += 1;
  }
  return n;
}

export async function clearDemoCommerceDepth(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  let cleared = 0;

  // Orders (delete API) + their byproduct rows (no delete API → direct store):
  // refund-ledger (keyed by refundLedgerId, not the optional Stripe refundId) and
  // the pending-order reservation-due rows (review #1357 HIGH/MEDIUM).
  const demoOrderIds = new Set<string>();
  for (const o of (await listOrders(tenantId, orgId)).filter((x) => x.createdBy === DEMO_COMMERCE_ACTOR)) {
    demoOrderIds.add(o.orderId);
    if (await deleteOrder(tenantId, orgId, o.orderId)) cleared += 1;
  }
  for (const r of (await refundStore.listForTenantIndexed(tenantId)).filter((x) => x.orderId && demoOrderIds.has(x.orderId))) {
    await refundStore.delete(r.refundLedgerId); cleared += 1;
  }
  for (const orderId of demoOrderIds) { await reservationDueStore.delete(orderId); }
  // Subscriptions + quotes (+ revisions) — no delete API.
  const demoQuoteIds = new Set<string>();
  for (const s of (await subStore.listForTenantIndexed(tenantId)).filter((x) => x.createdBy === DEMO_COMMERCE_ACTOR)) {
    await subStore.delete(s.subscriptionId); cleared += 1;
  }
  for (const q of (await quoteStore.listForTenantIndexed(tenantId)).filter((x) => x.createdBy === DEMO_COMMERCE_ACTOR)) {
    demoQuoteIds.add(q.quoteId); await quoteStore.delete(q.quoteId); cleared += 1;
  }
  for (const r of (await quoteRevStore.listForTenantIndexed(tenantId)).filter((x) => x.quoteId && demoQuoteIds.has(x.quoteId))) {
    await quoteRevStore.delete(r.revisionId);
  }
  // Price lists + coupons (delete APIs).
  for (const l of (await listPriceLists(tenantId, orgId)).filter((x) => x.createdBy === DEMO_COMMERCE_ACTOR)) {
    if (await deletePriceList(tenantId, orgId, l.priceListId)) cleared += 1;
  }
  const codes = new Set(SOLSTICE_COUPONS.map((c) => c.code));
  for (const c of (await listCoupons(tenantId, orgId)).filter((x) => codes.has(x.code))) {
    if (await deleteCoupon(tenantId, orgId, c.couponId)) cleared += 1;
  }
  // Affiliates + payouts (no delete API → direct store).
  const affCodes = new Set(SOLSTICE_AFFILIATES.map((a) => a.code));
  const demoAffIds = new Set<string>();
  for (const a of (await affiliateStore.listForTenantIndexed(tenantId)).filter((x) => x.code && affCodes.has(x.code))) {
    demoAffIds.add(a.affiliateId); await affiliateStore.delete(a.affiliateId); cleared += 1;
  }
  for (const p of (await payoutStore.listForTenantIndexed(tenantId)).filter((x) => x.affiliateId && demoAffIds.has(x.affiliateId))) {
    await payoutStore.delete(p.payoutId);
  }
  // Products (delete API) + their stock movements (no delete API → direct store).
  const demoProductIds = new Set<string>();
  for (const p of (await listProducts(tenantId, orgId)).filter((x) => x.createdBy === DEMO_COMMERCE_ACTOR)) {
    demoProductIds.add(p.productId);
    if (await deleteProduct(tenantId, orgId, p.productId)) cleared += 1;
  }
  for (const m of (await stockMovementStore.listForTenantIndexed(tenantId)).filter((x) => x.productId && demoProductIds.has(x.productId))) {
    await stockMovementStore.delete(m.movementId);
  }
  // Product field defs (roast/origin/format) are DELIBERATELY left on clear
  // (review #1357 MEDIUM): they carry no owner marker and their keys are the same
  // a user might independently define — deleting by shared key would clobber a
  // user's schema, and products reference these keys in customFields so they
  // can't be namespaced. They are harmless shared schema; a re-seed is idempotent
  // by key. (SOLSTICE_PRODUCT_FIELD_DEFS + listProductFieldDefs/deleteProductFieldDef
  // stay imported for the seed path.)

  log.info('demo_commerce_depth_cleared', { tenantId, cleared });
  return { cleared };
}
