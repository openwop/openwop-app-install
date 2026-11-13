/**
 * ADR 1110 round fixes — the blockers an independent grade found in P1–P5.
 *
 * Pins:
 *  - index rows never count as an org's own data, and an emptied catalog leaves no
 *    counter behind (they used to block `deleteOrg` once anyone had read the catalog);
 *  - a tenant too large to index inside a request is queued for the background build
 *    and served by the bounded fallback meanwhile, with the same answers;
 *  - an index marked built is checked before it is trusted: a fold into an
 *    already-built tenant is caught and rebuilt;
 *  - teardown deletes a tenant's index rows as one key range, never another tenant's,
 *    and the ghost-namespace scan still finds rows no live collection owns.
 *
 * Sabotage, each restored, each red: counting derived rows in the org guard; building
 * every tenant inline (no queue); trusting `built` without the count check; a purge
 * range without the trailing ':' (a shorter tenant id eats a longer one's rows).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { countOrgHostExtRows, initHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __forgetCatalogIndexReady, createProduct, deleteProduct, listProductsPage } from '../src/features/commerce/commerceService.js';
import {
  __clearSystemIndex, __forgetVerifiedIndexes, drainSystemIndexBuilds, INLINE_BUILD_MAX, queuedBuildCount,
} from '../src/features/entities/systemIndex.js';

const ORG = 'org-rf';
let storage: Storage;
let n = 0;
const tenant = (): string => `user:rf-${++n}`;
const make = (T: string, name: string) => createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name, price: 1, currency: 'USD' });
const fresh = (): void => { __forgetCatalogIndexReady(); __forgetVerifiedIndexes(); };

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  fresh();
});

describe('ADR 1110 round fixes — org deletion', () => {
  it('index rows never count as the org\'s own rows, and an emptied catalog leaves no counter', async () => {
    const T = tenant();
    const p = await make(T, 'Only');
    await listProductsPage(T, ORG, {}); // reads the counter (it used to write one, even 0)
    expect(await countOrgHostExtRows(T, ORG)).toBe(1); // the product row itself, not its index rows
    await deleteProduct(T, ORG, p.productId);
    await listProductsPage(T, ORG, {});
    expect(await countOrgHostExtRows(T, ORG)).toBe(0);
    expect(await storage.kvList(`hostext:entity:sysidx-count:${T}:`)).toEqual([]);
  });
});

describe('ADR 1110 round fixes — no large build inside a request', () => {
  it('a tenant over the inline limit is queued and served by the fallback meanwhile', async () => {
    const T = tenant();
    for (let i = 0; i <= INLINE_BUILD_MAX; i += 1) await make(T, `Item ${String(i).padStart(4, '0')}`);
    await __clearSystemIndex(); // as after a deploy: rows exist, the index does not
    fresh();
    const page = await listProductsPage(T, ORG, { limit: 3 });
    expect(page.products.map((p) => p.name)).toEqual(['Item 0000', 'Item 0001', 'Item 0002']);
    expect(page.total).toBe(INLINE_BUILD_MAX + 1);
    expect(page.nextCursor?.startsWith('f.')).toBe(true); // the fallback's cursor
    const second = await listProductsPage(T, ORG, { limit: 3, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) });
    expect(second.products.map((p) => p.name)).toEqual(['Item 0003', 'Item 0004', 'Item 0005']);
    expect((await listProductsPage(T, ORG, { q: 'item 0499' })).products.map((p) => p.name)).toEqual(['Item 0499']);
    expect(await queuedBuildCount()).toBe(1);
    expect(await storage.kvList(`hostext:entity:sysidx:${T}:`)).toEqual([]); // nothing built inline
    expect(await drainSystemIndexBuilds({ limit: 1 })).toBe(1);
    fresh();
    const built = await listProductsPage(T, ORG, { limit: 3 });
    expect(built.products.map((p) => p.name)).toEqual(['Item 0000', 'Item 0001', 'Item 0002']);
    expect(built.nextCursor?.startsWith('b.')).toBe(true); // the index's cursor
  }, 120_000);
});

describe('ADR 1110 round fixes — a built index is checked before it is trusted', () => {
  it('a fold into an already-built tenant is caught and rebuilt', async () => {
    const from = `anon:${tenant()}`;
    const to = tenant();
    await make(to, 'Mine');
    await listProductsPage(to, ORG, {}); // `to` is built
    await make(from, 'Folded');
    // `from`'s rows were never indexed (a tenant that predates the index): its rows move,
    // but no marker comes with them, and `to`'s `built` row still says built.
    for (const r of await storage.kvList(`hostext:entity:sysidx:${from}:`)) await storage.kvDelete(r.key);
    await storage.reassignTenant(from, to); // the fold merges `from`'s rows into a built tenant
    fresh();
    expect((await listProductsPage(to, ORG, {})).products.map((p) => p.name).sort()).toEqual(['Folded', 'Mine']);
  });
});

describe('ADR 1110 round fixes — teardown', () => {
  it('deletes the tenant\'s index range only, and the ghost scan still purges unowned rows', async () => {
    const T = tenant();
    const longer = `${T}0`; // T is a string prefix of it
    await make(T, 'Gone');
    await make(longer, 'Kept');
    await storage.kvSet('hostext:retired-feature:x1', JSON.stringify({ tenantId: T, note: 'ghost' }));
    await purgeTenantHostExt(T);
    expect(await storage.kvList(`hostext:entity:sysidx:${T}:`)).toEqual([]);
    expect((await storage.kvList(`hostext:entity:sysidx:${longer}:`)).length).toBeGreaterThan(0);
    expect(await storage.kvGet('hostext:retired-feature:x1')).toBeNull();
  });
});
