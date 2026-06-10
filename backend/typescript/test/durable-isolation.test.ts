/**
 * CTI-1 cross-tenant isolation sweep (SECURITY/invariants.yaml, agent-memory.md
 * §CTI-1). For every durable host surface, data written by tenant A MUST NOT be
 * visible to tenant B. All durable adapters key on tenantId; this proves it
 * end-to-end against a real (sqlite) Storage backend.
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
    expect((await createDurableKv(B).get({ key: 'k' })).found).toBe(false);
    expect((await createDurableKv(B).list({ prefix: '' })).keys).toEqual([]);
  });

  it('cache', async () => {
    await createDurableCache(A).put({ key: 'k', value: 'A-secret' });
    expect((await createDurableCache(B).get({ key: 'k' }) as { hit: boolean }).hit).toBe(false);
  });

  it('table', async () => {
    await createDurableTable(A).insert({ table: 't', row: { id: '1', v: 'A' } });
    expect(await createDurableTable(B).count({ table: 't' })).toEqual({ count: 0 });
    expect((await createDurableTable(B).query({ table: 't' }) as { rows: unknown[] }).rows).toEqual([]);
  });

  it('queue', async () => {
    await createDurableQueue(A).enqueue({ queue: 'q', payload: 'A' });
    expect(await createDurableQueue(B).dequeue({ queue: 'q' })).toEqual({ found: false });
  });

  it('queueBus', async () => {
    await createDurableQueueBus(A).publish({ subject: 's', payload: 'A' });
    expect(await createDurableQueueBus(B).consume({ subject: 's' })).toEqual({ found: false });
  });

  it('vector', async () => {
    await createDurableVector(A).upsert({ namespace: 'n', items: [{ id: 'a', vector: [1, 0] }] });
    expect((await createDurableVector(B).query({ namespace: 'n', vector: [1, 0] }) as { matches: unknown[] }).matches).toEqual([]);
  });

  it('search', async () => {
    await createDurableSearch(A).index({ index: 'i', docs: [{ id: '1', fields: { t: 'secret' } }] });
    expect((await createDurableSearch(B).query({ index: 'i', q: 'secret' }) as { hits: unknown[] }).hits).toEqual([]);
  });

  it('nosql', async () => {
    await createDurableNosql(A).insert({ datasource: 'd', collection: 'c', docs: [{ _id: '1', v: 'A' }] });
    expect((await createDurableNosql(B).find({ datasource: 'd', collection: 'c' }) as { docs: unknown[] }).docs).toEqual([]);
  });

  it('fs', async () => {
    await createDurableFs(A).write({ path: 'secret.txt', contentBase64: b64('A') });
    expect(await createDurableFs(B).stat({ path: 'secret.txt' })).toEqual({ found: false });
    expect((await createDurableFs(B).list({ path: '.' }) as { entries: unknown[] }).entries).toEqual([]);
  });
});
