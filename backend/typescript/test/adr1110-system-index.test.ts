/**
 * ADR 1110 P1 — the kernel's declared index for commerce.product, the counted cap, the
 * paged read and the whole-catalog iterator.
 *
 * Pins: every family is written and moved by the kernel's own writes; a write whose
 * markers would not change writes no index row; an index failure never fails the
 * write and leaves an intent the repair finishes; a kernel write the hooks never saw
 * (a crash after the row landed) is repaired from the stored row; two racing writes of
 * one row end with the stored row's markers; reads page without skipping or repeating,
 * re-check the full row, and search ranks as ADR 0239 did (without the description);
 * the anon fold moves the index and tenant teardown removes it; a tenant whose index
 * was never built is rebuilt on first read; drift is reported and rebuilt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence, purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  __forgetCatalogIndexReady, catalogIndexGauge, createProduct, deleteProduct, getProduct, iterateCatalog,
  listProductsPage, repairCatalogIndex, updateProduct, type Product,
} from '../src/features/commerce/commerceService.js';
import { getEntityType, getSystemEntity, type EntityRecord } from '../src/features/entities/entitiesService.js';
import { __clearSystemIndex, indexedCount, repairSystemIndex } from '../src/features/entities/systemIndex.js';

const TYPE = 'commerce.product';
const ORG = 'org-catalog';
let storage: Storage;
let n = 0;
const tenant = (): string => `tenant-sysidx-${++n}`;

/** A value the test needs present; fails the test with a reason instead of a `!`. */
function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}
/** The stored product inside a kernel row, renamed or otherwise patched. */
function withProduct(rec: EntityRecord, patch: Partial<Product>): EntityRecord {
  return { ...rec, ext: { product: { ...must(rec.ext?.product as Product | undefined, 'ext.product'), ...patch } } };
}

/** Every index key of the tenant (the markers collection), id part only. */
async function markerIds(tenantId: string): Promise<string[]> {
  return (await storage.kvList(`hostext:entity:sysidx:${tenantId}:`)).map((r) => r.key.slice('hostext:entity:sysidx:'.length)).sort();
}
const familyIds = (ids: string[], family: string): string[] => ids.filter((k) => k.split(':').includes(family) && k.includes(`:${family}:${ORG}:`));

async function make(tenantId: string, name: string, extra: Record<string, unknown> = {}): Promise<Product> {
  return createProduct({ tenantId, orgId: ORG, createdBy: 'u1', type: 'physical', name, price: 10, currency: 'USD', ...extra });
}

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __forgetCatalogIndexReady();
});

describe('ADR 1110 D1 — the kernel keeps the declared families', () => {
  it('writes n, c, t, w and low markers on create, a manifest, the counter, and no leftover intent', async () => {
    const T = tenant();
    const p = await make(T, 'Linen Shirt', { categories: ['tops'], tags: ['summer'], inventory: 2, lowStockThreshold: 3 });
    const ids = await markerIds(T);
    expect(familyIds(ids, 'n')).toEqual([`${T}:commerce.product:n:${ORG}:linen%20shirt:${encodeURIComponent(p.productId)}`]);
    expect(familyIds(ids, 'c')).toHaveLength(1);
    expect(familyIds(ids, 't')).toHaveLength(1);
    expect(familyIds(ids, 'w').map((k) => k.split(':')[4])).toEqual(expect.arrayContaining(['linen', 'shirt', 'tops', 'summer']));
    expect(familyIds(ids, 'low')).toHaveLength(1);
    expect(await indexedCount(T, TYPE, ORG)).toBe(1);
    expect(await storage.kvList('hostext:entity:sysidx-pend:')).toHaveLength(0);
  });

  it('keeps tenant and org raw and every other segment encoded (the fold must match the raw tenant)', async () => {
    const T = `anon:${tenant()}`;
    await make(T, 'a:b', { categories: ['x:y'] });
    const ids = await markerIds(T);
    expect(ids.every((k) => k.startsWith(`${T}:commerce.product:`))).toBe(true);
    expect(familyIds(ids, 'n')[0]).toContain(':a%3Ab:');
    expect(familyIds(ids, 'c')[0]).toContain(':x%3Ay:');
  });

  it('moves markers on rename and facet change, and removes them all on delete', async () => {
    const T = tenant();
    const p = await make(T, 'Old Name', { tags: ['red'] });
    await updateProduct(T, ORG, p.productId, { name: 'New Name', tags: ['blue'] });
    let ids = await markerIds(T);
    expect(familyIds(ids, 'n')).toHaveLength(1);
    expect(familyIds(ids, 'n')[0]).toContain(':new%20name:');
    expect(familyIds(ids, 't').map((k) => k.split(':')[4])).toEqual(['blue']);
    expect(ids.some((k) => k.includes(':old'))).toBe(false);
    await deleteProduct(T, ORG, p.productId);
    ids = await markerIds(T);
    expect(ids).toEqual([]);
    expect(await indexedCount(T, TYPE, ORG)).toBe(0);
    expect(await storage.kvList(`hostext:entity:sysidx-manifest:${T}:`)).toHaveLength(0);
  });

  it('a write whose markers would not change writes no index row (a stock change)', async () => {
    const T = tenant();
    const p = await make(T, 'Kettle', { inventory: 50, lowStockThreshold: 5 });
    const before = await storage.kvList(`hostext:entity:sysidx`);
    let indexWrites = 0;
    const kvSet = storage.kvSet.bind(storage);
    storage.kvSet = async (k, v) => { if (k.startsWith('hostext:entity:sysidx')) indexWrites += 1; return kvSet(k, v); };
    const cas = storage.kvCompareAndSwap.bind(storage);
    storage.kvCompareAndSwap = async (k, e, v) => { if (k.startsWith('hostext:entity:sysidx')) indexWrites += 1; return cas(k, e, v); };
    await updateProduct(T, ORG, p.productId, { inventory: 40 });
    storage.kvSet = kvSet;
    storage.kvCompareAndSwap = cas;
    expect(indexWrites).toBe(0);
    expect(await storage.kvList(`hostext:entity:sysidx`)).toEqual(before);
  });
});

describe('ADR 1110 D1 — crash ordering and races', () => {
  it('an index failure never fails the write; the intent stays and the repair finishes it', async () => {
    const T = tenant();
    const kvSet = storage.kvSet.bind(storage);
    let fail = true;
    storage.kvSet = async (k, v) => {
      if (fail && k.startsWith('hostext:entity:sysidx:')) { fail = false; throw new Error('disk gone'); }
      return kvSet(k, v);
    };
    const p = await make(T, 'Survivor');
    storage.kvSet = kvSet;
    expect((await getProduct(T, ORG, p.productId))?.name).toBe('Survivor'); // the write landed
    expect(await storage.kvList('hostext:entity:sysidx-pend:')).toHaveLength(1);
    expect((await repairSystemIndex({ limit: 10, now: Date.now() + 60_000 })).repaired).toBe(1);
    expect(familyIds(await markerIds(T), 'n')).toHaveLength(1);
    expect(await storage.kvList('hostext:entity:sysidx-pend:')).toHaveLength(0);
  });

  it('the repair sweep leaves a freshly marked intent to its writer (it may not have landed yet)', async () => {
    const T = tenant();
    const p = await make(T, 'Fresh');
    const rec = must(await getSystemEntity(T, TYPE, p.productId), 'the product row');
    const { beforeSystemWrite } = await import('../src/features/entities/systemIndex.js');
    await beforeSystemWrite(TYPE, T, p.productId, withProduct(rec, { name: 'Later' }));
    expect((await repairSystemIndex({ limit: 10 })).held).toBe(1);   // fresh: left alone
    expect(await storage.kvList('hostext:entity:sysidx-pend:')).toHaveLength(1); // the intent survives
    expect((await repairSystemIndex({ limit: 10, now: Date.now() + 60_000 })).repaired).toBe(1); // stale: repaired
  });

  it('a kernel write the hooks never saw is repaired from the stored row', async () => {
    const T = tenant();
    const p = await make(T, 'Before');
    // The process dies after the intent and the row write, before any marker moves.
    const rec = must(await getSystemEntity(T, TYPE, p.productId), 'the product row');
    const renamed = withProduct(rec, { name: 'After' });
    const { beforeSystemWrite } = await import('../src/features/entities/systemIndex.js');
    await beforeSystemWrite(TYPE, T, p.productId, renamed);
    await storage.kvSet(`hostext:entity:record:${rec.recordKey}`, JSON.stringify(renamed));
    expect(familyIds(await markerIds(T), 'n')[0]).toContain(':before:');
    await repairSystemIndex({ limit: 10, now: Date.now() + 60_000 });
    const n = familyIds(await markerIds(T), 'n');
    expect(n).toHaveLength(1);
    expect(n[0]).toContain(':after:');
  });

  it('two racing renames of one product end with the stored row’s markers only', async () => {
    const T = tenant();
    const p = await make(T, 'Start');
    await Promise.all([
      updateProduct(T, ORG, p.productId, { name: 'Alpha' }).catch(() => null),
      updateProduct(T, ORG, p.productId, { name: 'Omega' }).catch(() => null),
    ]);
    await repairSystemIndex({ limit: 10, now: Date.now() + 60_000 });
    const stored = must(await getProduct(T, ORG, p.productId), 'the product');
    const n = familyIds(await markerIds(T), 'n');
    expect(n).toHaveLength(1);
    expect(n[0]).toContain(`:${stored.name.toLowerCase()}:`);
    expect(await indexedCount(T, TYPE, ORG, { exact: true })).toBe(1);
  });
  it('a write that lands while another sync holds the lease is picked up before the lease is released', async () => {
    const T = tenant();
    const p = await make(T, 'First');
    const { afterSystemWrite, beforeSystemWrite, configureSystemIndex, syncRow } = await import('../src/features/entities/systemIndex.js');
    const { getSystemEntity: read, iterateSystemEntities } = await import('../src/features/entities/entitiesService.js');
    let interleaved = false;
    configureSystemIndex({
      scanRows: iterateSystemEntities,
      readRow: async (t, ty, id) => {
        const rec = await read(t, ty, id);
        if (!interleaved && rec) {
          interleaved = true;
          // Another writer lands between this holder's read and its release.
          const renamed = withProduct(rec, { name: 'Second' });
          await beforeSystemWrite(TYPE, T, p.productId, renamed);
          await storage.kvSet(`hostext:entity:record:${rec.recordKey}`, JSON.stringify(renamed));
          await afterSystemWrite(TYPE, T, p.productId, renamed); // the lease is held: it only marks
        }
        return rec;
      },
    });
    try {
      const rec = must(await read(T, TYPE, p.productId), 'the product row');
      await beforeSystemWrite(TYPE, T, p.productId, withProduct(rec, { name: 'Interim' }));
      expect(await syncRow(T, TYPE, p.productId)).toBe(true);
    } finally {
      configureSystemIndex({ readRow: read, scanRows: iterateSystemEntities });
    }
    expect(interleaved).toBe(true);
    const n = familyIds(await markerIds(T), 'n');
    expect(n).toHaveLength(1);
    expect(n[0]).toContain(':second:');
    expect(await storage.kvList('hostext:entity:sysidx-pend:')).toHaveLength(0);
  });
});

describe('ADR 1110 D3/D4 — the paged read', () => {
  it('browses in name order across pages with no repeat and no gap, with the org total', async () => {
    const T = tenant();
    const names = Array.from({ length: 120 }, (_, i) => `Item ${String(i).padStart(3, '0')}`);
    for (const name of [...names].reverse()) await make(T, name);
    await make(T, 'Elsewhere').then(() => undefined);
    const seen: string[] = [];
    let cursor: string | undefined;
    let total: number | undefined;
    do {
      const page = await listProductsPage(T, ORG, { limit: 50, ...(cursor ? { cursor } : {}) });
      total ??= page.total;
      seen.push(...page.products.map((p) => p.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.filter((s) => s.startsWith('Item'))).toEqual(names);
    expect(total).toBe(121);
  });

  it('filters by category, tag and listing, and re-checks the full row against a stale projection', async () => {
    const T = tenant();
    const a = await make(T, 'Alpha', { categories: ['tools'], tags: ['sale'] });
    await make(T, 'Beta', { categories: ['tools'], unlisted: true });
    await make(T, 'Gamma', { tags: ['sale'] });
    expect((await listProductsPage(T, ORG, { category: 'tools' })).products.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    expect((await listProductsPage(T, ORG, { category: 'tools', listedOnly: true })).products.map((p) => p.name)).toEqual(['Alpha']);
    expect((await listProductsPage(T, ORG, { tag: 'sale' })).products.map((p) => p.name)).toEqual(['Alpha', 'Gamma']);
    // A stale projection says Alpha is listed after it was unlisted: the full row decides.
    const rec = must(await getSystemEntity(T, TYPE, a.productId), 'the product row');
    await storage.kvSet(`hostext:entity:record:${rec.recordKey}`, JSON.stringify(withProduct(rec, { unlisted: true })));
    expect((await listProductsPage(T, ORG, { category: 'tools', listedOnly: true })).products).toEqual([]);
  });

  it('skips a malformed marker instead of failing the page', async () => {
    const T = tenant();
    await make(T, 'Good');
    const bad = await make(T, 'Broken');
    const key = must(familyIds(await markerIds(T), 'n').find((k) => k.endsWith(encodeURIComponent(bad.productId))), 'the n marker');
    await storage.kvSet(`hostext:entity:sysidx:${key}`, JSON.stringify({ k: key, tenantId: T, type: TYPE, id: bad.productId, p: { productId: bad.productId } }));
    expect((await listProductsPage(T, ORG, {})).products.map((p) => p.name)).toEqual(['Good']);
  });

  it('searches by word prefix with AND, ranks a name hit over a tag hit, and no longer reads descriptions', async () => {
    const T = tenant();
    await make(T, 'Shirt', { tags: ['red'] });
    await make(T, 'Red Shirt');
    await make(T, 'Red Scarf');
    await make(T, 'Plain Mug', { description: 'a red shirt pattern' });
    const red = await listProductsPage(T, ORG, { q: 'red shir' });
    expect(red.products.map((p) => p.name)).toEqual(['Red Shirt', 'Shirt']);
    expect(red.ranked).toEqual({ window: 2000, past: false });
    expect((await listProductsPage(T, ORG, { q: 'mug' })).products.map((p) => p.name)).toEqual(['Plain Mug']);
    expect((await listProductsPage(T, ORG, { q: 'pattern' })).products).toEqual([]);
    expect((await listProductsPage(T, ORG, { q: 'zzz red' })).products).toEqual([]);
    expect((await listProductsPage(T, ORG, { q: 'r' })).products.map((p) => p.name)).toEqual(['Red Scarf', 'Red Shirt']);
  });

  it('pages a ranked search without repeating a product', async () => {
    const T = tenant();
    for (let i = 0; i < 30; i += 1) await make(T, `Lamp ${i}`, { tags: i % 2 ? ['lamp'] : [] });
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await listProductsPage(T, ORG, { q: 'lamp', limit: 7, ...(cursor ? { cursor } : {}) });
      for (const p of page.products) { expect(seen.has(p.productId)).toBe(false); seen.add(p.productId); }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(30);
  });

  it('iterates the whole catalog in name order', async () => {
    const T = tenant();
    for (const name of ['c', 'a', 'b']) await make(T, name);
    const got: string[] = [];
    for await (const p of iterateCatalog(T, ORG, 2)) got.push(p.name);
    expect(got).toEqual(['a', 'b', 'c']);
  });
});

describe('ADR 1110 — fold, teardown, backfill and drift', () => {
  it('the anon fold moves the index with the tenant', async () => {
    const from = `anon:${tenant()}`;
    const to = `user:${tenant()}`;
    await make(from, 'Folded');
    await storage.reassignTenant(from, to);
    __forgetCatalogIndexReady();
    expect(await markerIds(from)).toEqual([]);
    expect((await listProductsPage(to, ORG, {})).products.map((p) => p.name)).toEqual(['Folded']);
    // The fold rewrites the row's top-level tenant only; the product read must follow it.
    const [folded] = (await listProductsPage(to, ORG, {})).products;
    expect((await getProduct(to, ORG, must(folded, 'the folded product').productId))?.tenantId).toBe(to);
  });

  it('tenant teardown removes every index row', async () => {
    const T = tenant();
    await make(T, 'Gone', { tags: ['x'] });
    await purgeTenantHostExt(T);
    for (const c of ['entity:sysidx', 'entity:sysidx-manifest', 'entity:sysidx-count', 'entity:sysidx-built']) {
      expect(await storage.kvList(`hostext:${c}:${T}:`)).toEqual([]);
    }
  });

  it('a tenant whose index was never built is rebuilt on first read', async () => {
    const T = tenant();
    await make(T, 'One');
    await make(T, 'Two');
    await __clearSystemIndex();
    __forgetCatalogIndexReady();
    expect((await listProductsPage(T, ORG, {})).products.map((p) => p.name)).toEqual(['One', 'Two']);
    expect(await indexedCount(T, TYPE, ORG)).toBe(2);
  });

  it('reports drift, queues a rebuild once an hour, and the next tick builds it', async () => {
    const T = tenant();
    await make(T, 'Kept');
    const [first] = familyIds(await markerIds(T), 'n');
    await storage.kvDelete(`hostext:entity:sysidx:${first}`);
    expect((await catalogIndexGauge()).driftTenants).toBe(1);
    expect((await repairCatalogIndex(Date.UTC(2026, 10, 12))).drifted).toBe(1); // queued, not built inline
    expect((await catalogIndexGauge()).queuedBuilds).toBe(1);
    expect((await repairCatalogIndex(Date.UTC(2026, 10, 12, 0, 1))).built).toBe(1); // the next tick builds it
    expect((await catalogIndexGauge()).driftTenants).toBe(0);
    expect((await repairCatalogIndex(Date.UTC(2026, 10, 12, 0, 30))).drifted).toBe(0); // same hour: no second check
  });

  it('commerce.product declares its own kernel row ceiling', async () => {
    const T = tenant();
    await make(T, 'Any');
    expect((await getEntityType(T, undefined, TYPE))?.rowCap).toBe(5_000_000);
  });

  it('a page read stays within limit × 4 markers however sparse the filter', async () => {
    const T = tenant();
    // 300 unlisted products and one listed one at the end of name order.
    for (let i = 0; i < 300; i += 1) await make(T, `P${String(i).padStart(3, '0')}`, { unlisted: true });
    await make(T, 'Zed');
    const kvListPage = must(storage.kvListPage, 'a paged storage backend').bind(storage);
    let read = 0;
    storage.kvListPage = async (prefix, opts) => { const rows = await kvListPage(prefix, opts); if (prefix.startsWith('hostext:entity:sysidx:')) read += rows.length; return rows; };
    const first = await listProductsPage(T, ORG, { listedOnly: true, limit: 10 });
    storage.kvListPage = kvListPage;
    expect(first.products).toEqual([]);          // the budget ran out before the listed one
    expect(first.nextCursor).toBeDefined();       // ...and the caller is told to go on
    expect(read).toBeLessThanOrEqual(50);         // one bounded page, not the catalog
    let cursor = first.nextCursor;
    const found: string[] = [];
    while (cursor) {
      const page = await listProductsPage(T, ORG, { listedOnly: true, limit: 10, cursor });
      found.push(...page.products.map((p) => p.name));
      cursor = page.nextCursor;
    }
    expect(found).toEqual(['Zed']);
  });
});
