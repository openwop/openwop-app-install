/**
 * R3 M4 (freshness half) — `computedAt` was written by the rebuild and read by
 * NOTHING: a store serving last quarter's frozen affinity looked identical to
 * a fresh one. The resolve now carries `affinityComputedAt` (the newest stamp
 * among the affinity rows it consumed); absent when none contributed.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createProduct, createOrder, markAsPaid, __resetCommerce } from '../src/features/commerce/commerceService.js';
import {
  createPlacement, rebuildAffinity, resolveRecommendations, __resetRecommendations,
} from '../src/features/recommendations/recommendationsService.js';

const T = 'tenant-raf';
const ORG = 'org-raf';
const BY = 'user-raf';

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
beforeEach(async () => { await __resetCommerce(); await __resetRecommendations(); });

describe('R3 M4 — the resolve reports the freshness of the affinity it consumed', () => {
  it('carries affinityComputedAt after a rebuild; omits it when no affinity exists', async () => {
    const a = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'Alpha', price: 10, currency: 'USD' });
    const b = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'digital', name: 'Beta', price: 12, currency: 'USD' });
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: BY, slot: 'home', source: 'trending' });

    // No affinity yet — the stamp must be ABSENT, not fabricated.
    const before = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'home' });
    expect(before.affinityComputedAt).toBeUndefined();

    // A settled order feeds the rebuild (unpaid carts are noise — R2 M3).
    const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, lines: [{ productId: a.productId, quantity: 1 }, { productId: b.productId, quantity: 1 }] });
    await markAsPaid(T, ORG, o.orderId, 'pi-raf');
    await rebuildAffinity(T, ORG);

    const after = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'home' });
    expect(after.affinityComputedAt).toBeTruthy();
    expect(Date.parse(after.affinityComputedAt!)).toBeGreaterThan(Date.now() - 60_000); // fresh, not frozen
  });
});
