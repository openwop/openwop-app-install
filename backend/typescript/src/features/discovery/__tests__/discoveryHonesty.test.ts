/**
 * Discovery ROUND 2 (UX_UPGRADE-product-discovery, pass 2) — the seams where the
 * console told a merchandiser something that was not true.
 *
 *  - PD2-1  a price bound only applies within its own currency, and needs one
 *  - PD2-3  the search reports the MATCH count, not the page cap
 *  - PD2-6  `boost.factor` is read (1.05 and 10 are no longer identical)
 *  - PD2-5  a broken vector store degrades to lexical instead of 500ing
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { createProduct, __resetCommerce, type Product } from '../../commerce/commerceService.js';
import {
  createCollection, createMerchRule, resolveCollection, applyMerchRules, searchProducts, __resetDiscovery,
  type MerchRule,
} from '../discoveryService.js';
import * as embeddings from '../productEmbeddingIndex.js';

const T = 'default';
const ORG = 'org-disc-r2';

const mk = (name: string, price: number, currency: string, cats: string[] = ['all']): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name, price, currency, categories: cats });

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCommerce(); await __resetDiscovery(); vi.restoreAllMocks(); });

describe('PD2-1 — a price bound is denominated', () => {
  it('a "under 50" rule does not sweep in ¥50 (≈ $0.33) items', async () => {
    const cheapUsd = await mk('USD budget', 20, 'USD');
    await mk('USD premium', 400, 'USD');
    await mk('JPY cheap-looking', 50, 'JPY');     // ¥50 — pennies, not $50
    await mk('JPY genuinely cheap', 3000, 'JPY'); // ¥3,000 — the real budget item

    const col = await createCollection({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Under 50', type: 'dynamic',
      rule: { maxPrice: 50, currency: 'USD' },
    });
    const ids = (await resolveCollection(T, ORG, col.collectionId)).map((p) => p.productId);
    expect(ids).toEqual([cheapUsd.productId]); // the ¥ rows are not comparable, so they are out
  });

  it('the same bound in JPY selects the JPY row instead', async () => {
    await mk('USD budget', 20, 'USD');
    const jpy = await mk('JPY genuinely cheap', 3000, 'JPY');
    const col = await createCollection({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Under 5000 JPY', type: 'dynamic',
      rule: { maxPrice: 5000, currency: 'JPY' },
    });
    expect((await resolveCollection(T, ORG, col.collectionId)).map((p) => p.productId)).toEqual([jpy.productId]);
  });

  it('a price bound with NO currency is refused at intake', async () => {
    await expect(createCollection({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Under 50', type: 'dynamic',
      rule: { maxPrice: 50 },
    })).rejects.toThrow(/needs a `currency`/i);
  });
});

describe('PD2-3 — the response states the match count, not the page', () => {
  it('reports `total` above the cap, and flags the truncation', async () => {
    for (let i = 0; i < 55; i++) await mk(`Widget ${i}`, 10, 'USD');
    const res = await searchProducts({ tenantId: T, orgId: ORG });
    expect(res.products).toHaveLength(48);  // the page
    expect(res.total).toBe(55);             // the truth
    expect(res.truncated).toBe(true);
  });

  it('a result set that fits is not flagged (the disclosure must not become noise)', async () => {
    await mk('Only one', 10, 'USD');
    const res = await searchProducts({ tenantId: T, orgId: ORG });
    expect(res.total).toBe(1);
    expect(res.truncated).toBe(false);
    expect(res.hiddenByRules).toBe(0);
  });
});

describe('review fold-ins — defects the independent pass found in the fix', () => {
  it('B2: a legacy price bound (no currency) DEGRADES the rule loudly instead of silently un-hiding', async () => {
    const cheap = await mk('Cheap', 10, 'USD');
    await mk('Dear', 900, 'USD');
    // A rule stored before R2 carries a bound with no currency. "Matches nothing" is
    // NOT fail-closed for a HIDE rule — it means hide nothing, so suppressed inventory
    // silently returns to the public storefront.
    const legacy = {
      ruleId: 'r-legacy', tenantId: T, orgId: ORG, name: 'Hide cheap', scope: 'all',
      actions: [{ kind: 'hide', predicate: { maxPrice: 50 } }],
      active: true, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as MerchRule;

    const out = applyMerchRules([cheap], [legacy], 'all');
    expect(out.degradedRuleIds).toEqual(['r-legacy']); // reported, not silent
    expect(out.appliedRuleIds).toEqual([]);
  });

  it('I1: a boost factor of 0 or below is REFUSED at intake, not stored and clamped later', async () => {
    await expect(createMerchRule({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Bad boost', scope: 'all',
      actions: [{ kind: 'boost', predicate: { categories: ['all'] }, factor: 0 }],
    })).rejects.toThrow(/greater than 0/i);
  });

  it('I1: a factor above the clamp is STORED clamped — what you read back is what applies', async () => {
    const r = await createMerchRule({
      tenantId: T, orgId: ORG, createdBy: 'u', name: 'Huge boost', scope: 'all',
      actions: [{ kind: 'boost', predicate: { categories: ['all'] }, factor: 5000 }],
    });
    expect((r.actions[0] as { factor: number }).factor).toBe(100);
  });

  it('I4: a legacy product row with no currency does not crash the public search', async () => {
    const p = await mk('Legacy', 10, 'USD');
    const noCurrency = { ...p, currency: undefined } as unknown as Product;
    // The predicate path used to call `p.currency.toUpperCase()` — a 500 on the
    // unauthenticated storefront, the exact failure mode PD2-5 was fixed to prevent.
    expect(() => applyMerchRules([noCurrency], [{
      ruleId: 'r-x', tenantId: T, orgId: ORG, name: 'Hide cheap', scope: 'all',
      actions: [{ kind: 'hide', predicate: { maxPrice: 50, currency: 'USD' } }],
      active: true, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as MerchRule], 'all')).not.toThrow();
  });
});

describe('PD2-6 — boost.factor is actually read', () => {
  const rule = (factor: number): MerchRule => ({
    ruleId: `r-${factor}`, tenantId: T, orgId: ORG, name: `boost ${factor}`, scope: 'all',
    actions: [{ kind: 'boost', predicate: { categories: ['promo'] }, factor }],
    active: true, createdBy: 'u', createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  });
  const list = (): Product[] => ([
    { productId: 'a', categories: ['plain'] }, { productId: 'b', categories: ['plain'] },
    { productId: 'c', categories: ['plain'] }, { productId: 'd', categories: ['plain'] },
    { productId: 'e', categories: ['promo'] },
  ] as unknown as Product[]);

  it('a gentle factor NUDGES; it does not teleport the match to the front', async () => {
    const out = applyMerchRules(list(), [rule(1.5)], 'all').products.map((p) => p.productId);
    expect(out[0]).not.toBe('e');   // a 1.5× nudge must not win the top slot outright
    expect(out.indexOf('e')).toBeLessThan(4); // …but it does move up
  });

  it('a large factor DOES promote to the front — the two are distinguishable', async () => {
    const out = applyMerchRules(list(), [rule(10)], 'all').products.map((p) => p.productId);
    expect(out[0]).toBe('e');
  });

  it('the transform is deterministic (the holdout cohort depends on it)', async () => {
    const once = applyMerchRules(list(), [rule(2)], 'all').products.map((p) => p.productId);
    const twice = applyMerchRules(list(), [rule(2)], 'all').products.map((p) => p.productId);
    expect(once).toEqual(twice);
  });
});

describe('PD2-5 — a broken vector store must not take down keyword search', () => {
  it('degrades to lexical instead of rejecting the search', async () => {
    await mk('Findable', 10, 'USD');
    vi.spyOn(embeddings, 'ensureProductEmbeddingsFresh').mockRejectedValue(new Error('vector store down'));

    const res = await searchProducts({ tenantId: T, orgId: ORG, q: 'Findable' });
    expect(res.products.map((p) => p.name)).toContain('Findable');
  });
});
