/**
 * #5928 ask 2 — the media library's capacity gate and lists read the org's INDEX, not
 * every asset of the tenant (ADR 1110 P5's store index over media's own rows, with the
 * per-org counter extended to sum bytes).
 *
 * Pins: the gate reads no asset row and no tenant slice once the index is built (also on
 * a cold instance); it still enforces the org count, org bytes and workspace bytes caps;
 * an over-counted counter is recounted exactly at the cap, an under-counted one (count
 * or bytes) is healed by the hourly drift check; the paged list is keyset-paged and
 * neither repeats nor skips a row under an insert and a delete between pages (org slice,
 * collection slice, uncategorized, and a `q` filter that pages within a scan budget);
 * the collection cap counts through the index; and the generic weighted counter follows
 * create, weight change, org move and delete.
 *
 * Sabotage, each restored, each red: `assertOrgCapacity` back on `listAssetsForTenant`
 * (the "reads no asset row" case); `indexedTotals` trusting the counter at the cap (the
 * over-count case); `checkSystemIndex`/`indexedTotals` recounting the count but not the
 * sum (the bytes drift case); an offset cursor in `listAssetsPage` (the paging cases);
 * `applyRow` ignoring a same-org weight change (the generic weight case).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { runSystemIndexUpkeep } from '../src/features/entities/systemIndexSweep.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  MEDIA_ASSET_TYPE, UNCATEGORIZED, assertOrgCapacity, createAsset, createCollection, deleteAsset, listAssets, listAssetsPage,
  listCollectionsPage, __forgetMediaIndexReady, type MediaAsset,
} from '../src/features/media/mediaService.js';
import {
  __forgetVerifiedIndexes, afterSystemWrite, beforeSystemWrite, indexedTenantTotals, indexedTotals, registerStoreIndex,
} from '../src/features/entities/systemIndex.js';

let storage: Storage;
let n = 0;
const tenant = (): string => `tenant-mi-${++n}`;
let clock = Date.UTC(2026, 10, 1);

/** One asset, one millisecond newer than the last (newest-first order is then total). */
async function seed(T: string, ORG: string, opts: { bytes?: number; collectionId?: string; name?: string; hash?: string } = {}): Promise<MediaAsset> {
  clock += 1000;
  vi.setSystemTime(clock);
  const k = `${T}-${clock}`;
  return createAsset({
    tenantId: T, orgId: ORG, name: opts.name ?? `a-${clock}.png`, contentType: 'image/png', sizeBytes: opts.bytes ?? 100,
    storageRef: `ref-${k}`, serveToken: `tok-${k}`, uploadedBy: 'u',
    ...(opts.collectionId ? { collectionId: opts.collectionId } : {}), ...(opts.hash ? { contentHash: opts.hash } : {}),
  });
}

/** Record every storage key the next calls touch. */
function spyReads(): { keys: string[]; stop: () => void } {
  const keys: string[] = [];
  const s = storage as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const m of ['kvGet', 'kvList', 'kvListPage', 'kvCount']) {
    const orig = s[m];
    if (typeof orig !== 'function') continue;
    saved[m] = orig;
    s[m] = (key: string, ...rest: unknown[]) => { keys.push(`${m} ${key}`); return (orig as (...a: unknown[]) => unknown).call(storage, key, ...rest); };
  }
  return { keys, stop: () => { for (const [m, f] of Object.entries(saved)) s[m] = f; } };
}
const touchesAssetRows = (keys: string[]): string[] => keys.filter((k) => k.includes('hostext:media:asset:') || (k.includes('hostextidx:media:asset:') && !k.startsWith('kvCount')));

const counterKey = (T: string, org: string): string => `hostext:entity:sysidx-count:${T}:${MEDIA_ASSET_TYPE}:${org}`;
async function tamperCounter(T: string, org: string, count: number, sum: number): Promise<void> {
  await storage.kvSet(counterKey(T, org), JSON.stringify({ k: `${T}:${MEDIA_ASSET_TYPE}:${org}`, tenantId: T, orgId: org, type: MEDIA_ASSET_TYPE, count, sum }));
}

/** Walk every page; `between(i)` runs after page i is read. */
async function walk(read: (cursor?: string) => Promise<{ ids: string[]; next?: string }>, between: (i: number) => Promise<void> = async () => {}): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i += 1) {
    const page = await read(cursor);
    seen.push(...page.ids);
    if (!page.next) return seen;
    cursor = page.next;
    await between(i);
  }
  throw new Error('paging did not end');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __forgetMediaIndexReady();
  __forgetVerifiedIndexes();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS;
  delete process.env.OPENWOP_MEDIA_ORG_MAX_BYTES;
  delete process.env.OPENWOP_MEDIA_TENANT_MAX_BYTES;
  delete process.env.OPENWOP_MEDIA_ORG_MAX_COLLECTIONS;
});

describe('#5928 — the capacity gate reads counters, not asset rows', () => {
  it('reads no asset row and no tenant slice once built, on a warm AND a cold instance', async () => {
    const T = tenant();
    for (let i = 0; i < 12; i += 1) await seed(T, 'org-a');
    for (let i = 0; i < 5; i += 1) await seed(T, 'org-b');
    await assertOrgCapacity(T, 'org-a', 10); // the first call builds and verifies the index
    const warm = spyReads();
    await assertOrgCapacity(T, 'org-a', 10);
    warm.stop();
    expect(touchesAssetRows(warm.keys)).toEqual([]);
    // A new instance re-verifies the index with two counts, still reading no row.
    __forgetMediaIndexReady();
    __forgetVerifiedIndexes();
    const cold = spyReads();
    await assertOrgCapacity(T, 'org-a', 10);
    cold.stop();
    expect(touchesAssetRows(cold.keys)).toEqual([]);
  });

  it('still enforces the org count, the org bytes and the workspace bytes caps', async () => {
    const T = tenant();
    for (let i = 0; i < 3; i += 1) await seed(T, 'org-a', { bytes: 1000 });
    await seed(T, 'org-b', { bytes: 1000 });
    process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS = '3';
    await expect(assertOrgCapacity(T, 'org-a', 1)).rejects.toMatchObject({ httpStatus: 409, details: { max: 3 } });
    await assertOrgCapacity(T, 'org-b', 1);
    delete process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS;
    process.env.OPENWOP_MEDIA_ORG_MAX_BYTES = '3500';
    await expect(assertOrgCapacity(T, 'org-a', 501)).rejects.toMatchObject({ details: { maxBytes: 3500 } });
    await assertOrgCapacity(T, 'org-a', 500);
    delete process.env.OPENWOP_MEDIA_ORG_MAX_BYTES;
    process.env.OPENWOP_MEDIA_TENANT_MAX_BYTES = '4500';
    await expect(assertOrgCapacity(T, 'org-b', 501)).rejects.toMatchObject({ details: { scope: 'workspace' } });
    await assertOrgCapacity(T, 'org-b', 500);
    // A delete frees room at once (the counter moves with the row).
    const [first] = await listAssets(T, 'org-a');
    await deleteAsset(T, 'org-a', first!.assetId);
    await assertOrgCapacity(T, 'org-b', 1500);
    expect(await indexedTotals(T, MEDIA_ASSET_TYPE, 'org-a')).toEqual({ count: 2, sum: 2000 });
  });

  it('an over-counted counter is recounted exactly at the cap, so an upload that fits is admitted', async () => {
    const T = tenant();
    for (let i = 0; i < 2; i += 1) await seed(T, 'org-a', { bytes: 100 });
    await assertOrgCapacity(T, 'org-a', 1);
    process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS = '5';
    process.env.OPENWOP_MEDIA_ORG_MAX_BYTES = '1000';
    await tamperCounter(T, 'org-a', 9, 99_999);
    await assertOrgCapacity(T, 'org-a', 100);
    expect(await indexedTotals(T, MEDIA_ASSET_TYPE, 'org-a')).toEqual({ count: 2, sum: 200 });
  });

  it('an under-counted counter (count AND bytes) is healed by the hourly drift check', async () => {
    const T = tenant();
    for (let i = 0; i < 3; i += 1) await seed(T, 'org-a', { bytes: 400 });
    await assertOrgCapacity(T, 'org-a', 1);
    await tamperCounter(T, 'org-a', 1, 1);
    process.env.OPENWOP_MEDIA_ORG_MAX_BYTES = '1000';
    await assertOrgCapacity(T, 'org-a', 1); // the drift window: the under-count admits
    await runSystemIndexUpkeep(clock + 3_600_000);
    expect(await indexedTotals(T, MEDIA_ASSET_TYPE, 'org-a')).toEqual({ count: 3, sum: 1200 });
    await expect(assertOrgCapacity(T, 'org-a', 1)).rejects.toMatchObject({ details: { maxBytes: 1000 } });
    expect(await indexedTenantTotals(T, MEDIA_ASSET_TYPE)).toEqual({ count: 3, sum: 1200 });
  });

  it('the workspace total heals at its own boundary (an exact pass over the tenant)', async () => {
    const T = tenant();
    await seed(T, 'org-a', { bytes: 100 });
    await seed(T, 'org-b', { bytes: 100 });
    await assertOrgCapacity(T, 'org-a', 1);
    await tamperCounter(T, 'org-b', 1, 50_000);
    process.env.OPENWOP_MEDIA_TENANT_MAX_BYTES = '1000';
    await assertOrgCapacity(T, 'org-a', 500); // over-counted org-b recounted, admitted
    expect(await indexedTenantTotals(T, MEDIA_ASSET_TYPE)).toEqual({ count: 2, sum: 200 });
  });

  it('the collection cap counts through the index', async () => {
    const T = tenant();
    process.env.OPENWOP_MEDIA_ORG_MAX_COLLECTIONS = '2';
    const tick = (): void => { clock += 1000; vi.setSystemTime(clock); }; // oldest first is by createdAt, then id
    tick(); await createCollection(T, 'org-a', 'one', 'u');
    tick(); await createCollection(T, 'org-b', 'other org', 'u');
    tick(); await createCollection(T, 'org-a', 'two', 'u');
    await expect(createCollection(T, 'org-a', 'three', 'u')).rejects.toMatchObject({ httpStatus: 409, details: { max: 2 } });
    const seen = await walk(async (cursor) => {
      const p = await listCollectionsPage(T, 'org-a', { limit: 1, ...(cursor ? { cursor } : {}) });
      return { ids: p.collections.map((c) => c.name), ...(p.nextCursor ? { next: p.nextCursor } : {}) };
    });
    expect(seen).toEqual(['one', 'two']);
  });
});

describe('#5928 — the paged list is keyset-paged and stable', () => {
  async function pagedIds(T: string, ORG: string, query: Parameters<typeof listAssetsPage>[2], between: (i: number) => Promise<void>): Promise<string[]> {
    return walk(async (cursor) => {
      const p = await listAssetsPage(T, ORG, { ...query, ...(cursor ? { cursor } : {}) });
      return { ids: p.assets.map((a) => a.assetId), ...(p.nextCursor ? { next: p.nextCursor } : {}) };
    }, between);
  }

  it('the org slice: newest first, no repeat and no skip under a delete and an insert between pages', async () => {
    const T = tenant();
    const rows: MediaAsset[] = [];
    for (let i = 0; i < 10; i += 1) rows.push(await seed(T, 'org-a'));
    await seed(T, 'org-b');
    const newestFirst = [...rows].reverse().map((a) => a.assetId);
    expect((await listAssetsPage(T, 'org-a', { limit: 50 })).assets.map((a) => a.assetId)).toEqual(newestFirst);
    const deletedSeen = newestFirst[0]!;
    const deletedUnseen = newestFirst[8]!;
    const seen = await pagedIds(T, 'org-a', { limit: 3 }, async (i) => {
      if (i === 0) await deleteAsset(T, 'org-a', deletedSeen); // an offset cursor would now skip a row
      if (i === 1) { await seed(T, 'org-a'); await deleteAsset(T, 'org-a', deletedUnseen); } // and now repeat one
    });
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(newestFirst.filter((id) => id !== deletedUnseen));
    expect((await listAssetsPage(T, 'org-a', { limit: 1 })).total).toBe(9);
  });

  it('the collection slice and the uncategorized slice page the same way', async () => {
    const T = tenant();
    const col = await createCollection(T, 'org-a', 'Brand', 'u');
    const inCol: MediaAsset[] = [];
    const loose: MediaAsset[] = [];
    for (let i = 0; i < 6; i += 1) {
      inCol.push(await seed(T, 'org-a', { collectionId: col.collectionId }));
      loose.push(await seed(T, 'org-a'));
    }
    const colIds = [...inCol].reverse().map((a) => a.assetId);
    const seen = await pagedIds(T, 'org-a', { collectionId: col.collectionId, limit: 2 }, async (i) => {
      if (i === 0) { await deleteAsset(T, 'org-a', colIds[1]!); await seed(T, 'org-a', { collectionId: col.collectionId }); }
    });
    // The deleted row was already read; an offset cursor would now skip colIds[2].
    expect(seen).toEqual(colIds);
    expect((await listAssetsPage(T, 'org-a', { collectionId: col.collectionId, limit: 1 })).total).toBe(6);
    const looseSeen = await pagedIds(T, 'org-a', { collectionId: UNCATEGORIZED, limit: 4 }, async () => {});
    expect(looseSeen).toEqual([...loose].reverse().map((a) => a.assetId));
  });

  it('a q filter pages within its scan budget, decides on the full row, and still covers the slice', async () => {
    const T = tenant();
    const hits: MediaAsset[] = [];
    for (let i = 0; i < 40; i += 1) {
      const a = await seed(T, 'org-a', { name: i % 10 === 0 ? `hero-${i}.png` : `filler-${i}.png` });
      if (i % 10 === 0) hits.push(a);
    }
    const pages: number[] = [];
    const seen = await walk(async (cursor) => {
      const p = await listAssetsPage(T, 'org-a', { q: 'hero', limit: 1, ...(cursor ? { cursor } : {}) });
      pages.push(p.assets.length);
      expect(p.total).toBeUndefined();
      return { ids: p.assets.map((a) => a.assetId), ...(p.nextCursor ? { next: p.nextCursor } : {}) };
    });
    expect(seen).toEqual([...hits].reverse().map((a) => a.assetId));
    expect(pages.some((c) => c === 0)).toBe(true); // a budget-bounded page may come back empty, with a cursor
  });

  it('the unpaged read is the whole filtered org list, from the org slice only', async () => {
    const T = tenant();
    for (let i = 0; i < 4; i += 1) await seed(T, 'org-a', { hash: i === 2 ? 'f'.repeat(64) : undefined });
    for (let i = 0; i < 30; i += 1) await seed(T, 'org-b');
    expect(await listAssets(T, 'org-a')).toHaveLength(4);
    const spy = spyReads();
    await listAssets(T, 'org-a');
    spy.stop();
    // Four asset rows read (by id), never org-b's thirty or the tenant slice.
    expect(spy.keys.filter((k) => k.startsWith('kvGet hostext:media:asset:'))).toHaveLength(4);
    expect(spy.keys.filter((k) => k.includes('hostextidx:media:asset:'))).toEqual([]);
  });
});

describe('#5928 — the weighted counter (systemIndex, generic)', () => {
  interface Row { id: string; tenantId: string; orgId: string; w: number }
  const store = new Map<string, Row>();
  registerStoreIndex<Row>('test.weighted', {
    isRow: (v): v is Row => !!v && typeof (v as Row).id === 'string',
    idOf: (r) => r.id, tenantOf: (r) => r.tenantId, orgOf: (r) => r.orgId,
    countedFamily: 'all', weightOf: (r) => r.w,
    markers: () => [{ family: 'all', segments: [], p: {} }],
    read: async (_t, id) => store.get(id) ?? null,
    scan: async function* (t) { for (const r of store.values()) if (r.tenantId === t) yield r; },
    count: async (t) => [...store.values()].filter((r) => r.tenantId === t).length,
  });
  async function write(r: Row | null, id: string, T: string): Promise<void> {
    await beforeSystemWrite('test.weighted', T, id, r);
    if (r) store.set(id, r); else store.delete(id);
    await afterSystemWrite('test.weighted', T, id, r);
  }

  it('follows create, a same-org weight change, an org move and a delete', async () => {
    const T = tenant();
    await write({ id: 'x', tenantId: T, orgId: 'o1', w: 10 }, 'x', T);
    await write({ id: 'y', tenantId: T, orgId: 'o1', w: 5 }, 'y', T);
    expect(await indexedTotals(T, 'test.weighted', 'o1')).toEqual({ count: 2, sum: 15 });
    await write({ id: 'x', tenantId: T, orgId: 'o1', w: 30 }, 'x', T);
    expect(await indexedTotals(T, 'test.weighted', 'o1')).toEqual({ count: 2, sum: 35 });
    await write({ id: 'y', tenantId: T, orgId: 'o2', w: 7 }, 'y', T);
    expect(await indexedTotals(T, 'test.weighted', 'o1')).toEqual({ count: 1, sum: 30 });
    expect(await indexedTotals(T, 'test.weighted', 'o2')).toEqual({ count: 1, sum: 7 });
    expect(await indexedTenantTotals(T, 'test.weighted')).toEqual({ count: 2, sum: 37 });
    await write(null, 'x', T);
    expect(await indexedTotals(T, 'test.weighted', 'o1')).toEqual({ count: 0, sum: 0 });
    expect(await indexedTotals(T, 'test.weighted', 'o2', { exact: true })).toEqual({ count: 1, sum: 7 });
  });
});
