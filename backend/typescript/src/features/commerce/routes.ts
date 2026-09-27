/**
 * E-Commerce routes (ADR 0177 Phase 1) — product catalog + order lifecycle under
 * `/v1/host/openwop-app/commerce/orgs/:orgId`. Toggle `commerce` + `authorizeOrgScope`
 * (read = workspace:read, write = workspace:write); tenant+org IDOR-guarded. Customer =
 * a CRM `contactId` (validated same tenant). Payment: when the operator's Stripe
 * key is configured the supplied paymentIntentId is VERIFIED against Stripe
 * (LEAK-11); keyless keeps the honest demo posture. Public storefront = later phase.
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString, publicBaseUrl } from '../featureRoute.js';
import type { Scope } from '../../host/accessControlService.js';
import type { User } from '../users/usersService.js';
import { getContact, ensureContact } from '../crm/contactsService.js';
import { getOrg } from '../../host/accessControlService.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { verifyStripeSignature, STRIPE_KEY_REF } from '../billing/billingService.js';
import { createStripeOrderCheckoutSession, createStripeCustomer, createStripeOffSessionPaymentIntent, toStripeMinorUnits } from '../billing/stripeApi.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import { createLogger } from '../../observability/logger.js';
import {
  listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  listOrders, getOrder, createOrder, markAsPaid, refundOrder, cancelOrder, updateFulfillment,
  listCoupons, createCoupon, getCart, setCartItem, clearCart, checkoutCart,
  listStockMovements, commerceSummary, partialRefundOrder, listOrderRefunds, orderChargeTotal,
  ORDER_STATUSES, FULFILLMENT_STATUSES, type OrderStatus, type FulfillmentStatus, type Order,
  getSavedPaymentMethod, captureSavedPmFromPaidIntent, listChildOrders, extendReservationForSca,
} from './commerceService.js';
import { recordCommerceAction } from './telemetry.js';
import { listPriceLists, createPriceList, updatePriceList, deletePriceList, resolvePrice, resolveSellable } from './pricing.js';
import { listQuotes, getQuote, createQuote, reviseQuote, sendQuote, declineQuote, acceptQuote, listQuoteRevisions, projectQuotePublic, QUOTE_STATUSES, type QuoteStatus, type QuoteLineInput } from './quotes.js';
import { assertLiveLinkFor } from '../sharing/sharingService.js';
import { listAffiliates, createAffiliate, recordPayout, listPayouts, affiliateCodeExists, payoutExportRows } from './affiliate.js';
import { listProductFieldDefs, createProductFieldDef, deleteProductFieldDef } from './productFields.js';
import { subscribeToProduct, listProductSubscriptions, cancelSubscription, runSubscriptionCycle } from './subscriptions.js';
import { sendError } from '../../middleware/errorEnvelope.js';

const FEATURE = { toggleId: 'commerce', label: 'E-Commerce' };
/** ADR 0296 — one-click money movement is operator OPT-IN (default off). Read
 *  per-request so tests and incremental env updates take effect immediately. */
const offSessionEnabled = (): boolean => process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED === 'true';
const BASE = '/v1/host/openwop-app/commerce/orgs/:orgId';
const log = createLogger('commerce');
/** GEN-2d — the client order-idempotency key: the standard `Idempotency-Key` header,
 *  or a body `idempotencyKey` fallback. Bounded so a hostile client can't bloat the
 *  claim key. Absent → keyless (a fresh order per call, unchanged). */
function idempotencyKeyOf(req: { get(name: string): string | undefined }, body: unknown): string | undefined {
  const raw = req.get('idempotency-key') ?? (typeof (body as { idempotencyKey?: unknown })?.idempotencyKey === 'string' ? (body as { idempotencyKey: string }).idempotencyKey : undefined);
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? raw : undefined;
}
/** DEF-1 — the tax + shipping Stripe line items so the checkout charge equals
 *  `orderChargeTotal` (goods + tax + shipping). Empty when neither is set. */
function taxShippingSessionLines(o: Order): { name: string; amountMinor: number; currency: string; quantity: number }[] {
  const lines: { name: string; amountMinor: number; currency: string; quantity: number }[] = [];
  for (const t of o.taxLines ?? []) if (t.amount > 0) lines.push({ name: t.name, amountMinor: toStripeMinorUnits(t.amount, o.currency), currency: o.currency, quantity: 1 });
  if ((o.shippingCost ?? 0) > 0) lines.push({ name: 'Shipping', amountMinor: toStripeMinorUnits(o.shippingCost!, o.currency), currency: o.currency, quantity: 1 });
  return lines;
}
/** ADR 0257 — resolve a product's typed customFields to LABELLED pairs for the public
 *  storefront (shoppers see "Material", not the raw `material` key). Falls back to the key
 *  when a def was deleted. Booleans render Yes/No. */
function publicCustomFields(defs: { key: string; label: string }[], cf?: Record<string, string | number | boolean>): { label: string; value: string }[] {
  if (!cf) return [];
  const label = new Map(defs.map((d) => [d.key, d.label]));
  return Object.entries(cf).map(([k, v]) => ({ label: label.get(k) ?? k, value: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v) }));
}
interface Ctx { user: User; orgId: string; tenantId: string }
// The ONE opt-in plan-entitlement gate (ADR 0176 Phase 3) rides the shared authz helper,
// so it covers every org-scoped operator route and ONLY those: the public storefront
// (shoppers must never see a merchant's plan error) and the Stripe webhook (money-state
// truth beats plan gating) do not flow through here. No-op unless an operator narrows
// OPENWOP_BILLING_PLAN_FEATURES with the billing toggle on.
const authz = async (req: Request, scope: Scope): Promise<Ctx> => {
  const ctx = await authorizeOrgScope(req, FEATURE, scope);
  await checkEntitlement(req, 'commerce');
  return ctx;
};

export function registerCommerceRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── Products ──
  app.get(`${BASE}/products`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ products: await listProducts(ctx.tenantId, ctx.orgId, optionalString(req.query.q)) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/products`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const p = await createProduct({ tenantId: ctx.tenantId, orgId: ctx.orgId, createdBy: ctx.user.userId, type: b.type, name: requireString(b.name, 'name'), description: b.description, price: b.price, currency: b.currency, imageAssetTokens: b.imageAssetTokens, downloadAssetTokens: b.downloadAssetTokens, inventory: b.inventory, lowStockThreshold: b.lowStockThreshold, variants: b.variants, categories: b.categories, tags: b.tags, attributes: b.attributes, weightGrams: b.weightGrams, dims: b.dims, customFields: b.customFields, cost: b.cost, kind: b.kind, components: b.components, subscription: b.subscription });
      res.status(201).json(p);
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/products/:productId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); const p = await getProduct(ctx.tenantId, ctx.orgId, req.params.productId); if (!p) throw new OpenwopError('not_found', 'Product not found.', 404, { productId: req.params.productId }); res.json(p); } catch (err) { next(err); }
  });
  app.patch(`${BASE}/products/:productId`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateProduct>[3] = {};
      if (typeof b.name === 'string') patch.name = b.name;
      if ('description' in b) patch.description = b.description === null ? null : optionalString(b.description) ?? null;
      if (typeof b.price === 'number') patch.price = b.price;
      if (typeof b.currency === 'string') patch.currency = b.currency;
      if ('imageAssetTokens' in b) patch.imageAssetTokens = b.imageAssetTokens;
      if ('downloadAssetTokens' in b) patch.downloadAssetTokens = b.downloadAssetTokens;
      if ('inventory' in b) patch.inventory = b.inventory === null ? null : (typeof b.inventory === 'number' ? b.inventory : null);
      if ('lowStockThreshold' in b) patch.lowStockThreshold = b.lowStockThreshold === null ? null : (typeof b.lowStockThreshold === 'number' ? b.lowStockThreshold : null);
      if ('variants' in b) patch.variants = b.variants;
      if ('categories' in b) patch.categories = b.categories;
      if ('tags' in b) patch.tags = b.tags;
      if ('attributes' in b) patch.attributes = b.attributes;
      if ('weightGrams' in b) patch.weightGrams = b.weightGrams === null ? null : (typeof b.weightGrams === 'number' ? b.weightGrams : null);
      if ('dims' in b) patch.dims = b.dims;
      if ('customFields' in b) patch.customFields = b.customFields;
      if ('cost' in b) patch.cost = b.cost === null ? null : (typeof b.cost === 'number' ? b.cost : null);
      if ('kind' in b) patch.kind = b.kind;
      if ('components' in b) patch.components = b.components;
      if ('subscription' in b) patch.subscription = b.subscription;
      if (typeof b.active === 'boolean') patch.active = b.active;
      const p = await updateProduct(ctx.tenantId, ctx.orgId, req.params.productId, patch, { actor: ctx.user.userId });
      if (!p) throw new OpenwopError('not_found', 'Product not found.', 404, { productId: req.params.productId });
      res.json(p);
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/products/:productId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const ok = await deleteProduct(ctx.tenantId, ctx.orgId, req.params.productId, { actor: ctx.user.userId }); if (!ok) throw new OpenwopError('not_found', 'Product not found.', 404, { productId: req.params.productId }); res.status(204).end(); } catch (err) { next(err); }
  });

  // ── Typed product custom-field definitions (ADR 0257) ──
  app.get(`${BASE}/product-fields`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ fields: await listProductFieldDefs(ctx.tenantId, ctx.orgId) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/product-fields`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.status(201).json(await createProductFieldDef({ tenantId: ctx.tenantId, orgId: ctx.orgId, key: b.key, label: b.label, type: b.type, required: b.required, options: b.options }));
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/product-fields/:defId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const ok = await deleteProductFieldDef(ctx.tenantId, ctx.orgId, req.params.defId); if (!ok) throw new OpenwopError('not_found', 'Product field not found.', 404, { defId: req.params.defId }); res.status(204).end(); } catch (err) { next(err); }
  });

  // ── Orders ──
  app.get(`${BASE}/orders`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); const s = optionalString(req.query.status); res.json({ orders: await listOrders(ctx.tenantId, ctx.orgId, s && (ORDER_STATUSES as readonly string[]).includes(s) ? s as OrderStatus : undefined) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/orders`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as { contactId?: unknown; lines?: unknown; couponCode?: unknown };
      // Customer = a CRM Contact in the SAME tenant (IDOR-safe); optional.
      let contactId: string | undefined;
      const cid = optionalString(b.contactId);
      if (cid) { const c = await getContact(cid); if (!c || c.tenantId !== ctx.tenantId) throw new OpenwopError('validation_error', 'contactId does not reference a contact in this tenant.', 400, { field: 'contactId' }); contactId = cid; }
      const lines = Array.isArray(b.lines) ? b.lines.map((l) => ({ productId: String((l as { productId?: unknown })?.productId ?? ''), quantity: Number((l as { quantity?: unknown })?.quantity ?? 0) })) : [];
      const coupon = optionalString(b.couponCode);
      const affiliate = optionalString((b as { affiliateCode?: unknown }).affiliateCode);
      const shippingAddress = b && typeof (b as Record<string, unknown>).shippingAddress === 'object' && (b as Record<string, unknown>).shippingAddress !== null ? (b as { shippingAddress: Record<string, unknown> }).shippingAddress : undefined;
      const idempotencyKey = idempotencyKeyOf(req, b);
      const order = await createOrder({ tenantId: ctx.tenantId, orgId: ctx.orgId, createdBy: ctx.user.userId, ...(contactId ? { contactId } : {}), ...(coupon ? { couponCode: coupon } : {}), ...(affiliate ? { affiliateCode: affiliate } : {}), ...(shippingAddress ? { shippingAddress } : {}), ...(idempotencyKey ? { idempotencyKey } : {}), lines });
      res.status(201).json(order);
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/orders/:orderId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); const o = await getOrder(ctx.tenantId, ctx.orgId, req.params.orderId); if (!o) throw new OpenwopError('not_found', 'Order not found.', 404, { orderId: req.params.orderId }); res.json(o); } catch (err) { next(err); }
  });

  const orderAction = (suffix: string, fn: (ctx: Ctx, orderId: string, body: Record<string, unknown>) => Promise<import('./commerceService.js').Order | null>) => {
    app.post(`${BASE}/orders/:orderId/${suffix}`, async (req, res, next) => {
      try {
        const ctx = await authz(req, 'workspace:write');
        const o = await fn(ctx, req.params.orderId, (req.body ?? {}) as Record<string, unknown>);
        if (!o) throw new OpenwopError('not_found', 'Order not found.', 404, { orderId: req.params.orderId });
        res.json(o);
      } catch (err) { next(err); }
    });
  };
  // Payment — LEAK-11: when the operator's Stripe key is configured, the supplied
  // paymentIntentId is VERIFIED against Stripe (succeeded + exact amount/currency)
  // before pending→paid; keyless keeps the honest demo posture. The response's
  // `paymentVerification` field says which happened.
  app.post(`${BASE}/orders/:orderId/pay`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      const o = await markAsPaid(ctx.tenantId, ctx.orgId, req.params.orderId, requireString(b.paymentIntentId, 'paymentIntentId'), { stripeKey, actor: ctx.user.userId });
      if (!o) throw new OpenwopError('not_found', 'Order not found.', 404, { orderId: req.params.orderId });
      res.json({ ...o, paymentVerification: stripeKey ? 'stripe' : 'none' });
    } catch (err) { next(err); }
  });
  orderAction('refund', async (ctx, orderId) => refundOrder(ctx.tenantId, ctx.orgId, orderId, { actor: ctx.user.userId, stripeKey: await resolveSecret(STRIPE_KEY_REF) }));
  // DEF-7 (ADR 0238) — a PARTIAL refund (a price adjustment; repeat-safe via `refundKey`).
  app.post(`${BASE}/orders/:orderId/partial-refund`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new OpenwopError('validation_error', 'A partial refund `amount` (> 0) is required.', 400, { field: 'amount' });
      const refundKey = requireString(b.refundKey, 'refundKey');
      const o = await partialRefundOrder(ctx.tenantId, ctx.orgId, req.params.orderId, amount, { refundKey, actor: ctx.user.userId, stripeKey: await resolveSecret(STRIPE_KEY_REF) });
      if (!o) throw new OpenwopError('not_found', 'Order not found.', 404, { orderId: req.params.orderId });
      res.json(o);
    } catch (err) { next(err); }
  });
  // The partial-refund ledger for an order (a one-shot full refund records `refundedAmount`
  // + `refundId` on the order itself, not a ledger row — see refundOrder).
  app.get(`${BASE}/orders/:orderId/refunds`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ refunds: await listOrderRefunds(ctx.tenantId, ctx.orgId, req.params.orderId) }); } catch (err) { next(err); }
  });
  orderAction('cancel', (ctx, orderId) => cancelOrder(ctx.tenantId, ctx.orgId, orderId, { actor: ctx.user.userId }));
  orderAction('fulfillment', (ctx, orderId, b) => {
    const fs = requireString(b.fulfillmentStatus, 'fulfillmentStatus');
    if (!(FULFILLMENT_STATUSES as readonly string[]).includes(fs)) throw new OpenwopError('validation_error', `fulfillmentStatus must be one of: ${FULFILLMENT_STATUSES.join(', ')}`, 400, { field: 'fulfillmentStatus' });
    return updateFulfillment(ctx.tenantId, ctx.orgId, orderId, fs as FulfillmentStatus, { actor: ctx.user.userId });
  });

  // ── Price lists + explainable resolution (gap plan §5C C4) ──
  app.get(`${BASE}/price-lists`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ priceLists: await listPriceLists(ctx.tenantId, ctx.orgId) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/price-lists`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.status(201).json(await createPriceList({ tenantId: ctx.tenantId, orgId: ctx.orgId, createdBy: ctx.user.userId, name: b.name, currency: b.currency, entries: b.entries, contactIds: b.contactIds, companyIds: b.companyIds, priority: b.priority, exclusiveAssortment: b.exclusiveAssortment }));
    } catch (err) { next(err); }
  });
  app.patch(`${BASE}/price-lists/:priceListId`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const p = await updatePriceList(ctx.tenantId, ctx.orgId, req.params.priceListId, (req.body ?? {}) as Record<string, unknown>, { actor: ctx.user.userId });
      if (!p) throw new OpenwopError('not_found', 'Price list not found.', 404, { priceListId: req.params.priceListId });
      res.json(p);
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/price-lists/:priceListId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const ok = await deletePriceList(ctx.tenantId, ctx.orgId, req.params.priceListId, { actor: ctx.user.userId }); if (!ok) throw new OpenwopError('not_found', 'Price list not found.', 404, { priceListId: req.params.priceListId }); res.status(204).end(); } catch (err) { next(err); }
  });
  // "View as buyer" preview — the explainable answer for one product + buyer context.
  app.get(`${BASE}/price`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:read');
      const productId = requireString(req.query.productId, 'productId');
      const product = await getProduct(ctx.tenantId, ctx.orgId, productId);
      if (!product) throw new OpenwopError('not_found', 'Product not found.', 404, { productId });
      const buyer = {
        ...(optionalString(req.query.contactId) ? { contactId: optionalString(req.query.contactId)! } : {}),
        ...(optionalString(req.query.companyId) ? { companyId: optionalString(req.query.companyId)! } : {}),
      };
      const resolved = await resolvePrice(ctx.tenantId, ctx.orgId, product, {
        ...(optionalString(req.query.variantId) ? { variantId: optionalString(req.query.variantId)! } : {}),
        buyer,
      });
      // D3 — the preview answers sellability beside price ("view as account").
      const sellable = await resolveSellable(ctx.tenantId, ctx.orgId, product.productId, buyer);
      res.json({ ...resolved, sellable: sellable.sellable, sellableReason: sellable.reason });
    } catch (err) { next(err); }
  });

  // ── Stock movements (gap plan §5C C5) — the auditable inventory ledger ──
  app.get(`${BASE}/products/:productId/movements`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ movements: await listStockMovements(ctx.tenantId, ctx.orgId, req.params.productId) }); } catch (err) { next(err); }
  });

  // ── Quotes (gap plan §5C C3 — quote-to-order) ──
  const quoteLines = (raw: unknown): QuoteLineInput[] =>
    Array.isArray(raw) ? raw.map((l) => ({
      productId: String((l as { productId?: unknown })?.productId ?? ''),
      quantity: Number((l as { quantity?: unknown })?.quantity ?? 0),
      ...(typeof (l as { unitPrice?: unknown })?.unitPrice === 'number' ? { unitPrice: Number((l as { unitPrice: number }).unitPrice) } : {}),
    })) : [];

  app.get(`${BASE}/quotes`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:read');
      const st = optionalString(req.query.status);
      res.json({ quotes: await listQuotes(ctx.tenantId, ctx.orgId, st && (QUOTE_STATUSES as readonly string[]).includes(st) ? st as QuoteStatus : undefined) });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/quotes`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      let contactId: string | undefined;
      const cid = optionalString(b.contactId);
      if (cid) { const cc = await getContact(cid); if (!cc || cc.tenantId !== ctx.tenantId) throw new OpenwopError('validation_error', 'contactId does not reference a contact in this tenant.', 400, { field: 'contactId' }); contactId = cid; }
      const q = await createQuote({
        tenantId: ctx.tenantId, orgId: ctx.orgId, createdBy: ctx.user.userId,
        lines: quoteLines(b.lines),
        ...(contactId ? { contactId } : {}),
        ...(optionalString(b.companyId) ? { companyId: optionalString(b.companyId)! } : {}),
        ...(optionalString(b.dealId) ? { dealId: optionalString(b.dealId)! } : {}),
        note: b.note,
        ...(typeof b.expiresInDays === 'number' ? { expiresInDays: b.expiresInDays } : {}),
      });
      res.status(201).json(q);
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/quotes/:quoteId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); const q = await getQuote(ctx.tenantId, ctx.orgId, req.params.quoteId); if (!q) throw new OpenwopError('not_found', 'Quote not found.', 404, { quoteId: req.params.quoteId }); res.json(q); } catch (err) { next(err); }
  });
  app.get(`${BASE}/quotes/:quoteId/revisions`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ revisions: await listQuoteRevisions(ctx.tenantId, ctx.orgId, req.params.quoteId) }); } catch (err) { next(err); }
  });
  app.patch(`${BASE}/quotes/:quoteId`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const q = await reviseQuote(ctx.tenantId, ctx.orgId, req.params.quoteId, {
        ...(b.lines !== undefined ? { lines: quoteLines(b.lines) } : {}),
        ...(b.note !== undefined ? { note: b.note } : {}),
        ...(typeof b.expiresInDays === 'number' ? { expiresInDays: b.expiresInDays } : {}),
      }, { actor: ctx.user.userId });
      if (!q) throw new OpenwopError('not_found', 'Quote not found.', 404, { quoteId: req.params.quoteId });
      res.json(q);
    } catch (err) { next(err); }
  });
  const quoteAction = (suffix: string, fn: (ctx: Ctx, quoteId: string) => Promise<unknown>) => {
    app.post(`${BASE}/quotes/:quoteId/${suffix}`, async (req, res, next) => {
      try {
        const ctx = await authz(req, 'workspace:write');
        const out = await fn(ctx, req.params.quoteId);
        if (!out) throw new OpenwopError('not_found', 'Quote not found.', 404, { quoteId: req.params.quoteId });
        res.json(out);
      } catch (err) { next(err); }
    });
  };
  quoteAction('send', (ctx, id) => sendQuote(ctx.tenantId, ctx.orgId, id, { actor: ctx.user.userId }));
  quoteAction('decline', (ctx, id) => declineQuote(ctx.tenantId, ctx.orgId, id, { actor: ctx.user.userId }));
  // Operator-side accept (assisted selling: "the customer said yes on the phone").
  quoteAction('accept', (ctx, id) => acceptQuote(ctx.tenantId, ctx.orgId, id, { actor: ctx.user.userId }));

  // ── Public quote accept (C3) — the shared-offer-link last mile: the LIVE share
  // token is the capability proof (expiry + revocation enforced by the sharing
  // feature). CORRECTED (SHCD-1 / ADR 0644 D8): this used to claim the VIEW CAP
  // was enforced here too, and it never was. It still is not, and that is now a
  // deliberate, documented exemption rather than an oversight — a `maxViews:1`
  // link spends its only view when the buyer OPENS the quote, so enforcing the
  // cap on this capability proof would refuse the Accept they were invited to
  // make. A cap limits reads of an offer, not the recipient's right to act on it.
  // Acceptance converts at the NEGOTIATED snapshot prices and,
  // with a Stripe key configured, returns a hosted-checkout URL for the order. ──
  app.post('/v1/host/openwop-app/public-store/:orgId/quotes/:quoteId/accept', async (req, res, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Store not found.', 404, {});
      const token = requireString((req.body ?? {} as Record<string, unknown>).token, 'token');
      await assertLiveLinkFor(token, 'commerce_quote', req.params.quoteId, req.params.orgId);
      const out = await acceptQuote(org.tenantId, req.params.orgId, req.params.quoteId, { actor: 'public:quote-accept' });
      if (!out) throw new OpenwopError('not_found', 'Quote not found.', 404, {});
      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      if (stripeKey) {
        const base = publicBaseUrl(req);
        try {
          const session = await createStripeOrderCheckoutSession(stripeKey, {
            lines: [
              { name: `Quote ${out.quote.quoteId} — ${out.order.items.length} item${out.order.items.length === 1 ? '' : 's'}`, amountMinor: toStripeMinorUnits(out.order.total, out.order.currency), currency: out.order.currency, quantity: 1 },
              ...taxShippingSessionLines(out.order), // DEF-1 — charge = goods + tax + shipping
            ],
            metadata: { orderId: out.order.orderId, tenantId: org.tenantId, orgId: req.params.orgId },
            successUrl: `${base}/store/${encodeURIComponent(req.params.orgId)}?order=${encodeURIComponent(out.order.orderId)}&paid=1`,
            cancelUrl: `${base}/store/${encodeURIComponent(req.params.orgId)}?order=${encodeURIComponent(out.order.orderId)}&canceled=1`,
          });
          res.json({ quote: projectQuotePublic(out.quote), orderId: out.order.orderId, total: out.order.total, currency: out.order.currency, mode: 'live', checkoutUrl: session.url });
          return;
        } catch (err) {
          // grade-code B7: a Stripe failure after conversion strands the order pending
          // (holding stock) with an unrepeatable-accept quote. Cancel the order to
          // release the reservation; the buyer can retry accept (the quote is already
          // converted, so the retry surfaces the converted order via the demo branch).
          await cancelOrder(org.tenantId, req.params.orgId, out.order.orderId, { actor: 'system:quote-checkout-failed' }).catch(() => undefined);
          throw err;
        }
      }
      res.json({ quote: projectQuotePublic(out.quote), orderId: out.order.orderId, total: out.order.total, currency: out.order.currency, mode: 'demo' });
    } catch (err) { next(err); }
  });

  // ── Coupons (Phase 3) ──
  app.get(`${BASE}/coupons`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ coupons: await listCoupons(ctx.tenantId, ctx.orgId) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/coupons`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const b = (req.body ?? {}) as Record<string, unknown>; res.status(201).json(await createCoupon({ tenantId: ctx.tenantId, orgId: ctx.orgId, code: b.code, type: b.type, value: b.value, currency: b.currency, actor: ctx.user.userId })); } catch (err) { next(err); }
  });

  // ── Product subscriptions (MERCH-E, ADR 0279) — subscribe-and-save. ──
  app.get(`${BASE}/subscriptions`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ subscriptions: await listProductSubscriptions(ctx.tenantId, ctx.orgId) }); }
    catch (err) { next(err); }
  });
  app.post(`${BASE}/subscriptions`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const stripeKey = await resolveSecret(STRIPE_KEY_REF).catch(() => null);
      const idempotencyKey = idempotencyKeyOf(req, b);
      const out = await subscribeToProduct({ tenantId: ctx.tenantId, orgId: ctx.orgId, createdBy: ctx.user.userId, productId: String(b.productId ?? ''), interval: b.interval, ...(typeof b.contactId === 'string' ? { contactId: b.contactId } : {}), ...(idempotencyKey ? { idempotencyKey } : {}), stripeKey });
      res.status(201).json(out);
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/subscriptions/:subscriptionId/cycle`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const order = await runSubscriptionCycle(ctx.tenantId, ctx.orgId, req.params.subscriptionId); if (!order) throw new OpenwopError('not_found', 'Active subscription not found.', 404, {}); res.json({ order }); }
    catch (err) { next(err); }
  });
  app.delete(`${BASE}/subscriptions/:subscriptionId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const sub = await cancelSubscription(ctx.tenantId, ctx.orgId, req.params.subscriptionId, { stripeKey: await resolveSecret(STRIPE_KEY_REF).catch(() => null) }); if (!sub) throw new OpenwopError('not_found', 'Subscription not found.', 404, {}); res.json({ subscription: sub }); }
    catch (err) { next(err); }
  });

  // ── Public storefront (Phase 3) — unauthenticated, published (active) products only,
  // org from the URL (tenant host-resolved), like Forms/Sharing. Read-only. ──
  app.get('/v1/host/openwop-app/public-store/:orgId/products', async (req, res, next) => {
    try {
      // Tenant comes from the RESOURCE (the org), never the request — a public surface
      // (the Forms/Sharing discipline). An unknown org 404s (uniform, no existence leak).
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Store not found.', 404, {});
      const tenantId = org.tenantId;
      // C6 — public browse facets: ?q= (name/description/tag match), ?category=, ?tag=.
      const all = await listProducts(tenantId, req.params.orgId, optionalString(req.query.q), {
        ...(optionalString(req.query.category) ? { category: optionalString(req.query.category)! } : {}),
        ...(optionalString(req.query.tag) ? { tag: optionalString(req.query.tag)! } : {}),
      });
      const fieldDefs = await listProductFieldDefs(tenantId, req.params.orgId); // fetch ONCE for label resolution
      // Only active products, and never expose internal/inventory operational fields.
      const store = all.filter((p) => p.active).map((p) => { const cf = publicCustomFields(fieldDefs, p.customFields); return { productId: p.productId, type: p.type, name: p.name, description: p.description, price: p.price, currency: p.currency, imageAssetTokens: p.imageAssetTokens, variants: p.variants, categories: p.categories ?? [], tags: p.tags ?? [], ...(p.attributes?.length ? { attributes: p.attributes } : {}), ...(cf.length ? { customFields: cf } : {}) }; });
      // grade-ux I9: the merchant's own name so the storefront has an identity
      // (the org display name is not sensitive — it's the public store's brand).
      res.json({ products: store, store: { name: org.name } });
    } catch (err) { next(err); }
  });

  // ── Public product detail (gap plan §5C C2) — same posture as the list. ──
  app.get('/v1/host/openwop-app/public-store/:orgId/products/:productId', async (req, res, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Store not found.', 404, {});
      const p = await getProduct(org.tenantId, req.params.orgId, req.params.productId);
      if (!p || !p.active) throw new OpenwopError('not_found', 'Product not found.', 404, {});
      const cf = publicCustomFields(await listProductFieldDefs(org.tenantId, req.params.orgId), p.customFields);
      res.json({ product: { productId: p.productId, type: p.type, name: p.name, description: p.description, price: p.price, currency: p.currency, imageAssetTokens: p.imageAssetTokens, variants: p.variants, categories: p.categories ?? [], tags: p.tags ?? [], ...(p.attributes?.length ? { attributes: p.attributes } : {}), ...(cf.length ? { customFields: cf } : {}) } });
    } catch (err) { next(err); }
  });

  // ── Public guest checkout (gap plan §5C C2) — the real-capture last mile. ──
  // Creates a pending order (guest → best-effort CRM contact, the Forms pattern +
  // an email dedupe), then, when the operator's Stripe key is configured, a REAL
  // hosted Checkout Session whose payment_intent metadata lets the EXISTING
  // commerce webhook flip the order `paid` — no card datum ever touches this app.
  // Keyless operators keep the honest demo posture (`mode:'demo'`, order pending).
  // No approval gate: a customer buying from the merchant is not an agent
  // committing the merchant's money (B3 gates agent paths + refunds).
  app.post('/v1/host/openwop-app/public-store/:orgId/checkout', async (req, res, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Store not found.', 404, {});
      const tenantId = org.tenantId;
      const b = (req.body ?? {}) as { lines?: unknown; email?: unknown; name?: unknown; couponCode?: unknown; shippingAddress?: unknown; bumps?: unknown; funnel?: unknown; savePaymentMethod?: unknown; ref?: unknown };
      const email = requireString(b.email, 'email').trim().toLowerCase();
      // A real (if lenient) email shape — the public route is a CRM-write vector, so
      // reject obvious garbage before it reaches createContact (grade-code I2).
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new OpenwopError('validation_error', 'A valid `email` is required.', 400, { field: 'email' });
      const rawLines = Array.isArray(b.lines) ? b.lines : [];
      // Cap public cart size (grade-code I2) — the service caps at 200, but a public
      // anonymous surface should reject an oversized cart up front, not scan it.
      if (rawLines.length > 50) throw new OpenwopError('validation_error', 'Too many items in one order (max 50).', 400, { field: 'lines' });
      const lines: { productId: string; quantity: number; origin?: 'bump' }[] = rawLines.map((l) => ({ productId: String((l as { productId?: unknown })?.productId ?? ''), quantity: Number((l as { quantity?: unknown })?.quantity ?? 0) }));
      // ADR 0296 P1 — order bumps: checkbox add-ons accepted ON the payment step.
      // ROUTE-derived origin (a client cannot mark arbitrary cart lines as bumps),
      // priced by the same resolver into the SAME single charge. Cap 5.
      const rawBumps = Array.isArray(b.bumps) ? b.bumps.slice(0, 5) : [];
      for (const raw of rawBumps) {
        const productId = String((raw as { productId?: unknown })?.productId ?? '');
        const quantity = Math.max(1, Math.trunc(Number((raw as { quantity?: unknown })?.quantity ?? 1)) || 1);
        if (productId) lines.push({ productId, quantity, origin: 'bump' });
      }
      // ADR 0294 P3 contract — the funnel provenance stamp, wired here (0296):
      // both ids or nothing; createOrder re-validates + bounds.
      const rawFunnel = (b.funnel ?? undefined) as { funnelId?: unknown; stepId?: unknown } | undefined;
      // ADR 0297 D2 — affiliate ref capture: only a code that references a REAL
      // affiliate in this org attributes (junk refs are silently dropped — a
      // public surface must not be a validation oracle for affiliate codes).
      let affiliateCode: string | undefined;
      const ref = optionalString(b.ref);
      if (ref && ref.length <= 40) {
        const code = await affiliateCodeExists(tenantId, req.params.orgId, ref); // grade fix HIGH-1: no ledger projection on the public path
        if (code) affiliateCode = code;
      }

      // Guest → CRM contact via the shared merge-aware seam (ADR 0449 P1). Was a
      // linear listContacts().find (merge-blind); ensureContact follows a merged
      // contact to its survivor and is O(1). A contact failure never blocks the
      // purchase.
      let contactId: string | undefined;
      try {
        // ADR 0627 D2 — a guest checkout IS a new lead: `contact.created` fires
        // inside the seam for a NEW row (an existing contact emits nothing).
        const contact = await ensureContact({ tenantId, email, name: optionalString(b.name) ?? email, actor: 'public:guest' });
        contactId = contact?.contactId;
      } catch { /* best-effort — guest checkout must not depend on CRM */ }

      const order = await createOrder({
        // grade-code B6: NO PII in the actor — it lands in audit rows + webhook fan-out.
        // The contact link (below) carries identity; the actor stays opaque.
        tenantId, orgId: req.params.orgId, createdBy: 'public:guest',
        ...(contactId ? { contactId } : {}),
        ...(optionalString(b.couponCode) ? { couponCode: optionalString(b.couponCode)! } : {}),
        ...(b.shippingAddress && typeof b.shippingAddress === 'object' ? { shippingAddress: b.shippingAddress as Record<string, unknown> } : {}),
        ...(rawFunnel ? { funnelRef: rawFunnel } : {}),
        ...(affiliateCode ? { affiliateCode } : {}),
        // ADR 0296 P2 — EXPLICIT consent only (unticked by default client-side),
        // meaningful only with a CRM contact to key the saved reference, and
        // only while the operator has one-click enabled.
        ...(b.savePaymentMethod === true && contactId && offSessionEnabled() ? { pmSaveRequested: true } : {}),
        ...(idempotencyKeyOf(req, b) ? { idempotencyKey: idempotencyKeyOf(req, b)! } : {}),
        lines,
      });

      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      if (stripeKey) {
        const base = publicBaseUrl(req);
        try {
        // A coupon discount can't be a negative Stripe line — bill ONE aggregate
        // line for the exact order total so the charge always equals the order.
        const goodsLines = order.discount > 0
          ? [{ name: `Order ${order.orderId} (${order.items.length} item${order.items.length === 1 ? '' : 's'}, coupon applied)`, amountMinor: toStripeMinorUnits(order.total, order.currency), currency: order.currency, quantity: 1 }]
          : order.items.map((i) => ({ name: i.name, amountMinor: toStripeMinorUnits(i.unitPrice, order.currency), currency: order.currency, quantity: i.quantity }));
        // ADR 0296 P2 — a consented save needs a Stripe Customer to anchor the
        // payment method; the webhook captures pm+customer ids on success.
        let customerId: string | undefined;
        if (order.pmSaveRequested) {
          try { customerId = (await createStripeCustomer(stripeKey, { email })).customerId; }
          catch { /* consent is best-effort — the purchase must not fail on it */ }
        }
        const session = await createStripeOrderCheckoutSession(stripeKey, {
          lines: [...goodsLines, ...taxShippingSessionLines(order)], // DEF-1 — charge = goods + tax + shipping
          metadata: { orderId: order.orderId, tenantId, orgId: req.params.orgId },
          successUrl: `${base}/store/${encodeURIComponent(req.params.orgId)}?order=${encodeURIComponent(order.orderId)}&paid=1`,
          cancelUrl: `${base}/store/${encodeURIComponent(req.params.orgId)}?order=${encodeURIComponent(order.orderId)}&canceled=1`,
          ...(customerId ? { customerId, setupFutureUsage: 'off_session' as const } : {}),
        });
        res.status(201).json({ orderId: order.orderId, total: order.total, taxTotal: order.taxTotal ?? 0, shippingCost: order.shippingCost ?? 0, charge: orderChargeTotal(order), currency: order.currency, mode: 'live', checkoutUrl: session.url });
        return;
        } catch (err) {
          // A Stripe hiccup must not strand the reservation for the full TTL —
          // release the stock now; the shopper can simply retry checkout.
          await cancelOrder(tenantId, req.params.orgId, order.orderId, { actor: 'system:checkout-failed' }).catch(() => undefined);
          throw err;
        }
      }
      // R2 CM-P2-M6 — the demo placement returns the SAME breakdown the live branch
      // does, so the confirmation can state what was actually charged rather than the
      // goods-only number the shopper saw in the cart.
      res.status(201).json({ orderId: order.orderId, total: order.total, taxTotal: order.taxTotal ?? 0, shippingCost: order.shippingCost ?? 0, charge: orderChargeTotal(order), currency: order.currency, mode: 'demo' });
    } catch (err) { next(err); }
  });

  // ── Cart (deferred Phase 1) — server-persisted, one per user+org ──
  app.get(`${BASE}/cart`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json(await getCart(ctx.tenantId, ctx.orgId, ctx.user.userId)); } catch (err) { next(err); }
  });
  app.put(`${BASE}/cart/items/:productId`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const q = Number((req.body ?? {}).quantity ?? 1); res.json(await setCartItem(ctx.tenantId, ctx.orgId, ctx.user.userId, req.params.productId, q)); } catch (err) { next(err); }
  });
  app.delete(`${BASE}/cart`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); await clearCart(ctx.tenantId, ctx.orgId, ctx.user.userId); res.status(204).end(); } catch (err) { next(err); }
  });
  app.post(`${BASE}/cart/checkout`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:write');
      const b = (req.body ?? {}) as { contactId?: unknown; couponCode?: unknown };
      let contactId: string | undefined;
      const cid = optionalString(b.contactId);
      if (cid) { const c = await getContact(cid); if (!c || c.tenantId !== ctx.tenantId) throw new OpenwopError('validation_error', 'contactId does not reference a contact in this tenant.', 400, { field: 'contactId' }); contactId = cid; }
      const idempotencyKey = idempotencyKeyOf(req, b);
      const order = await checkoutCart(ctx.tenantId, ctx.orgId, ctx.user.userId, { ...(contactId ? { contactId } : {}), ...(optionalString(b.couponCode) ? { couponCode: optionalString(b.couponCode)! } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) });
      res.status(201).json(order);
    } catch (err) { next(err); }
  });

  // ── Revenue summary (gap plan §5C C9) — ONE read for the whole dashboard tab. ──
  app.get(`${BASE}/reports/summary`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json(await commerceSummary(ctx.tenantId, ctx.orgId)); } catch (err) { next(err); }
  });

  // ── Affiliates / commission / payout (deferred P5) — advisory ledger ──
  app.get(`${BASE}/affiliates`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ affiliates: await listAffiliates(ctx.tenantId, ctx.orgId) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/affiliates`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); const b = (req.body ?? {}) as Record<string, unknown>; res.status(201).json(await createAffiliate({ tenantId: ctx.tenantId, orgId: ctx.orgId, code: b.code, name: b.name, commissionType: b.commissionType, commissionRate: b.commissionRate, currency: b.currency })); } catch (err) { next(err); }
  });
  // ADR 0297 D2 — payout export (CSV): the advisory ledger as a file the
  // operator pays from. No money movement.
  app.get(`${BASE}/affiliates/payouts.csv`, async (req, res, next) => {
    try {
      const ctx = await authz(req, 'workspace:read');
      const rows = await payoutExportRows(ctx.tenantId, ctx.orgId);
      const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`;
      const csv = ['code,name,currency,balance_owed,pending_payouts',
        ...rows.map((r: { code: string; name: string; currency: string; balanceOwed: number; pendingPayouts: number }) => [esc(r.code), esc(r.name), esc(r.currency), String(r.balanceOwed), String(r.pendingPayouts)].join(','))].join('\n');
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="affiliate-payouts.csv"');
      res.send(csv);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/affiliates/:affiliateId/payout`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:write'); res.status(201).json(await recordPayout(ctx.tenantId, ctx.orgId, req.params.affiliateId)); } catch (err) { next(err); }
  });
  app.get(`${BASE}/payouts`, async (req, res, next) => {
    try { const ctx = await authz(req, 'workspace:read'); res.json({ payouts: await listPayouts(ctx.tenantId, ctx.orgId) }); } catch (err) { next(err); }
  });

  // ── ADR 0296 P3 — one-click post-purchase upsell (env-gated, DEFAULT OFF).
  // Charges the parent purchase's SAVED payment method off-session for ONE
  // server-priced product. Money-movement posture: amount always resolved
  // server-side (LEAK-11), OPENWOP_COMMERCE_OFFSESSION_ENABLED must be 'true',
  // chain depth ≤ 3, per-product duplicate guard, SCA challenge falls back to
  // an on-session confirm (clientSecret returned), a decline cancels the child
  // so the funnel can route to a downsell.
  app.post('/v1/host/openwop-app/public-store/:orgId/orders/:orderId/one-click', async (req, res, next) => {
    try {
      if (!offSessionEnabled()) { sendError(res, 503, 'not_configured', 'One-click offers are not enabled on this host.'); return; }
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Store not found.', 404, {});
      const tenantId = org.tenantId;
      const orgId = req.params.orgId;
      const b = (req.body ?? {}) as { productId?: unknown; quantity?: unknown; funnel?: unknown };
      const productId = requireString(b.productId, 'productId');
      const quantity = Math.max(1, Math.trunc(Number(b.quantity ?? 1)) || 1);

      const parent = await getOrder(tenantId, orgId, req.params.orderId);
      if (!parent || parent.status !== 'paid') throw new OpenwopError('not_found', 'Order not found.', 404, {});
      if (!parent.contactId) throw new OpenwopError('validation_error', 'This purchase has no saved payment profile.', 400, {});
      const saved = await getSavedPaymentMethod(tenantId, orgId, parent.contactId);
      if (!saved) throw new OpenwopError('validation_error', 'No saved payment method for this purchase.', 400, {});

      const children = await listChildOrders(tenantId, orgId, parent.orderId);
      if (children.filter((c) => c.status !== 'canceled').length >= 3) {
        throw new OpenwopError('validation_error', 'One-click chain limit reached for this purchase.', 400, { code: 'chain_limit' });
      }
      // Duplicate guard: an accepted offer for the same product returns the
      // existing child (refresh/double-click can never double-charge).
      const dup = children.find((c) => c.status !== 'canceled' && c.items.some((i) => i.productId === productId && i.origin === 'upsell'));
      if (dup) { res.status(200).json({ orderId: dup.orderId, status: dup.status, duplicate: true }); return; }

      const rawFunnel = (b.funnel ?? undefined) as { funnelId?: unknown; stepId?: unknown } | undefined;
      const child = await createOrder({
        tenantId, orgId, createdBy: 'public:one-click',
        contactId: parent.contactId,
        parentOrderId: parent.orderId,
        // provenance: the explicit upsell step when supplied, else the parent's stamp
        ...(rawFunnel ? { funnelRef: rawFunnel } : parent.funnelRef ? { funnelRef: parent.funnelRef } : {}),
        lines: [{ productId, quantity, origin: 'upsell' }],
      });

      const stripeKey = await resolveSecret(STRIPE_KEY_REF);
      if (!stripeKey) {
        // Keyless demo posture — the child order exists, honestly unpaid.
        res.status(201).json({ orderId: child.orderId, status: child.status, mode: 'demo' });
        return;
      }
      const outcome = await createStripeOffSessionPaymentIntent(stripeKey, {
        customerId: saved.stripeCustomerId, paymentMethodId: saved.paymentMethodId,
        amountMinor: toStripeMinorUnits(orderChargeTotal(child), child.currency), currency: child.currency,
        metadata: { orderId: child.orderId, tenantId, orgId },
        idempotencyKey: `oneclick:${parent.orderId}:${productId}`,
      });
      if (outcome.outcome === 'succeeded') {
        await markAsPaid(tenantId, orgId, child.orderId, outcome.paymentIntentId, { actor: 'public:one-click', stripeKey });
        res.status(201).json({ orderId: child.orderId, status: 'paid', paid: true });
        return;
      }
      if (outcome.outcome === 'requires_action') {
        // SCA challenge — the chain never silently drops revenue: the SPA
        // confirms on-session with this clientSecret; the webhook flips paid.
        // GC-OC-2: keep the child's stock reservation alive through the
        // challenge window so the expiry sweep can't cancel it mid-confirm.
        await extendReservationForSca(tenantId, orgId, child.orderId).catch(() => undefined);
        res.status(202).json({ orderId: child.orderId, requiresAction: true, clientSecret: outcome.clientSecret, paymentIntentId: outcome.paymentIntentId });
        return;
      }
      // Declined — release the child (stock restored) so the funnel can downsell.
      await cancelOrder(tenantId, orgId, child.orderId, { actor: 'system:one-click-declined' }).catch(() => undefined);
      res.status(402).json({ declined: true, reason: outcome.reason });
    } catch (err) { next(err); }
  });

  // ── Commerce Stripe webhook (deferred Phase-3) — PUBLIC, signature-is-credential (reuses
  // billing's verify). On a successful payment referencing an order (metadata.orderId +
  // tenantId/orgId), advance it via markAsPaid. Demo-mode: 503 until the signing secret is
  // set. Idempotency rides markAsPaid's pending-only guard (a re-delivery is a 409 → ack). ──
  app.post('/v1/host/openwop-app/commerce/webhook', async (req: Request, res: Response) => {
    try {
      const rawBody = req.rawBody?.toString('utf8');
      if (!rawBody) { sendError(res, 400, 'invalid_request', 'The raw request body is required to verify the Stripe signature.'); return; }
      const signingSecret = await resolveSecret('commerce:webhook-secret');
      if (!signingSecret) { sendError(res, 503, 'not_configured', 'No commerce webhook signing secret is configured on this host.'); return; }
      const verdict = verifyStripeSignature({ signingSecret, signatureHeader: req.get('stripe-signature'), rawBody, now: Date.now() });
      if (!verdict.ok) { log.warn('commerce webhook rejected', { reason: verdict.reason }); sendError(res, 401, 'unauthorized', 'Stripe signature verification failed.'); return; }
      const event = (req.body ?? {}) as { type?: unknown; data?: unknown };
      const obj = ((event.data as { object?: unknown })?.object ?? {}) as Record<string, unknown>;
      const meta = (obj.metadata ?? {}) as { orderId?: unknown; tenantId?: unknown; orgId?: unknown };
      const type = typeof event.type === 'string' ? event.type : '';
      if ((type === 'payment_intent.succeeded' || type === 'checkout.session.completed') && typeof meta.orderId === 'string' && typeof meta.tenantId === 'string' && typeof meta.orgId === 'string') {
        // grade-code B1: a checkout.session.completed fires with payment_status 'unpaid'
        // for async methods (boleto/SEPA) — do NOT flip paid until the money is actually
        // captured. payment_intent.succeeded is already terminal-captured.
        const paymentStatus = typeof obj.payment_status === 'string' ? obj.payment_status : undefined;
        if (type === 'checkout.session.completed' && paymentStatus !== undefined && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
          log.info('commerce webhook: session completed but not yet paid — ignoring', { orderId: meta.orderId, paymentStatus });
          res.status(202).json({ received: true, ignored: 'payment_pending' });
          return;
        }
        // For a payment_intent event the id IS the intent → verify amount/currency against
        // the order (grade-code B1). A session event carries payment_intent as a field.
        const paymentIntentId = type === 'payment_intent.succeeded' && typeof obj.id === 'string'
          ? obj.id
          : (typeof obj.payment_intent === 'string' ? obj.payment_intent : `evt:${type}`);
        // Pass the resolved Stripe key so markAsPaid VERIFIES the intent — a re-verified
        // amount/currency is the money-truth guard the weblhook lacked.
        const stripeKey = paymentIntentId.startsWith('evt:') ? null : await resolveSecret(STRIPE_KEY_REF);
        try {
          await markAsPaid(String(meta.tenantId), String(meta.orgId), String(meta.orderId), paymentIntentId, { actor: 'stripe-webhook', stripeKey });
          // ADR 0296 P2 — capture the consented saved payment method (idempotent,
          // best-effort; only orders that REQUESTED the save carry the marker).
          // NOTE: only payment_intent.succeeded carries payment_method+customer —
          // a checkout.session.completed obj lacks payment_method, so capture
          // no-ops there and relies on the intent event Stripe also delivers.
          const paidOrder = await getOrder(String(meta.tenantId), String(meta.orgId), String(meta.orderId));
          if (paidOrder?.pmSaveRequested) await captureSavedPmFromPaidIntent(paidOrder, obj);
        } catch (err) {
          // grade-code B2: DON'T silently swallow — a payment landing on a canceled/
          // expired order means money captured with no order to fulfil (an operator
          // must refund). Audit + log it; still 202 so Stripe stops retrying a
          // permanently-unfulfillable delivery.
          const code = err instanceof OpenwopError ? err.code : 'internal_error';
          if (code === 'validation_error') {
            recordCommerceAction('order.webhook-unresolved', { tenantId: String(meta.tenantId), orgId: String(meta.orgId) }, 'stripe-webhook', { orderId: meta.orderId, paymentIntentId, reason: err instanceof Error ? err.message : String(err) });
            log.error('commerce webhook: payment could not be applied to its order (operator refund may be needed)', { orderId: meta.orderId, paymentIntentId, error: err instanceof Error ? err.message : String(err) });
          } else {
            throw err; // a real internal error → 500 so Stripe retries
          }
        }
      }
      res.status(202).json({ received: true });
    } catch (err) {
      log.error('commerce webhook error', { error: err instanceof Error ? err.message : String(err) });
      sendError(res, 500, 'internal_error', 'An unexpected error occurred.');
    }
  });
}
