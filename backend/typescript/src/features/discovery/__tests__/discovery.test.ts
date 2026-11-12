/**
 * Discovery (ADR 0275 / MERCH-C):
 *  - a manual collection resolves its curated ids; a dynamic collection resolves
 *    LIVE from the catalog by facet predicate (ADR 0211, never materialized);
 *  - faceted search returns category/tag/typed-field facet counts + filters;
 *  - a pin/hide merch-rule re-orders/removes the ranked set (post-ranking transform);
 *  - a holdout control cohort (by sessionKey) sees the UNMODIFIED order.
 *
 * Sabotage witnesses (w74, re-witnessed w102 after #5469; discoveryService.ts): a manual collection returning the whole
 * catalog reds case 1; a dynamic one ignoring its predicate reds 2; dropping the
 * no-rule refusal reds 3; a category filter that keeps everything, or a facet count
 * stuck at 1, reds 4; a pin that appends instead of inserting, or a hide that keeps the
 * match, reds 5; removing the holdout skip reds 6 (whose no-sessionKey control proves
 * the rule is live and only the holdout skipped it).
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
    const camera = await mk('Camera', 100, ['photo']);
    const lens = await mk('Lens', 50, ['photo']);
    const mug = await mk('Mug', 10, ['home']);
    const col = await createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Photo gear', type: 'dynamic', rule: { categories: ['photo'] } });
    const products = await resolveCollection(T, ORG, col.collectionId);
    expect(products.map((p) => p.productId).sort()).toEqual([camera.productId, lens.productId].sort());
    expect(products.map((p) => p.productId)).not.toContain(mug.productId);
    // Adding a matching product later is reflected immediately (resolve-at-read).
    const wide = await mk('Wide lens', 80, ['photo']);
    const after = await resolveCollection(T, ORG, col.collectionId);
    expect(after.map((p) => p.productId)).toContain(wide.productId);
  });

  it('rejects a dynamic collection with no rule', async () => {
    await expect(createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'bad', type: 'dynamic' })).rejects.toThrow(/A dynamic collection needs a rule/);
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
    const pin = await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'pin B first', scope: 'all', actions: [{ kind: 'pin', productId: b.productId, position: 0 }] });
    const hide = await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'hide hidden', scope: 'all', actions: [{ kind: 'hide', predicate: { categories: ['hidden'] } }] });
    const rules = await listMerchRules(T, ORG);
    const { products, appliedRuleIds } = applyMerchRules(ranked, rules, 'all');
    expect(products.map((p) => p.productId)).toEqual([b.productId, a.productId]); // B pinned to front, C hidden
    expect([...appliedRuleIds].sort()).toEqual([pin.ruleId, hide.ruleId].sort());
  });

  it('holdout control cohort sees the unmodified ranking', async () => {
    const a = await mk('A', 10, ['x']);
    const b = await mk('B', 20, ['x']);
    const ranked = [a, b];
    const rule = await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'pin B', scope: 'all', actions: [{ kind: 'pin', productId: b.productId, position: 0 }], holdoutPct: 100 });
    const rules = await listMerchRules(T, ORG);
    // Positive control: with no sessionKey there is no cohort, so the rule applies — it is
    // live, and below only the holdout skips it.
    const live = applyMerchRules(ranked, rules, 'all');
    expect(live.products.map((p) => p.productId)).toEqual([b.productId, a.productId]);
    expect(live.appliedRuleIds).toEqual([rule.ruleId]);
    const { products, appliedRuleIds } = applyMerchRules(ranked, rules, 'all', 'sess-1');
    expect(products.map((p) => p.productId)).toEqual([a.productId, b.productId]); // untouched (100% control)
    expect(appliedRuleIds).toHaveLength(0);
  });
});
