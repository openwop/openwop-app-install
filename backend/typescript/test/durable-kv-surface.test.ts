import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { KvSurface } from '../src/host/inMemorySurfaces.js';
import {
  createDurableKv,
  initDurableSurfaces,
  _setDurableStorageForTesting,
  DURABLE_BACKEND_ID,
} from '../src/host/durable/durableKv.js';
import {
  resolveSurface,
  resolveBackendId,
  _resetSurfaceAdaptersForTesting,
} from '../src/host/surfaceBackends.js';

let storage: Storage;

beforeAll(async () => {
  // Real durable backend, exercised on the dialect-agnostic sqlite store.
  storage = await openStorage('memory://');
  _setDurableStorageForTesting(storage);
});

afterAll(async () => {
  await storage.close();
});

const kvFor = (tenantId: string) => createDurableKv({ tenantId });

describe('durable KV surface (Storage-backed)', () => {
  it('round-trips set/get with found + null-miss semantics', async () => {
    const kv = kvFor('t1');
    expect(await kv.get({ key: 'missing' })).toEqual({ value: null, found: false, ttlRemainingMs: null });
    await kv.set({ key: 'a', value: { n: 1 } });
    expect(await kv.get({ key: 'a' })).toEqual({ value: { n: 1 }, found: true, ttlRemainingMs: null });
  });

  it('persists through the shared Storage (durability)', async () => {
    await kvFor('t1').set({ key: 'persisted', value: 'yes' });
    // A fresh surface instance (new run) sees the same durable row.
    expect((await kvFor('t1').get({ key: 'persisted' })).value).toBe('yes');
  });

  it('reports ttlRemainingMs and treats an expired entry as absent', async () => {
    const kv = kvFor('t1');
    await kv.set({ key: 'ttl', value: 'v', ttlSeconds: 60 });
    const got = await kv.get({ key: 'ttl' });
    expect(got.found).toBe(true);
    expect(got.ttlRemainingMs).toBeGreaterThan(0);

    // Deterministic expiry: write an already-expired envelope directly.
    await storage.kvSet('hostsurf:kv:t1:dead', JSON.stringify({ v: 'x', e: 1 }));
    expect(await kv.get({ key: 'dead' })).toEqual({ value: null, found: false, ttlRemainingMs: null });
    // ...and it was lazily evicted.
    expect(await storage.kvGet('hostsurf:kv:t1:dead')).toBeNull();
  });

  it('delete reports prior existence', async () => {
    const kv = kvFor('t1');
    await kv.set({ key: 'del', value: 1 });
    expect(await kv.delete({ key: 'del' })).toEqual({ ok: true, existed: true });
    expect(await kv.delete({ key: 'del' })).toEqual({ ok: true, existed: false });
  });

  it('list filters by prefix and strips the tenant namespace', async () => {
    const kv = kvFor('list-t');
    await kv.set({ key: 'p:1', value: 1 });
    await kv.set({ key: 'p:2', value: 2 });
    await kv.set({ key: 'q:1', value: 3 });
    const keys = (await kv.list({ prefix: 'p:' })).keys as string[];
    expect(new Set(keys)).toEqual(new Set(['p:1', 'p:2']));
  });

  it('isolates tenants — same key, different tenants, no leakage', async () => {
    await kvFor('tenant-a').set({ key: 'shared', value: 'A' });
    await kvFor('tenant-b').set({ key: 'shared', value: 'B' });
    expect((await kvFor('tenant-a').get({ key: 'shared' })).value).toBe('A');
    expect((await kvFor('tenant-b').get({ key: 'shared' })).value).toBe('B');
    // A tenant's list never sees another tenant's rows.
    const keys = (await kvFor('tenant-a').list({ prefix: '' })).keys as string[];
    expect(keys).toContain('shared');
    expect(keys.every((k) => !k.includes('tenant-b'))).toBe(true);
  });

  it('atomicIncrement starts at 0 and accumulates; serialized under concurrency', async () => {
    const kv = kvFor('inc-t');
    expect(await kv.atomicIncrement({ key: 'c', delta: 5 })).toEqual({ value: 5 });
    expect(await kv.atomicIncrement({ key: 'c' })).toEqual({ value: 6 }); // default delta 1
    // 100 concurrent +1s must not lose updates (the per-key lock serializes RMW).
    await Promise.all(Array.from({ length: 100 }, () => kv.atomicIncrement({ key: 'race', delta: 1 })));
    expect((await kv.get({ key: 'race' })).value).toBe(100);
  });

  it('cas swaps only on an exact expected match (canonical + legacy shapes)', async () => {
    const kv = kvFor('cas-t');
    // miss against an absent key: expect null
    expect(await kv.cas({ key: 'x', expect: 'wrong', set: 'v1' })).toEqual({ swapped: false, actual: null });
    expect(await kv.cas({ key: 'x', expect: null, set: 'v1' })).toEqual({ swapped: true, actual: 'v1' });
    expect(await kv.cas({ key: 'x', expect: 'v1', set: 'v2' })).toEqual({ swapped: true, actual: 'v2' });
    // legacy {expected,value} aliases still accepted
    expect(await kv.cas({ key: 'x', expected: 'v2', value: 'v3' })).toEqual({ swapped: true, actual: 'v3' });
    expect((await kv.get({ key: 'x' })).value).toBe('v3');
  });
});

describe('durable KV behind the surface seam', () => {
  afterEach(() => {
    _resetSurfaceAdaptersForTesting();
    delete process.env.OPENWOP_SURFACE_KV;
  });

  it('initDurableSurfaces registers kv under the durable backend id', async () => {
    process.env.OPENWOP_SURFACE_KV = DURABLE_BACKEND_ID;
    initDurableSurfaces(storage); // registers 'kv' → 'durable'
    expect(resolveBackendId('kv')).toBe(DURABLE_BACKEND_ID);
    const memoryFactory = (): KvSurface => { throw new Error('should not use memory factory'); };
    const kv = resolveSurface<KvSurface>('kv', memoryFactory, { tenantId: 'seam-t' });
    await kv.set({ key: 'via-seam', value: 42 });
    expect((await kv.get({ key: 'via-seam' })).value).toBe(42);
  });
});
