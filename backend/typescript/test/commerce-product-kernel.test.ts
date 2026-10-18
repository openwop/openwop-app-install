/**
 * ADR 0410 Phase 1 — the product catalog lives in the content kernel. Pins: the
 * full Product round-trips via ext.product with queryable scalars + top-level
 * orgId; generic kernel writes are BLOCKED (money-truth: only the commerce
 * façade + ledger mutate inventory); and the migration is id-preserving.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, getProduct, migrateProductsToKernel, type Product } from '../src/features/commerce/commerceService.js';
import { getSystemEntity, createEntity, queryEntities } from '../src/features/entities/entitiesService.js';

const T = 'tenant-product-kernel';
const ORG = 'org-shop';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0410 Phase 1 — commerce.product on the kernel', () => {
  // The type flags (system / neverPublic / publicRead unset) and the anonymous-read 404 are
  // owned by commerce-product-public-leak-guard.test.ts, which asserts them with the
  // `entities` toggle ON and a positive control (here the toggle was off, so the 404 was
  // vacuous). Round-1 probe w39g3-leak-mint-publicread reds that file for the same edit
  // that red this one (w39g3-ker-mint-publicread).
  it('round-trips via ext.product with queryable scalars; cross-org get refused', async () => {
    const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u1', type: 'physical', name: 'Roaster', price: 199.99, currency: 'USD', inventory: 12, cost: 90 });

    const got = await getProduct(T, ORG, p.productId);
    expect(got).toMatchObject({ name: 'Roaster', price: 199.99, currency: 'USD', inventory: 12, cost: 90, orgId: ORG });

    const rec = await getSystemEntity(T, 'commerce.product', p.productId);
    expect(rec?.ext?.product).toMatchObject({ name: 'Roaster', productId: p.productId });
    expect(rec?.values.name).toBe('Roaster');
    expect(rec?.values.price).toBe(199.99);
    expect(rec?.values.inventory).toBe(12); // queryable stock projection
    expect(rec?.orgId).toBe(ORG);            // RI-7 org guard sees it

    // Generic query by org works internally; cross-org get refused (IDOR guard).
    const q = await queryEntities({ tenantId: T, typeName: 'commerce.product', filters: [{ key: 'org_id', op: 'eq', value: ORG }] });
    expect(q.entities.map((e) => e.values.name)).toContain('Roaster');
    expect(await getProduct(T, 'other-org', p.productId)).toBeNull();
  });

  it('MONEY-TRUTH: a generic kernel write to commerce.product is BLOCKED (only the façade + ledger mutate)', async () => {
    // Mint the type through the façade first: without it (case order shuffled) the write
    // fails as "Entity type not found", which is not the guard under test.
    await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u1', type: 'digital', name: 'Seed', price: 1, currency: 'USD' });
    await expect(createEntity({ tenantId: T, typeName: 'commerce.product', values: { name: 'Rogue' }, createdBy: 'attacker' }))
      .rejects.toThrow(/system type/);
  });

  it('migrates legacy commerce:product rows id-preservingly + idempotently', async () => {
    const legacy = new DurableCollection<Product>('commerce:product', (p) => p.productId, undefined, (p) => p.tenantId);
    await legacy.put({
      productId: 'prod:legacy-1', tenantId: 'tenant-legacy', orgId: 'org-legacy', type: 'digital',
      name: 'Old Ebook', price: 9.99, currency: 'USD', imageAssetTokens: [], downloadAssetTokens: ['tok-a'],
      variants: [], categories: ['books'], tags: ['sale'], active: true,
      createdBy: 'u0', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const first = await migrateProductsToKernel();
    expect(first.migrated).toBeGreaterThanOrEqual(1);
    expect((await migrateProductsToKernel()).migrated).toBe(0);
    const got = await getProduct('tenant-legacy', 'org-legacy', 'prod:legacy-1');
    expect(got).toMatchObject({ name: 'Old Ebook', price: 9.99, type: 'digital' });
    expect(got!.categories).toContain('books'); // arrays round-trip via ext.product
    expect(got!.downloadAssetTokens).toContain('tok-a');
  });
});
