/**
 * CTI-1 cross-tenant isolation sweep (SECURITY/invariants.yaml, agent-memory.md
 * §CTI-1). For every durable host surface, data written by tenant A MUST NOT be
 * visible to tenant B. All durable adapters key on tenantId; this proves it
 * end-to-end against a real (sqlite) Storage backend. TST-CWD-3.
 *
 * Each case also reads tenant A's write BACK as A (a positive control): without
 * it, a write that silently failed would make "B sees nothing" pass for the
 * wrong reason. Each surface has ONE guard — its tenant segment in the storage
 * key — and dropping that segment reds that surface's case (sabotage-witnessed,
 * wave 69, one probe per surface: kv+cache, table, queue, queueBus, vector,
 * search, nosql, fs). The sql surface (a file per tenant) is durable-sql.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createDurableKv, createDurableCache, _setDurableStorageForTesting } from '../src/host/durable/durableKv.js';
import { createDurableTable } from '../src/host/durable/durableTable.js';
import { createDurableQueue, createDurableQueueBus } from '../src/host/durable/durableQueue.js';
import { createDurableVector, createDurableSearch, createDurableNosql } from '../src/host/durable/durableData.js';
import { createDurableFs } from '../src/host/durable/durableFs.js';

let storage: Storage;
beforeAll(async () => { storage = await openStorage('memory://'); _setDurableStorageForTesting(storage); });
afterAll(async () => { await storage.close(); });

const A = { tenantId: 'tenant-A' };
const B = { tenantId: 'tenant-B' };
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('CTI-1: durable surfaces never leak across tenants', () => {
  it('kv', async () => {
    await createDurableKv(A).set({ key: 'k', value: 'A-secret' });
    expect((await createDurableKv(A).get({ key: 'k' })).value).toBe('A-secret');
    expect((await createDurableKv(B).get({ key: 'k' })).found).toBe(false);
    expect((await createDurableKv(B).list({ prefix: '' })).keys).toEqual([]);
  });

  it('cache', async () => {
    await createDurableCache(A).put({ key: 'k', value: 'A-secret' });
    expect((await createDurableCache(A).get({ key: 'k' }) as { hit: boolean; value: unknown })).toMatchObject({ hit: true, value: 'A-secret' });
    expect((await createDurableCache(B).get({ key: 'k' }) as { hit: boolean }).hit).toBe(false);
  });

  it('table', async () => {
    await createDurableTable(A).insert({ table: 't', row: { id: '1', v: 'A' } });
    expect(await createDurableTable(A).count({ table: 't' })).toEqual({ count: 1 });
    expect(await createDurableTable(B).count({ table: 't' })).toEqual({ count: 0 });
    expect((await createDurableTable(B).query({ table: 't' }) as { rows: unknown[] }).rows).toEqual([]);
  });

  it('queue', async () => {
    await createDurableQueue(A).enqueue({ queue: 'q', payload: 'A' });
    expect(await createDurableQueue(B).dequeue({ queue: 'q' })).toEqual({ found: false });
    expect(await createDurableQueue(A).dequeue({ queue: 'q' })).toMatchObject({ found: true, payload: 'A' });
  });

  it('queueBus', async () => {
    await createDurableQueueBus(A).publish({ subject: 's', payload: 'A' });
    expect(await createDurableQueueBus(B).consume({ subject: 's' })).toEqual({ found: false });
    expect(await createDurableQueueBus(A).consume({ subject: 's' })).toMatchObject({ found: true, payload: 'A' });
  });

  it('vector', async () => {
    await createDurableVector(A).upsert({ namespace: 'n', items: [{ id: 'a', vector: [1, 0] }] });
    expect(((await createDurableVector(A).query({ namespace: 'n', vector: [1, 0] })) as { matches: Array<{ id: string }> }).matches.map((m) => m.id)).toEqual(['a']);
    expect((await createDurableVector(B).query({ namespace: 'n', vector: [1, 0] }) as { matches: unknown[] }).matches).toEqual([]);
  });

  it('search', async () => {
    await createDurableSearch(A).index({ index: 'i', docs: [{ id: '1', fields: { t: 'secret' } }] });
    expect(((await createDurableSearch(A).query({ index: 'i', q: 'secret' })) as { hits: Array<{ id: string }> }).hits.map((h) => h.id)).toEqual(['1']);
    expect((await createDurableSearch(B).query({ index: 'i', q: 'secret' }) as { hits: unknown[] }).hits).toEqual([]);
  });

  it('nosql', async () => {
    await createDurableNosql(A).insert({ datasource: 'd', collection: 'c', docs: [{ _id: '1', v: 'A' }] });
    expect(((await createDurableNosql(A).find({ datasource: 'd', collection: 'c' })) as { docs: unknown[] }).docs).toEqual([{ _id: '1', v: 'A' }]);
    expect((await createDurableNosql(B).find({ datasource: 'd', collection: 'c' }) as { docs: unknown[] }).docs).toEqual([]);
  });

  it('fs', async () => {
    await createDurableFs(A).write({ path: 'secret.txt', contentBase64: b64('A') });
    expect(await createDurableFs(A).stat({ path: 'secret.txt' })).toMatchObject({ found: true, isFile: true });
    expect(await createDurableFs(B).stat({ path: 'secret.txt' })).toEqual({ found: false });
    expect((await createDurableFs(B).list({ path: '.' }) as { entries: unknown[] }).entries).toEqual([]);
  });
});
