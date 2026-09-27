/**
 * Commerce showcase seeder (ecommerce gap-analysis Phase A / A3) — proves the demo:
 *   - seeds 4 products (physical w/ variants, a deliberately LOW-STOCK physical,
 *     digital, service) + 1 coupon + 3 lifecycle orders (pending / paid /
 *     delivered→fulfilled) through commerceService ONLY (lifecycle guards +
 *     inventory math hold);
 *   - toggle-gated (skips when `commerce` is off — never flips toggles),
 *     idempotent, and clears only its own marker-carrying entities.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  seedCommerceShowcase,
  clearCommerceShowcase,
  countCommerceShowcase,
} from '../src/host/commerceShowcaseSeed.js';
import { COMMERCE_SHOWCASE_ACTOR, SHOWCASE_COUPON } from '../src/host/seed-data/commerceShowcase.js';
import { listProducts, listOrders, listCoupons, createProduct } from '../src/features/commerce/commerceService.js';

let server: http.Server;
const TENANT = 'user:commerce-showcase-test';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_DEMO_MODE = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => {
  delete process.env.OPENWOP_DEMO_MODE;
  await new Promise<void>((res) => server.close(() => res()));
});

async function setToggle(status: 'on' | 'off') {
  const d = getToggleDefault('commerce');
  if (d) await saveConfig({ ...d, status }, 'test');
}

describe('commerce showcase seeder', () => {
  it('skips when the commerce toggle is off (and never flips it)', async () => {
    await setToggle('off');
    const r = await seedCommerceShowcase(TENANT);
    expect(r.created).toBe(0);
    expect(r.details).toMatchObject({ skipped: 'commerce feature is off' });
    expect(await countCommerceShowcase(TENANT)).toBe(0);
  });

  it('seeds products + coupon + lifecycle orders through the service, idempotently, and clears only its own', async () => {
    await setToggle('on');
    const r = await seedCommerceShowcase(TENANT);
    expect(r.created).toBe(4 + 1 + 3); // products + coupon + orders

    // No orgs exist for this tenant → org falls back to the tenant id.
    const orgId = TENANT;
    const products = (await listProducts(TENANT, orgId)).filter((p) => p.createdBy === COMMERCE_SHOWCASE_ACTOR);
    expect(products).toHaveLength(4);
    expect(new Set(products.map((p) => p.type))).toEqual(new Set(['physical', 'digital', 'service']));

    // The espresso blend is deliberately under its threshold (low-stock surface demo)…
    const espresso = products.find((p) => p.name.includes('Espresso'))!;
    expect(espresso.inventory).toBeLessThan(espresso.lowStockThreshold ?? 0);
    // …minus the 1 unit the fulfilled order RESERVED at create (C5: reserve-on-create,
    // consumed at pay — 6 seeded − 1).
    expect(espresso.inventory).toBe(5);

    // The flagship physical product carries variants with SKUs; C5 reserves stock at
    // order CREATE, so both the pending order (2) and the fulfilled order (1) hold
    // units: 120 − 2 − 1 = 117.
    const flagship = products.find((p) => p.name.includes('Medium Roast'))!;
    expect(flagship.variants.length).toBe(2);
    expect(flagship.variants.every((v) => v.sku)).toBe(true);
    expect(flagship.inventory).toBe(117);

    // Orders: one pending (coupon-discounted), one paid digital, one fulfilled.
    const orders = (await listOrders(TENANT, orgId)).filter((o) => o.createdBy === COMMERCE_SHOWCASE_ACTOR);
    expect(orders).toHaveLength(3);
    const pending = orders.find((o) => o.status === 'pending')!;
    expect(pending.couponCode).toBe(SHOWCASE_COUPON.code);
    expect(pending.discount).toBeGreaterThan(0);
    const paid = orders.find((o) => o.status === 'paid')!;
    expect(paid.paymentIntentId).toMatch(/^demo:/);
    const fulfilled = orders.find((o) => o.status === 'fulfilled')!;
    expect(fulfilled.fulfillmentStatus).toBe('delivered');

    // Coupon present.
    expect((await listCoupons(TENANT, orgId)).some((c) => c.code === SHOWCASE_COUPON.code)).toBe(true);

    // Idempotent: re-seed creates nothing new (orders would double inventory math).
    const again = await seedCommerceShowcase(TENANT);
    expect(again.created).toBe(0);
    expect((await listOrders(TENANT, orgId)).filter((o) => o.createdBy === COMMERCE_SHOWCASE_ACTOR)).toHaveLength(3);

    // Clear removes ONLY marker-carrying entities — a user-authored product survives.
    const userProduct = await createProduct({ tenantId: TENANT, orgId, createdBy: 'user:real', type: 'physical', name: 'My Own Thing', price: 5, currency: 'USD' });
    const cleared = await clearCommerceShowcase(TENANT);
    expect(cleared.cleared).toBe(4 + 1 + 3);
    expect(await countCommerceShowcase(TENANT)).toBe(0);
    const remaining = await listProducts(TENANT, orgId);
    expect(remaining.map((p) => p.productId)).toEqual([userProduct.productId]);
  });
});
