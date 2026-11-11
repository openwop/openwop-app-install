/**
 * ADR 1025 D5/D8/D9 — discovery (row 74, MCHWF-5/8/9).
 *
 *  - D5  a merch rule can be paused and re-activated (rules had create + delete only), and
 *        an `active:false` rule changes nothing a search returns;
 *  - D8  a PAUSED collection resolves empty on every search lane (it used to resolve on the
 *        public route); `parentId` is checked on create and update (one level, same org);
 *  - D9  at most 200 merch rules per org.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { createProduct, __resetCommerce } from '../../commerce/commerceService.js';
import {
  createCollection, updateCollection, resolveCollection, createMerchRule, updateMerchRule, listMerchRules, searchProducts, pruneProductRefs, __resetDiscovery,
} from '../discoveryService.js';

const T = 'default';
const ORG = 'org-disc-1025';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCommerce(); await __resetDiscovery(); });

const seed = async (): Promise<{ keep: string; sale: string }> => {
  const keep = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Keep', price: 10, currency: 'USD', categories: ['main'] });
  const sale = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Sale', price: 5, currency: 'USD', categories: ['clearance'] });
  return { keep: keep.productId, sale: sale.productId };
};

describe('ADR 1025 D5 — merch rules can be paused and activated', () => {
  it('an inactive (proposed) rule hides nothing; activating it hides; pausing restores', async () => {
    const { sale } = await seed();
    const rule = await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'agent', name: 'Hide clearance', scope: 'all', actions: [{ kind: 'hide', predicate: { categories: ['clearance'] } }], active: false });
    expect(rule.active).toBe(false);
    const ids = async (): Promise<string[]> => (await searchProducts({ tenantId: T, orgId: ORG })).products.map((p) => p.productId);
    expect(await ids()).toContain(sale);
    expect((await updateMerchRule(T, ORG, rule.ruleId, { active: true }))?.active).toBe(true);
    expect(await ids()).not.toContain(sale);
    expect((await updateMerchRule(T, ORG, rule.ruleId, { active: false }))?.active).toBe(false);
    expect(await ids()).toContain(sale);
  });

  it('the service default stays live (the console and the seed create active rules)', async () => {
    const r = await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'R', scope: 'all', actions: [{ kind: 'hide', predicate: { categories: ['x'] } }] });
    expect(r.active).toBe(true);
  });

  it('an agent rule is marked proposed until activated; `active` must be a boolean; an empty rule cannot be activated', async () => {
    const r = await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'agent', name: 'P', scope: 'all', actions: [{ kind: 'pin', productId: 'gone', position: 0 }], active: false });
    expect(r.proposed).toBe(true);
    await expect(updateMerchRule(T, ORG, r.ruleId, { active: 'yes' })).rejects.toMatchObject({ details: { field: 'active' } });
    const live = await updateMerchRule(T, ORG, r.ruleId, { active: true });
    expect(live?.active).toBe(true);
    expect(live?.proposed).toBeUndefined();
    // Its only action pruned (product deleted) → paused by the prune; re-activation refused.
    await pruneProductRefs(T, ORG, 'gone');
    await expect(updateMerchRule(T, ORG, r.ruleId, { active: true })).rejects.toMatchObject({ details: { field: 'actions' } });
  });

  it('another org cannot patch the rule (uniform not-found)', async () => {
    const r = await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'R', scope: 'all', actions: [{ kind: 'hide', predicate: { categories: ['x'] } }] });
    expect(await updateMerchRule(T, 'org-other', r.ruleId, { active: false })).toBeNull();
    expect((await listMerchRules(T, ORG))[0]!.active).toBe(true);
  });
});

describe('ADR 1025 D8 — paused collections and the one-level taxonomy', () => {
  it('a paused collection searches empty; the console preview still lists its members', async () => {
    const { keep } = await seed();
    const c = await createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Picks', type: 'manual', productIds: [keep] });
    expect((await searchProducts({ tenantId: T, orgId: ORG, collectionId: c.collectionId })).products.map((p) => p.productId)).toEqual([keep]);
    await updateCollection(T, ORG, c.collectionId, { active: false });
    expect((await searchProducts({ tenantId: T, orgId: ORG, collectionId: c.collectionId })).products).toEqual([]);
    expect((await resolveCollection(T, ORG, c.collectionId, { activeProducts: false, activeCollection: false })).map((p) => p.productId)).toEqual([keep]);
  });

  it('refuses a parent that is missing, itself, nested, or given to a collection that has children', async () => {
    const root = await createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Root', type: 'manual' });
    const child = await createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Child', type: 'manual', parentId: root.collectionId });
    expect(child.parentId).toBe(root.collectionId);
    await expect(createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'X', type: 'manual', parentId: 'col:missing' })).rejects.toMatchObject({ details: { field: 'parentId' } });
    await expect(createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Grand', type: 'manual', parentId: child.collectionId })).rejects.toMatchObject({ details: { field: 'parentId' } });
    await expect(updateCollection(T, ORG, root.collectionId, { parentId: root.collectionId })).rejects.toMatchObject({ details: { field: 'parentId' } });
    const other = await createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Other', type: 'manual' });
    await expect(updateCollection(T, ORG, root.collectionId, { parentId: other.collectionId })).rejects.toMatchObject({ details: { field: 'parentId' } });
    // A parent in ANOTHER org reads as missing.
    const foreign = await createCollection({ tenantId: T, orgId: 'org-other', createdBy: 'u', name: 'Foreign', type: 'manual' });
    await expect(createCollection({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Y', type: 'manual', parentId: foreign.collectionId })).rejects.toMatchObject({ details: { field: 'parentId' } });
  });
});

describe('ADR 1025 D9 — merch rules are bounded per org', () => {
  it('the 201st rule is refused with a typed error', async () => {
    for (let i = 0; i < 200; i++) await createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: `R${i}`, scope: 'all', actions: [{ kind: 'bury', predicate: { categories: [`c${i}`] } }] });
    await expect(createMerchRule({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'one too many', scope: 'all', actions: [{ kind: 'bury', predicate: { categories: ['z'] } }] }))
      .rejects.toMatchObject({ code: 'validation_error', details: { limit: 200 } });
  });
});
