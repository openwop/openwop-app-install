/**
 * R3 M4 (freshness half) — `computedAt` was written by the rebuild and read by
 * NOTHING: a store serving last quarter's frozen affinity looked identical to
 * a fresh one. The resolve now carries `affinityComputedAt` (the newest stamp
 * among the affinity rows it consumed); absent when none contributed.
 *
 * The clock is faked (Date only) so the stamp is asserted EXACTLY: the first
 * rebuild at T1 stamps T1, a later rebuild at T2 restamps T2 (not frozen at the
 * first, not fabricated at resolve time). Sabotage-witnessed (/grade-tests 8f
 * wave 1): the field dropped (8fw1g3-rec-field), a stamp fabricated with no
 * affinity (rec-fabricated), a frozen stamp (rec-frozen).
 *
 * HONEST CEILING — "the NEWEST stamp" among several rows cannot be shown here:
 * `rebuildAffinity` rewrites every row of an org with ONE `computedAt`, and its
 * removal pass drops rows that no longer qualify, so no public-API fixture holds
 * two rows with different stamps in one org. A resolve picking the oldest row
 * instead of the newest is therefore indistinguishable (8fw1g3-rec-newest,
 * vacuous by construction). The case title claims only the rebuild stamp.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createProduct, createOrder, markAsPaid, __resetCommerce } from '../src/features/commerce/commerceService.js';
import {
  createPlacement, rebuildAffinity, resolveRecommendations, __resetRecommendations,
} from '../src/features/recommendations/recommendationsService.js';

const T = 'tenant-raf';
const ORG = 'org-raf';
const BY = 'user-raf';
const T1 = '2026-03-01T00:00:00.000Z';
const T2 = '2026-03-08T12:30:00.000Z';

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
beforeEach(async () => { await __resetCommerce(); await __resetRecommendations(); });
afterEach(() => { vi.useRealTimers(); });

describe('R3 M4 — the resolve reports the freshness of the affinity it consumed', () => {
  it('carries the rebuild stamp as affinityComputedAt (restamped by a later rebuild); omits it when no affinity exists', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T1));
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
    expect(after.affinityComputedAt).toBe(T1);

    // A later rebuild restamps: the resolve reports T2, not the first stamp.
    vi.setSystemTime(new Date(T2));
    await rebuildAffinity(T, ORG);
    const later = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'home' });
    expect(later.affinityComputedAt).toBe(T2);
  });
});
