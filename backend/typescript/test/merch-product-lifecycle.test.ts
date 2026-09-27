/**
 * RI-4 (grade-data / ADR 0279) — deleting a commerce product prunes the merch
 * features' soft references through the REAL product-lifecycle seam:
 *  - discovery: the id leaves manual collections; pin actions referencing it are
 *    stripped (a rule whose actions empty is DEACTIVATED, not deleted);
 *    predicate actions untouched.
 *  - promotions: the id leaves scope.productIds; a promotion whose product scope
 *    empties is DEACTIVATED (disable-don't-destroy); category/all scopes and
 *    other ids survive.
 * Bystander refs to OTHER products are untouched; a re-fire is a no-op.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, deleteProduct } from '../src/features/commerce/commerceService.js';
import { createCollection, getCollection, createMerchRule, listMerchRules, pruneProductRefs as prunedDiscovery } from '../src/features/discovery/discoveryService.js';
import { createPromotion, getPromotion } from '../src/features/promotions/promotionsService.js';
import { onProductDeleted } from '../src/features/commerce/productLifecycleSeam.js';
import { pruneProductRefs as prunePromotions } from '../src/features/promotions/promotionsService.js';

const T = 'merch-lc-t1';
const ORG = 'org-merch-lc';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // The feature modules register these hooks in registerRoutes (app boot); this
  // service-level suite registers the SAME consumers explicitly (keyed — a real
  // boot would overwrite, not stack).
  onProductDeleted('discovery', async ({ tenantId, orgId, productId }) => { await prunedDiscovery(tenantId, orgId, productId); });
  onProductDeleted('promotions', async ({ tenantId, orgId, productId }) => { await prunePromotions(tenantId, orgId, productId); });
});

describe('merch product-lifecycle consumers (RI-4)', () => {
  it('deleteProduct prunes collections/pins/promotion scopes; deactivates emptied configs; bystanders intact', async () => {
    const doomed = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'test', type: 'physical', name: 'Doomed Bean', price: 1800 });
    const keeper = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'test', type: 'physical', name: 'Keeper Bean', price: 1600 });

    const col = await createCollection({ tenantId: T, orgId: ORG, createdBy: 'test', name: 'Front Page', type: 'manual', productIds: [doomed.productId, keeper.productId] });
    const pinOnly = await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'test', name: 'Pin doomed', scope: 'all', actions: [{ kind: 'pin', productId: doomed.productId, position: 1 }] });
    const mixed = await createMerchRule({
      tenantId: T, orgId: ORG, createdBy: 'test', name: 'Pin + bury', scope: 'all',
      actions: [{ kind: 'pin', productId: doomed.productId, position: 2 }, { kind: 'bury', predicate: { tags: ['stale'] } }],
    });

    const scopedOnly = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'test', name: 'Doomed only', type: 'product_discount', reward: { kind: 'percent', value: 10 }, scope: { productIds: [doomed.productId] } });
    const scopedBoth = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'test', name: 'Both beans', type: 'product_discount', reward: { kind: 'percent', value: 5 }, scope: { productIds: [doomed.productId, keeper.productId] } });

    expect(await deleteProduct(T, ORG, doomed.productId)).toBe(true);

    // Discovery: collection keeps only the keeper.
    expect((await getCollection(T, ORG, col.collectionId))?.productIds).toEqual([keeper.productId]);
    const rules = await listMerchRules(T, ORG);
    const pinOnlyAfter = rules.find((r) => r.ruleId === pinOnly.ruleId)!;
    expect(pinOnlyAfter.actions).toHaveLength(0);
    expect(pinOnlyAfter.active).toBe(false); // emptied ⇒ deactivated, not deleted
    const mixedAfter = rules.find((r) => r.ruleId === mixed.ruleId)!;
    expect(mixedAfter.actions).toEqual([{ kind: 'bury', predicate: { tags: ['stale'] } }]);
    expect(mixedAfter.active).toBe(true); // predicate action survives, rule stays live

    // Promotions: emptied scope deactivates; shared scope shrinks and stays live.
    const soloAfter = (await getPromotion(T, ORG, scopedOnly.promotionId))!;
    expect(soloAfter.scope?.productIds).toEqual([]);
    expect(soloAfter.active).toBe(false);
    const bothAfter = (await getPromotion(T, ORG, scopedBoth.promotionId))!;
    expect(bothAfter.scope?.productIds).toEqual([keeper.productId]);
    expect(bothAfter.active).toBe(true);

    // Idempotent re-fire finds nothing.
    expect(await prunedDiscovery(T, ORG, doomed.productId)).toEqual({ collections: 0, rules: 0 });
    expect(await prunePromotions(T, ORG, doomed.productId)).toBe(0);
  });
});
