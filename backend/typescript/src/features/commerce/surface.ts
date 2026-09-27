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
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import {
  listProducts, getProduct, updateProduct, listOrders, getOrder, createOrder,
  refundOrder, updateFulfillment, listCoupons, createCoupon,
  FULFILLMENT_STATUSES, type FulfillmentStatus,
} from './commerceService.js';
import { OpenwopError } from '../../types.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { STRIPE_KEY_REF } from '../billing/billingService.js';
import { resolvePrice } from './pricing.js';
import { createQuote, getQuote, listQuotes, sendQuote, type QuoteLineInput } from './quotes.js';
import { discoverMerchant, searchMerchantCatalog, buildPurchaseDraft, checkoutPurchase, trackPurchase, listPurchases } from './ucpBuyer/ucpBuyerService.js';

const INTERNAL = new Set(['tenantId', 'createdBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const projectOne = (o: object | null): Record<string, unknown> | null => (o ? project(o) : null);

export function buildCommerceSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listProducts: async (args) => ({ products: (await listProducts(tenantId, str(args.orgId), optStr(args.q))).map(project) }),
    getProduct: async (args) => ({ product: projectOne(await getProduct(tenantId, str(args.orgId), str(args.productId))) }),
    listOrders: async (args) => ({ orders: (await listOrders(tenantId, str(args.orgId))).map(project) }),
    getOrder: async (args) => ({ order: projectOne(await getOrder(tenantId, str(args.orgId), str(args.orderId))) }),
    // WRITE (role:action node) — create an order from lines; recorded output ⇒ replay-safe.
    // AGENT path ⇒ requireApprovalOverThreshold (gap plan §5B B3): an at/over-threshold
    // order parks a commerce-spend approval (approval_required, 409) instead of creating.
    createOrder: async (args) => {
      const lines = Array.isArray(args.lines) ? (args.lines as { productId?: unknown; quantity?: unknown }[]).map((l) => ({ productId: String(l?.productId ?? ''), quantity: Number(l?.quantity ?? 0) })) : [];
      const order = await createOrder({ tenantId, orgId: str(args.orgId), createdBy: 'agent', ...(optStr(args.contactId) ? { contactId: str(args.contactId) } : {}), lines, requireApprovalOverThreshold: true });
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
      const stripeKey = await resolveSecret(STRIPE_KEY_REF).catch(() => null);
      const order = await refundOrder(tenantId, str(args.orgId), str(args.orderId), { actor: 'agent', stripeKey });
      if (!order) throw new OpenwopError('not_found', 'Order not found.', 404, { orderId: str(args.orderId) });
      return { order: project(order) };
    },
    updateFulfillment: async (args) => {
      const fs = str(args.fulfillmentStatus);
      if (!(FULFILLMENT_STATUSES as readonly string[]).includes(fs)) {
        throw new OpenwopError('validation_error', `fulfillmentStatus must be one of: ${FULFILLMENT_STATUSES.join(', ')}`, 400, { field: 'fulfillmentStatus' });
      }
      const order = await updateFulfillment(tenantId, str(args.orgId), str(args.orderId), fs as FulfillmentStatus, { actor: 'agent' });
      if (!order) throw new OpenwopError('not_found', 'Order not found.', 404, { orderId: str(args.orderId) });
      return { order: project(order) };
    },
    adjustInventory: async (args) => {
      const inventory = typeof args.inventory === 'number' && Number.isFinite(args.inventory) && args.inventory >= 0 ? args.inventory : undefined;
      if (inventory === undefined) throw new OpenwopError('validation_error', '`inventory` must be a non-negative number.', 400, { field: 'inventory' });
      const product = await updateProduct(tenantId, str(args.orgId), str(args.productId), { inventory }, { actor: 'agent' });
      if (!product) throw new OpenwopError('not_found', 'Product not found.', 404, { productId: str(args.productId) });
      return { product: project(product) };
    },
    // ── Quotes (gap plan §5C C3) — the copilot's "draft a quote" verbs. Send rides
    // the B3 threshold gate inside the service; accept stays human/route-side. ──
    createQuote: async (args) => {
      const lines: QuoteLineInput[] = Array.isArray(args.lines) ? (args.lines as { productId?: unknown; quantity?: unknown; unitPrice?: unknown }[]).map((l) => ({ productId: String(l?.productId ?? ''), quantity: Number(l?.quantity ?? 0), ...(typeof l?.unitPrice === 'number' ? { unitPrice: l.unitPrice } : {}) })) : [];
      const quote = await createQuote({ tenantId, orgId: str(args.orgId), createdBy: 'agent', lines, ...(optStr(args.contactId) ? { contactId: str(args.contactId) } : {}), ...(optStr(args.companyId) ? { companyId: str(args.companyId) } : {}), note: args.note });
      return { quote: project(quote) };
    },
    getQuote: async (args) => ({ quote: projectOne(await getQuote(tenantId, str(args.orgId), str(args.quoteId))) }),
    listQuotes: async (args) => ({ quotes: (await listQuotes(tenantId, str(args.orgId))).map(project) }),
    sendQuote: async (args) => {
      const quote = await sendQuote(tenantId, str(args.orgId), str(args.quoteId), { actor: 'agent' });
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
    ucpDiscover: async (args) => ({ discovery: await discoverMerchant(tenantId, { merchantUrl: args.merchantUrl, merchantServerId: args.merchantServerId }, { orgId: str(args.orgId) }) }),
    ucpSearchCatalog: async (args) => ({ catalog: await searchMerchantCatalog(tenantId, { merchantUrl: args.merchantUrl, merchantServerId: args.merchantServerId, q: optStr(args.q) }, { orgId: str(args.orgId) }) }),
    ucpBuildCart: async (args) => ({
      purchase: project(await buildPurchaseDraft({
        tenantId, orgId: str(args.orgId), createdBy: 'agent',
        merchantUrl: args.merchantUrl, merchantServerId: args.merchantServerId, intent: args.intent, maxAmountMinor: typeof args.maxAmountMinor === 'number' ? args.maxAmountMinor : Number(args.maxAmountMinor),
        currency: args.currency,
        lines: Array.isArray(args.lines) ? (args.lines as Record<string, unknown>[]) : [],
      })),
    }),
    ucpCheckout: async (args) => ({ purchase: project(await checkoutPurchase(tenantId, str(args.orgId), str(args.purchaseId), { actor: 'agent' })) }),
    ucpTrack: async (args) => ({ purchase: project(await trackPurchase(tenantId, str(args.orgId), str(args.purchaseId))) }),
    ucpListPurchases: async (args) => ({ purchases: (await listPurchases(tenantId, str(args.orgId))).map(project) }),
    listCoupons: async (args) => ({ coupons: (await listCoupons(tenantId, str(args.orgId))).map(project) }),
    createCoupon: async (args) => ({
      coupon: project(await createCoupon({ tenantId, orgId: str(args.orgId), code: args.code, type: args.type, value: args.value, ...(args.currency !== undefined ? { currency: args.currency } : {}), actor: 'agent' })),
    }),
  };
}
