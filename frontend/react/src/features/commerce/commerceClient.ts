/**
 * Commerce admin client (gap plan §5C C1) — thin fetch wrappers over the ADR 0177/0221
 * host-ext routes. One batched read per tab (the rate-limit fan-out gotcha).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
export interface ProductVariant { variantId: string; name: string; sku?: string; price?: number; inventory?: number }
export interface Product {
  productId: string; type: 'physical' | 'digital' | 'service'; name: string; description?: string;
  price: number; currency: string; inventory?: number; lowStockThreshold?: number;
  variants: ProductVariant[]; categories?: string[]; tags?: string[];
  attributes?: { label: string; value: string }[]; // DEF-4 (ADR 0240) — bounded custom attributes
  weightGrams?: number; dims?: { l: number; w: number; h: number }; // ADR 0250 — parcel for rate-shopping
  customFields?: Record<string, string | number | boolean>;         // ADR 0257 — typed custom fields
  kind?: 'simple' | 'bundle';                                        // MERCH-D (ADR 0276)
  components?: { productId: string; variantId?: string; quantity: number }[];
  subscription?: { enabled: boolean; intervals: string[]; savePercent?: number }; // MERCH-E (ADR 0279)
  active: boolean; updatedAt: string;
}
export type ProductFieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum';
export interface ProductFieldDef { defId: string; key: string; label: string; type: ProductFieldType; required: boolean; options?: string[] }
export interface OrderItem { productId: string; name: string; unitPrice: number; quantity: number; priceSource?: string }
/** R2 CM-P2-M3 — mirrors the backend `CURRENCIES` SSoT (commerceService.ts). The admin
 *  hardcoded 'USD' on every create, so a EUR/JPY store could not be built from the UI at
 *  all — while the Reports tab already shipped a per-currency band design. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'] as const;

export interface Order {
  orderId: string; contactId?: string; items: OrderItem[];
  subtotal: number; discount: number; total: number; currency: string; couponCode?: string;
  taxLines?: { name: string; amount: number }[]; taxTotal?: number; shippingCost?: number; // DEF-1 (ADR 0238)
  refundedAmount?: number;                                                                 // DEF-7 (ADR 0238)
  /** R2 CM-P2-B3 — 'none' = the state was flipped but NO money was returned. Absent on
   *  pre-R2 rows, which is UNKNOWN — never render it as if it were 'stripe'. */
  refundProvider?: 'stripe' | 'none';
  status: 'pending' | 'paid' | 'fulfilled' | 'refunding' | 'partially_refunded' | 'refunded' | 'canceled';
  fulfillmentStatus: 'pending' | 'processing' | 'shipped' | 'delivered';
  reservationExpiresAt?: string; createdBy: string; createdAt: string;
}
/** `state` is ADR 0615 and is OPTIONAL: rows written before it carry none, and are
 *  read as `applied` (the same answer the screen gave them before). */
export interface OrderRefund { refundLedgerId: string; orderId: string; refundKey: string; amount: number; currency: string; provider: 'stripe' | 'none'; refundId?: string; state?: 'pending' | 'applied' | 'manual_intervention_required'; createdAt: string }
export interface QuoteLine { productId: string; name: string; quantity: number; listPrice: number; unitPrice: number; priceSource?: string }
export interface Quote {
  quoteId: string; contactId?: string; companyId?: string; lines: QuoteLine[];
  subtotal: number; total: number; currency: string; note?: string;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';
  version: number; expiresAt?: string; convertedOrderId?: string; createdAt: string;
}
export interface PriceList {
  priceListId: string; name: string; currency: string; priority: number; active: boolean;
  entries: { productId: string; variantId?: string; price: number }[];
  assignment: { contactIds?: string[]; companyIds?: string[] };
}
export interface ResolvedPrice { price: number; currency: string; source: string; priceListName?: string; priority?: number }
export interface CurrencyFigures { // DEF-6 (ADR 0239) — money figures for one currency
  currency: string; gmv: number; netRevenue: number; aov: number; paidOrders: number;
  couponUsage: { code: string; orders: number; discount: number }[];
  topProducts: { productId: string; name: string; revenue: number; units: number }[]; // ADR 0239 follow-on — per-currency
}
export interface CommerceSummary {
  gmv: number; netRevenue: number; currency: string; aov: number; // primary (highest-GMV) currency
  byCurrency: CurrencyFigures[]; // one per currency the org sold in (GMV-desc); mirrors the headline at [0]
  orderCounts: Record<Order['status'], number>;
  topProducts: { productId: string; name: string; revenue: number; units: number }[];
  couponUsage: { code: string; orders: number; discount: number }[];
  lowStock: { productId: string; name: string; inventory: number; lowStockThreshold: number }[];
}
export interface Coupon { couponId: string; code: string; type: 'percentage' | 'fixed' | 'free_shipping'; value: number; active: boolean; currency?: string }

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** grade-code M1: a typed error carrying the canonical envelope's `error` CODE and
 *  `details` — so callers discriminate on `code === 'approval_required'` (and its
 *  `approvalStatus`) rather than substring-matching a localizable message. */
export class CommerceApiError extends Error {
  constructor(message: string, readonly code: string, readonly details?: Record<string, unknown>, readonly status?: number) {
    super(message);
    this.name = 'CommerceApiError';
  }
}
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let env: { error?: string; message?: string; details?: Record<string, unknown> } = {};
    try { env = (await res.json()) as typeof env; } catch { /* non-JSON body */ }
    throw new CommerceApiError(env.message || `${ctx} returned ${res.status}`, env.error ?? 'unknown', env.details, res.status);
  }
  return (await res.json()) as T;
}
const orgBase = (orgId: string): string => `${root}/commerce/orgs/${encodeURIComponent(orgId)}`;
const get = async <T>(url: string, ctx: string): Promise<T> => asJson<T>(await fetch(url, fetchOpts({ headers: authedHeaders() })), ctx);
const post = async <T>(url: string, body: unknown, ctx: string): Promise<T> => asJson<T>(await fetch(url, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) })), ctx);
const patch = async <T>(url: string, body: unknown, ctx: string): Promise<T> => asJson<T>(await fetch(url, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(body) })), ctx);
const del = async (url: string, ctx: string): Promise<void> => {
  const res = await fetch(url, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new Error(`${ctx} returned ${res.status}`);
};

export const listOrgs = async (): Promise<Org[]> => (await get<{ orgs: Org[] }>(`${root}/orgs`, 'listOrgs')).orgs;

export const listProducts = async (orgId: string): Promise<Product[]> => (await get<{ products: Product[] }>(`${orgBase(orgId)}/products`, 'listProducts')).products;
export const createProduct = (orgId: string, body: Record<string, unknown>): Promise<Product> => post(`${orgBase(orgId)}/products`, body, 'createProduct');
export const updateProduct = (orgId: string, productId: string, body: Record<string, unknown>): Promise<Product> => patch(`${orgBase(orgId)}/products/${encodeURIComponent(productId)}`, body, 'updateProduct');
export const deleteProduct = (orgId: string, productId: string): Promise<void> => del(`${orgBase(orgId)}/products/${encodeURIComponent(productId)}`, 'deleteProduct');
// ADR 0257 — typed product custom-field definitions
export const listProductFields = async (orgId: string): Promise<ProductFieldDef[]> => (await get<{ fields: ProductFieldDef[] }>(`${orgBase(orgId)}/product-fields`, 'listProductFields')).fields;
export const createProductField = (orgId: string, body: Record<string, unknown>): Promise<ProductFieldDef> => post(`${orgBase(orgId)}/product-fields`, body, 'createProductField');
export const deleteProductField = (orgId: string, defId: string): Promise<void> => del(`${orgBase(orgId)}/product-fields/${encodeURIComponent(defId)}`, 'deleteProductField');

export const listOrders = async (orgId: string): Promise<Order[]> => (await get<{ orders: Order[] }>(`${orgBase(orgId)}/orders`, 'listOrders')).orders;
export const getOrder = (orgId: string, orderId: string): Promise<Order> => get<Order>(`${orgBase(orgId)}/orders/${encodeURIComponent(orderId)}`, 'getOrder');
export const payOrder = (orgId: string, orderId: string, paymentIntentId: string): Promise<Order> => post(`${orgBase(orgId)}/orders/${encodeURIComponent(orderId)}/pay`, { paymentIntentId }, 'payOrder');
export const refundOrder = (orgId: string, orderId: string): Promise<Order> => post(`${orgBase(orgId)}/orders/${encodeURIComponent(orderId)}/refund`, {}, 'refundOrder');
export const partialRefundOrder = (orgId: string, orderId: string, amount: number, refundKey: string): Promise<Order> => post(`${orgBase(orgId)}/orders/${encodeURIComponent(orderId)}/partial-refund`, { amount, refundKey }, 'partialRefundOrder');
export const listOrderRefunds = async (orgId: string, orderId: string): Promise<OrderRefund[]> => (await get<{ refunds: OrderRefund[] }>(`${orgBase(orgId)}/orders/${encodeURIComponent(orderId)}/refunds`, 'listOrderRefunds')).refunds;
export const cancelOrder = (orgId: string, orderId: string): Promise<Order> => post(`${orgBase(orgId)}/orders/${encodeURIComponent(orderId)}/cancel`, {}, 'cancelOrder');
export const advanceFulfillment = (orgId: string, orderId: string, fulfillmentStatus: string): Promise<Order> => post(`${orgBase(orgId)}/orders/${encodeURIComponent(orderId)}/fulfillment`, { fulfillmentStatus }, 'advanceFulfillment');

export const listQuotes = async (orgId: string): Promise<Quote[]> => (await get<{ quotes: Quote[] }>(`${orgBase(orgId)}/quotes`, 'listQuotes')).quotes;
export const createQuote = (orgId: string, body: Record<string, unknown>): Promise<Quote> => post(`${orgBase(orgId)}/quotes`, body, 'createQuote');
export const sendQuote = (orgId: string, quoteId: string): Promise<Quote> => post(`${orgBase(orgId)}/quotes/${encodeURIComponent(quoteId)}/send`, {}, 'sendQuote');
export const declineQuote = (orgId: string, quoteId: string): Promise<Quote> => post(`${orgBase(orgId)}/quotes/${encodeURIComponent(quoteId)}/decline`, {}, 'declineQuote');
export const acceptQuote = (orgId: string, quoteId: string): Promise<{ quote: Quote; order: Order }> => post(`${orgBase(orgId)}/quotes/${encodeURIComponent(quoteId)}/accept`, {}, 'acceptQuote');

export const listPriceLists = async (orgId: string): Promise<PriceList[]> => (await get<{ priceLists: PriceList[] }>(`${orgBase(orgId)}/price-lists`, 'listPriceLists')).priceLists;
export const createPriceList = (orgId: string, body: Record<string, unknown>): Promise<PriceList> => post(`${orgBase(orgId)}/price-lists`, body, 'createPriceList');
export const deletePriceList = (orgId: string, priceListId: string): Promise<void> => del(`${orgBase(orgId)}/price-lists/${encodeURIComponent(priceListId)}`, 'deletePriceList');
export const resolvePrice = (orgId: string, params: { productId: string; contactId?: string; companyId?: string }): Promise<ResolvedPrice> => {
  const q = new URLSearchParams({ productId: params.productId, ...(params.contactId ? { contactId: params.contactId } : {}), ...(params.companyId ? { companyId: params.companyId } : {}) });
  return get(`${orgBase(orgId)}/price?${q.toString()}`, 'resolvePrice');
};

export const listCoupons = async (orgId: string): Promise<Coupon[]> => (await get<{ coupons: Coupon[] }>(`${orgBase(orgId)}/coupons`, 'listCoupons')).coupons;
export const createCoupon = (orgId: string, body: Record<string, unknown>): Promise<Coupon> => post(`${orgBase(orgId)}/coupons`, body, 'createCoupon');

export const commerceSummary = (orgId: string): Promise<CommerceSummary> => get(`${orgBase(orgId)}/reports/summary`, 'commerceSummary');

/** Mint a commerce_quote share link (the ONE sharing feature owns links). */
export const createQuoteShareLink = (orgId: string, quoteId: string): Promise<{ token: string }> =>
  post(`${root}/sharing/orgs/${encodeURIComponent(orgId)}/links`, { resourceType: 'commerce_quote', resourceId: quoteId }, 'createQuoteShareLink');

/** The public storefront path for an org (link out from the admin). */
export const storefrontPath = (orgId: string): string => `/store/${encodeURIComponent(orgId)}`;
