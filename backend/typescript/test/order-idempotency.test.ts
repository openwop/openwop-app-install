/**
 * GEN-2d — createOrder client idempotency (Option B: the money-safe CAS claim).
 *
 * A retried checkout / double-submit previously minted a 2nd order AND a 2nd
 * reserve-on-create stock decrement — and the release path restores an order's line
 * qty only ONCE, so a double-reserve permanently leaked inventory. An optional
 * `idempotencyKey` claims a `commerce:order-idem` slot (insert-if-absent CAS) BEFORE
 * any stock is reserved, so:
 *   - a retry returns the ONE order (inventory decremented once);
 *   - a concurrent same-key create never double-reserves;
 *   - a failed create releases the claim so a corrected retry proceeds.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createProduct, createOrder, getProduct } from '../src/features/commerce/commerceService.js';
import type { Storage } from '../src/storage/storage.js';

const T = 'org:buyer';
const ORG = 'org:buyer';

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

async function physicalProduct(inventory: number): Promise<string> {
  const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'physical', name: 'Widget', price: 10, currency: 'USD', inventory });
  return p.productId;
}
const inventoryOf = async (productId: string): Promise<number | undefined> => (await getProduct(T, ORG, productId))?.inventory;

describe('GEN-2d — createOrder idempotency key', () => {
  it('a repeated key (sequential retry) returns ONE order and reserves stock ONCE', async () => {
    const productId = await physicalProduct(10);
    const lines = [{ productId, quantity: 3 }];

    const a = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines, idempotencyKey: 'ik-1' });
    const b = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines, idempotencyKey: 'ik-1' }); // retry

    expect(b.orderId).toBe(a.orderId); // same order, not a second
    expect(await inventoryOf(productId)).toBe(7); // reserved ONCE (10 − 3), not twice
  });

  it('a CONCURRENT same-key create never double-reserves (the case Option A would leak)', async () => {
    const productId = await physicalProduct(10);
    const lines = [{ productId, quantity: 3 }];

    const results = await Promise.allSettled([
      createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines, idempotencyKey: 'ik-c' }),
      createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines, idempotencyKey: 'ik-c' }),
    ]);
    const orderIds = new Set(
      results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.orderId] : [])),
    );
    // At least one succeeds; any that don't threw idempotency_key_conflict (409) — never a 2nd order.
    expect(orderIds.size).toBe(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'idempotency_key_conflict' });
    }
    // The decisive assertion: stock reserved exactly ONCE despite two concurrent creates.
    expect(await inventoryOf(productId)).toBe(7);
  });

  it('different keys / keyless mint distinct orders (unchanged behavior)', async () => {
    const productId = await physicalProduct(20);
    const lines = [{ productId, quantity: 1 }];
    const a = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines, idempotencyKey: 'k-a' });
    const b = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines, idempotencyKey: 'k-b' });
    const c = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines }); // keyless
    const d = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines }); // keyless
    expect(new Set([a.orderId, b.orderId, c.orderId, d.orderId]).size).toBe(4);
    expect(await inventoryOf(productId)).toBe(16); // 20 − 4
  });

  it('the SAME key in a DIFFERENT tenant is a distinct claim', async () => {
    const p1 = await physicalProduct(5);
    const a = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p1, quantity: 1 }], idempotencyKey: 'shared' });
    // a second tenant with its own product + the same key
    const T2 = 'org:other';
    const p2 = (await createProduct({ tenantId: T2, orgId: T2, createdBy: 'u', type: 'physical', name: 'W2', price: 5, currency: 'USD', inventory: 5 })).productId;
    const b = await createOrder({ tenantId: T2, orgId: T2, createdBy: 'u', lines: [{ productId: p2, quantity: 1 }], idempotencyKey: 'shared' });
    expect(b.orderId).not.toBe(a.orderId);
  });

  it('a FAILED create releases the claim so a corrected retry with the same key succeeds', async () => {
    const productId = await physicalProduct(1); // only 1 in stock
    // First attempt over-orders → insufficient stock (throws), releasing the claim.
    await expect(createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId, quantity: 5 }], idempotencyKey: 'ik-retry' }))
      .rejects.toMatchObject({ httpStatus: 409, details: { code: 'out_of_stock' } });
    // Same key, now a satisfiable order → succeeds (the claim was not wedged).
    const ok = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId, quantity: 1 }], idempotencyKey: 'ik-retry' });
    expect(ok.orderId).toBeTruthy();
    expect(await inventoryOf(productId)).toBe(0);
  });
});
