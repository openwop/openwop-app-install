/**
 * E-Commerce store (ADR 0177 Phase 1) — Products + Orders with the order lifecycle
 * state machine on real org-scoped persistence (MyndHyve's is in-memory). Composes
 * existing owners: product images / digital-download bytes = Media tokens (RFC 0055);
 * customer = a CRM `contactId` reference (ADR 0008 — no net-new Customer). Payment is
 * DEMO-MODE / external-intent (`markAsPaid(paymentIntentId)`, `not_configured`) — faithful
 * to MyndHyve, no capture fn. Every record tenant+org-scoped; every accessor verifies
 * BOTH (CTI-1 IDOR guard). Pure host-extension — no wire, no RFC.
 *
 * @see docs/adr/0177-e-commerce.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { createLogger } from '../../observability/logger.js';
import { getGovernancePolicy } from '../../host/governanceService.js';
import { getApproval, createCommerceSpendApproval } from '../../host/approvalService.js';
import { recordCommerceAction } from './telemetry.js';
import { resolvePrice, resolveSellable } from './pricing.js';
import { computeOrderPromotions, type AppliedPromotion } from './promotionSeam.js';
import { fireProductDeleted } from './productLifecycleSeam.js';
import { accrueCommission, reverseCommission, __resetAffiliates } from './affiliate.js';
import { getContact } from '../crm/contactsService.js';
import { createActivity, createDeal, makeLinkValidators } from '../crm/crmEntitiesService.js';
import { sendTransactionalEmail } from './transactionalEmail.js';
import { getStripePaymentIntent, createStripeRefund, toStripeMinorUnits, fromStripeMinorUnits } from '../billing/stripeApi.js';
import { quoteTaxAndShipping } from './taxShipping.js';
import { validateProductCustomFields, __clearProductFieldDefs } from './productFields.js';
import { recordEvent } from '../analytics/analyticsService.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';

export { recordCommerceAction } from './telemetry.js';

const log = createLogger('commerce.service');

const MAX = { name: 200, short: 120, desc: 4000, currency: 8, variants: 60, items: 200, images: 24, perOrg: 5000 } as const;
/** C5 — how long a pending order holds its stock before the expiry sweep auto-cancels. */
const RESERVATION_TTL_MS = (() => {
  const raw = Number(process.env.OPENWOP_COMMERCE_RESERVATION_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
})();
const nowIso = (): string => new Date().toISOString();
const cleanStr = (raw: unknown, max: number, fb = ''): string => cleanString(raw, max, fb);
const optStr = (raw: unknown, max: number): string | undefined => optionalCleanString(raw, max);
const nonNeg = (raw: unknown): number | undefined => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined);
/** C6 — bounded, lowercase, de-duped facet list (categories/tags). */
function cleanFacets(raw: unknown, max = 20): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const f = v.trim().toLowerCase().slice(0, 60);
    if (f && !out.includes(f)) out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

/** DEF-4 — bounded product attributes: up to 20 {label, value} pairs, each trimmed and
 *  length-capped, blanks/dupe-labels dropped. Returns undefined when none survive so the
 *  field stays absent (byte-identical to a product with no attributes). */
function cleanAttributes(raw: unknown): { label: string; value: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const label = optStr((r as { label?: unknown })?.label, MAX.short);
    const value = optStr((r as { value?: unknown })?.value, MAX.short);
    if (!label || !value) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value });
    if (out.length >= 20) break;
  }
  return out.length ? out : undefined;
}

/** ADR 0250 — sanitize a product's parcel metadata. Returns {weightGrams?, dims?} with
 *  only the positive-finite fields that survived; an all-empty result is `{}` (the field
 *  is then omitted upstream). Bounds keep a hostile payload from poisoning a rate quote. */
function cleanParcel(weightRaw: unknown, dimsRaw: unknown): { weightGrams?: number; dims?: { l: number; w: number; h: number } } {
  const out: { weightGrams?: number; dims?: { l: number; w: number; h: number } } = {};
  const w = nonNeg(weightRaw);
  if (w !== undefined && w > 0 && w <= 1_000_000) out.weightGrams = Math.round(w); // ≤ 1 tonne
  const d = dimsRaw as { l?: unknown; w?: unknown; h?: unknown } | undefined;
  const l = nonNeg(d?.l), dw = nonNeg(d?.w), h = nonNeg(d?.h);
  if (l !== undefined && dw !== undefined && h !== undefined && l > 0 && dw > 0 && h > 0 && [l, dw, h].every((n) => n <= 100_000)) {
    out.dims = { l: Math.round(l), w: Math.round(dw), h: Math.round(h) };
  }
  return out;
}

function assertCap(count: number, label: string): void {
  if (count >= MAX.perOrg) throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrg} ${label}.`, 409, { max: MAX.perOrg });
}

// ── Order/refund-value approval gate (gap plan §5B B3 — the adsAdapter
// `evaluateSpendGate` pattern). Enforced HERE in the service (direct node calls
// bypass the capability-firewall — the adsAdapter placement lesson). A gated
// mutation parks a `commerce-spend` PendingApproval in the ONE approvals inbox
// and throws `approval_required` (409); the caller retries after the human
// decision and the deterministic `spendIdemKey` resumes it. NOTE: the error
// envelope's entropy scrub redacts the raw approvalId on the wire (DATA-6 /
// secret-leakage-error-envelope — by design, not weakened for this); callers
// key off `details.approvalStatus` and the reviews inbox. ────────────────────
interface CommerceApprovalMapRow { gateKey: string; tenantId: string; approvalId: string }
const commerceApprovals = new DurableCollection<CommerceApprovalMapRow>('commerce:spend-approval', (r) => r.gateKey);

// GEN-2d — client order-idempotency claim (money-safe): a per-checkout `idempotencyKey`
// claims a `${tenant}:${org}:${key}` slot via insert-if-absent CAS BEFORE any stock is
// reserved, so a retry/double-submit can never mint a second order OR a second
// reserve-on-create (which the release path can't un-do — it restores an order's line
// qty once, so a double-reserve would leak inventory). `orderId` is filled after the
// order persists; a still-`pending` claim (a concurrent in-flight create) 409s the
// retry, and a claim whose creator died mid-flight is treated as stale after
// `ORDER_IDEM_STALE_MS`. `tenantId` is in the ROW so tenant teardown reaps it (GEN-6);
// no `tenantOf` — this is a point-read claim, a secondary index would be pure overhead.
interface OrderIdemRow { key: string; tenantId: string; orgId: string; orderId?: string; at: string }
const orderIdem = new DurableCollection<OrderIdemRow>('commerce:order-idem', (r) => r.key);
const ORDER_IDEM_STALE_MS = 120_000; // > any createOrder; a pending claim older than this = a dead creator

// Retention (ADR 0077 P3) — order-idempotency claims are opaque, short-lived checkout
// dedup tokens (no PII → `internal`) that today accrue forever once their order persists.
// Age them out on `at` under the operator's opt-in `retention.internalDays` window. The
// claim's own retry horizon is ORDER_IDEM_STALE_MS (minutes), so ANY configured window is
// far past the point the claim can still guard a live retry — purging a settled claim only
// reclaims storage. Key is tenant-prefixed ⇒ the scan is bounded to the tenant slice.
registerRetentionPurger({
  feature: 'commerce:order-idem',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'internal') return 0;
    return purgeRowsByAge('commerce:order-idem', await orderIdem.listByPrefix(`${tenantId}:`), tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.at, id: r.key }),
      (id) => orderIdem.delete(id));
  },
});
// ADR 0380 §3 — the SIZE-hygiene ceiling COMPOSING with the opt-in policy window
// above (two lanes, one tick): the governance purge is per-tenant, admin-tunable,
// and dormant until an operator enables the sweep; this is the global default-on
// backstop (the claim's retry horizon is ORDER_IDEM_STALE_MS = minutes; 30d is
// pure forensics headroom). Deletes compose idempotently. Index-free store.
registerKvAgeOut({ id: 'commerce:order-idem', prefix: 'hostext:commerce:order-idem:', ttlDays: 30, timestampField: 'at' });

async function assertCommerceGate(input: {
  tenantId: string; orgId: string;
  kind: 'order' | 'refund';
  gateKey: string;
  totalMajor: number; currency: string;
  orderId?: string;
  proposal: string;
}): Promise<void> {
  let policy: Awaited<ReturnType<typeof getGovernancePolicy>> = null;
  try { policy = await getGovernancePolicy(input.tenantId); }
  catch (e) {
    // grade-code I3: a money control must FAIL CLOSED on a policy read error — refuse
    // the action rather than silently disabling the approval gate during a storage
    // hiccup. (A tenant that never set a threshold is still unaffected: the throw is
    // only reached when the read itself errors.)
    log.error('commerce gate policy read failed — failing closed', { tenantId: input.tenantId, kind: input.kind, error: e instanceof Error ? e.message : String(e) });
    throw new OpenwopError('internal_error', 'The spend-approval policy could not be read — the action is held. Please retry.', 503, { kind: input.kind });
  }
  const threshold = input.kind === 'order' ? policy?.commerce?.orderApprovalThresholdMinor : policy?.commerce?.refundApprovalThresholdMinor;
  if (threshold === undefined) return;
  const totalMinor = toStripeMinorUnits(input.totalMajor, input.currency);
  if (totalMinor < threshold) return;

  const mapped = await commerceApprovals.get(input.gateKey).catch(() => undefined);
  if (mapped && mapped.tenantId === input.tenantId) {
    const approval = await getApproval(mapped.approvalId);
    if (approval && approval.tenantId === input.tenantId) {
      if (approval.status === 'approved') return; // human signed off — proceed
      throw new OpenwopError(
        'approval_required',
        approval.status === 'rejected'
          ? `This ${input.kind} was rejected by an approver.`
          : `This ${input.kind} exceeds the approval threshold — a sign-off is pending in the reviews inbox.`,
        409,
        { approvalId: approval.approvalId, approvalStatus: approval.status === 'rejected' ? 'rejected' : 'pending' },
      );
    }
  }
  const approval = await createCommerceSpendApproval({
    tenantId: input.tenantId, orgId: input.orgId,
    spendKind: input.kind,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    amountMinor: totalMinor, amountCurrency: input.currency,
    spendIdemKey: input.gateKey,
    proposal: input.proposal,
  });
  await commerceApprovals.put({ gateKey: input.gateKey, tenantId: input.tenantId, approvalId: approval.approvalId }).catch((e) =>
    log.warn('commerce approval map write failed', { gateKey: input.gateKey, error: e instanceof Error ? e.message : String(e) }));
  recordCommerceAction(`${input.kind}.approval-required`, { tenantId: input.tenantId, orgId: input.orgId }, 'system', {
    approvalId: approval.approvalId, amountMinor: totalMinor, currency: input.currency,
    ...(input.orderId ? { orderId: input.orderId } : {}),
  });
  throw new OpenwopError(
    'approval_required',
    `This ${input.kind} exceeds the approval threshold — a sign-off has been requested in the reviews inbox.`,
    409,
    { approvalId: approval.approvalId, approvalStatus: 'pending' },
  );
}

/** C3 — the quote SEND gate: the negotiation-side commitment moment. Rides the
 *  ONE assertCommerceGate machinery (order threshold), keyed per (quote, version)
 *  so a revised quote re-gates. */
export async function assertQuoteSendGate(q: { tenantId: string; orgId: string; quoteId: string; version: number; total: number; currency: string }): Promise<void> {
  await assertCommerceGate({
    tenantId: q.tenantId, orgId: q.orgId, kind: 'order',
    gateKey: `commerce-quote-send:${q.quoteId}:v${q.version}`,
    totalMajor: q.total, currency: q.currency,
    proposal: `Send quote (v${q.version}) — ${q.total} ${q.currency}`,
  });
}

// ── Product ──────────────────────────────────────────────────────────────────
// ADR 0420 P3 — `challenge`: a sellable KickTodo challenge. Behaves as a
// non-physical, non-download type everywhere here (no inventory/weight/
// download tokens); its FULFILMENT is the kicktodo entitlement observer via
// product links (ADR 0420 P1), not a commerce-side behavior.
export const PRODUCT_TYPES = ['physical', 'digital', 'service', 'challenge'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'] as const;

export interface ProductVariant { variantId: string; name: string; sku?: string; price?: number; inventory?: number }
export interface Product {
  productId: string; tenantId: string; orgId: string;
  type: ProductType; name: string; description?: string;
  price: number; currency: string;
  /** MERCH-B (ADR 0274) — merchant unit cost, MAJOR units (matches `price`), for
   *  basket-margin analytics + margin-aware recommendation ranking (MERCH-A). Optional;
   *  absent ⇒ margin unknown and those features degrade gracefully. Named `cost` (major),
   *  NOT `costMinor` — an ADR-text correction to match commerce's major-unit convention. */
  cost?: number;
  imageAssetTokens: string[];        // Media tokens
  downloadAssetTokens: string[];     // digital: Media tokens (the /assets/:id/use cap = the download limit)
  inventory?: number;                // physical
  lowStockThreshold?: number;
  /** ADR 0250 — parcel metadata for carrier rate-shopping (a physical product's shipping
   *  weight in grams, optional L×W×H in cm). Absent ⇒ the product can't be rate-shopped, so
   *  checkout falls back to the flat shipping rate (additive-optional, no migration). */
  weightGrams?: number;
  dims?: { l: number; w: number; h: number };
  variants: ProductVariant[];
  /** MERCH-D (ADR 0276) — a `bundle` is a Product whose `components` are decremented
   *  (all-or-nothing) and whose price allocates to components by weight; `simple`
   *  (default/absent) is an ordinary product. No second store (ruling 1). */
  kind?: 'simple' | 'bundle';
  components?: BundleComponent[];
  /** MERCH-E (ADR 0279) — subscribe-and-save opt-in. When `enabled`, a shopper may
   *  subscribe at the given intervals for a `savePercent` discount off the resolved
   *  price. Absent ⇒ one-time purchase only (additive). */
  subscription?: { enabled: boolean; intervals: SubscriptionInterval[]; savePercent?: number };
  /** C6 — browse/merchandising facets (bounded, lowercase-normalized). Categories
   *  are the storefront's browse tree floor; tags feed collections + CMS product
   *  blocks. NOT a taxonomy engine. */
  categories: string[];
  tags: string[];
  /** DEF-4 (ADR 0240) — bounded custom attributes ({label, value} pairs, e.g. Material →
   *  Cotton). A deliberately-lean key/value bag, NOT the CRM typed-FieldDef registry
   *  (extending that here would couple CRM to a commerce concept — see the ADR). Shown on
   *  the admin form + storefront; absent ⇒ no attributes (additive, no migration). */
  attributes?: { label: string; value: string }[];
  /** ADR 0257 — TYPED custom fields, validated against org-scoped ProductFieldDefs
   *  (string/number/boolean/date/enum) via the shared host/customFields seam. The typed
   *  layer above the untyped DEF-4 `attributes` bag (both stay). Absent ⇒ no typed fields
   *  (additive, no migration). */
  customFields?: Record<string, string | number | boolean>;
  active: boolean;
  createdBy: string; createdAt: string; updatedAt: string;
}
// ── commerce.product kernel adapter (ADR 0410 Phase 1) ──────────────────────
// The product CATALOG lives in the content kernel (the cms.page/CRM façade
// pattern). ONLY the catalog — orders/carts/coupons/refunds/stock-movement/
// payouts/quotes/price-lists/UCP are money-truth transactional and STAY. Full
// Product → ext.product (SoT); queryable scalars → values; org-scoped via the
// opaque top-level orgId. commerce.product is publicRead-ELIGIBLE (products are
// legitimately public) but v1 sets NEITHER flag → façade-only (the storefront
// read stays the commerce /public-store route); flipping publicRead is the
// Phase-3 productGrid→entityList convergence. Inventory is a façade-maintained
// PROJECTION: the ONLY mutators are updateProduct (admin) + casAdjustProduct-
// Inventory (ledger), both here — generic kernel writes are blocked, so the
// stock ledger stays authoritative by construction (money-truth).
import {
  mintSystemType, type EntityRecord,
} from '../entities/entitiesService.js';
import { makeKernelAdapter } from '../entities/kernelAdapter.js';

const COMMERCE_PRODUCT_TYPE = 'commerce.product';
const PRODUCT_SCALARS = [
  { key: 'org_id', label: 'Org', type: 'string', required: true },
  { key: 'type', label: 'Type', type: 'string', required: true },
  { key: 'name', label: 'Name', type: 'string', required: true },
  { key: 'price', label: 'Price', type: 'number', required: true },
  { key: 'currency', label: 'Currency', type: 'string', required: true },
  { key: 'cost', label: 'Cost', type: 'number', required: false },
  { key: 'inventory', label: 'Inventory', type: 'number', required: false },
  { key: 'active', label: 'Active', type: 'boolean', required: false },
];
async function ensureProductType(tenantId: string): Promise<void> {
  await mintSystemType({ tenantId, name: COMMERCE_PRODUCT_TYPE, displayName: 'Product', fields: PRODUCT_SCALARS, actor: 'system:commerce' });
}
function productToKernel(p: Product): { values: Record<string, unknown>; ext: Record<string, unknown> } {
  return {
    values: {
      org_id: p.orgId, type: p.type, name: p.name, price: p.price, currency: p.currency, active: p.active,
      ...(p.cost !== undefined ? { cost: p.cost } : {}),
      ...(p.inventory !== undefined ? { inventory: p.inventory } : {}),
    },
    ext: { product: p },
  };
}
const kernelToProduct = (rec: EntityRecord): Product => (rec.ext?.product as Product);
const legacyProducts = new DurableCollection<Product>('commerce:product', (p) => p.productId, undefined, (p) => p.tenantId);

/** The kernel-backed product store (KERNEL-5 shared factory). `cas` is
 *  byte-identical over ext.product — the inventory-decrement money path. */
const products = makeKernelAdapter<Product>({
  typeName: COMMERCE_PRODUCT_TYPE,
  ensureType: ensureProductType,
  toKernel: productToKernel,
  fromKernel: kernelToProduct,
  idOf: (p) => p.productId,
  tenantOf: (p) => p.tenantId,
  orgOf: (p) => p.orgId,
  actorOf: (p) => p.createdBy,
  updatedAtOf: (p) => p.updatedAt,
  legacy: legacyProducts,
});

/** ADR 0410 Phase 1 — id-preserving legacy→kernel product migration (idempotent). */
export async function migrateProductsToKernel(): Promise<{ migrated: number; skipped: number }> {
  return products.migrate();
}

function cleanVariants(raw: unknown): ProductVariant[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX.variants).map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const name = optStr(o.name, MAX.short);
    if (!name) return null;
    const out: ProductVariant = { variantId: `var:${randomUUID()}`, name };
    if (optStr(o.sku, MAX.short)) out.sku = optStr(o.sku, MAX.short);
    if (nonNeg(o.price) !== undefined) out.price = nonNeg(o.price);
    if (nonNeg(o.inventory) !== undefined) out.inventory = nonNeg(o.inventory);
    return out;
  }).filter((v): v is ProductVariant => v !== null);
}
const cleanTokens = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, MAX.images) : []);
/** MERCH-E (ADR 0279) — subscribe-and-save opt-in on a product. */
function cleanSubscription(raw: unknown): Product['subscription'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.enabled !== true) return undefined;
  const intervals = Array.isArray(o.intervals) ? o.intervals.filter((i): i is SubscriptionInterval => (SUBSCRIPTION_INTERVALS as readonly string[]).includes(String(i))) : [];
  if (intervals.length === 0) return undefined;
  const savePercent = nonNeg(o.savePercent);
  return { enabled: true, intervals, ...(savePercent !== undefined && savePercent <= 100 ? { savePercent } : {}) };
}
/** MERCH-D (ADR 0276) — a bundle's component list. No nested bundles in Phase 1 (a
 *  component that is itself a bundle is validated away at order time, not here). */
function cleanComponents(raw: unknown): BundleComponent[] {
  if (!Array.isArray(raw)) return [];
  const out: BundleComponent[] = [];
  for (const c of raw.slice(0, MAX.items)) {
    const o = (c ?? {}) as Record<string, unknown>;
    const productId = optStr(o.productId, MAX.short);
    const quantity = nonNeg(o.quantity);
    if (!productId || !quantity || quantity <= 0) continue;
    out.push({ productId, quantity: Math.trunc(quantity), ...(optStr(o.variantId, MAX.short) ? { variantId: optStr(o.variantId, MAX.short) } : {}) });
  }
  return out;
}
/** R2 CM-P2-I4 — REFUSE an unsupported currency instead of relabelling the money.
 *  `createProduct({ currency: 'CHF' })` used to yield a **USD** product at the CHF
 *  number, silently. Absent/empty stays the historical 'USD' default. */
const currencyOf = (raw: unknown): string => {
  const c = cleanStr(raw, MAX.currency, 'USD').toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(c)) {
    throw new OpenwopError('validation_error', `Unsupported currency '${c}'. Supported: ${CURRENCIES.join(', ')}.`, 400, { field: 'currency', supported: CURRENCIES });
  }
  return c;
};

/** R2 CM-P2-I3 — quantize a MAJOR-unit amount to the currency's smallest real unit.
 *  `Math.round(x * 100) / 100` was hardcoded at a dozen sites; JPY is a SUPPORTED
 *  currency, so a 10% coupon on a ¥12345 order stored ¥1234.5 — an amount that cannot
 *  exist. Routes through the same zero-decimal table the Stripe charge uses, so the
 *  stored figure and the billed figure can never disagree. Identical output for every
 *  two-decimal currency (the pre-R2 behaviour, byte for byte). */
export const quantizeMoney = (amount: number, currency: string): number => fromStripeMinorUnits(toStripeMinorUnits(amount, currency), currency);

/** DEF-3 (ADR 0239) — relevance-ranked product search. Multi-token AND (every query
 *  token must appear somewhere searchable) with a light field-weighted score (a name hit
 *  outranks a description/tag hit), so "red shirt" finds a product named "shirt" tagged
 *  "red" — not just a literal "red shirt" substring. In-memory over the tenant-indexed
 *  slice (products are `assertCap`-bounded per org); see the ADR for why this does NOT
 *  ride a `host.db.search` index (that surface is an equivalent O(n) scan on the durable
 *  backend, and a synced product index would be a parallel read model). */
export async function listProducts(tenantId: string, orgId: string, q?: string, opts: { category?: string; tag?: string } = {}): Promise<Product[]> {
  const tokens = (q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const category = opts.category?.trim().toLowerCase();
  const tag = opts.tag?.trim().toLowerCase();
  const phrase = tokens.join(' ');
  const scoreOf = (p: Product): number => {
    if (tokens.length === 0) return 1; // no query ⇒ every product qualifies equally
    const name = p.name.toLowerCase();
    const desc = (p.description ?? '').toLowerCase();
    const tags = (p.tags ?? []).map((t) => t.toLowerCase());
    let score = 0;
    for (const tok of tokens) {
      let hit = 0;
      if (name.includes(tok)) hit = Math.max(hit, 3); // a token in the name outranks tag/desc
      if (tags.some((t) => t.includes(tok))) hit = Math.max(hit, 2);
      if (desc.includes(tok)) hit = Math.max(hit, 1);
      if (hit === 0) return 0; // AND semantics — a token that matches nothing drops the product
      score += hit;
    }
    // Phrase/name bonuses so a product matching MORE tokens in its name ranks above one
    // that only matches via a tag: full-phrase-in-name > name-starts-with > exact name.
    if (name === phrase) score += 6;
    else if (name.startsWith(phrase)) score += 4;
    else if (name.includes(phrase)) score += 3;
    return score;
  };
  return (await products.listForTenant(tenantId))
    .filter((p) => p.orgId === orgId && (!category || (p.categories ?? []).includes(category)) && (!tag || (p.tags ?? []).includes(tag)))
    .map((p) => ({ p, score: scoreOf(p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}
export async function getProduct(tenantId: string, orgId: string, productId: string): Promise<Product | null> {
  const p = await products.get(tenantId, productId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

/** ADR 0455 — a TENANT-scoped product read (no org arg). A challenge↔product link
 *  is tenant-scoped and does not carry the org, so surfacing a linked challenge's
 *  price needs to resolve the product (which carries its OWN `orgId`) by tenant+id.
 *  Tenant-isolated — returns null cross-tenant; the caller is already tenant-scoped.
 *
 *  ⚠ Deliberately drops the org check `getProduct` has, so it returns the FULL
 *  `Product` (incl. `cost`/`inventory`/`downloadAssetTokens`/`customFields`) for
 *  ANY org in the tenant. Callers MUST project only storefront-public fields
 *  (`productForChallenge` returns just id/org/price/currency/active). Do NOT return
 *  this object to a client as-is — that would leak another org's product internals
 *  within the tenant. Prefer `getProduct` (org-guarded) whenever the org is known. */
export async function getProductInTenant(tenantId: string, productId: string): Promise<Product | null> {
  const p = await products.get(tenantId, productId);
  return p && p.tenantId === tenantId ? p : null;
}
export async function createProduct(input: { tenantId: string; orgId: string; createdBy: string; type: unknown; name: unknown; description?: unknown; price?: unknown; cost?: unknown; kind?: unknown; components?: unknown; subscription?: unknown; currency?: unknown; imageAssetTokens?: unknown; downloadAssetTokens?: unknown; inventory?: unknown; lowStockThreshold?: unknown; variants?: unknown; categories?: unknown; tags?: unknown; attributes?: unknown; weightGrams?: unknown; dims?: unknown; customFields?: unknown }): Promise<Product> {
  assertCap((await listProducts(input.tenantId, input.orgId)).length, 'products');
  const ts = nowIso();
  const type: ProductType = (PRODUCT_TYPES as readonly string[]).includes(String(input.type)) ? (input.type as ProductType) : 'physical';
  const cleanedAttrs = cleanAttributes(input.attributes);
  const parcel = cleanParcel(input.weightGrams, input.dims);
  // ADR 0257 — validate typed custom fields against the org's ProductFieldDefs (throws on
  // an unknown key / type mismatch / missing required field).
  const customFields = await validateProductCustomFields(input.tenantId, input.orgId, input.customFields, true);
  const p: Product = {
    productId: `prod:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId,
    type, name: cleanStr(input.name, MAX.name, 'Untitled product'),
    ...(optStr(input.description, MAX.desc) ? { description: optStr(input.description, MAX.desc) } : {}),
    price: nonNeg(input.price) ?? 0, currency: currencyOf(input.currency),
    ...(nonNeg(input.cost) !== undefined ? { cost: nonNeg(input.cost) } : {}),
    imageAssetTokens: cleanTokens(input.imageAssetTokens),
    downloadAssetTokens: type === 'digital' ? cleanTokens(input.downloadAssetTokens) : [],
    ...(type === 'physical' && nonNeg(input.inventory) !== undefined ? { inventory: nonNeg(input.inventory) } : {}),
    ...(nonNeg(input.lowStockThreshold) !== undefined ? { lowStockThreshold: nonNeg(input.lowStockThreshold) } : {}),
    variants: cleanVariants(input.variants),
    ...(input.kind === 'bundle' ? { kind: 'bundle' as const, components: cleanComponents(input.components) } : {}),
    ...(cleanSubscription(input.subscription) ? { subscription: cleanSubscription(input.subscription)! } : {}),
    categories: cleanFacets(input.categories), tags: cleanFacets(input.tags),
    ...(cleanedAttrs ? { attributes: cleanedAttrs } : {}),
    ...(parcel.weightGrams !== undefined ? { weightGrams: parcel.weightGrams } : {}),
    ...(parcel.dims ? { dims: parcel.dims } : {}),
    ...(customFields ? { customFields } : {}),
    active: true,
    createdBy: input.createdBy, createdAt: ts, updatedAt: ts,
  };
  await products.put(p);
  recordCommerceAction('product.created', p, input.createdBy, { productId: p.productId, name: p.name, type: p.type });
  return p;
}
export interface ProductPatch { name?: string; description?: string | null; price?: number; cost?: number | null; kind?: unknown; components?: unknown; subscription?: unknown; currency?: string; imageAssetTokens?: unknown; downloadAssetTokens?: unknown; inventory?: number | null; lowStockThreshold?: number | null; variants?: unknown; categories?: unknown; tags?: unknown; attributes?: unknown; weightGrams?: number | null; dims?: unknown; customFields?: unknown; active?: boolean }
export async function updateProduct(tenantId: string, orgId: string, productId: string, patch: ProductPatch, opts: { actor?: string } = {}): Promise<Product | null> {
  const p = await getProduct(tenantId, orgId, productId);
  if (!p) return null;
  const next: Product = { ...p, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanStr(patch.name, MAX.name, p.name);
  if (patch.description !== undefined) { if (patch.description === null) delete next.description; else next.description = optStr(patch.description, MAX.desc); }
  if (nonNeg(patch.price) !== undefined) next.price = nonNeg(patch.price)!;
  if (patch.cost !== undefined) { if (patch.cost === null) delete next.cost; else if (nonNeg(patch.cost) !== undefined) next.cost = nonNeg(patch.cost); }
  if (patch.kind !== undefined) { if (patch.kind === 'bundle') { next.kind = 'bundle'; next.components = cleanComponents(patch.components ?? p.components); } else { delete next.kind; delete next.components; } }
  else if (patch.components !== undefined && next.kind === 'bundle') next.components = cleanComponents(patch.components);
  if (patch.subscription !== undefined) { const s = cleanSubscription(patch.subscription); if (s) next.subscription = s; else delete next.subscription; }
  if (patch.currency !== undefined) next.currency = currencyOf(patch.currency);
  if (patch.imageAssetTokens !== undefined) next.imageAssetTokens = cleanTokens(patch.imageAssetTokens);
  if (patch.downloadAssetTokens !== undefined && next.type === 'digital') next.downloadAssetTokens = cleanTokens(patch.downloadAssetTokens);
  // R2 CM-P2-M7 — an inventory EDIT is a stock movement. This blind put wrote the new
  // count with no ledger row and no CAS, so `/products/:id/movements` — the route whose
  // docblock calls it "the auditable inventory ledger" — showed only reserves and
  // releases: correcting 12→40 after a delivery made 28 units appear from nowhere, and
  // the non-CAS write could clobber a concurrent reservation decrement (oversell).
  // `manual-adjust` was a declared `StockMovementReason` that nothing in the tree emitted.
  let manualInventoryTarget: number | undefined;
  if (patch.inventory !== undefined) {
    if (patch.inventory === null) delete next.inventory;
    else if (nonNeg(patch.inventory) !== undefined) {
      if (p.type === 'physical' && p.inventory !== undefined) manualInventoryTarget = nonNeg(patch.inventory)!; // ledgered below
      else next.inventory = nonNeg(patch.inventory);
    }
  }
  if (patch.lowStockThreshold !== undefined) { if (patch.lowStockThreshold === null) delete next.lowStockThreshold; else if (nonNeg(patch.lowStockThreshold) !== undefined) next.lowStockThreshold = nonNeg(patch.lowStockThreshold); }
  if (patch.variants !== undefined) next.variants = cleanVariants(patch.variants);
  if (patch.categories !== undefined) next.categories = cleanFacets(patch.categories);
  if (patch.tags !== undefined) next.tags = cleanFacets(patch.tags);
  if (patch.attributes !== undefined) { const a = cleanAttributes(patch.attributes); if (a) next.attributes = a; else delete next.attributes; }
  if (patch.weightGrams !== undefined || patch.dims !== undefined) {
    const parcel = cleanParcel(patch.weightGrams === null ? undefined : patch.weightGrams ?? next.weightGrams, patch.dims ?? next.dims);
    if (parcel.weightGrams !== undefined) next.weightGrams = parcel.weightGrams; else delete next.weightGrams;
    if (parcel.dims) next.dims = parcel.dims; else delete next.dims;
  }
  if (patch.customFields !== undefined) {
    // ADR 0257 — a patch REPLACES the typed custom fields (validated, requireAll=false so a
    // partial update needn't resend every required field). Empty/none ⇒ clear them.
    const cf = await validateProductCustomFields(tenantId, orgId, patch.customFields, false);
    if (cf) next.customFields = cf; else delete next.customFields;
  }
  if (typeof patch.active === 'boolean') next.active = patch.active;
  // R2 CM-P2-M7 (review B-1) — the metadata write must NEVER carry a stock count. `next`
  // is spread from the row we read, so a plain `put` blind-writes that stale `inventory`
  // over anything a concurrent reserve landed in the read→write window — which oversells
  // the reserved units and leaves the movement ledger unable to reconstruct the count.
  // (My first cut did exactly that and its own comment claimed the opposite; the
  // single-threaded test could not see it.) So: CAS the metadata onto the FRESHEST row,
  // carrying that row's inventory, and let the ledgered CAS below own the count entirely.
  const clearsInventory = patch.inventory === null;
  let saved: Product | null = null;
  for (let attempt = 0; attempt < 8 && !saved; attempt++) {
    const cur = await getProduct(tenantId, orgId, productId);
    if (!cur) return null; // deleted under us
    const merged: Product = { ...next, updatedAt: nowIso() };
    if (clearsInventory) delete merged.inventory;
    else if (cur.inventory !== undefined) merged.inventory = cur.inventory;
    else delete merged.inventory;
    if (await products.cas(cur, merged)) saved = merged;
  }
  if (!saved) throw new OpenwopError('internal_error', 'Product update contention — please retry.', 503, { productId });
  // The inventory leg rides the SAME CAS + ledger every other stock change uses, so the
  // count and its movement row cannot disagree. The delta is relative to the count the
  // operator was LOOKING at: correcting "12 → 40" after a delivery means 40 physical
  // units, of which any concurrently reserved ones are still spoken for.
  if (manualInventoryTarget !== undefined) {
    const delta = manualInventoryTarget - (p.inventory ?? 0);
    if (delta !== 0) {
      const outcome = await casAdjustProductInventory(tenantId, orgId, productId, delta, 'manual-adjust', opts.actor ?? 'system');
      if (outcome === 'insufficient') throw new OpenwopError('validation_error', `Setting inventory to ${manualInventoryTarget} would take more stock than exists (a concurrent order reserved some) — reload and try again.`, 409, { productId });
    }
  }
  recordCommerceAction('product.updated', saved, opts.actor ?? 'system', { productId: saved.productId, fields: Object.keys(patch) });
  return manualInventoryTarget !== undefined ? await getProduct(tenantId, orgId, productId) : saved;
}
export async function deleteProduct(tenantId: string, orgId: string, productId: string, opts: { actor?: string } = {}): Promise<boolean> {
  const p = await getProduct(tenantId, orgId, productId);
  if (!p) return false;
  await products.delete(tenantId, productId);
  // Fan out soft-reference cleanup via the dependency-safe seam so a deleted product
  // can't orphan live references (subscriptions cancel their active subs; future
  // registrants invalidate derived indexes). `cleanupHandlers` on the audit row makes
  // the fan-out observable.
  const cleanupHandlers = await fireProductDeleted({ tenantId, orgId, productId });
  recordCommerceAction('product.deleted', p, opts.actor ?? 'system', { productId: p.productId, name: p.name, cleanupHandlers });
  return true;
}

// ── Order ────────────────────────────────────────────────────────────────────
// `refunding` is a transient CAS-claim state (grade-code B3) between the paid/fulfilled
// terminal and `refunded` — it exists so a Stripe refund can't be double-issued.
export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'refunding', 'partially_refunded', 'refunded', 'canceled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const FULFILLMENT_STATUSES = ['pending', 'processing', 'shipped', 'delivered'] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

/** MERCH-D (ADR 0276) — one line of a bundle's recipe. */
export interface BundleComponent { productId: string; variantId?: string; quantity: number }
/** MERCH-E (ADR 0279) — subscribe-and-save cadence. */
export const SUBSCRIPTION_INTERVALS = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];
export interface OrderItem { productId: string; name: string; unitPrice: number; quantity: number; /** ADR 0296 P1 — how the line entered the order: absent = the shopper's cart; 'bump' = a checkout order-bump accept; 'upsell' = a post-purchase one-click accept (P3). Provenance for funnel analytics + attach-rate reporting; no pricing effect. */ origin?: 'bump' | 'upsell'; /** Explainable pricing (C4): the winning source when not the list price — 'price-list:<id>' | 'variant'. */ priceSource?: string; /** MERCH-D — for a bundle line, the components decremented + their weight-allocated price (refund attribution + replay). */ bundleComponents?: { productId: string; quantity: number; allocatedPrice: number }[] }
export interface Order {
  orderId: string; tenantId: string; orgId: string;
  contactId?: string;                // customer = CRM Contact (ADR 0008), never a net-new Customer
  items: OrderItem[];
  subtotal: number; discount: number; total: number; currency: string;
  couponCode?: string;               // applied coupon (Phase 3)
  /** MERCH-B (ADR 0274) — the rule-based promotions that fired on this order, snapshot
   *  at create for replay/:fork determinism + refund/basket-margin attribution. The
   *  promoted total is already frozen in `discount`/`total`; this is the explainable
   *  provenance (never recomputed). Absent ⇒ no promotions fired (additive, no migration). */
  appliedPromotions?: AppliedPromotion[];
  affiliateCode?: string;            // attribution for commission accrual (deferred P5)
  /** ADR 0294 P3 (the revenue-join contract, wired by ADR 0296) — which funnel
   *  step produced this order. Additive provenance, snapshot at create; a later
   *  funnel/step deletion tolerates on read (never re-resolved). */
  funnelRef?: { funnelId: string; stepId: string };
  /** ADR 0296 P3 — a one-click upsell child links its parent purchase (the
   *  transaction-graph edge). Children refund independently; a parent refund
   *  never cascades. */
  parentOrderId?: string;
  /** ADR 0296 P2 — the shopper EXPLICITLY consented (unticked-by-default
   *  checkbox) to save their payment method for one-click offers; the webhook
   *  captures the pm/customer ids on payment success. Internal marker. */
  pmSaveRequested?: true;
  status: OrderStatus; fulfillmentStatus: FulfillmentStatus;
  paymentIntentId?: string;          // externally-supplied (demo-mode); no capture fn
  refundId?: string;                 // D4 — the Stripe refund id, on the order (grade-code B3)
  /** R2 CM-P2-B3 — WHICH lane refunded. `'none'` = the state was flipped but NO money
   *  was returned (a demo/manual order, or a caller that resolved no Stripe key). This
   *  lived only in the audit row, so an agent-lane state-only refund and a real one were
   *  indistinguishable on every screen. Absent on pre-R2 rows ⇒ unknown, not 'stripe'. */
  refundProvider?: 'stripe' | 'none';
  /** DEF-7 (ADR 0238) — cumulative amount refunded so far, in MAJOR units. Absent ⇒ 0.
   *  A partial refund increments it; `status` flips to 'refunded' only when it reaches
   *  the full charge. A one-shot full `refundOrder` sets it to the charge total. */
  refundedAmount?: number;
  /** DEF-1 (ADR 0238) — tax + shipping, MAJOR units (same convention as subtotal/total).
   *  Absent ⇒ zero tax / flat-zero shipping, exactly the pre-0237 posture (byte-identical
   *  when no provider is configured). Populated best-effort at checkout from the tax/
   *  shipping connection-pack seam (`taxShipping.ts`); the Stripe charge and the paid-
   *  amount verification bill `orderChargeTotal` = total + taxTotal + shippingCost. */
  taxLines?: { name: string; amount: number }[];
  taxTotal?: number;
  shippingCost?: number;
  /** DEF-1 — optional shipping address (flat/manual by default; provider rate/tax packs
   *  are the RFC 0095 seam). Bounded free-text lines. */
  shippingAddress?: { name?: string; line1: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string };
  /** C5 — a PENDING order IS a stock reservation: its lines were CAS-decremented at
   *  create and are restored on cancel or when this deadline passes (the expiry
   *  sweep auto-cancels). Absent on pre-C5 orders (legacy decrement-at-paid). */
  reservationExpiresAt?: string;
  createdBy: string; createdAt: string; updatedAt: string;
}

// ── Coupon (net-new, Phase 3) ────────────────────────────────────────────────
export const COUPON_TYPES = ['percentage', 'fixed', 'free_shipping'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];
export interface Coupon {
  couponId: string; tenantId: string; orgId: string; code: string; type: CouponType; value: number; active: boolean; createdAt: string;
  /** R2 CM-P2-M2 — the currency a `fixed` coupon's `value` is denominated in, captured
   *  at intake. There was NO currency field: a "10 off" coupon rendered as "$10.00" on a
   *  EUR store and deducted €10. Absent on pre-R2 rows — unknowable after the fact, which
   *  is why capture had to ship before anything that reads it. */
  currency?: string;
}
const coupons = new DurableCollection<Coupon>('commerce:coupon', (c) => c.couponId, undefined, (c) => c.tenantId);

export async function listCoupons(tenantId: string, orgId: string): Promise<Coupon[]> {
  return (await coupons.listForTenantIndexed(tenantId)).filter((c) => c.orgId === orgId);
}
const requiredCouponCurrency = (raw: unknown): string => {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new OpenwopError('validation_error', 'A fixed-amount coupon must state the `currency` its value is in.', 400, { field: 'currency', supported: CURRENCIES });
  }
  return currencyOf(raw);
};

export async function createCoupon(input: { tenantId: string; orgId: string; code: unknown; type: unknown; value: unknown; currency?: unknown; actor?: string }): Promise<Coupon> {
  const type: CouponType = (COUPON_TYPES as readonly string[]).includes(String(input.type)) ? (input.type as CouponType) : 'percentage';
  const c: Coupon = {
    couponId: `cpn:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId,
    code: cleanStr(input.code, MAX.short).toUpperCase(), type, value: nonNeg(input.value) ?? 0, active: true, createdAt: nowIso(),
    // Only a `fixed` coupon is an amount; a percentage is currency-free by nature.
    // REQUIRED, not defaulted (review B-3): `currencyOf(undefined)` returns 'USD', so an
    // API/agent-created fixed coupon on a EUR store was born stamped USD and inert — and
    // no one can reconstruct afterwards what a stored "25 off" meant. The node pack
    // already tells the model this is required; now the code agrees.
    ...(type === 'fixed' ? { currency: requiredCouponCurrency(input.currency) } : {}),
  };
  if (!c.code) throw new OpenwopError('validation_error', 'A coupon `code` is required.', 400, {});
  // GEN-2e — code uniqueness (among ACTIVE coupons, matching how `couponByCode`
  // resolves): mirror `createAffiliate`'s 409 guard so a duplicate `code` can't be
  // minted and silently shadow the resolver. Active-only intentionally allows
  // re-creating a code after it's been deactivated.
  if (await couponByCode(input.tenantId, input.orgId, c.code)) {
    throw new OpenwopError('validation_error', 'That coupon code already exists.', 409, { code: c.code });
  }
  await coupons.put(c);
  recordCommerceAction('coupon.created', c, input.actor ?? 'system', { couponId: c.couponId, code: c.code, type: c.type, value: c.value });
  return c;
}
/** Internal/seeder use (no route exposes coupon deletion) — tenant+org guarded. */
export async function deleteCoupon(tenantId: string, orgId: string, couponId: string): Promise<boolean> {
  const c = await coupons.get(couponId);
  if (!c || c.tenantId !== tenantId || c.orgId !== orgId) return false;
  await coupons.delete(couponId);
  return true;
}
async function couponByCode(tenantId: string, orgId: string, code: string): Promise<Coupon | null> {
  const up = code.trim().toUpperCase();
  return (await listCoupons(tenantId, orgId)).find((c) => c.active && c.code === up) ?? null;
}
/** Compute the discount a coupon applies to a subtotal (free_shipping discounts the
 *  SHIPPING line, not the subtotal — see `createOrderInner`). */
function couponDiscount(coupon: Coupon, subtotal: number, currency: string): number {
  if (coupon.type === 'percentage') return Math.min(subtotal, quantizeMoney(subtotal * (coupon.value / 100), currency));
  if (coupon.type === 'fixed') {
    // R2 CM-P2-M2 — a fixed coupon is an AMOUNT, so it only means anything in a stated
    // currency, and must never be deducted from another one. It is REFUSED rather than
    // silently zeroed (review B-3): returning 0 accepted the code, stamped it on the
    // order and changed no price — trading "applies the wrong money" for "applies nothing,
    // silently", which is the same family. Pre-R2 rows carry no currency and stay
    // first-come (the historical behaviour); nothing can reconstruct what they meant.
    if (coupon.currency && coupon.currency !== currency) {
      throw new OpenwopError('validation_error', `Coupon ${coupon.code} applies to ${coupon.currency} orders only (this order is in ${currency}).`, 400, { field: 'couponCode', couponCurrency: coupon.currency, orderCurrency: currency });
    }
    return Math.min(subtotal, coupon.value);
  }
  return 0;
}
const orders = new DurableCollection<Order>('commerce:order', (o) => o.orderId, undefined, (o) => o.tenantId);

// DEF-7 (ADR 0238) — append-only refund ledger. One row per partial refund, keyed by
// the deterministic `commerce:refund:<tenant>:<org>:<order>:<refundKey>` id so a retry
// with the same refundKey is a no-op (the multi-refund idempotency anchor the terminal
// order CAS can't provide). Full refunds stay on the order (`refundId`/`refundedAmount`).
/**
 * ADR 0615 — the row carries an EXPLICIT state.
 *
 * It used to be implicit, and `provider:'none'` did double duty: "a manual/demo
 * order, no money to move" AND "claimed, but we have not finished yet". Those two
 * are indistinguishable on a stored row, which is why a process that died between
 * the provider call and the order fold was undetectable — and why the same-key
 * retry that should have repaired it was swallowed as "already applied" instead.
 *
 *  - `pending`  — claimed, effect not yet folded. Carries `leaseUntil`; once that
 *                 passes with the row still `pending`, the owner is gone and the
 *                 claim is reclaimable by the next same-key call.
 *  - `applied`  — the fold landed. Terminal, and the only state that may answer a
 *                 retry idempotently.
 *  - `manual_intervention_required` — the provider took the money and this host
 *                 could not record it. Terminal for the code: a human decides.
 *                 Named for the operational fact, and deliberately a state no
 *                 projection can map back to a cheerful "refunded".
 *
 * `state` is OPTIONAL for read-compatibility with rows written before this ADR.
 * A stateless legacy row is read as `applied` (see `refundClaimState`) — the
 * conservative choice: it preserves today's idempotent answer and never re-drives
 * a historical refund on the strength of an ambiguity we cannot resolve.
 */
export type RefundClaimState = 'pending' | 'applied' | 'manual_intervention_required';
export interface RefundLedgerEntry {
  refundLedgerId: string; tenantId: string; orgId: string; orderId: string;
  refundKey: string; amount: number; currency: string;
  provider: 'stripe' | 'none'; refundId?: string;
  state?: RefundClaimState; leaseUntil?: string;
  createdBy: string; createdAt: string;
}
/** How long a claim owner has to finish before the claim is reclaimable. Comfortably
 *  longer than a refund request can run (the Stripe call plus 8 CAS attempts), so a
 *  SLOW owner is never mistaken for a dead one. */
const REFUND_CLAIM_LEASE_MS = 120_000;
/** Legacy rows predate `state` and are read as `applied` — never as a reclaimable
 *  `pending`, which would re-drive a refund that most likely completed. */
function refundClaimState(r: RefundLedgerEntry): RefundClaimState { return r.state ?? 'applied'; }
function refundLeaseExpired(r: RefundLedgerEntry, now = Date.now()): boolean {
  return !r.leaseUntil || Date.parse(r.leaseUntil) <= now;
}
const refundLedger = new DurableCollection<RefundLedgerEntry>('commerce:refund', (r) => r.refundLedgerId, undefined, (r) => r.tenantId);

// DEF-5 (ADR 0239) — outstanding-reservation due-index. Holds ONE small row per LIVE
// pending reservation (not per historical order), so the expiry sweep scans only orders
// that can actually expire instead of `orders.list()` (the full, unbounded, cross-tenant
// order history). Written at createOrder; deleted when the order leaves 'pending' (pay /
// cancel / expire) and pruned if the sweep finds a row whose order already moved on.
interface ReservationDue { orderId: string; tenantId: string; orgId: string; dueAt: string }
const reservationDue = new DurableCollection<ReservationDue>('commerce:reservation-due', (r) => r.orderId, undefined, (r) => r.tenantId);
async function clearReservationDue(orderId: string): Promise<void> {
  await reservationDue.delete(orderId).catch(() => undefined); // best-effort — a missing row is fine
}

/** Every refund recorded against an order (partial-refund ledger), newest first. */
export async function listOrderRefunds(tenantId: string, orgId: string, orderId: string): Promise<RefundLedgerEntry[]> {
  return (await refundLedger.listForTenantIndexed(tenantId))
    .filter((r) => r.orgId === orgId && r.orderId === orderId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listOrders(tenantId: string, orgId: string, status?: OrderStatus): Promise<Order[]> {
  return (await orders.listForTenantIndexed(tenantId)).filter((o) => o.orgId === orgId && (!status || o.status === status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/**
 * KTFULL-B13 — every order in a tenant, across orgs, for a given status.
 * Fulfilment observers run BEST-EFFORT (`notifyObservers` swallows a throw so
 * the money truth never depends on an adapter), which means a transient
 * adapter failure would otherwise strand a paid order without its entitlement
 * forever. A reconciliation sweep needs to see the whole tenant, so this is
 * the org-agnostic read. It reuses the SAME bounded tenant index as
 * `listOrders` — no second store, no cross-tenant scan.
 */
export async function listTenantOrdersByStatus(tenantId: string, status: OrderStatus): Promise<Order[]> {
  return (await orders.listForTenantIndexed(tenantId)).filter((o) => o.status === status);
}

export async function getOrder(tenantId: string, orgId: string, orderId: string): Promise<Order | null> {
  const o = await orders.get(orderId);
  return o && o.tenantId === tenantId && o.orgId === orgId ? o : null;
}

/** Atomically transition an order's status (grade-code B4/B3) — a cross-instance
 *  guard against pay-vs-cancel / double-refund races. Applies `mutate` to the
 *  expected row and CAS-writes it; returns the new row, or null if a concurrent
 *  writer moved it (the caller re-reads / fails). `expect` is the exact row the
 *  caller already read (byte-match required). */
async function casOrder(expect: Order, mutate: (o: Order) => Order): Promise<Order | null> {
  const next = mutate(expect);
  return (await orders.compareAndSwap(expect, next)) ? next : null;
}

/** DEF-1 (ADR 0238) — the ONE amount a customer is actually charged: goods-after-
 *  discount (`total`) plus tax plus shipping, MAJOR units. Byte-identical to `total`
 *  when no tax/shipping is set (the pre-0237 posture). This is the single source of
 *  truth routed through BOTH the Stripe checkout-session builder AND `markAsPaid`'s
 *  amount verification, so the order, the charge, and the paid check never diverge. */
export function orderChargeTotal(o: Pick<Order, 'total' | 'taxTotal' | 'shippingCost' | 'currency'>): number {
  return quantizeMoney(o.total + (o.taxTotal ?? 0) + (o.shippingCost ?? 0), o.currency);
}
/** The same charge in Stripe minor units (currency-aware). */
export function orderChargeMinor(o: Pick<Order, 'total' | 'taxTotal' | 'shippingCost' | 'currency'>): number {
  return toStripeMinorUnits(orderChargeTotal(o), o.currency);
}

/** Internal/seeder use (no route exposes order deletion — the lifecycle is the product
 *  surface). Tenant+org guarded. Callers that delete PAID demo orders must also remove
 *  the demo products (inventory is NOT restored here — deletion is not a refund). */
export async function deleteOrder(tenantId: string, orgId: string, orderId: string): Promise<boolean> {
  const o = await getOrder(tenantId, orgId, orderId);
  if (!o) return false;
  await orders.delete(orderId);
  // WF-SHARE-4 — cascade the public share links that referenced this order.
  // Dynamic import: sharing imports THIS module for its resolver, so a static
  // edge back would cycle (the crm/signService precedent). Best-effort — a
  // cascade failure must not fail the delete, and the link would 404 anyway;
  // what it must not do is leave a row that reports "in use externally".
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    await purgeLinksForResource(tenantId, 'commerce_order', orderId);
  } catch { /* best-effort cascade — the link resolves 404 regardless */ }
  return true;
}

/** Create an order from a set of {productId, quantity} lines. Prices/names are
 *  SNAPSHOT from the product at create time (an order is immutable to later edits).
 *  `requireApprovalOverThreshold` marks the AGENT paths (workflow surface / UCP):
 *  when the tenant sets `commerce.orderApprovalThresholdMinor`, an at/over-threshold
 *  agent order parks a `commerce-spend` approval instead of creating (B3). Operator
 *  data-entry through the REST routes never sets it. */
async function createOrderInner(input: { tenantId: string; orgId: string; createdBy: string; contactId?: string; couponCode?: string; affiliateCode?: string; funnelRef?: { funnelId?: unknown; stepId?: unknown }; parentOrderId?: string; pmSaveRequested?: boolean; lines: { productId: string; quantity: number; /** INTERNAL (quote conversion, C3): honor a negotiated snapshot price instead of resolving. Route callers never populate this. */ unitPriceOverride?: number; /** ADR 0296 — line provenance; ROUTE-derived (from the separate `bumps` array / the one-click path), never client-marked. */ origin?: 'bump' | 'upsell' }[]; requireApprovalOverThreshold?: boolean; shippingAddress?: { name?: unknown; line1?: unknown; line2?: unknown; city?: unknown; region?: unknown; postalCode?: unknown; country?: unknown } }): Promise<Order> {
  assertCap((await listOrders(input.tenantId, input.orgId)).length, 'orders');
  const items: OrderItem[] = [];
  let subtotal = 0;
  let currency = 'USD';
  // ADR 0250 — accumulate the cart parcel for carrier rate-shopping. We rate-shop ONLY when
  // EVERY physical line carries a weight (else the total is understated and a flat rate is
  // safer). Digital/service lines add no weight.
  let parcelWeightGrams = 0;
  let anyPhysical = false; let anyPhysicalUnweighed = false;
  // MERCH-D (ADR 0276) — the ACTUAL stock reservations. A simple line reserves itself;
  // a bundle line reserves its COMPONENTS (all-or-nothing in the CAS block below).
  const reservations: { productId: string; quantity: number; name: string }[] = [];
  for (const line of (input.lines ?? []).slice(0, MAX.items)) {
    const qty = nonNeg(line?.quantity) ?? 0;
    if (qty <= 0) continue;
    const product = await getProduct(input.tenantId, input.orgId, String(line.productId));
    if (!product) throw new OpenwopError('validation_error', `Product not found: ${line.productId}`, 400, { productId: line.productId });
    // Multi-currency polish: an order is single-currency — reject a mixed-currency cart
    // rather than silently coercing (there's no FX in Phase 1; that's an operator concern).
    if (items.length > 0 && product.currency !== currency) {
      throw new OpenwopError('validation_error', 'All items in an order must share one currency.', 400, { expected: currency, got: product.currency });
    }
    // D3 — account-native assortment: a buyer with an exclusive-assortment list may
    // only buy products that list carries (ONE resolver; anonymous buyers unaffected).
    if (input.contactId) {
      const sellable = await resolveSellable(input.tenantId, input.orgId, product.productId, { contactId: input.contactId });
      if (!sellable.sellable) {
        throw new OpenwopError('validation_error', `'${product.name}' is not in this account's assortment.`, 409, { code: 'not_sellable', productId: product.productId });
      }
    }
    // C4 — ONE resolver for every seller path: contract entry > variant > list price.
    // C3 — a quote conversion supplies the NEGOTIATED snapshot price instead.
    const override = typeof line.unitPriceOverride === 'number' && Number.isFinite(line.unitPriceOverride) && line.unitPriceOverride >= 0 ? line.unitPriceOverride : undefined;
    const resolved = override !== undefined
      ? { price: override, currency: product.currency, source: 'quote' }
      : await resolvePrice(input.tenantId, input.orgId, product, { buyer: { ...(input.contactId ? { contactId: input.contactId } : {}) } });
    const item: OrderItem = { productId: product.productId, name: product.name, unitPrice: resolved.price, quantity: qty, ...(resolved.source !== 'default' ? { priceSource: resolved.source } : {}), ...(line.origin === 'bump' || line.origin === 'upsell' ? { origin: line.origin } : {}) };
    if (product.kind === 'bundle' && product.components && product.components.length > 0) {
      // MERCH-D — a bundle line reserves its COMPONENTS (not itself), and its line total
      // allocates to those components by resolved-price weight (refund attribution + replay).
      const comps: { productId: string; quantity: number; price: number; name: string }[] = [];
      for (const c of product.components) {
        const cp = await getProduct(input.tenantId, input.orgId, c.productId);
        if (!cp) throw new OpenwopError('validation_error', `Bundle '${product.name}' references a missing component.`, 400, { productId: c.productId, code: 'bundle_component_missing' });
        if (cp.kind === 'bundle') throw new OpenwopError('validation_error', 'Nested bundles are not supported.', 400, { productId: c.productId, code: 'nested_bundle' });
        const cprice = (await resolvePrice(input.tenantId, input.orgId, cp, { buyer: { ...(input.contactId ? { contactId: input.contactId } : {}) } })).price;
        comps.push({ productId: cp.productId, quantity: c.quantity, price: cprice, name: cp.name });
      }
      const lineTotal = resolved.price * qty;
      const weightSum = comps.reduce((s, c) => s + c.price * c.quantity, 0) || 1;
      item.bundleComponents = comps.map((c) => ({ productId: c.productId, quantity: c.quantity * qty, allocatedPrice: quantizeMoney(lineTotal * (c.price * c.quantity / weightSum), currency) }));
      for (const c of comps) reservations.push({ productId: c.productId, quantity: c.quantity * qty, name: c.name });
    } else {
      reservations.push({ productId: product.productId, quantity: qty, name: product.name });
    }
    items.push(item);
    subtotal += resolved.price * qty;
    currency = product.currency;
    if (product.type === 'physical') {
      anyPhysical = true;
      if (typeof product.weightGrams === 'number' && product.weightGrams > 0) parcelWeightGrams += product.weightGrams * qty;
      else anyPhysicalUnweighed = true;
    }
  }
  if (items.length === 0) throw new OpenwopError('validation_error', 'An order needs at least one line with quantity > 0.', 400, {});
  // Coupon (Phase 3) — an invalid/inactive code is rejected (not silently ignored).
  let discount = 0;
  let couponCode: string | undefined;
  // R2 CM-P2-M1 — a `free_shipping` coupon validated, stamped the order and did NOTHING:
  // `couponDiscount` returned 0 "not modeled in Phase 1" while shipping IS modeled now,
  // and the Stripe session still billed the full shipping line. Both parties believed
  // shipping was waived.
  let freeShipping = false;
  if (input.couponCode && input.couponCode.trim()) {
    const coupon = await couponByCode(input.tenantId, input.orgId, input.couponCode);
    if (!coupon) throw new OpenwopError('validation_error', 'Invalid or inactive coupon code.', 400, { field: 'couponCode' });
    discount = couponDiscount(coupon, subtotal, currency);
    couponCode = coupon.code;
    freeShipping = coupon.type === 'free_shipping';
  }
  // MERCH-B (ADR 0274) — rule-based promotions AFTER resolvePrice + coupon (never a second
  // pricing path, ruling 2). The hook is a no-op when the promotions feature is absent/off,
  // so commerce stays byte-identical. The fired promotions are snapshot onto the order.
  let appliedPromotions: AppliedPromotion[] | undefined;
  try {
    const promo = await computeOrderPromotions({
      tenantId: input.tenantId, orgId: input.orgId, currency,
      subtotalAfterCoupon: Math.max(0, subtotal - discount),
      ...(input.contactId ? { contactId: input.contactId } : {}),
      items: items.map((i) => ({ productId: i.productId, unitPrice: i.unitPrice, quantity: i.quantity })),
    });
    if (promo.discount > 0) discount = Math.min(subtotal, quantizeMoney(discount + promo.discount, currency));
    if (promo.appliedPromotions.length > 0) appliedPromotions = promo.appliedPromotions;
  } catch (e) { log.warn('promotion hook failed — no promo discount', { orderId: 'pending', error: e instanceof Error ? e.message : String(e) }); }
  const total = Math.max(0, quantizeMoney(subtotal - discount, currency));
  let consumeGateKey: string | undefined;
  if (input.requireApprovalOverThreshold) {
    // Deterministic content key (no orderId exists yet): identical retried proposals resume
    // the SAME approval (the ads adHash pattern). Includes the fired-promotion ids + the
    // promoted total (ADR 0274 ruling 5) so a changed promotion never resumes a stale
    // approval at a different real total.
    const gateKey = `commerce-order:${createHash('sha256').update(JSON.stringify([input.tenantId, input.orgId, items.map((i) => [i.productId, i.quantity]), couponCode ?? null, (appliedPromotions ?? []).map((p) => p.promotionId), total, input.contactId ?? null])).digest('hex')}`;
    await assertCommerceGate({
      tenantId: input.tenantId, orgId: input.orgId, kind: 'order', gateKey,
      totalMajor: total, currency,
      proposal: `Agent order: ${items.length} line${items.length === 1 ? '' : 's'} — ${total} ${currency}`,
    });
    consumeGateKey = gateKey;
  }
  const ts = nowIso();
  const orderId = `ord:${randomUUID()}`;
  // C5 — reserve-on-create: CAS-take stock for every tracked line NOW (closing the
  // pending→paid oversell window); a shortfall rolls back the lines already taken
  // and fails the create. The pending order carries the reservation deadline; the
  // expiry sweep auto-cancels (restoring stock) when it passes unpaid.
  const taken: { productId: string; quantity: number }[] = [];
  const rollbackTaken = async (): Promise<void> => {
    for (const t of taken) {
      await casAdjustProductInventory(input.tenantId, input.orgId, t.productId, t.quantity, 'release-cancel', input.createdBy, orderId).catch(() => undefined);
    }
  };
  try {
    // MERCH-D — reserve the EXPANDED list (bundle components, not the bundle itself),
    // all-or-nothing: a component shortfall rolls back every reservation already taken.
    for (const item of reservations) {
      // `casAdjustProductInventory` can THROW (503 after contention retries) as well as
      // return 'insufficient' — both paths must release the lines already taken, else
      // stock leaks with no order row (grade-code B5).
      const took = await casAdjustProductInventory(input.tenantId, input.orgId, item.productId, -item.quantity, 'reserve', input.createdBy, orderId);
      if (took === 'insufficient') {
        await rollbackTaken();
        throw new OpenwopError('validation_error', `Insufficient stock for ${item.name}.`, 409, { productId: item.productId, code: 'out_of_stock' });
      }
      if (took === 'ok') taken.push({ productId: item.productId, quantity: item.quantity });
    }
  } catch (err) {
    if (!(err instanceof OpenwopError && err.details?.code === 'out_of_stock')) await rollbackTaken();
    throw err;
  }
  const ship = input.shippingAddress && typeof input.shippingAddress.line1 === 'string' && input.shippingAddress.line1.trim()
    ? {
        line1: cleanStr(input.shippingAddress.line1, MAX.name),
        ...(optStr(input.shippingAddress.name, MAX.name) ? { name: optStr(input.shippingAddress.name, MAX.name)! } : {}),
        ...(optStr(input.shippingAddress.line2, MAX.name) ? { line2: optStr(input.shippingAddress.line2, MAX.name)! } : {}),
        ...(optStr(input.shippingAddress.city, MAX.short) ? { city: optStr(input.shippingAddress.city, MAX.short)! } : {}),
        ...(optStr(input.shippingAddress.region, MAX.short) ? { region: optStr(input.shippingAddress.region, MAX.short)! } : {}),
        ...(optStr(input.shippingAddress.postalCode, 20) ? { postalCode: optStr(input.shippingAddress.postalCode, 20)! } : {}),
        ...(optStr(input.shippingAddress.country, 60) ? { country: optStr(input.shippingAddress.country, 60)! } : {}),
      }
    : undefined;
  // DEF-1 (ADR 0238) — quote tax + shipping from the seam (provider pack if configured,
  // else flat/manual, else zero). Best-effort: NEVER blocks order creation. The result
  // folds into the order so `orderChargeTotal` (billed by the Stripe session AND verified
  // by markAsPaid) always equals goods + tax + shipping.
  let taxLines: { name: string; amount: number }[] = [];
  let taxTotal = 0;
  let shippingCost = 0;
  try {
    // Rate-shop only with a fully-weighed physical cart (ADR 0250); else pass no parcel ⇒
    // the seam uses the flat shipping rate.
    const parcel = anyPhysical && !anyPhysicalUnweighed && parcelWeightGrams > 0 ? { weightGrams: parcelWeightGrams } : undefined;
    const quote = await quoteTaxAndShipping({
      tenantId: input.tenantId, orgId: input.orgId, currency,
      subtotalAfterDiscount: total,
      ...(ship ? { address: ship } : {}),
      ...(parcel ? { parcel } : {}),
      ...(input.createdBy && !input.createdBy.startsWith('public:') && !input.createdBy.startsWith('system') ? { actingUserId: input.createdBy } : {}),
    });
    taxLines = quote.taxLines; taxTotal = quote.taxTotal; shippingCost = freeShipping ? 0 : quote.shippingCost;
  } catch (e) { log.warn('tax/shipping quote failed — charging goods only', { orderId, error: e instanceof Error ? e.message : String(e) }); }
  const order: Order = {
    orderId, tenantId: input.tenantId, orgId: input.orgId,
    ...(ship ? { shippingAddress: ship } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    items, subtotal, discount, total, currency,
    ...(taxLines.length ? { taxLines } : {}),
    ...(taxTotal > 0 ? { taxTotal } : {}),
    ...(shippingCost > 0 ? { shippingCost } : {}),
    ...(couponCode ? { couponCode } : {}),
    ...(appliedPromotions?.length ? { appliedPromotions } : {}),
    ...(input.affiliateCode?.trim() ? { affiliateCode: input.affiliateCode.trim() } : {}),
    // ADR 0294 P3 — funnel provenance stamp (both ids or nothing; bounded).
    ...(typeof input.funnelRef?.funnelId === 'string' && input.funnelRef.funnelId.trim() && typeof input.funnelRef?.stepId === 'string' && input.funnelRef.stepId.trim()
      ? { funnelRef: { funnelId: input.funnelRef.funnelId.trim().slice(0, 100), stepId: input.funnelRef.stepId.trim().slice(0, 100) } } : {}),
    // ADR 0296 — one-click child linkage + the consent-to-save marker.
    ...(typeof input.parentOrderId === 'string' && input.parentOrderId.trim() ? { parentOrderId: input.parentOrderId.trim().slice(0, 100) } : {}),
    ...(input.pmSaveRequested === true ? { pmSaveRequested: true as const } : {}),
    status: 'pending', fulfillmentStatus: 'pending',
    reservationExpiresAt: new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
    createdBy: input.createdBy, createdAt: ts, updatedAt: ts,
  };
  // DEF-5 — register the reservation in the due-index FIRST (before the order row), so an
  // order can NEVER be persisted without its sweep entry (a lost index write would else
  // leak the reservation forever — the sweep no longer scans all orders). If the index
  // write fails we fail the create and release the stock; if the order write then fails we
  // roll back BOTH. A due-row pointing at a never-persisted order is self-healing: the
  // sweep finds no order and prunes it.
  if (order.reservationExpiresAt) {
    try { await reservationDue.put({ orderId, tenantId: input.tenantId, orgId: input.orgId, dueAt: order.reservationExpiresAt }); }
    catch (err) { await rollbackTaken(); throw err; }
  }
  // Persist the order row; if THIS fails, the stock is already reserved with no order —
  // release it (grade-code B5) and drop the now-orphaned due-row.
  try { await orders.put(order); }
  catch (err) { await rollbackTaken(); await clearReservationDue(orderId); throw err; }
  // CONSUME a spent order-gate approval: unlike ads (whose dispatch ledger dedups the
  // side effect), every create makes a NEW order — one sign-off must authorize exactly
  // one order, so the next identical agent order re-parks a fresh approval.
  if (consumeGateKey) {
    await commerceApprovals.delete(consumeGateKey).catch((e) =>
      log.warn('commerce order-gate consume failed', { gateKey: consumeGateKey, error: e instanceof Error ? e.message : String(e) }));
  }
  recordCommerceAction('order.created', order, input.createdBy, { orderId: order.orderId, total: order.total, currency: order.currency, itemCount: order.items.length, status: order.status });
  return order;
}

/**
 * GEN-2d — order creation with OPTIONAL client idempotency. Keyless behaves exactly
 * as before (a fresh order per call). With an `idempotencyKey`, a `commerce:order-idem`
 * claim is taken via insert-if-absent CAS BEFORE `createOrderInner` reserves any stock:
 *  - a completed claim → return the existing order (the retry/double-submit case);
 *  - a live `pending` claim → 409 `order_in_progress` (a concurrent create is mid-flight;
 *    the retry finds the order once it lands) — this is what prevents the double-reserve
 *    that Option-A (deterministic id, no claim) would have leaked;
 *  - a STALE pending claim (creator died mid-flight) → re-claimed;
 *  - any failure after claiming RELEASES the claim so a retry isn't wedged.
 */
export async function createOrder(
  input: Parameters<typeof createOrderInner>[0] & { idempotencyKey?: string },
): Promise<Order> {
  const { idempotencyKey } = input;
  if (!idempotencyKey) return createOrderInner(input);
  const key = `${input.tenantId}:${input.orgId}:${idempotencyKey}`;

  const resolveExisting = async (row: OrderIdemRow | null): Promise<Order | null> => {
    if (!row || row.tenantId !== input.tenantId || !row.orderId) return null;
    const o = await orders.get(row.orderId);
    return o && o.tenantId === input.tenantId ? o : null; // claim's order was deleted → allow a fresh create
  };

  const existing = await orderIdem.get(key).catch(() => null);
  const done = await resolveExisting(existing);
  if (done) return done;
  if (existing && existing.tenantId === input.tenantId && !existing.orderId
      && Date.now() - Date.parse(existing.at) < ORDER_IDEM_STALE_MS) {
    throw new OpenwopError('idempotency_key_conflict', 'An order for this request is already being created — please retry in a moment.', 409, { code: 'order_in_progress' });
  }

  // Atomically claim the slot. CAS against the row we just read: insert-if-absent when
  // none existed, or overwrite a stale/deleted-order claim. A concurrent claimer that
  // wins makes this CAS fail → re-read and return/409.
  const claim: OrderIdemRow = { key, tenantId: input.tenantId, orgId: input.orgId, at: nowIso() };
  if (!(await orderIdem.compareAndSwap(existing ?? null, claim))) {
    const now = await orderIdem.get(key).catch(() => null);
    const raced = await resolveExisting(now);
    if (raced) return raced;
    throw new OpenwopError('idempotency_key_conflict', 'An order for this request is already being created — please retry in a moment.', 409, { code: 'order_in_progress' });
  }

  try {
    const order = await createOrderInner(input);
    await orderIdem.put({ ...claim, orderId: order.orderId }).catch((e) =>
      log.warn('order-idem claim finalize failed', { key, orderId: order.orderId, error: e instanceof Error ? e.message : String(e) }));
    return order;
  } catch (err) {
    // Release the claim so a retry can proceed (never wedge a key on a failed create).
    await orderIdem.delete(key).catch(() => undefined);
    throw err;
  }
}

// ── Stock movements + CAS inventory (gap plan §5C C5) ────────────────────────
export type StockMovementReason = 'reserve' | 'release-cancel' | 'release-expired' | 'refund-restore' | 'legacy-paid-decrement' | 'manual-adjust';
export interface StockMovement {
  movementId: string; tenantId: string; orgId: string;
  productId: string; delta: number; inventoryAfter: number;
  reason: StockMovementReason; orderId?: string; actor: string; at: string;
}
const stockMovements = new DurableCollection<StockMovement>('commerce:stock-movement', (m) => m.movementId, undefined, (m) => m.tenantId);

export async function listStockMovements(tenantId: string, orgId: string, productId?: string): Promise<StockMovement[]> {
  return (await stockMovements.listForTenantIndexed(tenantId))
    .filter((m) => m.orgId === orgId && (!productId || m.productId === productId))
    .sort((a, b) => b.at.localeCompare(a.at));
}

async function recordMovement(p: Product, delta: number, inventoryAfter: number, reason: StockMovementReason, actor: string, orderId?: string): Promise<void> {
  try {
    await stockMovements.put({
      movementId: `mvt:${randomUUID()}`, tenantId: p.tenantId, orgId: p.orgId,
      productId: p.productId, delta, inventoryAfter, reason,
      ...(orderId ? { orderId } : {}), actor, at: nowIso(),
    });
  } catch (err) { log.warn('stock movement append failed', { productId: p.productId, reason, error: err instanceof Error ? err.message : String(err) }); }
}

/** CAS-adjust ONE product's inventory (cross-instance safe — the #1189 reserveSend
 *  posture): retries on contention; a decrement below zero reports 'insufficient'
 *  instead of clamping (the oversell guard). Untracked products are a no-op. */
async function casAdjustProductInventory(
  tenantId: string, orgId: string, productId: string, delta: number,
  reason: StockMovementReason, actor: string, orderId?: string,
): Promise<'ok' | 'insufficient' | 'untracked'> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = await getProduct(tenantId, orgId, productId);
    if (!p || p.type !== 'physical' || p.inventory === undefined) return 'untracked';
    const nextInventory = p.inventory + delta;
    if (nextInventory < 0) return 'insufficient';
    if (await products.cas(p, { ...p, inventory: nextInventory, updatedAt: nowIso() })) {
      await recordMovement(p, delta, nextInventory, reason, actor, orderId);
      if (delta < 0 && p.lowStockThreshold !== undefined && p.inventory >= p.lowStockThreshold && nextInventory < p.lowStockThreshold) {
        recordCommerceAction('inventory.low-stock', p, 'system', { productId: p.productId, productName: p.name, inventory: nextInventory, lowStockThreshold: p.lowStockThreshold });
      }
      return 'ok';
    }
  }
  throw new OpenwopError('internal_error', 'Inventory update contention — please retry.', 503, { productId });
}

/** Adjust inventory for every line of an order (sign = +restore / −take). Used by the
 *  restore paths and the legacy decrement-at-paid fallback. */
async function adjustInventory(order: Order, sign: 1 | -1, reason: StockMovementReason, actor = 'system'): Promise<void> {
  for (const item of order.items) {
    // MERCH-D (ADR 0276) — a bundle line adjusts its COMPONENTS (what was reserved at
    // create), never the bundle product itself; keeps paid/cancel/refund/expiry symmetric.
    if (item.bundleComponents && item.bundleComponents.length > 0) {
      for (const c of item.bundleComponents) {
        await casAdjustProductInventory(order.tenantId, order.orgId, c.productId, sign * c.quantity, reason, actor, order.orderId);
      }
    } else {
      await casAdjustProductInventory(order.tenantId, order.orgId, item.productId, sign * item.quantity, reason, actor, order.orderId);
    }
  }
}

/** Mark an order paid. LEAK-11: when the operator's Stripe key is configured,
 *  the supplied paymentIntentId is VERIFIED against Stripe — the intent must be
 *  `succeeded` and its amount/currency must match the order total exactly
 *  (minor-units aware; a currency mismatch always hard-fails). Keyless mode
 *  keeps the honest demo posture (recorded, unverified — surfaced to the caller
 *  via the route's `paymentVerification` field). Then pending→paid + inventory. */
/**
 * ADR 0420 P1 — order lifecycle observers (the fulfilment inversion seam):
 * adapters (kicktodo-commerce) register here; commerce never imports them.
 * Invoked BEST-EFFORT after the CAS transitions — the money truth never
 * depends on an observer; observers must be idempotent + repairable.
 */
type OrderObserver = (order: Order) => Promise<void>;
const orderPaidObservers: OrderObserver[] = [];
const orderRefundObservers: OrderObserver[] = [];
export function registerOrderPaidObserver(fn: OrderObserver): void { orderPaidObservers.push(fn); }
export function registerOrderRefundObserver(fn: OrderObserver): void { orderRefundObservers.push(fn); }
async function notifyObservers(list: OrderObserver[], order: Order, what: string): Promise<void> {
  for (const fn of list) {
    try { await fn(order); } catch (err) {
      log.warn('order_observer_failed', { what, orderId: order.orderId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export async function markAsPaid(
  tenantId: string, orgId: string, orderId: string, paymentIntentId: string,
  opts: { stripeKey?: string | null; actor?: string } = {},
): Promise<Order | null> {
  const o = await getOrder(tenantId, orgId, orderId);
  if (!o) return null;
  if (o.status !== 'pending') throw new OpenwopError('validation_error', `Only a pending order can be marked paid (is '${o.status}').`, 409, { status: o.status });
  if (opts.stripeKey) {
    const intent = await getStripePaymentIntent(opts.stripeKey, paymentIntentId);
    if (intent.status !== 'succeeded') {
      throw new OpenwopError('validation_error', `Payment intent is '${intent.status}', not succeeded — the order stays pending.`, 409, { paymentIntentId, intentStatus: intent.status });
    }
    if (intent.currency.toLowerCase() !== o.currency.toLowerCase()) {
      throw new OpenwopError('validation_error', `Payment currency '${intent.currency}' does not match the order currency '${o.currency}'.`, 409, { paymentIntentId });
    }
    const expected = orderChargeMinor(o); // total + tax + shipping (DEF-1)
    if (intent.amount !== expected) {
      throw new OpenwopError('validation_error', `Payment amount ${intent.amount} does not match the order charge (${expected} minor units).`, 409, { paymentIntentId });
    }
  }
  // CAS pending→paid (grade-code B4): a concurrent cancel/sweep must not be able to
  // cancel an order this call is flipping paid. A lost CAS means someone moved it —
  // re-read and honour the terminal state (idempotent for a re-delivered webhook).
  const next = await casOrder(o, (cur) => ({ ...cur, status: 'paid', paymentIntentId: cleanStr(paymentIntentId, MAX.short), updatedAt: nowIso() }));
  if (next) await notifyObservers(orderPaidObservers, next, 'paid');
  if (!next) {
    const fresh = await getOrder(tenantId, orgId, orderId);
    if (fresh?.status === 'paid') return fresh; // idempotent — already paid
    throw new OpenwopError('validation_error', `Order state changed concurrently (is '${fresh?.status ?? 'gone'}').`, 409, { status: fresh?.status });
  }
  // C5 — a reserved-at-create order's stock was already taken (the reservation is
  // simply consumed); a pre-C5 order (no reservation stamp) keeps the legacy
  // decrement-at-paid so upgrades never double-count.
  if (!o.reservationExpiresAt) await adjustInventory(o, -1, 'legacy-paid-decrement', opts.actor ?? 'system');
  await clearReservationDue(next.orderId); // DEF-5 — paid ⇒ no longer expirable
  recordCommerceAction('order.paid', next, opts.actor ?? 'system', { orderId: next.orderId, total: next.total, currency: next.currency, paymentVerification: opts.stripeKey ? 'stripe' : 'none', status: next.status });
  // Affiliate commission accrual (deferred P5) — best-effort; only fires on this
  // pending→paid transition, so no double-accrual.
  try { await accrueCommission(next); } catch { /* best-effort — never block payment */ }
  // Customer order-confirmation email — best-effort transactional send to the linked
  // CRM contact's address via the brokered default transport (B4); honest no-op when
  // no provider connection / sender address is configured. `context` lets the
  // transport resolve the acting human's connection; idempotencyKey rides the ONE
  // email sent-ledger so a webhook re-delivery never re-sends.
  try {
    if (next.contactId) {
      const contact = await getContact(next.contactId);
      if (contact?.email && contact.tenantId === next.tenantId) {
        // D1 — the customer-identity floor: mint an order-status share link for the
        // confirmation (capability token; expiring; PII-free view). Best-effort —
        // sharing off / link failure never blocks the email, let alone the payment.
        let statusLink = '';
        try {
          const { createLink } = await import('../sharing/sharingService.js');
          const link = await createLink(next.tenantId, next.orgId, 'system:commerce', { resourceType: 'commerce_order', resourceId: next.orderId, expiresInDays: 90 });
          const base = (process.env.OPENWOP_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
          if (base) statusLink = `\n\nTrack your order: ${base}/shared/${link.token}`;
        } catch { /* sharing unavailable — plain confirmation */ }
        await sendTransactionalEmail({
          to: contact.email,
          subject: `Order ${next.orderId} confirmed`,
          text: `Thanks for your order. Total: ${next.total} ${next.currency}.${statusLink}`,
          context: { tenantId: next.tenantId, orgId: next.orgId, actingUserId: next.createdBy, idempotencyKey: `commerce:order-confirm:${next.orderId}` },
        });
      }
    }
  } catch { /* best-effort — never block payment */ }
  // C9 — revenue floor: the paid order lands as an analytics `conversion` event so
  // campaign attribution can finally join spend to revenue. FIRST-PARTY operator
  // data (the merchant's own order), not visitor tracking — the beacon's consent
  // gate governs visitor sessions, not the merchant's ledger (ADR notes). Best-effort.
  try {
    await recordEvent({ tenantId: next.tenantId, orgId: next.orgId, raw: { type: 'conversion', name: 'commerce.order.paid', path: '/store', props: { orderId: next.orderId, total: next.total, currency: next.currency, itemCount: next.items.length } } });
  } catch { /* best-effort — analytics off/unwired never blocks payment */ }
  // Order ↔ CRM linkage (B6): a deterministic-id Activity on the contact's timeline
  // (the ADR 0162 idempotency pattern — a webhook re-delivery can't duplicate it).
  // Best-effort; validators only ever check the contact link here.
  try {
    if (next.contactId) {
      await createActivity({
        tenantId: next.tenantId, orgId: next.orgId, kind: 'note',
        body: `Order ${next.orderId} paid — ${next.total} ${next.currency} (${next.items.length} item${next.items.length === 1 ? '' : 's'}).`,
        contactId: next.contactId,
        createdBy: 'system:commerce',
        activityId: `act:commerce-order-${next.orderId.replace(/^ord:/, '')}`,
        validators: {
          validateDeal: async () => false,
          validateCompany: async () => false,
          validateContact: async (id) => { const c = await getContact(id); return c !== null && c.tenantId === next.tenantId; },
        },
      });
    }
  } catch (err) { log.warn('commerce order-paid activity append failed', { orderId: next.orderId, error: err instanceof Error ? err.message : String(err) }); }
  // DEF-8 (ADR 0240) — opt-in Deal-on-paid: when the org enables `commerce.dealOnPaid`
  // AND the order links a contact, open a WON Deal for the sale. Deterministic dealId
  // (ADR 0162) ⇒ a webhook re-delivery links the SAME deal, never a duplicate. Best-effort:
  // a Deal failure NEVER blocks payment. The gate is read fail-OPEN here (unlike the spend
  // gate) — a policy hiccup simply skips this convenience linkage, it doesn't hold money.
  try {
    if (next.contactId) {
      const policy = await getGovernancePolicy(next.tenantId).catch(() => null);
      if (policy?.commerce?.dealOnPaid) {
        await createDeal({
          tenantId: next.tenantId, orgId: next.orgId,
          title: `Order ${next.orderId}`,
          amount: next.total, currency: next.currency,
          contactId: next.contactId, status: 'won',
          // ADR 0240 follow-on — honor an operator-configured target pipeline/stage; absent
          // ⇒ createDeal resolves the org default (the shipped behavior).
          ...(policy.commerce.dealOnPaidPipelineId ? { pipelineId: policy.commerce.dealOnPaidPipelineId } : {}),
          ...(policy.commerce.dealOnPaidStageId ? { stageId: policy.commerce.dealOnPaidStageId } : {}),
          createdBy: 'system:commerce', actor: 'system:commerce',
          dealId: `deal:commerce-order-${next.orderId.replace(/^ord:/, '')}`,
          ...makeLinkValidators(next.tenantId, next.orgId),
        });
      }
    }
  } catch (err) { log.warn('commerce deal-on-paid failed', { orderId: next.orderId, error: err instanceof Error ? err.message : String(err) }); }
  // Order-confirmation (ADR 0177 Phase 2) — best-effort, composes the Notification seam
  // (never forks a sender; the notification system carries the in-app + email delivery).
  // Customer-facing transactional email to the CRM contact is a transactional-email follow-on.
  try {
    // ADR 0710 AUDIENCE DECISION — `commerce.order.paid` STAYS a tenant-wide
    // broadcast, deliberately, and this comment is the decision the ADR asked the
    // implementing PR to make.
    //
    // The appendix flagged it as "a money fact with a customer attached". Read at
    // HEAD, the payload is `orderId`, `total`, `currency` — NO customer identity;
    // the contact lives behind the `actionUrl`, which has its own authz. And
    // unlike a failure notice, this is a FULFILMENT signal: the people who pack
    // and ship are editor-class, so addressing it to `admin` would hide orders
    // from exactly the members whose job they are. It sits with `budget-alert`
    // (ADR 0482 §4), the other deliberate workspace-wide business fact, not with
    // `workflow.failed`.
    //
    // What WOULD change this: putting a contact name, email or address in the
    // title/message, or a role that means "fulfils orders". Neither exists today.
    await getNotificationEmitter().emit({
      tenantId, type: 'commerce.order.paid', priority: 'low',
      title: 'Order confirmed', message: `Order ${next.orderId} paid — ${next.total} ${next.currency}.`,
      // Deep-link spine (Phase 2): land on the specific order, not the Products tab.
      actionUrl: `/commerce/orders/${encodeURIComponent(next.orderId)}?org=${encodeURIComponent(next.orgId)}`,
    });
  } catch (err) {
    // Never block payment on a notification failure, but a systematic outage on
    // the order-confirmation path must be visible (matches the pacing pattern).
    log.warn('order-paid notification emit failed', { orderId: next.orderId, error: err instanceof Error ? err.message : String(err) });
  }
  return next;
}
/** Refund a paid/fulfilled order. Issues a REAL Stripe refund when the caller resolves
 *  a key (D4) and records WHICH lane ran on the order (`refundProvider`, R2 CM-P2-B3);
 *  a keyless caller flips state only and says so. (The docblock previously claimed
 *  "state-only — no Stripe refund is issued" long after D4 shipped — R2 CM-P2-I11.)
 *  When the tenant sets
 *  `commerce.refundApprovalThresholdMinor`, an at/over-threshold refund requires an
 *  approved `commerce-spend` sign-off for EVERY caller (B3). */
export async function refundOrder(tenantId: string, orgId: string, orderId: string, opts: { actor?: string; stripeKey?: string | null } = {}): Promise<Order | null> {
  const o = await getOrder(tenantId, orgId, orderId);
  if (!o) return null;
  // R2 CM-P2-B1 — `refunding` is RESUMABLE. It used to be refused here (and by every
  // sibling transition, and by every UI action gate), so a single Stripe failure wedged
  // a paid order forever with no way to finish or abandon the refund — while the comment
  // below promised a retry could finish it. Accepting it here is also the migration path
  // for rows already wedged by the old code: no backfill exists for them.
  if (o.status !== 'paid' && o.status !== 'fulfilled' && o.status !== 'refunding') throw new OpenwopError('validation_error', `Only a paid/fulfilled order can be refunded (is '${o.status}').`, 409, { status: o.status });
  const chargeTotal = orderChargeTotal(o); // DEF-1 — refund the full charge (goods + tax + shipping)
  await assertCommerceGate({
    tenantId, orgId, kind: 'refund',
    gateKey: `commerce-refund:${orderId}`, // one approval per order — deterministic, fork-stable
    totalMajor: chargeTotal, currency: o.currency, orderId,
    proposal: `Refund order ${orderId} — ${chargeTotal} ${o.currency}`,
  });
  // CAS paid/fulfilled→refunding FIRST (grade-code B3): claim the transition before
  // touching Stripe so two concurrent refunds can't both issue a refund. The loser
  // sees `refunding`/`refunded` and stops.
  // A resume already holds the claim — re-claiming would lose the CAS against itself.
  const claimed = o.status === 'refunding' ? o : await casOrder(o, (cur) => ({ ...cur, status: 'refunding' as OrderStatus, updatedAt: nowIso() }));
  if (!claimed) {
    const fresh = await getOrder(tenantId, orgId, orderId);
    if (fresh?.status === 'refunded') return fresh; // idempotent — already refunded
    throw new OpenwopError('validation_error', `Order is being refunded or its state changed (is '${fresh?.status ?? 'gone'}').`, 409, { status: fresh?.status });
  }
  /** Hand the order back to its pre-claim status so the operator can retry or walk away.
   *  Safe because the Stripe call is idempotency-keyed per order: a retry replays the
   *  SAME refund rather than issuing a second one. */
  const releaseClaim = async (): Promise<void> => {
    const cur = await getOrder(tenantId, orgId, orderId);
    // On a RESUME `o.status` is itself 'refunding', so it cannot be the restore target —
    // hard-coding 'paid' downgraded a DELIVERED order (review M-1). Derive it the same way
    // `updateFulfillment` does: delivered ⇒ fulfilled.
    const restore: OrderStatus = o.status !== 'refunding' ? o.status : (cur?.fulfillmentStatus === 'delivered' ? 'fulfilled' : 'paid');
    if (cur?.status === 'refunding') await casOrder(cur, (row) => ({ ...row, status: restore, updatedAt: nowIso() }));
  };
  // D4 — REAL money back when possible. A Stripe failure RELEASES the claim (R2
  // CM-P2-B1) so the order is actionable again, and carries a deterministic idempotency
  // key so the retry replays the same refund instead of issuing a second one — the shape
  // `partialRefundOrder` already had.
  let refundProvider: 'stripe' | 'none' = 'none';
  let refundId: string | undefined;
  const stripeKey = opts.stripeKey ?? null;
  if (stripeKey && o.paymentIntentId && !o.paymentIntentId.startsWith('demo:') && !o.paymentIntentId.startsWith('manual:') && !o.paymentIntentId.startsWith('evt:')) {
    try {
      const r = await createStripeRefund(stripeKey, o.paymentIntentId, { idempotencyKey: `commerce-refund:${orderId}` });
      refundProvider = 'stripe'; refundId = r.id;
    } catch (err) {
      // "Already refunded" at Stripe is success on a retry; anything else releases.
      if (err instanceof OpenwopError && /already.*refund|charge_already_refunded/i.test(err.message)) {
        refundProvider = 'stripe';
      } else {
        // Release ONLY when the failure proves no money moved (Stripe rejected the
        // request outright). A timeout or a 5xx is AMBIGUOUS — Stripe may have processed
        // the refund and lost the response — so the claim is KEPT: `refunding` is now a
        // recoverable state with a retry action, not the dead end it used to be, and
        // telling the operator "it failed, still paid" would be a claim we cannot make.
        // (Review M-2: the idempotency key that makes a retry safe expires, so "retry is
        // always safe" is true inside Stripe's retention window and false outside it.)
        const provablyNoCharge = err instanceof OpenwopError && err.code === 'validation_error';
        recordCommerceAction('order.refund-failed', o, opts.actor ?? 'system', { orderId: o.orderId, error: err instanceof Error ? err.message : String(err), released: provablyNoCharge });
        if (provablyNoCharge) await releaseClaim().catch(() => undefined);
        throw err;
      }
    }
  }
  // Persist the terminal state WITH the refundId + full refundedAmount on the order.
  const refundedRow: Order = { ...claimed, status: 'refunded', refundedAmount: chargeTotal, refundProvider, ...(refundId ? { refundId } : {}), updatedAt: nowIso() };
  await orders.put(refundedRow);
  await notifyObservers(orderRefundObservers, refundedRow, 'refunded'); // ADR 0420 P1
  // ADR 0447 P2 — affiliate clawback (best-effort, idempotent mirror; the old
  // running-balance lane never clawed back a refunded order's commission).
  try { await reverseCommission(refundedRow); } catch { /* best-effort — never block the refund */ }
  await adjustInventory(o, 1, 'refund-restore', opts.actor ?? 'system'); // restore (a full refund is a return)
  recordCommerceAction('order.refunded', o, opts.actor ?? 'system', { orderId: o.orderId, total: chargeTotal, currency: o.currency, status: 'refunded', refundProvider, ...(refundId ? { refundId } : {}) });
  return getOrder(tenantId, orgId, orderId);
}

/** DEF-7 (ADR 0238) — a PARTIAL refund: a price adjustment, NOT a return. Distinct from
 *  the one-shot `refundOrder` so the shipped full-refund CAS/idempotency invariant stays
 *  untouched. Repeat-safe:
 *   - append-only refund ledger keyed by the caller's `refundKey` ⇒ a retry with the same
 *     key returns the existing refund (the multi-refund idempotency the single-order CAS
 *     can't give);
 *   - cumulative `refundedAmount` updated via a CAS-retry loop (over-refund guarded);
 *   - NO inventory restore (goods aren't coming back — it's a discount after the sale);
 *   - status → 'partially_refunded' until the cumulative reaches the full charge, then
 *     'refunded' (no restore even then — a series of price adjustments is not a return);
 *   - gate keyed per-request (`commerce-refund:<orderId>:<refundKey>`) so each partial
 *     gets its own `commerce-spend` sign-off. */
export async function partialRefundOrder(
  tenantId: string, orgId: string, orderId: string, amount: number,
  opts: { refundKey: string; actor?: string; stripeKey?: string | null },
): Promise<Order | null> {
  const refundKey = cleanStr(opts.refundKey, MAX.short);
  if (!refundKey) throw new OpenwopError('validation_error', 'A `refundKey` is required for a partial refund (idempotency).', 400, {});
  const amt = nonNeg(amount) ?? 0;
  if (amt <= 0) throw new OpenwopError('validation_error', 'A partial refund `amount` must be greater than zero.', 400, {});

  const ledgerId = `commerce:refund:${tenantId}:${orgId}:${orderId}:${refundKey}`;
  const existing = await refundLedger.get(ledgerId);
  // ADR 0615 — what a same-key retry means depends on the claim's STATE. The old
  // `if (existing) return` answered "already applied" for every row, including one
  // abandoned mid-flight by a crashed owner: money gone, order unchanged, and the
  // retry that should have repaired it reporting success.
  if (existing) {
    const state = refundClaimState(existing);
    if (state === 'manual_intervention_required') {
      // The provider moved money this host could not record. Re-driving would be
      // guessing with someone's money; a human decides. Fail LOUD.
      throw new OpenwopError(
        'conflict',
        `Refund '${refundKey}' on order ${orderId} needs manual intervention: the provider accepted it but this host could not record it.`,
        409,
        { orderId, refundKey, ...(existing.refundId ? { refundId: existing.refundId } : {}) },
      );
    }
    // `pending` with a live lease is a concurrent caller, not a corpse — answer
    // idempotently exactly as before. Only an EXPIRED lease means the owner is gone.
    if (state === 'applied' || !refundLeaseExpired(existing)) return getOrder(tenantId, orgId, orderId);
  }

  const o = await getOrder(tenantId, orgId, orderId);
  if (!o) return null;
  if (o.status !== 'paid' && o.status !== 'fulfilled' && o.status !== 'partially_refunded') {
    throw new OpenwopError('validation_error', `Only a paid/fulfilled/partially-refunded order can be partially refunded (is '${o.status}').`, 409, { status: o.status });
  }
  const chargeTotal = orderChargeTotal(o);
  const already = o.refundedAmount ?? 0;
  const remaining = quantizeMoney(chargeTotal - already, o.currency);
  if (amt > remaining) {
    throw new OpenwopError('validation_error', `Partial refund ${amt} exceeds the ${remaining} ${o.currency} remaining on order ${orderId}.`, 409, { remaining, currency: o.currency });
  }
  // Per-request approval — each partial refund is its own spend event.
  await assertCommerceGate({
    tenantId, orgId, kind: 'refund',
    gateKey: `commerce-refund:${orderId}:${refundKey}`,
    totalMajor: amt, currency: o.currency, orderId,
    proposal: `Partial refund order ${orderId} — ${amt} ${o.currency} (${refundKey})`,
  });
  // ATOMIC CLAIM (grade-code HIGH-1): insert-if-absent the ledger row via CAS. This is
  // the idempotency anchor — two concurrent calls with the SAME refundKey can't both
  // proceed (the loser returns idempotently), so the cumulative total is folded exactly
  // once. Deleted on any downstream failure so a retry re-drives (self-healing).
  // ADR 0615 — the claim is `pending` under a LEASE. Reaching here with an `existing`
  // row means it was `pending` with an expired lease, so this call is RECLAIMING an
  // abandoned claim: CAS from that exact row, not from null, so two reclaimers racing
  // still leave exactly one owner.
  const ledgerRow: RefundLedgerEntry = {
    refundLedgerId: ledgerId, tenantId, orgId, orderId, refundKey, amount: amt, currency: o.currency,
    provider: 'none', state: 'pending', leaseUntil: new Date(Date.now() + REFUND_CLAIM_LEASE_MS).toISOString(),
    createdBy: opts.actor ?? 'system',
    createdAt: existing?.createdAt ?? nowIso(), // a reclaim keeps the ORIGINAL claim time
  };
  const claimed = await refundLedger.compareAndSwap(existing ?? null, ledgerRow);
  if (!claimed) return getOrder(tenantId, orgId, orderId); // a concurrent same-key call won — idempotent
  // Hoisted out of the try: the catch has to know whether the provider actually took
  // the money, and a `let` inside the try is invisible to it.
  let refundProvider: 'stripe' | 'none' = 'none';
  let refundId: string | undefined;
  try {
    // REAL partial money back when possible. The Stripe refund carries a deterministic
    // idempotency key so a retry after a crash is a no-op, not a second charge-back; a
    // genuine over-refund across concurrent DIFFERENT keys is rejected by Stripe here.
    const stripeKey = opts.stripeKey ?? null;
    if (stripeKey && o.paymentIntentId && !o.paymentIntentId.startsWith('demo:') && !o.paymentIntentId.startsWith('manual:') && !o.paymentIntentId.startsWith('evt:')) {
      const r = await createStripeRefund(stripeKey, o.paymentIntentId, {
        amountMinor: toStripeMinorUnits(amt, o.currency),
        idempotencyKey: `commerce-partial-refund:${orderId}:${refundKey}`,
      });
      refundProvider = 'stripe'; refundId = r.id;
    }
    // Fold the cumulative amount into the order with a CAS-retry loop. The over-refund
    // clamp lives INSIDE the mutator (grade-code MEDIUM-2): concurrent partials on a
    // MANUAL/DEMO order (no Stripe backstop) are serialized by the CAS, so the second one
    // sees the first's total and is rejected — the `refundedAmount + amt ≤ chargeTotal`
    // invariant holds without relying on Stripe.
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await getOrder(tenantId, orgId, orderId);
      if (!cur) throw new OpenwopError('not_found', 'Order vanished mid-refund.', 404, { orderId });
      const newTotal = quantizeMoney((cur.refundedAmount ?? 0) + amt, cur.currency);
      if (newTotal > orderChargeTotal(cur) + 0.005) {
        throw new OpenwopError('validation_error', `Partial refund ${amt} would exceed the order charge (a concurrent refund landed first).`, 409, { orderId, currency: o.currency });
      }
      const fullyRefunded = newTotal >= orderChargeTotal(cur) - 0.005;
      const applied = await casOrder(cur, (row) => ({ ...row, refundedAmount: newTotal, status: (fullyRefunded ? 'refunded' : 'partially_refunded') as OrderStatus, refundProvider: row.refundProvider === 'stripe' ? 'stripe' : refundProvider, updatedAt: nowIso() }));
      if (applied && fullyRefunded) {
        await notifyObservers(orderRefundObservers, applied, 'refunded'); // ADR 0420 P1
        try { await reverseCommission(applied); } catch { /* ADR 0447 P2 — best-effort clawback */ }
      }
      if (applied) {
        // Finalize the ledger row with the real provider/refundId (we own the claim).
        // ADR 0615: `applied` is what makes the next same-key call idempotent, and the
        // lease is dropped with it — a terminal row is not reclaimable.
        await refundLedger.put({ ...ledgerRow, provider: refundProvider, state: 'applied', leaseUntil: undefined, ...(refundId ? { refundId } : {}) });
        recordCommerceAction('order.partially-refunded', applied, opts.actor ?? 'system', { orderId, amount: amt, refundedAmount: newTotal, currency: o.currency, status: applied.status, refundProvider, ...(refundId ? { refundId } : {}) });
        return applied;
      }
    }
    throw new OpenwopError('internal_error', 'The order total could not be updated after retries — please retry.', 503, { orderId, refundKey });
  } catch (err) {
    // ADR 0615 — the two failures are NOT the same failure, and treating them alike is
    // what stranded the claim.
    if (refundId) {
      // The provider ALREADY took the money and we could not record it. Deleting the
      // claim here would erase the only durable trace that it happened. Park the row at
      // the state a human has to clear; keep the refundId so they can reconcile it.
      await refundLedger.put({ ...ledgerRow, provider: refundProvider, refundId, state: 'manual_intervention_required', leaseUntil: undefined }).catch(() => undefined);
      recordCommerceAction('order.refund-stranded', o, opts.actor ?? 'system', {
        orderId: o.orderId, partial: true, amount: amt, refundKey, refundId, refundProvider,
        error: err instanceof Error ? err.message : String(err),
      });
    } else {
      // No money moved (the provider rejected it, or there was no provider leg at all),
      // so releasing the claim is correct and a corrected retry re-drives cleanly.
      await refundLedger.delete(ledgerId).catch(() => undefined);
      if (!(err instanceof OpenwopError)) recordCommerceAction('order.refund-failed', o, opts.actor ?? 'system', { orderId: o.orderId, partial: true, amount: amt, error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}
export async function cancelOrder(tenantId: string, orgId: string, orderId: string, opts: { actor?: string; expired?: boolean } = {}): Promise<Order | null> {
  const o = await getOrder(tenantId, orgId, orderId);
  if (!o) return null;
  if (o.status !== 'pending') throw new OpenwopError('validation_error', `Only a pending order can be canceled (is '${o.status}').`, 409, { status: o.status });
  // CAS pending→canceled (grade-code B4): if a concurrent pay flipped it paid between
  // our read and here, the CAS fails and we DON'T cancel a paid order / restore sold
  // stock. The sweep relies on this: a raced order is simply left for the next tick.
  const next = await casOrder(o, (cur) => ({ ...cur, status: 'canceled', updatedAt: nowIso() }));
  if (!next) return getOrder(tenantId, orgId, orderId); // lost the race — return the current state
  // C5 — canceling a reserved order releases its stock.
  if (o.reservationExpiresAt) await adjustInventory(o, 1, opts.expired ? 'release-expired' : 'release-cancel', opts.actor ?? 'system');
  await clearReservationDue(next.orderId); // DEF-5 — canceled ⇒ off the due-index
  recordCommerceAction('order.canceled', next, opts.actor ?? 'system', { orderId: next.orderId, total: next.total, currency: next.currency, status: next.status, ...(opts.expired ? { reason: 'reservation-expired' } : {}) });
  return next;
}

/** C5 — expiry sweep: auto-cancel pending orders whose reservation deadline passed,
 *  releasing their stock. Bounded per tick (the emailSentLedger sweep posture);
 *  piggybacked on the webhook delivery worker's cadence — no new daemon. */
const RESERVATION_SWEEP_BATCH = 50;
export async function sweepExpiredReservations(now = Date.now()): Promise<number> {
  let released = 0;
  try {
    // DEF-5 — scan the due-index (bounded to LIVE reservations), not the full order
    // history. Due-first so the oldest expirations clear first under a batch cap.
    const due = (await reservationDue.list())
      .filter((r) => Date.parse(r.dueAt) <= now)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    for (const r of due) {
      if (released >= RESERVATION_SWEEP_BATCH) break;
      try {
        // Prune BEFORE cancel: if the order already left 'pending' (paid/canceled, or gone),
        // drop the stale index row now — otherwise cancelOrder THROWS on a non-pending order
        // and the row would be re-scanned every tick forever (a delete-failure leak).
        const cur = await getOrder(r.tenantId, r.orgId, r.orderId);
        if (!cur || cur.status !== 'pending') { await clearReservationDue(r.orderId); continue; }
        const canceled = await cancelOrder(r.tenantId, r.orgId, r.orderId, { actor: 'system:reservation-sweep', expired: true });
        if (canceled?.status === 'canceled') released += 1; // cancelOrder clears the due-row on success
      } catch { /* raced with a concurrent pay/cancel — left for the next tick */ }
    }
  } catch (err) { log.warn('reservation sweep failed', { error: err instanceof Error ? err.message : String(err) }); }
  return released;
}
/** Advance fulfillment (paid orders). Reaching `delivered` flips order status→fulfilled. */
export async function updateFulfillment(tenantId: string, orgId: string, orderId: string, fulfillmentStatus: FulfillmentStatus, opts: { actor?: string } = {}): Promise<Order | null> {
  const o = await getOrder(tenantId, orgId, orderId);
  if (!o) return null;
  if (o.status !== 'paid' && o.status !== 'fulfilled') throw new OpenwopError('validation_error', 'Fulfillment applies to a paid order.', 409, { status: o.status });
  // R2 CM-P2-B4 — CAS, like every sibling transition. This was the ONE order write that
  // read-then-blind-put: marking a stale row shipped wrote back the pre-refund snapshot,
  // so a concurrent partial refund's `refundedAmount` vanished, `partially_refunded`
  // reverted to `paid`, and the UI re-offered a FULL refund on money already returned.
  const next = await casOrder(o, (cur) => ({ ...cur, fulfillmentStatus, ...(fulfillmentStatus === 'delivered' ? { status: 'fulfilled' as OrderStatus } : {}), updatedAt: nowIso() }));
  if (!next) throw new OpenwopError('validation_error', 'The order changed while you were updating fulfillment — reload and try again.', 409, { orderId });
  recordCommerceAction('order.fulfillment-updated', next, opts.actor ?? 'system', { orderId: next.orderId, fulfillmentStatus: next.fulfillmentStatus, status: next.status });
  return next;
}

// ── Cart (Phase-1 deferred: server-persisted, one per user+org) ───────────────
export interface CartLine { productId: string; quantity: number }
export interface Cart { cartId: string; tenantId: string; orgId: string; userId: string; lines: CartLine[]; updatedAt: string }
const carts = new DurableCollection<Cart>('commerce:cart', (c) => c.cartId, undefined, (c) => c.tenantId);
const cartId = (tenantId: string, orgId: string, userId: string): string => `${tenantId}:${orgId}:${userId}`;

export async function getCart(tenantId: string, orgId: string, userId: string): Promise<Cart> {
  return (await carts.get(cartId(tenantId, orgId, userId))) ?? { cartId: cartId(tenantId, orgId, userId), tenantId, orgId, userId, lines: [], updatedAt: nowIso() };
}
/** Set a product's quantity in the cart (quantity 0 removes it). Validates the product. */
export async function setCartItem(tenantId: string, orgId: string, userId: string, productId: string, quantity: number): Promise<Cart> {
  const qty = Math.max(0, Math.floor(nonNeg(quantity) ?? 0));
  if (qty > 0 && !(await getProduct(tenantId, orgId, productId))) {
    throw new OpenwopError('validation_error', `Product not found: ${productId}`, 400, { productId });
  }
  const cart = await getCart(tenantId, orgId, userId);
  const lines = cart.lines.filter((l) => l.productId !== productId);
  if (qty > 0) lines.push({ productId, quantity: qty });
  const next: Cart = { ...cart, lines: lines.slice(0, MAX.items), updatedAt: nowIso() };
  await carts.put(next);
  return next;
}
export async function clearCart(tenantId: string, orgId: string, userId: string): Promise<void> {
  await carts.delete(cartId(tenantId, orgId, userId));
}
/**
 * EM-4b (review HIGH-2) — GDPR data-subject erasure for `commerce:cart`.
 *
 * `clearCart` above is the OPERATIONAL clear (checkout emptied the basket); it is
 * scoped to one org and is not an erasure path. Before this existed the store had
 * no eraser, no purger and no `registerKvAgeOut`, and — worse — the ADR 0464
 * coverage gate resolves `hasEraser` at FEATURE-DIRECTORY level, so once the
 * de-anchored signal regexes could finally SEE `interface Cart { … userId … }`
 * the gate began reporting the store COVERED because `features/commerce`
 * registers *an* eraser. A false clean bill is worse than the invisibility it
 * replaced, so the cure is the eraser rather than a ledger entry.
 *
 * DELETE, not anonymize: a cart is a transient pre-purchase basket. The
 * legally-retained financial record is the ORDER, which `eraseCommerce`
 * anonymizes-but-keeps — deleting a cart destroys no business record.
 *
 * The subject key here is a USER id (carts are keyed `${tenantId}:${orgId}:${userId}`),
 * which is the space `features/users` DSAR lane supplies. A contactId-shaped key
 * matches nothing — the seam's documented harmless no-op — and correctly so: a CRM
 * contact who was never a user cannot have a cart. Bounded by the tenant index,
 * and idempotent (a second run finds no rows).
 */
export async function deleteCartsForUser(tenantId: string, userId: string): Promise<number> {
  if (!tenantId || !userId) return 0;
  let n = 0;
  for (const row of await carts.listForTenantIndexed(tenantId)) {
    if (row.userId === userId) { await carts.delete(row.cartId); n += 1; }
  }
  return n;
}
/** Check out the cart into an order (composes createOrder), then clear the cart. */
export async function checkoutCart(tenantId: string, orgId: string, userId: string, opts: { contactId?: string; couponCode?: string; requireApprovalOverThreshold?: boolean; idempotencyKey?: string } = {}): Promise<Order> {
  const cart = await getCart(tenantId, orgId, userId);
  if (cart.lines.length === 0) throw new OpenwopError('validation_error', 'The cart is empty.', 400, {});
  const order = await createOrder({
    tenantId, orgId, createdBy: userId,
    ...(opts.contactId ? { contactId: opts.contactId } : {}),
    ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
    ...(opts.requireApprovalOverThreshold ? { requireApprovalOverThreshold: true } : {}),
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    lines: cart.lines,
  });
  await clearCart(tenantId, orgId, userId);
  return order;
}

/** C9 — the ONE commerce report read (a single fetch for the hub tab; never an
 *  N+1 fan-out — the rate-limit gotcha). GMV counts paid+fulfilled+refunded-net. */
/** DEF-6 (ADR 0239) — money figures for ONE currency. An order is single-currency
 *  (createOrder rejects a mixed cart), but an org may sell in several, so every money
 *  aggregate is bucketed per currency. */
export interface CurrencyFigures {
  currency: string;
  gmv: number; netRevenue: number; aov: number;
  paidOrders: number;
  couponUsage: { code: string; orders: number; discount: number }[];
  /** ADR 0239 follow-on — top products for THIS currency (revenue-desc). Revenue is
   *  single-currency here, so it can be shown with a currency symbol honestly (the flat
   *  `CommerceSummary.topProducts` mirrors the primary currency's list). */
  topProducts: { productId: string; name: string; revenue: number; units: number }[];
}
export interface CommerceSummary {
  /** Headline figures for the PRIMARY currency (highest GMV) — kept flat for the
   *  existing single-currency callers/cards. `currency` names which one. */
  gmv: number; netRevenue: number; currency: string; aov: number;
  /** DEF-6 — one entry per currency the org has sold in (GMV-desc). Length 1 for a
   *  single-currency store; the flat headline mirrors `byCurrency[0]`. */
  byCurrency: CurrencyFigures[];
  orderCounts: Record<OrderStatus, number>;
  topProducts: { productId: string; name: string; revenue: number; units: number }[];
  couponUsage: { code: string; orders: number; discount: number }[];
  lowStock: { productId: string; name: string; inventory: number; lowStockThreshold: number }[];
}
export async function commerceSummary(tenantId: string, orgId: string): Promise<CommerceSummary> {
  const [allOrders, allProducts] = await Promise.all([listOrders(tenantId, orgId), listProducts(tenantId, orgId)]);
  // Initialize EVERY status (a transient 'refunding' or a persisted 'partially_refunded'
  // must not land as NaN via `undefined + 1`).
  const orderCounts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
  // DEF-6 — accumulate money PER currency (an org can sell in several; summing across
  // them is meaningless). ADR 0239 follow-on: top-product REVENUE is also per-currency
  // (was a single global sum shown under one symbol — misleading in a multi-currency store).
  interface Acc { gmv: number; refunded: number; revenueOrders: number; coupons: Map<string, { orders: number; discount: number }>; products: Map<string, { name: string; revenue: number; units: number }> }
  const byCcy = new Map<string, Acc>();
  const accFor = (ccy: string): Acc => {
    let a = byCcy.get(ccy);
    if (!a) { a = { gmv: 0, refunded: 0, revenueOrders: 0, coupons: new Map(), products: new Map() }; byCcy.set(ccy, a); }
    return a;
  };
  for (const o of allOrders) {
    orderCounts[o.status] += 1;
    const acc = accFor(o.currency);
    // A partially_refunded order was a real sale (still counts toward GMV); its refunded
    // slice is netted below.
    if (o.status === 'paid' || o.status === 'fulfilled' || o.status === 'partially_refunded') {
      acc.gmv += o.total; acc.revenueOrders += 1;
      for (const i of o.items) {
        const row = acc.products.get(i.productId) ?? { name: i.name, revenue: 0, units: 0 };
        row.revenue += i.unitPrice * i.quantity; row.units += i.quantity;
        acc.products.set(i.productId, row);
      }
      if (o.couponCode) {
        const c = acc.coupons.get(o.couponCode) ?? { orders: 0, discount: 0 };
        c.orders += 1; c.discount += o.discount;
        acc.coupons.set(o.couponCode, c);
      }
    }
    // DEF-7 — net out refunds. A full refund reverses the whole charge; a partial refund
    // reverses only its cumulative slice.
    if (o.status === 'refunded') acc.refunded += o.refundedAmount ?? o.total;
    else if (o.status === 'partially_refunded') acc.refunded += o.refundedAmount ?? 0;
  }
  const byCurrency: CurrencyFigures[] = [...byCcy.entries()]
    .map(([currency, a]) => ({
      currency,
      // R2 CM-P2-I3 — quantize in the BUCKET's own currency (each bucket is single-
      // currency by construction), not at a fixed two decimals.
      gmv: quantizeMoney(a.gmv, currency), netRevenue: quantizeMoney(a.gmv - a.refunded, currency),
      aov: a.revenueOrders > 0 ? quantizeMoney(a.gmv / a.revenueOrders, currency) : 0,
      paidOrders: a.revenueOrders,
      couponUsage: [...a.coupons.entries()].map(([code, c]) => ({ code, orders: c.orders, discount: quantizeMoney(c.discount, currency) })).sort((x, y) => y.orders - x.orders).slice(0, 10),
      topProducts: [...a.products.entries()].map(([productId, r]) => ({ productId, name: r.name, revenue: quantizeMoney(r.revenue, currency), units: r.units })).sort((x, y) => y.revenue - x.revenue).slice(0, 10),
    }))
    .sort((x, y) => y.gmv - x.gmv || x.currency.localeCompare(y.currency)); // deterministic on a GMV tie
  // The flat headline mirrors the primary (highest-GMV) currency — a stable single value
  // for the existing cards; empty-store default keeps the historical 'USD'/zeros.
  const primary = byCurrency[0] ?? { currency: 'USD', gmv: 0, netRevenue: 0, aov: 0, paidOrders: 0, couponUsage: [], topProducts: [] };
  return {
    gmv: primary.gmv, netRevenue: primary.netRevenue, currency: primary.currency, aov: primary.aov,
    byCurrency,
    orderCounts,
    topProducts: primary.topProducts,
    couponUsage: primary.couponUsage,
    lowStock: allProducts
      .filter((p) => p.type === 'physical' && p.inventory !== undefined && p.lowStockThreshold !== undefined && p.inventory < p.lowStockThreshold)
      .map((p) => ({ productId: p.productId, name: p.name, inventory: p.inventory!, lowStockThreshold: p.lowStockThreshold! })),
  };
}

export async function __resetCommerce(): Promise<void> {
  await products.__clear();
  await orders.__clear();
  await coupons.__clear();
  await carts.__clear();
  await reservationDue.__clear();
  await refundLedger.__clear();
  await __clearProductFieldDefs();
  await __resetAffiliates();
}

// ── ADR 0296 P2 — saved payment methods (consent-to-save for one-click) ──────
// Stripe holds the instrument; this row holds ONLY the references + the consent
// timestamp. Keyed per (tenant, org, contact); a contact deletion prunes it via
// the crmRecordLifecycle seam (registered in feature.ts).
export interface SavedPaymentMethod {
  id: string; // `${tenantId}:${orgId}:${contactId}`
  tenantId: string; orgId: string; contactId: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  consentAt: string;
}
const savedPms = new DurableCollection<SavedPaymentMethod>('commerce:saved-pm', (r) => r.id, undefined, (r) => r.tenantId);

export async function getSavedPaymentMethod(tenantId: string, orgId: string, contactId: string): Promise<SavedPaymentMethod | null> {
  const row = await savedPms.get(`${tenantId}:${orgId}:${contactId}`);
  return row && row.tenantId === tenantId ? row : null;
}

export async function deleteSavedPaymentMethodsForContact(tenantId: string, contactId: string): Promise<number> {
  let n = 0;
  for (const row of await savedPms.listForTenantIndexed(tenantId)) {
    if (row.contactId === contactId) { await savedPms.delete(row.id); n += 1; }
  }
  return n;
}

/**
 * PRIV-1 (GDPR erasure) — ANONYMIZE the shipping snapshot on a subject's orders while
 * KEEPING the order + its financial totals + id + coarse region/country. An order is a
 * legally-retained financial record (tax law overrides erasure, Art. 17(3)(b)); the
 * reconciliation is to strip the personal identity, not delete the record. Clears the
 * directly-identifying fields (name, street, city, postalCode — a full postcode is
 * treated as identifying); keeps region/country (coarse geography for tax/reporting).
 * Idempotent (a re-run finds the fields already cleared). Best-effort, tenant-scoped.
 */
const REDACTED_ADDRESS = '[redacted]'; // `line1` is required on the type, so it also marks an already-anonymized address (idempotency guard).
/** R3 I1 (retention half) — GUEST shipping snapshots have NO subject key: a
 *  contactId-less order (ensureContact failed / anonymous checkout) can never
 *  be reached by `eraseSubject`, so its name+street PII would live forever.
 *  Retention is the backstop the DSAR lane structurally cannot be: past the
 *  window, the snapshot anonymizes REGARDLESS of linkage (same shape as the
 *  contact anonymizer — coarse region/country kept for tax/reporting, direct
 *  identifiers stripped, idempotent via the redaction marker). Contact-LINKED
 *  orders are deliberately excluded: their PII is DSAR-reachable and follows
 *  the contact's lifecycle, not a clock. Bounded per pass. */
export const GUEST_SHIPPING_RETENTION_DAYS = (() => {
  const raw = Number(process.env.OPENWOP_COMMERCE_GUEST_SHIPPING_RETENTION_DAYS);
  return Number.isFinite(raw) && raw >= 30 ? raw : 540; // ~18 months default
})();

export async function purgeStaleGuestShipping(now = Date.now(), maxPerPass = 200): Promise<number> {
  const cutoff = now - GUEST_SHIPPING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const o of await orders.list()) {
    if (purged >= maxPerPass) break;
    if (o.contactId || !o.shippingAddress) continue;             // guest-only
    if (o.shippingAddress.line1 === REDACTED_ADDRESS) continue;  // idempotent
    if (Date.parse(o.updatedAt ?? o.createdAt) > cutoff) continue; // inside the window
    const sAddr = o.shippingAddress;
    const anonymized: NonNullable<Order['shippingAddress']> = {
      line1: REDACTED_ADDRESS,
      ...(sAddr.region !== undefined ? { region: sAddr.region } : {}),
      ...(sAddr.country !== undefined ? { country: sAddr.country } : {}),
    };
    await orders.put({ ...o, shippingAddress: anonymized, updatedAt: nowIso() });
    purged += 1;
  }
  return purged;
}

export async function anonymizeOrderShippingForContacts(tenantId: string, contactIds: ReadonlySet<string>): Promise<number> {
  if (!tenantId || contactIds.size === 0) return 0;
  let n = 0;
  for (const o of await orders.listForTenantIndexed(tenantId)) {
    if (!o.contactId || !contactIds.has(o.contactId) || !o.shippingAddress) continue;
    const s = o.shippingAddress;
    if (s.line1 === REDACTED_ADDRESS) continue; // already anonymized
    // Keep coarse geography (region/country) for tax/reporting; strip the direct
    // identifiers (name/street/city/postalCode). line1 is required → redaction marker.
    const anonymized: NonNullable<Order['shippingAddress']> = {
      line1: REDACTED_ADDRESS,
      ...(s.region !== undefined ? { region: s.region } : {}),
      ...(s.country !== undefined ? { country: s.country } : {}),
    };
    await orders.put({ ...o, shippingAddress: anonymized, updatedAt: nowIso() });
    n += 1;
  }
  return n;
}

/** Webhook-side capture: when a paid order requested pm-save and the intent
 *  carries the customer + payment_method ids, persist the reference row.
 *  Idempotent (fixed key); never throws (payment success must not depend on it). */
export async function captureSavedPmFromPaidIntent(order: Order, intent: { customer?: unknown; payment_method?: unknown }): Promise<boolean> {
  try {
    if (!order.pmSaveRequested || !order.contactId) return false;
    const customer = typeof intent.customer === 'string' ? intent.customer : '';
    const pm = typeof intent.payment_method === 'string' ? intent.payment_method : '';
    if (!customer || !pm) return false;
    await savedPms.put({
      id: `${order.tenantId}:${order.orgId}:${order.contactId}`,
      tenantId: order.tenantId, orgId: order.orgId, contactId: order.contactId,
      stripeCustomerId: customer, paymentMethodId: pm, consentAt: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/** GC-OC-2 (ADR 0296 review) — an SCA-challenged one-click child stays PENDING
 *  while the shopper confirms on-session; without this, the reservation-expiry
 *  sweep could cancel it mid-challenge and the late payment would land on a
 *  canceled order (the operator-refund path). Extends the child's reservation
 *  deadline to at least now + the SCA window (never shortens). */
export async function extendReservationForSca(tenantId: string, orgId: string, orderId: string): Promise<string | null> {
  const order = await orders.get(orderId);
  if (!order || order.tenantId !== tenantId || order.orgId !== orgId || order.status !== 'pending' || !order.reservationExpiresAt) return null;
  const windowMs = (() => {
    const raw = Number(process.env.OPENWOP_COMMERCE_SCA_RESERVATION_MS);
    return Number.isFinite(raw) && raw >= 60_000 ? raw : 2 * 60 * 60 * 1000; // default 2h
  })();
  const target = new Date(Date.now() + windowMs).toISOString();
  if (order.reservationExpiresAt >= target) return order.reservationExpiresAt;
  const next = { ...order, reservationExpiresAt: target, updatedAt: new Date().toISOString() };
  await orders.put(next);
  try { await reservationDue.put({ orderId, tenantId, orgId, dueAt: target }); } catch { /* sweep falls back to the order row */ }
  return target;
}

/** ADR 0296 P3 — one-click children of a parent order (the chain-depth guard +
 *  the per-product duplicate guard read). */
export async function listChildOrders(tenantId: string, orgId: string, parentOrderId: string): Promise<Order[]> {
  return (await listOrders(tenantId, orgId)).filter((o) => o.parentOrderId === parentOrderId);
}

