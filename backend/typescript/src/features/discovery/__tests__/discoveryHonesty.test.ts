/**
 * Discovery ROUND 2 (UX_UPGRADE-product-discovery, pass 2) — the seams where the
 * console told a merchandiser something that was not true.
 *
 *  - PD2-1  a price bound only applies within its own currency, and needs one
 *  - PD2-3  the search reports the MATCH count, not the page cap
 *  - PD2-6  `boost.factor` is read (1.05 and 10 are no longer identical)
 *  - PD2-5  a broken vector store degrades to lexical instead of 500ing
 *
 * Sabotage witnesses (w74, re-witnessed w102 after #5469; discoveryService.ts): comparing a bound across currencies reds
 * both PD2-1 selection cases; accepting a bound with no currency reds the intake case;
 * capping `total` at the page reds PD2-3 case 1, and a `truncated` that fires on any
 * match reds case 2; skipping the degraded-rule report reds B2; accepting factor 0 reds
 * I1 (refuse), storing the raw factor reds I1 (clamp); reading `p.currency` without a
 * fallback reds I4; ranking a boost hit at 0 (teleport) reds the gentle case, and
 * ignoring the factor reds gentle + large (+ the exact-order determinism case);
 * re-throwing the embedding failure reds PD2-5 (whose spy is asserted to have fired).
 * One cast remains (I4): the claim IS a row the `Product` type forbids (TST-DXF-3).
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
    // Type-legal: `FacetPredicate.currency` is optional, which is exactly what a pre-R2 row looks like.
    const legacy: MerchRule = {
      ruleId: 'r-legacy', tenantId: T, orgId: ORG, name: 'Hide cheap', scope: 'all',
      actions: [{ kind: 'hide', predicate: { maxPrice: 50 } }],
      active: true, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const out = applyMerchRules([cheap], [legacy], 'all');
    expect(out.degradedRuleIds).toEqual(['r-legacy']); // reported, not silent
    expect(out.appliedRuleIds).toEqual([]);
    expect(out.products.map((p) => p.productId)).toEqual([cheap.productId]); // skipped, not applied
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
    const hideCheap: MerchRule = {
      ruleId: 'r-x', tenantId: T, orgId: ORG, name: 'Hide cheap', scope: 'all',
      actions: [{ kind: 'hide', predicate: { maxPrice: 50, currency: 'USD' } }],
      active: true, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const out = applyMerchRules([noCurrency], [hideCheap], 'all');
    // A row with no currency is not comparable to a USD bound, so it is NOT hidden.
    expect(out.products.map((x) => x.productId)).toEqual([p.productId]);
    expect(out.appliedRuleIds).toEqual([]);
    expect(out.degradedRuleIds).toEqual([]);
  });
});

describe('PD2-6 — boost.factor is actually read', () => {
  const rule = (factor: number): MerchRule => ({
    ruleId: `r-${factor}`, tenantId: T, orgId: ORG, name: `boost ${factor}`, scope: 'all',
    actions: [{ kind: 'boost', predicate: { categories: ['promo'] }, factor }],
    active: true, createdBy: 'u', createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  });
  // Real product rows (one created product, re-keyed) — no cast. Ranks are 1-based: a..d
  // are 1..4, the promo row `e` is rank 5, and a boost moves it to rank 5 / factor.
  const list = (base: Product): Product[] => [
    ...['a', 'b', 'c', 'd'].map((productId) => ({ ...base, productId, categories: ['plain'] })),
    { ...base, productId: 'e', categories: ['promo'] },
  ];

  it('a gentle factor NUDGES; it does not teleport the match to the front', async () => {
    const base = await mk('base', 10, 'USD');
    const out = applyMerchRules(list(base), [rule(1.5)], 'all').products.map((p) => p.productId);
    // 5 / 1.5 = 3.33 — past c (3), before d (4): it moves up, but does not win the top slot.
    expect(out).toEqual(['a', 'b', 'c', 'e', 'd']);
  });

  it('a large factor DOES promote to the front — the two are distinguishable', async () => {
    const base = await mk('base', 10, 'USD');
    const out = applyMerchRules(list(base), [rule(10)], 'all').products.map((p) => p.productId);
    expect(out).toEqual(['e', 'a', 'b', 'c', 'd']); // 5 / 10 = 0.5
  });

  it('the transform is deterministic (the holdout cohort depends on it)', async () => {
    const base = await mk('base', 10, 'USD');
    const once = applyMerchRules(list(base), [rule(2)], 'all').products.map((p) => p.productId);
    const twice = applyMerchRules(list(base), [rule(2)], 'all').products.map((p) => p.productId);
    expect(once).toEqual(['a', 'b', 'e', 'c', 'd']); // 5 / 2 = 2.5 — a fixed, stated order
    expect(twice).toEqual(once);
  });
});

describe('PD2-5 — a broken vector store must not take down keyword search', () => {
  it('degrades to lexical instead of rejecting the search', async () => {
    await mk('Findable', 10, 'USD');
    const spy = vi.spyOn(embeddings, 'ensureProductEmbeddingsFresh').mockRejectedValue(new Error('vector store down'));

    const res = await searchProducts({ tenantId: T, orgId: ORG, q: 'Findable' });
    expect(spy).toHaveBeenCalledTimes(1); // the failure was really injected
    expect(res.products.map((p) => p.name)).toEqual(['Findable']);
  });
});
