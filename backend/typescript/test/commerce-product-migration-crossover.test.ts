/**
 * ADR 0410 Phase 2 — the money-path × migration crossover: a LEGACY product
 * (in the old `commerce:product` store) survives the id-preserving kernel
 * migration AND its inventory still reserves/decrements correctly through the
 * order path over the kernel (the stock ledger stays authoritative). This is
 * the one integration Phase 1's per-store honesty gate didn't compose end-to-end.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  createOrder, getProduct, migrateProductsToKernel, type Product,
} from '../src/features/commerce/commerceService.js';

const T = 'tenant-xover';
const ORG = 'org-xover';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0410 Phase 2 — legacy product survives migration + order still decrements inventory', () => {
  it('reserves inventory over the kernel for a migrated legacy product', async () => {
    // A physical product with stock, seeded in the LEGACY store (pre-kernel).
    const legacy = new DurableCollection<Product>('commerce:product', (p) => p.productId, undefined, (p) => p.tenantId);
    await legacy.put({
      productId: 'prod:xover-1', tenantId: T, orgId: ORG, type: 'physical',
      name: 'Beans 1kg', price: 24, currency: 'USD', inventory: 5, imageAssetTokens: [], downloadAssetTokens: [],
      variants: [], categories: [], tags: [], active: true,
      createdBy: 'u0', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    // The migration moves it to the kernel, id-preserving.
    await migrateProductsToKernel();
    expect((await getProduct(T, ORG, 'prod:xover-1'))?.inventory).toBe(5);

    // An order for 2 units reserves stock — the decrement runs through the
    // ledger CAS over the KERNEL row (casSystemEntity), not the legacy store.
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'buyer', lines: [{ productId: 'prod:xover-1', quantity: 2 }] });
    expect(order.status).toBe('pending');

    // Inventory decremented over the kernel; the order references the same id.
    expect((await getProduct(T, ORG, 'prod:xover-1'))?.inventory).toBe(3);
    expect(order.items.map((i) => i.productId)).toContain('prod:xover-1');
  });
});
