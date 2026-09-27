/**
 * MERCH-D bundles (ADR 0276) — a bundle is a Product whose COMPONENTS are decremented:
 *  - ordering a bundle reserves each component (compQty × orderQty), not the bundle;
 *  - the line total allocates to components by resolved-price weight (refund attribution);
 *  - reservation is ALL-OR-NOTHING: a component shortfall rolls back the whole order;
 *  - nested bundles are rejected;
 *  - canceling a bundle order RESTORES component stock (symmetry with reserve-on-create).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import {
  createProduct, getProduct, createOrder, cancelOrder, __resetCommerce, type Product,
} from '../commerceService.js';

const T = 'default';
const ORG = 'org-bundle';
const phys = (name: string, price: number, inventory: number): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'physical', name, price, currency: 'USD', inventory });

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCommerce(); });

async function bundleOf(a: Product, b: Product, price: number): Promise<Product> {
  return createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'physical', name: 'Kit', price, currency: 'USD', kind: 'bundle', components: [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }] });
}

describe('MERCH-D bundles', () => {
  it('decrements components (not the bundle) and allocates the price by weight', async () => {
    const a = await phys('A', 60, 10);
    const b = await phys('B', 40, 5);
    const kit = await bundleOf(a, b, 100);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: kit.productId, quantity: 2 }] });
    expect((await getProduct(T, ORG, a.productId))?.inventory).toBe(8); // 10 - 2
    expect((await getProduct(T, ORG, b.productId))?.inventory).toBe(3); // 5 - 2
    const line = order.items[0]!;
    expect(line.bundleComponents).toHaveLength(2);
    const alloc = line.bundleComponents!;
    expect(alloc.find((c) => c.productId === a.productId)?.allocatedPrice).toBe(120); // 200 * 60/100
    expect(alloc.find((c) => c.productId === b.productId)?.allocatedPrice).toBe(80);  // 200 * 40/100
    expect(alloc.reduce((s, c) => s + c.allocatedPrice, 0)).toBe(200); // = line total
  });

  it('is all-or-nothing: a component shortfall rolls back the whole order', async () => {
    const a = await phys('A', 60, 10);
    const b = await phys('B', 40, 3);
    const kit = await bundleOf(a, b, 100);
    await expect(createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: kit.productId, quantity: 5 }] })).rejects.toThrow();
    // A was reserved (10→5) then rolled back to 10 when B (needs 5 > 3) failed.
    expect((await getProduct(T, ORG, a.productId))?.inventory).toBe(10);
    expect((await getProduct(T, ORG, b.productId))?.inventory).toBe(3);
  });

  it('rejects a nested bundle', async () => {
    const a = await phys('A', 60, 10);
    const b = await phys('B', 40, 10);
    const kit = await bundleOf(a, b, 100);
    const superKit = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'physical', name: 'Super', price: 200, currency: 'USD', kind: 'bundle', components: [{ productId: kit.productId, quantity: 1 }] });
    await expect(createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: superKit.productId, quantity: 1 }] })).rejects.toThrow();
  });

  it('restores component stock when the bundle order is canceled', async () => {
    const a = await phys('A', 60, 10);
    const b = await phys('B', 40, 5);
    const kit = await bundleOf(a, b, 100);
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: kit.productId, quantity: 2 }] });
    await cancelOrder(T, ORG, order.orderId);
    expect((await getProduct(T, ORG, a.productId))?.inventory).toBe(10); // restored
    expect((await getProduct(T, ORG, b.productId))?.inventory).toBe(5);
  });
});
