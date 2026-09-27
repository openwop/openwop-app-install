/**
 * Commerce SHOWCASE seeder (ecommerce gap-analysis Phase A / A3).
 *
 * Seeds the "Solstice Roasters" storefront: 4 products (all three types;
 * one deliberately low-stock), 1 coupon, and 3 orders exercising the
 * lifecycle (pending / paid / delivered→fulfilled) — so a demo tenant that
 * turns the `commerce` toggle on sees a live catalog, order states, and the
 * low-stock surface instead of an empty feature.
 *
 * Follows the `campaignShowcaseSeed` contract exactly:
 * - gated on the `commerce` toggle (skips when off — it NEVER flips the
 *   server-authoritative toggle; enabling commerce stays an explicit admin act);
 * - idempotent (creates only what's missing, keyed by the seed actor marker);
 * - EVERY write goes through `commerceService` so lifecycle guards and
 *   inventory math hold (a raw-write seed could fabricate unreachable states);
 * - `clear()` removes only entities carrying the `demo:commerce-showcase`
 *   marker (orders first, then products, then the coupon — so a partial
 *   failure never strands orders referencing deleted products).
 */
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import {
  listProducts, createProduct, deleteProduct,
  listOrders, createOrder, markAsPaid, updateFulfillment, deleteOrder,
  listCoupons, createCoupon, deleteCoupon,
  type FulfillmentStatus,
} from '../features/commerce/commerceService.js';
import {
  COMMERCE_SHOWCASE_ACTOR, SHOWCASE_COUPON, SHOWCASE_ORDERS, SHOWCASE_PRODUCTS,
} from './seed-data/commerceShowcase.js';

const log = createLogger('seed.commerceShowcase');

async function gateOpen(tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne('commerce', { tenantId }))?.enabled);
}

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

export async function countCommerceShowcase(tenantId: string): Promise<number> {
  if (!(await gateOpen(tenantId))) return 0;
  const orgId = await orgIdFor(tenantId);
  const [products, orders, coupons] = await Promise.all([
    listProducts(tenantId, orgId), listOrders(tenantId, orgId), listCoupons(tenantId, orgId),
  ]);
  return (
    products.filter((p) => p.createdBy === COMMERCE_SHOWCASE_ACTOR).length +
    orders.filter((o) => o.createdBy === COMMERCE_SHOWCASE_ACTOR).length +
    coupons.filter((c) => c.code === SHOWCASE_COUPON.code).length
  );
}

export async function seedCommerceShowcase(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await gateOpen(tenantId))) return { created: 0, details: { skipped: 'commerce feature is off' } };
  const orgId = await orgIdFor(tenantId);
  let created = 0;

  // Products — create only the missing ones (idempotent by actor + name).
  const existing = await listProducts(tenantId, orgId);
  const byKey = new Map<string, string>(); // showcase key → productId
  for (const sp of SHOWCASE_PRODUCTS) {
    const found = existing.find((p) => p.createdBy === COMMERCE_SHOWCASE_ACTOR && p.name === sp.name);
    if (found) { byKey.set(sp.key, found.productId); continue; }
    const p = await createProduct({
      tenantId, orgId, createdBy: COMMERCE_SHOWCASE_ACTOR,
      type: sp.type, name: sp.name, description: sp.description,
      price: sp.price, currency: sp.currency,
      inventory: sp.inventory, lowStockThreshold: sp.lowStockThreshold,
      variants: sp.variants,
    });
    byKey.set(sp.key, p.productId);
    created += 1;
  }

  // Coupon — one canonical code.
  const hasCoupon = (await listCoupons(tenantId, orgId)).some((c) => c.code === SHOWCASE_COUPON.code);
  if (!hasCoupon) {
    await createCoupon({ tenantId, orgId, code: SHOWCASE_COUPON.code, type: SHOWCASE_COUPON.type, value: SHOWCASE_COUPON.value });
    created += 1;
  }

  // Orders — only when NO showcase orders exist yet (orders mutate inventory, so
  // per-order diffing can't be made idempotent; all-or-nothing is the honest unit).
  // A mid-batch failure rolls the batch's orders back so a re-seed starts clean —
  // otherwise `hasOrders` would short-circuit forever on a partial batch. (Inventory
  // decremented by a rolled-back paid order is not restored; demo recovery is
  // clear + re-seed, which recreates the products at their seed inventory.)
  const hasOrders = (await listOrders(tenantId, orgId)).some((o) => o.createdBy === COMMERCE_SHOWCASE_ACTOR);
  if (!hasOrders) {
    const batch: string[] = [];
    try {
      for (const so of SHOWCASE_ORDERS) {
        const lines = so.lines.map((l) => ({ productId: byKey.get(l.productKey)!, quantity: l.quantity }));
        const order = await createOrder({
          tenantId, orgId, createdBy: COMMERCE_SHOWCASE_ACTOR,
          ...(so.couponCode ? { couponCode: so.couponCode } : {}), lines,
        });
        batch.push(order.orderId);
        if (so.advanceTo === 'paid' || so.advanceTo === 'fulfilled') {
          // Keyless demo intent → honest `paymentVerification:'none'` posture.
          await markAsPaid(tenantId, orgId, order.orderId, so.demoPaymentIntentId ?? 'demo:pi_showcase');
        }
        if (so.advanceTo === 'fulfilled') {
          for (const fs of ['processing', 'shipped', 'delivered'] as FulfillmentStatus[]) {
            await updateFulfillment(tenantId, orgId, order.orderId, fs);
          }
        }
        created += 1;
      }
    } catch (err) {
      for (const orderId of batch) {
        try { await deleteOrder(tenantId, orgId, orderId); created -= 1; } catch { /* best-effort rollback */ }
      }
      throw err;
    }
  }

  log.info('commerce showcase seeded', { tenantId, created });
  return { created, details: { products: byKey.size, orders: SHOWCASE_ORDERS.length } };
}

export async function clearCommerceShowcase(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  // Clear is by MARKER, not by toggle state — an admin who turned commerce off can
  // still clean demo rows out. But listing needs the service; commerce reads have no
  // toggle gate inside the service layer, so this works regardless of toggle state.
  const orgId = await orgIdFor(tenantId);
  let cleared = 0;
  // Orders FIRST (so a partial failure never strands orders referencing deleted products).
  for (const o of (await listOrders(tenantId, orgId)).filter((x) => x.createdBy === COMMERCE_SHOWCASE_ACTOR)) {
    if (await deleteOrder(tenantId, orgId, o.orderId)) cleared += 1;
  }
  for (const p of (await listProducts(tenantId, orgId)).filter((x) => x.createdBy === COMMERCE_SHOWCASE_ACTOR)) {
    if (await deleteProduct(tenantId, orgId, p.productId)) cleared += 1;
  }
  for (const c of (await listCoupons(tenantId, orgId)).filter((x) => x.code === SHOWCASE_COUPON.code)) {
    if (await deleteCoupon(tenantId, orgId, c.couponId)) cleared += 1;
  }
  log.info('commerce showcase cleared', { tenantId, cleared });
  return { cleared };
}
