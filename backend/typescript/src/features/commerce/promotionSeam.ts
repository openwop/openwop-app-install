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
import { createLogger } from '../../observability/logger.js';

const log = createLogger('commerce.promotion-seam');

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
  /** ADR 1025 D1 — budget holds taken for this order (order lane only). The caller MUST
   *  commit them with the orderId once the order row is written, or release them. */
  holdIds?: string[];
}

type OrderDiscountHook = (ctx: OrderDiscountContext) => Promise<OrderDiscountResult>;

let hook: OrderDiscountHook | null = null;

/** The promotions feature registers its `applyPromotions` here at boot. */
export function setOrderDiscountHook(fn: OrderDiscountHook | null): void { hook = fn; }

/** ADR 1025 D1 — how commerce settles the budget holds a pricing pass took. Registered by
 *  the promotions feature with the discount hook; no-ops when it is absent. */
type HoldHooks = { commit: (tenantId: string, holdIds: readonly string[], orderId: string) => Promise<void>; release: (tenantId: string, holdIds: readonly string[]) => Promise<void> };
let holdHooks: HoldHooks | null = null;
export function setOrderPromotionHoldHooks(h: HoldHooks | null): void { holdHooks = h; }
/** Best-effort: a hold that cannot be settled expires on its own (the TTL), so a failure
 *  here never fails an order that was already written. */
export async function commitOrderPromotionHolds(tenantId: string, holdIds: readonly string[], orderId: string): Promise<void> {
  if (!holdHooks || holdIds.length === 0) return;
  await holdHooks.commit(tenantId, holdIds, orderId).catch((e) => log.warn('promotion hold commit failed — it will expire', { tenantId, orderId, error: e instanceof Error ? e.message : String(e) }));
}
export async function releaseOrderPromotionHolds(tenantId: string, holdIds: readonly string[]): Promise<void> {
  if (!holdHooks || holdIds.length === 0) return;
  await holdHooks.release(tenantId, holdIds).catch((e) => log.warn('promotion hold release failed — it will expire', { tenantId, error: e instanceof Error ? e.message : String(e) }));
}

/** Called by `createOrder`; the documented no-op when no promotions feature is wired. */
export async function computeOrderPromotions(ctx: OrderDiscountContext): Promise<OrderDiscountResult> {
  if (!hook) return { discount: 0, appliedPromotions: [] };
  return hook(ctx);
}
