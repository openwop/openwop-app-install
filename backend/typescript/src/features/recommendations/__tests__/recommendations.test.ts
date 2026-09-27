/**
 * Recommendations (ADR 0273 / MERCH-A) — the conversion-layer core:
 *  - FBT ranks by mined co-occurrence (derived cache, ADR 0211);
 *  - upsell surfaces higher-priced same-category products;
 *  - holdout is sticky + a control cohort sees NO recs (lift is measurable);
 *  - a segment-targeted placement is INERT for an anonymous caller (the public
 *    IDOR invariant's service-level shadow — no contact ⇒ no targeted recs);
 *  - placement CRUD validates its closed vocabulary.
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { createProduct, createOrder, markAsPaid, __resetCommerce, type Product } from '../../commerce/commerceService.js';
import {
  createPlacement, updatePlacement, deletePlacement, listPlacements,
  resolveRecommendations, rebuildAffinity, __resetRecommendations,
} from '../recommendationsService.js';

const T = 'default';
const ORG = 'org-reco';
const mk = (name: string, price: number): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name, price, currency: 'USD', categories: ['photo'], tags: ['gear'] });

async function seed(): Promise<{ a: Product; b: Product; c: Product }> {
  const a = await mk('Camera', 100);
  const b = await mk('Lens', 50);
  const c = await mk('Tripod', 200);
  // R2 REC2-M3 — orders must be PAID to count. These fixtures left every order
  // `pending` (created-but-unpaid), so the suite was implicitly asserting that unpaid
  // carts shape recommendations — the defect, pinned as expected behaviour.
  const order = async (ps: Product[]): Promise<unknown> => {
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: ps.map((p) => ({ productId: p.productId, quantity: 1 })) });
    return markAsPaid(T, ORG, o.orderId, `demo:pi_${o.orderId}`, {});
  };
  await order([a, b]); // a+b co-occur twice
  await order([a, b]);
  await order([a, c]); // a+c once
  return { a, b, c };
}

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCommerce(); await __resetRecommendations(); });

describe('MERCH-A recommendations', () => {
  it('rebuilds affinity and ranks bought-together by co-occurrence', async () => {
    const { a, b, c } = await seed();
    await rebuildAffinity(T, ORG);
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'pdp', source: 'bought_together' });
    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'pdp', productId: a.productId });
    const ids = r.products.map((p) => p.productId);
    expect(ids).toContain(b.productId);
    expect(ids).toContain(c.productId);
    expect(ids.indexOf(b.productId)).toBeLessThan(ids.indexOf(c.productId)); // b (co=2) ranks above c (co=1)
    expect(ids).not.toContain(a.productId); // never recommend the anchor
  });

  it('upsell surfaces only higher-priced same-category products', async () => {
    const { a, b, c } = await seed();
    await rebuildAffinity(T, ORG);
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'pdp', source: 'upsell' });
    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'pdp', productId: a.productId });
    const ids = r.products.map((p) => p.productId);
    expect(ids).toContain(c.productId);      // Tripod 200 > Camera 100
    expect(ids).not.toContain(b.productId);  // Lens 50 < 100 excluded
    expect(r.products.every((p) => p.price > a.price)).toBe(true);
  });

  it('holdout control cohort sees no recs, deterministically (sticky by sessionKey)', async () => {
    const { a } = await seed();
    await rebuildAffinity(T, ORG);
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'pdp', source: 'bought_together', holdoutPct: 100 });
    const r1 = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'pdp', productId: a.productId, sessionKey: 'sess-1' });
    const r2 = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'pdp', productId: a.productId, sessionKey: 'sess-1' });
    expect(r1.variant).toBe('control');
    expect(r1.products).toHaveLength(0);
    expect(r2.variant).toBe('control'); // deterministic
  });

  it('segment-targeted placement is inert for an anonymous caller (IDOR-safe)', async () => {
    const { a } = await seed();
    await rebuildAffinity(T, ORG);
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'pdp', source: 'bought_together', segmentId: 'seg-x' });
    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'pdp', productId: a.productId }); // no contactId
    expect(r.products).toHaveLength(0);
    expect(r.placementId).toBeUndefined();
  });

  it('placement CRUD validates the closed slot/source vocabulary', async () => {
    const p = await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'cart', source: 'cross_sell' });
    expect(await listPlacements(T, ORG)).toHaveLength(1);
    await expect(createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'nope', source: 'cross_sell' })).rejects.toThrow();
    await expect(createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'cart', source: 'nope' })).rejects.toThrow();
    const upd = await updatePlacement(T, ORG, p.placementId, { active: false });
    expect(upd?.active).toBe(false);
    expect(await deletePlacement(T, ORG, p.placementId)).toBe(true);
    expect(await listPlacements(T, ORG)).toHaveLength(0);
  });
});
