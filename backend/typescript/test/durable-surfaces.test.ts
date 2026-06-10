import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { CacheSurface, TableSurface } from '../src/host/inMemorySurfaces.js';
import { createDurableCache } from '../src/host/durable/durableKv.js';
import { createDurableTable } from '../src/host/durable/durableTable.js';
import { _setDurableStorageForTesting } from '../src/host/durable/durableKv.js';

let storage: Storage;

beforeAll(async () => {
  storage = await openStorage('memory://');
  _setDurableStorageForTesting(storage);
});

afterAll(async () => {
  await storage.close();
});

describe('Storage.kvCompareAndSwap (atomic primitive)', () => {
  it('inserts only when absent (expected=null)', async () => {
    expect(await storage.kvCompareAndSwap('cas:a', null, 'v1')).toEqual({ swapped: true, actual: 'v1' });
    // second insert-if-absent fails; reports the live value
    expect(await storage.kvCompareAndSwap('cas:a', null, 'v2')).toEqual({ swapped: false, actual: 'v1' });
  });

  it('swaps only on an exact match of the current value', async () => {
    await storage.kvSet('cas:b', 'one');
    expect(await storage.kvCompareAndSwap('cas:b', 'WRONG', 'two')).toEqual({ swapped: false, actual: 'one' });
    expect(await storage.kvCompareAndSwap('cas:b', 'one', 'two')).toEqual({ swapped: true, actual: 'two' });
    expect(await storage.kvGet('cas:b')).toBe('two');
  });
});

describe('durable cache surface', () => {
  const cache: CacheSurface = createDurableCache({ tenantId: 'cache-t' });

  it('reports hit:false on a miss and hit:true after put', async () => {
    expect(await cache.get({ key: 'm' })).toEqual({ hit: false, value: null, ttlRemainingMs: null, found: false });
    await cache.put({ key: 'm', value: { a: 1 } });
    const got = await cache.get({ key: 'm' }) as { hit: boolean; value: unknown; ttlRemainingMs: number | null };
    expect(got.hit).toBe(true);
    expect(got.value).toEqual({ a: 1 });
    expect(got.ttlRemainingMs).toBeGreaterThan(0); // default 60s ttl
  });

  it('evicts', async () => {
    await cache.put({ key: 'e', value: 1 });
    await cache.evict({ key: 'e' });
    expect((await cache.get({ key: 'e' }) as { hit: boolean }).hit).toBe(false);
  });

  it('is namespaced apart from kv (different root)', async () => {
    // A cache key should not collide with the kv keyspace.
    await cache.put({ key: 'shared', value: 'cache-val' });
    const raw = await storage.kvGet('hostsurf:cache:cache-t:shared');
    expect(raw).not.toBeNull();
    expect(await storage.kvGet('hostsurf:kv:cache-t:shared')).toBeNull();
  });
});

describe('durable table surface', () => {
  const table: TableSurface = createDurableTable({ tenantId: 'tbl-t' });

  it('insert declares schema; conforming inserts pass, violations throw', async () => {
    await table.insert({ table: 'users', row: { id: 'u1', name: 'Ada', age: 36 } });
    await table.insert({ table: 'users', row: { id: 'u2', name: 'Linus', age: 54 } });
    await expect(
      table.insert({ table: 'users', row: { id: 'u3', name: 'X', age: 'not-a-number' } }),
    ).rejects.toThrow(/declared as 'number'/);
  });

  it('update / upsert / delete', async () => {
    expect(await table.update({ table: 'users', id: 'u1', patch: { age: 37 } })).toEqual({ updated: 1 });
    expect(await table.update({ table: 'users', id: 'nope', patch: { age: 1 } })).toEqual({ updated: 0 });
    expect(await table.upsert({ table: 'users', row: { id: 'u9', name: 'New', age: 1 } })).toEqual({ upserted: 1, created: true });
    expect(await table.upsert({ table: 'users', row: { id: 'u9', name: 'New2', age: 2 } })).toEqual({ upserted: 1, created: false });
    expect(await table.delete({ table: 'users', id: 'u9' })).toEqual({ deleted: 1 });
    expect(await table.delete({ table: 'users', id: 'u9' })).toEqual({ deleted: 0 });
  });

  it('query filters, sorts by id, and paginates by cursor', async () => {
    const page1 = await table.query({ table: 'users', limit: 1 }) as { rows: Array<{ id: string }>; nextCursor: string | null };
    expect(page1.rows.map((r) => r.id)).toEqual(['u1']);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await table.query({ table: 'users', limit: 1, cursor: page1.nextCursor }) as { rows: Array<{ id: string }>; nextCursor: string | null };
    expect(page2.rows.map((r) => r.id)).toEqual(['u2']);
    expect(page2.nextCursor).toBeNull();

    const filtered = await table.query({ table: 'users', filter: { name: 'Ada' } }) as { rows: Array<{ id: string }> };
    expect(filtered.rows.map((r) => r.id)).toEqual(['u1']);
  });

  it('count returns the table row total', async () => {
    expect(await table.count({ table: 'users' })).toEqual({ count: 2 });
  });

  it('isolates tenants and tables', async () => {
    const other = createDurableTable({ tenantId: 'tbl-other' });
    await other.insert({ table: 'users', row: { id: 'x1', name: 'Z', age: 9 } });
    expect(await table.count({ table: 'users' })).toEqual({ count: 2 }); // unchanged by other tenant
    expect(await table.count({ table: 'orders' })).toEqual({ count: 0 }); // different table
  });
});
