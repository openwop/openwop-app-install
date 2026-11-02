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
 *
 * The concurrent case FORCES the race (a storage proxy parks the first
 * idempotency-claim read until the second caller has read too), so both callers
 * see "no claim" and the insert-if-absent CAS is the guard that decides.
 *
 * DOUBLE GUARDS, recorded (w74 round 1, measured):
 *   - concurrency: the CAS (`compareAndSwap(existing ?? null, claim)`) and the
 *     live-pending-claim 409 before it. Under the forced race only the CAS is
 *     reached, so neutralising the pending check alone stays green; a blind
 *     `put` in place of the CAS reds, and so does breaking both in one edit.
 *   - tenant: the claim key's `${tenantId}:${orgId}:` prefix, `resolveExisting`'s
 *     tenant checks, and the pending check's tenant check. Unscoping the key
 *     alone stays green; one edit that removes the key scope and both
 *     `resolveExisting` checks reds the cross-tenant case.
 *
 * Sabotage, each red (w74): returning nothing for a completed claim (a retry
 * mints a second order); not releasing the claim on failure (the corrected
 * retry 409s); routing keyless creates through one fixed key.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createProduct, createOrder, getProduct } from '../src/features/commerce/commerceService.js';
import type { Order } from '../src/features/commerce/commerceService.js';
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

    // Force the window: the first claim read parks until the second caller has
    // read as well, so BOTH observe "no claim yet" (2 s fallback so a broken
    // proxy cannot hang the case).
    let arrivals = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((r) => { release = r; });
    const fallback = setTimeout(() => release(), 2_000);
    const racing: Storage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'kvGet') {
          return async (...args: Parameters<Storage['kvGet']>) => {
            if (args[0].includes('commerce:order-idem:') && arrivals < 2) {
              arrivals += 1;
              if (arrivals === 2) release(); else await bothRead;
            }
            return target.kvGet(...args);
          };
        }
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    initHostExtPersistence(racing);
    let results: PromiseSettledResult<Order>[];
    try {
      results = await Promise.allSettled([
        createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines, idempotencyKey: 'ik-c' }),
        createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines, idempotencyKey: 'ik-c' }),
      ]);
    } finally {
      clearTimeout(fallback);
      initHostExtPersistence(storage);
    }
    expect(arrivals, 'both callers read the claim before either wrote it').toBe(2);

    // Exactly ONE order; the LOSER is the typed 409, not a second order.
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Order> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'idempotency_key_conflict', httpStatus: 409, details: { code: 'order_in_progress' } });
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
    expect(b.tenantId).toBe(T2);
    // Positive control: the same key in the SAME tenant is the same claim.
    const again = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p1, quantity: 1 }], idempotencyKey: 'shared' });
    expect(again.orderId).toBe(a.orderId);
    // Each tenant reserved its own stock once.
    expect(await inventoryOf(p1)).toBe(4);
    expect((await getProduct(T2, T2, p2))?.inventory).toBe(4);
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
