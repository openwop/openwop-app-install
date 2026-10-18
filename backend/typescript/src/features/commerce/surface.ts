/**
 * Commerce workflow surface (ADR 0177 Phase 2) — `ctx.features.commerce`. Thin adapter
 * over `commerceService` (the source of truth shared with REST). Tenant from the run
 * scope (CTI-1); `orgId` node-supplied + service-enforced. Reads (products/orders/coupons)
 * + governed writes (create-order, refund, fulfillment, inventory, coupons — gap plan
 * §5B B5) for the store-assistant agent + order-ops workflows. Agent-path money
 * mutations ride the B3 threshold gates inside the service.
 *
 * @see docs/adr/0177-e-commerce.md
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface, type FeatureSurfaceOrgPolicy } from '../../host/featureSurfaces.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import {
  listProducts, getProduct, updateProduct, listOrders, getOrder, createOrder,
  refundOrder, updateFulfillment, listCoupons, createCoupon,
  FULFILLMENT_STATUSES, type FulfillmentStatus, liveStripeKeyFor,
} from './commerceService.js';
import { OpenwopError } from '../../types.js';
import { getContact } from '../crm/contactsService.js';
import { resolvePrice } from './pricing.js';
import { createQuote, getQuote, listQuotes, sendQuote, type QuoteLineInput } from './quotes.js';
import { discoverMerchant, searchMerchantCatalog, buildPurchaseDraft, checkoutPurchase, trackPurchase, listPurchases } from './ucpBuyer/ucpBuyerService.js';

/**
 * ADR 0875 D5 — the closed-world method partition. Every write asks the scope its
 * HTTP door asks (`workspace:write`), so a run acting for a Viewer cannot refund,
 * restock, mint a coupon or send a quote that the Viewer's own HTTP call is refused.
 * `adr0875-commerce-trust-lanes.test.ts` fails if a method is added unclassified.
 */
export const COMMERCE_SURFACE_READS = [
  'listProducts', 'getProduct', 'listOrders', 'getOrder', 'getQuote', 'listQuotes', 'resolvePrice',
  'ucpDiscover', 'ucpSearchCatalog', 'ucpTrack', 'ucpListPurchases', 'listCoupons',
] as const;
export const COMMERCE_SURFACE_ORG_WRITERS = [
  'createOrder', 'refundOrder', 'updateFulfillment', 'adjustInventory', 'createQuote', 'sendQuote',
  'ucpBuildCart', 'ucpCheckout', 'createCoupon',
] as const;
export const COMMERCE_SURFACE_POLICY: FeatureSurfaceOrgPolicy = {
  methodScopes: Object.fromEntries(COMMERCE_SURFACE_ORG_WRITERS.map((m) => [m, 'workspace:write' as const])),
};

/** A write names its org, or the ADR 0832 floor (which skips an absent org) never runs. */
function writeOrg(raw: unknown): string {
  const orgId = str(raw);
  if (!orgId) throw new OpenwopError('validation_error', 'A commerce write needs an `orgId`.', 400, { field: 'orgId' });
  return orgId;
}

/** ADR 0875 D5 — the `ucp*` verbs are the UCP BUYER feature: the seam only checks
 *  the `commerce` toggle, so they ask `commerce-ucp-buyer` here, the same
 *  predicate the HTTP routes and chat tools use. */
async function assertBuyerEnabled(scope: BundleScope): Promise<void> {
  const a = await resolveOne('commerce-ucp-buyer', { tenantId: scope.tenantId, ...(scope.actingUserId ? { userId: scope.actingUserId } : {}) });
  if (!a || !a.enabled) {
    throw Object.assign(new Error("feature 'commerce-ucp-buyer' is not enabled for this tenant"), { code: 'host_capability_disabled', capability: 'host.sample.commerce-ucp-buyer' });
  }
}

const INTERNAL = new Set(['tenantId', 'createdBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
function found<T extends object>(row: T | null, what: string, field: string, id: unknown): T {
  if (!row) throw new OpenwopError('not_found', `${what} not found.`, 404, { [field]: str(id) });
  return row;
}

export function buildCommerceSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listProducts: async (args) => ({ products: (await listProducts(tenantId, str(args.orgId), optStr(args.q))).map(project) }),
    // ADR 0875 D11 — a missing row is a typed failure, never `success` with null (a chain
    // fed an empty id used to carry on and hand the model nothing to ground on).
    getProduct: async (args) => ({ product: project(found(await getProduct(tenantId, str(args.orgId), str(args.productId)), 'Product', 'productId', args.productId)) }),
    listOrders: async (args) => ({ orders: (await listOrders(tenantId, str(args.orgId))).map(project) }),
    getOrder: async (args) => ({ order: project(found(await getOrder(tenantId, str(args.orgId), str(args.orderId)), 'Order', 'orderId', args.orderId)) }),
    // WRITE (role:action node) — create an order from lines; recorded output ⇒ replay-safe.
    // AGENT path ⇒ requireApprovalOverThreshold (gap plan §5B B3): an at/over-threshold
    // order parks a commerce-spend approval (approval_required, 409) instead of creating.
    createOrder: async (args) => {
      const lines = Array.isArray(args.lines) ? (args.lines as { productId?: unknown; quantity?: unknown }[]).map((l) => ({ productId: String(l?.productId ?? ''), quantity: Number(l?.quantity ?? 0) })) : [];
      // ADR 0875 (grade-code COM2CD-5) — the contact must be this tenant's: this lane (and
      // the MCP place-order projection that runs it) passes a model-supplied id. The HTTP
      // routes make the same check; the service stays trusting for internal callers.
      const cid = optStr(args.contactId);
      if (cid) {
        const contact = await getContact(cid);
        if (!contact || contact.tenantId !== tenantId) throw new OpenwopError('validation_error', 'contactId does not reference a contact in this tenant.', 400, { field: 'contactId' });
      }
      // ADR 0875 D11 — `couponCode` is a declared node input; it was dropped here.
      const order = await createOrder({ tenantId, orgId: writeOrg(args.orgId), createdBy: 'agent', ...(optStr(args.contactId) ? { contactId: str(args.contactId) } : {}), ...(optStr(args.couponCode) ? { couponCode: str(args.couponCode) } : {}), lines, requireApprovalOverThreshold: true });
      return { order: project(order) };
    },
    // ── Order-ops verbs (gap plan §5B B5) — every write goes through the service, so
    // audit rows + host events + the B3 threshold gates apply by construction. ──
    refundOrder: async (args) => {
      // R2 CM-P2-B3 — resolve the tenant's Stripe key exactly as the operator route
      // does. This lane used to omit it, so an agent/workflow refund flipped the order
      // to `refunded`, restored inventory and clawed back commission while the card was
      // never touched — and no screen could tell the two apart. (The ref is host-global
      // and scopeless, so it resolves the same inside a run; a tenant with no key still
      // gets the honest `refundProvider:'none'` the order now carries.)
      const stripeKey = await liveStripeKeyFor(tenantId).catch(() => null); // ADR 0875 — the ONE live-key resolver (null for anon:)
      const order = await refundOrder(tenantId, writeOrg(args.orgId), str(args.orderId), { actor: 'agent', stripeKey });
      if (!order) throw new OpenwopError('not_found', 'Order not found.', 404, { orderId: str(args.orderId) });
      return { order: project(order) };
    },
    updateFulfillment: async (args) => {
      const fs = str(args.fulfillmentStatus);
      if (!(FULFILLMENT_STATUSES as readonly string[]).includes(fs)) {
        throw new OpenwopError('validation_error', `fulfillmentStatus must be one of: ${FULFILLMENT_STATUSES.join(', ')}`, 400, { field: 'fulfillmentStatus' });
      }
      const order = await updateFulfillment(tenantId, writeOrg(args.orgId), str(args.orderId), fs as FulfillmentStatus, { actor: 'agent' });
      if (!order) throw new OpenwopError('not_found', 'Order not found.', 404, { orderId: str(args.orderId) });
      return { order: project(order) };
    },
    adjustInventory: async (args) => {
      const inventory = typeof args.inventory === 'number' && Number.isFinite(args.inventory) && args.inventory >= 0 ? args.inventory : undefined;
      if (inventory === undefined) throw new OpenwopError('validation_error', '`inventory` must be a non-negative number.', 400, { field: 'inventory' });
      const product = await updateProduct(tenantId, writeOrg(args.orgId), str(args.productId), { inventory }, { actor: 'agent' });
      if (!product) throw new OpenwopError('not_found', 'Product not found.', 404, { productId: str(args.productId) });
      return { product: project(product) };
    },
    // ── Quotes (gap plan §5C C3) — the copilot's "draft a quote" verbs. Send rides
    // the B3 threshold gate inside the service; accept stays human/route-side. ──
    createQuote: async (args) => {
      const lines: QuoteLineInput[] = Array.isArray(args.lines) ? (args.lines as { productId?: unknown; quantity?: unknown; unitPrice?: unknown }[]).map((l) => ({ productId: String(l?.productId ?? ''), quantity: Number(l?.quantity ?? 0), ...(typeof l?.unitPrice === 'number' ? { unitPrice: l.unitPrice } : {}) })) : [];
      const quote = await createQuote({ tenantId, orgId: writeOrg(args.orgId), createdBy: 'agent', lines, ...(optStr(args.contactId) ? { contactId: str(args.contactId) } : {}), ...(optStr(args.companyId) ? { companyId: str(args.companyId) } : {}), note: args.note });
      return { quote: project(quote) };
    },
    getQuote: async (args) => ({ quote: project(found(await getQuote(tenantId, str(args.orgId), str(args.quoteId)), 'Quote', 'quoteId', args.quoteId)) }),
    listQuotes: async (args) => ({ quotes: (await listQuotes(tenantId, str(args.orgId))).map(project) }),
    sendQuote: async (args) => {
      const quote = await sendQuote(tenantId, writeOrg(args.orgId), str(args.quoteId), { actor: 'agent' });
      if (!quote) throw new OpenwopError('not_found', 'Quote not found.', 404, { quoteId: str(args.quoteId) });
      return { quote: project(quote) };
    },
    // C4 — the explainable price answer ("why this price").
    resolvePrice: async (args) => {
      const product = await getProduct(tenantId, str(args.orgId), str(args.productId));
      if (!product) throw new OpenwopError('not_found', 'Product not found.', 404, { productId: str(args.productId) });
      const resolved = await resolvePrice(tenantId, str(args.orgId), product, {
        ...(optStr(args.variantId) ? { variantId: str(args.variantId) } : {}),
        buyer: { ...(optStr(args.contactId) ? { contactId: str(args.contactId) } : {}), ...(optStr(args.companyId) ? { companyId: str(args.companyId) } : {}) },
      });
      return { ...resolved };
    },
    // ── UCP buyer verbs (ADR 0188 Phase 4) — outbound agent shopping. Checkout is
    // the app's highest-risk verb: the service enforces the org cap + the ALWAYS
    // human sign-off; the node metadata additionally declares chat-path approval. ──
    // ADR 0258 — the agent path has NO acting user, so an MCP `merchantServerId` resolves a
    // WORKSPACE-scoped merchant connection (an org/user connection needs human attribution).
    ucpDiscover: async (args) => { await assertBuyerEnabled(scope); return { discovery: await discoverMerchant(tenantId, { merchantUrl: args.merchantUrl, merchantServerId: args.merchantServerId }, { orgId: str(args.orgId) }) }; },
    ucpSearchCatalog: async (args) => { await assertBuyerEnabled(scope); return { catalog: await searchMerchantCatalog(tenantId, { merchantUrl: args.merchantUrl, merchantServerId: args.merchantServerId, q: optStr(args.q) }, { orgId: str(args.orgId) }) }; },
    ucpBuildCart: async (args) => {
      const orgId = writeOrg(args.orgId);
      await assertBuyerEnabled(scope);
      return {
      purchase: project(await buildPurchaseDraft({
        tenantId, orgId, createdBy: 'agent',
        merchantUrl: args.merchantUrl, merchantServerId: args.merchantServerId, intent: args.intent, maxAmountMinor: typeof args.maxAmountMinor === 'number' ? args.maxAmountMinor : Number(args.maxAmountMinor),
        currency: args.currency,
        lines: Array.isArray(args.lines) ? (args.lines as Record<string, unknown>[]) : [],
      })),
      };
    },
    ucpCheckout: async (args) => { const orgId = writeOrg(args.orgId); await assertBuyerEnabled(scope); return { purchase: project(await checkoutPurchase(tenantId, orgId, str(args.purchaseId), { actor: 'agent' })) }; },
    ucpTrack: async (args) => { await assertBuyerEnabled(scope); return { purchase: project(await trackPurchase(tenantId, str(args.orgId), str(args.purchaseId))) }; },
    ucpListPurchases: async (args) => { await assertBuyerEnabled(scope); return { purchases: (await listPurchases(tenantId, str(args.orgId))).map(project) }; },
    listCoupons: async (args) => ({ coupons: (await listCoupons(tenantId, str(args.orgId))).map(project) }),
    createCoupon: async (args) => ({
      coupon: project(await createCoupon({ tenantId, orgId: writeOrg(args.orgId), code: args.code, type: args.type, value: args.value, ...(args.currency !== undefined ? { currency: args.currency } : {}), actor: 'agent' })),
    }),
  };
}
