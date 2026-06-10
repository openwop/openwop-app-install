import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { VectorSurface, SearchSurface, NoSqlSurface } from '../src/host/inMemorySurfaces.js';
import { createDurableVector, createDurableSearch, createDurableNosql } from '../src/host/durable/durableData.js';
import { _setDurableStorageForTesting } from '../src/host/durable/durableKv.js';

let storage: Storage;
beforeAll(async () => { storage = await openStorage('memory://'); _setDurableStorageForTesting(storage); });
afterAll(async () => { await storage.close(); });

describe('durable vector surface', () => {
  const v: VectorSurface = createDurableVector({ tenantId: 'vec-t' });
  it('upsert + nearest-neighbour query (cosine, topK) + delete', async () => {
    await v.upsert({ namespace: 'n', items: [
      { id: 'a', vector: [1, 0, 0], metadata: { tag: 'x' } },
      { id: 'b', vector: [0, 1, 0] },
      { id: 'c', vector: [0.9, 0.1, 0] },
    ] });
    const res = await v.query({ namespace: 'n', vector: [1, 0, 0], topK: 2 }) as { matches: Array<{ id: string; metadata?: unknown }> };
    expect(res.matches.map((m) => m.id)).toEqual(['a', 'c']); // closest two
    expect(res.matches[0].metadata).toEqual({ tag: 'x' });
    expect(await v.delete({ namespace: 'n', ids: ['a'] })).toEqual({ deleted: 1 });
    const res2 = await v.query({ namespace: 'n', vector: [1, 0, 0], topK: 1 }) as { matches: Array<{ id: string }> };
    expect(res2.matches[0].id).toBe('c');
  });
});

describe('durable search surface', () => {
  const s: SearchSurface = createDurableSearch({ tenantId: 'srch-t' });
  it('index + bag-of-words query ranks by term frequency', async () => {
    await s.index({ index: 'i', docs: [
      { id: '1', fields: { title: 'the quick brown fox' } },
      { id: '2', fields: { title: 'quick quick rabbit' } },
      { id: '3', fields: { title: 'slow turtle' } },
    ] });
    const res = await s.query({ index: 'i', q: 'quick' }) as { hits: Array<{ id: string }> };
    expect(res.hits.map((h) => h.id)).toEqual(['2', '1']); // doc 2 has 'quick' twice
    expect(await s.query({ index: 'i', q: 'nonexistent' })).toEqual({ hits: [] });
    expect(await s.delete({ index: 'i', ids: ['2'] })).toEqual({ deleted: 1 });
  });
});

describe('durable nosql surface', () => {
  const n: NoSqlSurface = createDurableNosql({ tenantId: 'no-t' });
  it('insert assigns _id; find with filter/sort/limit/projection', async () => {
    const ins = await n.insert({ datasource: 'd', collection: 'c', docs: [
      { name: 'a', age: 30 }, { name: 'b', age: 20 }, { name: 'c', age: 40 },
    ] }) as { inserted: number; ids: string[] };
    expect(ins.inserted).toBe(3);
    const found = await n.find({ datasource: 'd', collection: 'c', sort: { age: 1 }, limit: 2, projection: { name: 1 } }) as { docs: Array<Record<string, unknown>> };
    expect(found.docs.map((d) => d.name)).toEqual(['b', 'a']);
    expect(found.docs[0]).not.toHaveProperty('age'); // projected out
  });
  it('exact-match filter; update $set/$unset; delete', async () => {
    await n.insert({ datasource: 'd', collection: 'u', docs: [{ _id: 'x', status: 'new', tmp: 1 }] });
    const upd = await n.update({ datasource: 'd', collection: 'u', filter: { status: 'new' }, update: { $set: { status: 'done' }, $unset: { tmp: '' } } }) as { matched: number };
    expect(upd.matched).toBe(1);
    const after = await n.find({ datasource: 'd', collection: 'u', filter: { _id: 'x' } }) as { docs: Array<Record<string, unknown>> };
    expect(after.docs[0]).toEqual({ _id: 'x', status: 'done' });
    expect(await n.delete({ datasource: 'd', collection: 'u', filter: { _id: 'x' } })).toEqual({ deleted: 1 });
  });
  it('rejects $-operator injection in filters', async () => {
    await expect(n.find({ datasource: 'd', collection: 'c', filter: { age: { $gt: 10 } } }))
      .rejects.toThrow(/not supported/);
  });
  it('upsert creates when no match', async () => {
    const res = await n.update({ datasource: 'd', collection: 'up', filter: { k: 'v' }, update: { $set: { a: 1 } }, upsert: true }) as { upsertedId?: string };
    expect(res.upsertedId).toBeTruthy();
  });
});
