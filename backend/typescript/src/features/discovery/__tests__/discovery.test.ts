/**
 * Discovery (ADR 0275 / MERCH-C):
 *  - a manual collection resolves its curated ids; a dynamic collection resolves
 *    LIVE from the catalog by facet predicate (ADR 0211, never materialized);
 *  - faceted search returns category/tag/typed-field facet counts + filters;
 *  - a pin/hide merch-rule re-orders/removes the ranked set (post-ranking transform);
 *  - a holdout control cohort (by sessionKey) sees the UNMODIFIED order.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { createProduct, __resetCommerce, type Product } from '../../commerce/commerceService.js';
import {
  createCollection, resolveCollection, createMerchRule, applyMerchRules,
  listMerchRules, searchProducts, __resetDiscovery,
} from '../discoveryService.js';

const T = 'default';
const ORG = 'org-disc';
const mk = (name: string, price: number, cats: string[], tags: string[] = []): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name, price, currency: 'USD', categories: cats, tags });

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCommerce(); await __resetDiscovery(); });

describe('MERCH-C discovery', () => {
  it('resolves a manual collection to its curated products', async () => {
    const a = await mk('Camera', 100, ['photo']);
    await mk('Lens', 50, ['photo']);
    const col = await createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Staff picks', type: 'manual', productIds: [a.productId] });
    const products = await resolveCollection(T, ORG, col.collectionId);
    expect(products.map((p) => p.productId)).toEqual([a.productId]);
  });

  it('resolves a dynamic collection LIVE by facet predicate', async () => {
    await mk('Camera', 100, ['photo']);
    await mk('Lens', 50, ['photo']);
    const mug = await mk('Mug', 10, ['home']);
    const col = await createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Photo gear', type: 'dynamic', rule: { categories: ['photo'] } });
    const products = await resolveCollection(T, ORG, col.collectionId);
    expect(products).toHaveLength(2);
    expect(products.map((p) => p.productId)).not.toContain(mug.productId);
    // Adding a matching product later is reflected immediately (resolve-at-read).
    const wide = await mk('Wide lens', 80, ['photo']);
    const after = await resolveCollection(T, ORG, col.collectionId);
    expect(after.map((p) => p.productId)).toContain(wide.productId);
  });

  it('rejects a dynamic collection with no rule', async () => {
    await expect(createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'bad', type: 'dynamic' })).rejects.toThrow();
  });

  it('faceted search returns facet counts and filters by category', async () => {
    await mk('Camera', 100, ['photo'], ['pro']);
    await mk('Lens', 50, ['photo'], ['pro']);
    await mk('Mug', 10, ['home']);
    const all = await searchProducts({ tenantId: T, orgId: ORG });
    const catFacet = all.facets.find((f) => f.key === 'category');
    expect(catFacet?.values.find((v) => v.value === 'photo')?.count).toBe(2);
    const filtered = await searchProducts({ tenantId: T, orgId: ORG, filters: { category: 'home' } });
    expect(filtered.products).toHaveLength(1);
    expect(filtered.products[0]?.name).toBe('Mug');
  });

  it('applies pin and hide merch-rules as a post-ranking transform', async () => {
    const a = await mk('A', 10, ['x']);
    const b = await mk('B', 20, ['x']);
    const c = await mk('C', 30, ['hidden']);
    const ranked = [a, b, c];
    await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'pin B first', scope: 'all', actions: [{ kind: 'pin', productId: b.productId, position: 0 }] });
    await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'hide hidden', scope: 'all', actions: [{ kind: 'hide', predicate: { categories: ['hidden'] } }] });
    const rules = await listMerchRules(T, ORG);
    const { products, appliedRuleIds } = applyMerchRules(ranked, rules, 'all');
    expect(products[0]?.productId).toBe(b.productId); // pinned to front
    expect(products.map((p) => p.productId)).not.toContain(c.productId); // hidden
    expect(appliedRuleIds).toHaveLength(2);
  });

  it('holdout control cohort sees the unmodified ranking', async () => {
    const a = await mk('A', 10, ['x']);
    const b = await mk('B', 20, ['x']);
    const ranked = [a, b];
    await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'pin B', scope: 'all', actions: [{ kind: 'pin', productId: b.productId, position: 0 }], holdoutPct: 100 });
    const rules = await listMerchRules(T, ORG);
    const { products, appliedRuleIds } = applyMerchRules(ranked, rules, 'all', 'sess-1');
    expect(products.map((p) => p.productId)).toEqual([a.productId, b.productId]); // untouched (100% control)
    expect(appliedRuleIds).toHaveLength(0);
  });
});
