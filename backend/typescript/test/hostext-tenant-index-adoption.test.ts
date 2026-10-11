/**
 * ADR 0866 — deploy-safe adoption of a DurableCollection tenant index.
 *
 * The hazard: during a deploy the superseded revision keeps writing rows with NO
 * index marker after the new revision's one-shot backfill has run. Adoption keeps
 * reads on the full scan until a reconcile pass that listed the rows at least
 * `windowMs` after the first pass, and un-verifies on any later unmarked row.
 * `legacy()` is the pre-index writer: the same namespace with no `tenantOf`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { registerTenantIndexAdoption, reconcileTenantIndexesOnce, __resetTenantIndexAdoptionRegistry } from '../src/host/tenantIndexAdoption.js';
import type { Storage } from '../src/storage/storage.js';

interface Row { id: string; tenantId: string }
const NAME = 'test:adoption';
const indexed = () => new DurableCollection<Row>(NAME, (r) => r.id, undefined, (r) => r.tenantId);
const legacy = () => new DurableCollection<Row>(NAME, (r) => r.id);

const MIN = 60_000;
const W = 180 * MIN;
const T0 = Date.parse('2026-10-09T00:00:00Z');

/** What a migrated read path does: the index only once verified. */
async function read(c: DurableCollection<Row>, tenantId: string): Promise<string[]> {
  const rows = (await c.tenantIndexVerified())
    ? await c.listForTenantIndexed(tenantId)
    : (await c.list()).filter((r) => r.tenantId === tenantId);
  return rows.map((r) => r.id).sort();
}

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetTenantIndexAdoptionRegistry();
});

describe('ADR 0866 — tenant index adoption', () => {
  it('a row the old revision writes AFTER the first pass is never invisible to reads', async () => {
    const c = indexed();
    await legacy().put({ id: 'pre', tenantId: 'tA' });

    // The new revision's one-shot backfill runs first (any indexed read triggers it)...
    await c.ensureTenantIndex();
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 })).toMatchObject({ repaired: 0, verified: false });
    // ...then the old revision, still serving, writes without a marker. The sentinel
    // is already set, so the backfill will never mark this row: the old hazard.
    await legacy().put({ id: 'overlap', tenantId: 'tA' });
    await c.ensureTenantIndex();
    expect(await storage.kvGet(`hostextidx:${NAME}:tA:overlap`)).toBeNull();
    expect(await c.tenantIndexVerified()).toBe(false);
    expect(await read(c, 'tA')).toEqual(['overlap', 'pre']);

    // Mid-window passes repair but do not verify.
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + 60 * MIN })).toMatchObject({ repaired: 1, verified: false });
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W - 1 })).toMatchObject({ repaired: 0, verified: false });
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W })).toMatchObject({ repaired: 0, verified: true, verifiedNow: true, reset: false });
    // Only the flipping pass reports verifiedNow (the one-shot tenant_index_verified log).
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W + 60 * MIN })).toMatchObject({ verified: true, verifiedNow: false });

    expect(await c.tenantIndexVerified()).toBe(true);
    expect(await read(c, 'tA')).toEqual(['overlap', 'pre']);
    expect(await read(c, 'tB')).toEqual([]);
  });

  it('a later pass that finds an unmarked row (a rollback) un-verifies, and reads fall back to the scan', async () => {
    const c = indexed();
    await c.put({ id: 'a', tenantId: 'tA' });
    await c.ensureTenantIndex();
    await c.reconcileTenantIndex({ windowMs: W, now: T0 });
    await c.reconcileTenantIndex({ windowMs: W, now: T0 + W });
    expect(await c.tenantIndexVerified()).toBe(true);

    await legacy().put({ id: 'rolled-back', tenantId: 'tA' });
    // Between the write and the next pass the row is missing from the index: the exposure is one tick.
    expect(await read(c, 'tA')).toEqual(['a']);

    const r = await c.reconcileTenantIndex({ windowMs: W, now: T0 + W + 60 * MIN });
    expect(r).toMatchObject({ repaired: 1, verified: false, verifiedNow: false, reset: true });
    expect(await c.tenantIndexVerified()).toBe(false);
    expect(await read(c, 'tA')).toEqual(['a', 'rolled-back']);

    // The window restarts from the reset, not from the original first pass.
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W + 61 * MIN })).toMatchObject({ verified: false });
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + 2 * W + 60 * MIN })).toMatchObject({ verified: true });
  });

  it('the first pass anchors the window; later passes never move it', async () => {
    const c = indexed();
    await c.reconcileTenantIndex({ windowMs: W, now: T0 });
    await c.reconcileTenantIndex({ windowMs: W, now: T0 + 90 * MIN });
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W })).toMatchObject({ verified: true });
  });

  it('a row with no tenant is skipped, not indexed under an empty tenant', async () => {
    const c = indexed();
    await legacy().put({ id: 'orphan', tenantId: '' });
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 })).toMatchObject({ repaired: 0, skipped: 1 });
  });

  it('ADR 0872 D3: a row with no tenant blocks verification and resets a verified index', async () => {
    const c = indexed();
    await legacy().put({ id: 'ok', tenantId: 'tA' });
    await legacy().put({ id: 'orphan', tenantId: '' });
    await c.ensureTenantIndex(); // the backfill skips it rather than throwing
    expect(await storage.kvGet(`hostextidx:${NAME}:tA:ok`)).not.toBeNull();
    await c.reconcileTenantIndex({ windowMs: W, now: T0 });
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W })).toMatchObject({ skipped: 1, verified: false });

    await storage.kvDelete(`hostext:${NAME}:orphan`);
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W + 1 })).toMatchObject({ verified: false }); // window restarted
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + 2 * W + 1 })).toMatchObject({ verified: true });

    await legacy().put({ id: 'late', tenantId: '' });
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + 3 * W })).toMatchObject({ skipped: 1, verified: false, reset: true });
  });

  it('ADR 0872 D3: a lost CAS against a row with no tenant repairs nothing and does not throw', async () => {
    const c = indexed();
    await legacy().put({ id: 'r', tenantId: '' });
    expect(await c.compareAndSwap({ id: 'r', tenantId: 'stale' }, { id: 'r', tenantId: 'tA' })).toBe(false);
    expect(await storage.kvList(`hostextidx:${NAME}:`)).toEqual([]);
  });

  it('ADR 0872 D2: beforeReconcile runs under the slot lease before the pass, and its failure does not stop the pass', async () => {
    const c = indexed();
    const order: string[] = [];
    registerTenantIndexAdoption(NAME, c, { beforeReconcile: async () => {
      order.push('hook');
      await legacy().put({ id: 'stamped-by-hook', tenantId: 'tA' });
    } });
    await reconcileTenantIndexesOnce(storage, T0);
    await reconcileTenantIndexesOnce(storage, T0 + 5 * MIN); // same slot: no second hook run
    expect(order).toEqual(['hook']);
    expect(await storage.kvGet(`hostextidx:${NAME}:tA:stamped-by-hook`)).not.toBeNull(); // the pass saw it

    __resetTenantIndexAdoptionRegistry();
    registerTenantIndexAdoption(NAME, c, { beforeReconcile: async () => { throw new Error('boom'); } });
    await legacy().put({ id: 'after-failure', tenantId: 'tA' });
    await reconcileTenantIndexesOnce(storage, T0 + 60 * MIN);
    expect(await storage.kvGet(`hostextidx:${NAME}:tA:after-failure`)).not.toBeNull();
  });

  it('malformed verification metadata fails closed and can be repaired', async () => {
    const c = indexed();
    const k = `hostextidxmeta:${NAME}:adoption`;
    await storage.kvSet(k, JSON.stringify({ since: 'bad', verifiedAt: 'also-bad' }));
    expect(await c.tenantIndexVerified()).toBe(false);
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 })).toMatchObject({ verified: false });
    expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W })).toMatchObject({ verified: true });
  });

  it('a delayed verification cannot overwrite a concurrent reset', async () => {
    const c = indexed();
    const k = `hostextidxmeta:${NAME}:adoption`;
    await c.reconcileTenantIndex({ windowMs: W, now: T0 });
    const cas = storage.kvCompareAndSwap.bind(storage);
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === k && next?.includes('verifiedAt')) {
        await storage.kvSet(k, JSON.stringify({ since: new Date(T0 + W).toISOString() }));
      }
      return cas(key, expected, next);
    });
    try {
      expect(await c.reconcileTenantIndex({ windowMs: W, now: T0 + W })).toMatchObject({ verified: false });
      expect(await c.tenantIndexVerified()).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('the hourly tick reconciles each registration once per slot, across instances', async () => {
    const c = indexed();
    registerTenantIndexAdoption(NAME, c);
    await legacy().put({ id: 'x', tenantId: 'tA' });
    await reconcileTenantIndexesOnce(storage, T0);
    // A second instance in the same hour holds no lease, so a row written now waits for the next slot.
    await legacy().put({ id: 'y', tenantId: 'tA' });
    await reconcileTenantIndexesOnce(storage, T0 + 5 * MIN);
    expect(await storage.kvGet(`hostextidx:${NAME}:tA:x`)).not.toBeNull();
    expect(await storage.kvGet(`hostextidx:${NAME}:tA:y`)).toBeNull();
    await reconcileTenantIndexesOnce(storage, T0 + 60 * MIN);
    expect(await storage.kvGet(`hostextidx:${NAME}:tA:y`)).not.toBeNull();
  });
});
