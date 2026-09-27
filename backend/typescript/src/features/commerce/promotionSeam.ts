/**
 * Promotion seam (ADR 0274 / MERCH-B) — the dependency-safe hook by which the
 * `promotions` feature injects a rule-based discount into commerce `createOrder`
 * WITHOUT commerce importing the promotions feature (ruling 1; the same shape as
 * `setTransactionalEmailTransport`). Default = no-op ⇒ commerce is byte-identical
 * when promotions is absent/off.
 *
 * The discount is computed AFTER `resolvePrice` + the coupon (never a second
 * pricing path, ADR 0274 ruling 2). The fired promotions are snapshot onto the
 * Order (`appliedPromotions`), which freezes the promoted total for replay/:fork
 * and gives refund/basket-margin attribution (ruling 7).
 *
 * Amounts are MAJOR units, matching the commerce Order convention (subtotal/total).
 */
export interface AppliedPromotion {
  promotionId: string;
  /** cart_threshold | bogo | tiered | product_discount | loss_leader */
  type: string;
  name?: string;
  /** Discount contributed by this promotion, MAJOR units. */
  amount: number;
  /** Discounted UNITS this promotion granted on the order (per-unit reward types:
   *  bogo / product_discount / loss_leader). Absent on cart-level types and on
   *  orders frozen before `budget.maxQuantity` enforcement (⇒ counted as 0 in the
   *  derived quantity budget). Snapshot for replay/:fork like `amount`. */
  quantity?: number;
}

export interface OrderDiscountContext {
  tenantId: string;
  orgId: string;
  currency: string;
  /** Goods subtotal already net of any coupon — promotions stack on top of this. */
  subtotalAfterCoupon: number;
  contactId?: string;
  items: { productId: string; unitPrice: number; quantity: number }[];
}

export interface OrderDiscountResult {
  /** Additional order-level discount, MAJOR units (0 = none). */
  discount: number;
  appliedPromotions: AppliedPromotion[];
}

type OrderDiscountHook = (ctx: OrderDiscountContext) => Promise<OrderDiscountResult>;

let hook: OrderDiscountHook | null = null;

/** The promotions feature registers its `applyPromotions` here at boot. */
export function setOrderDiscountHook(fn: OrderDiscountHook | null): void { hook = fn; }

/** Called by `createOrder`; the documented no-op when no promotions feature is wired. */
export async function computeOrderPromotions(ctx: OrderDiscountContext): Promise<OrderDiscountResult> {
  if (!hook) return { discount: 0, appliedPromotions: [] };
  return hook(ctx);
}
