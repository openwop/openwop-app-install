/**
 * GOV-1 — DurableCollection tenant secondary index.
 *
 * A collection constructed with a `tenantOf` extractor maintains a secondary index in a
 * separate `hostextidx:` keyspace so `listForTenantIndexed(tenantId)` is a BOUNDED scan of
 * one tenant's slice — without re-keying the primary rows (zero data-migration / data-loss
 * risk on the primary store). Verifies: index maintained on put/delete/CAS, cross-tenant
 * isolation, one-time backfill of pre-index rows, stale-marker self-heal, and that the
 * primary key scheme is unchanged (a plain `get(id)` still works).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';

interface Row { id: string; tenantId: string; v: number }
const indexed = () => new DurableCollection<Row>('test:indexed', (r) => r.id, undefined, (r) => r.tenantId);
const legacy = () => new DurableCollection<Row>('test:indexed', (r) => r.id); // SAME backend, NO tenantOf (pre-index writer)

const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('GOV-1 — DurableCollection tenant index', () => {
  it('listForTenantIndexed returns ONLY the tenant slice; the primary get(id) is unchanged', async () => {
    const c = indexed();
    await c.put({ id: 'a', tenantId: 'tA', v: 1 });
    await c.put({ id: 'b', tenantId: 'tA', v: 2 });
    await c.put({ id: 'z', tenantId: 'tB', v: 9 });

    expect(ids(await c.listForTenantIndexed('tA'))).toEqual(['a', 'b']);
    expect(ids(await c.listForTenantIndexed('tB'))).toEqual(['z']);
    expect(await c.listForTenantIndexed('tNone')).toEqual([]);
    // The primary rows are NOT re-keyed — a bare-id get still resolves.
    expect((await c.get('a'))?.v).toBe(1);
  });

  it('maintains the index on put (update) and delete', async () => {
    const c = indexed();
    await c.put({ id: 'a', tenantId: 'tA', v: 1 });
    await c.put({ id: 'a', tenantId: 'tA', v: 2 }); // update — still one marker
    expect(ids(await c.listForTenantIndexed('tA'))).toEqual(['a']);
    expect((await c.listForTenantIndexed('tA'))[0].v).toBe(2);

    await c.delete('a');
    expect(await c.listForTenantIndexed('tA')).toEqual([]); // marker cleaned
    expect(await c.get('a')).toBeNull();
  });

  it('one-time backfill picks up rows written BEFORE the index existed (no marker on write)', async () => {
    // Simulate legacy rows: written via a NO-tenantOf collection over the same backend, so
    // no index markers were created. The indexed view backfills them on first use.
    const old = legacy();
    await old.put({ id: 'l1', tenantId: 'tA', v: 1 });
    await old.put({ id: 'l2', tenantId: 'tB', v: 2 });

    const c = indexed();
    expect(ids(await c.listForTenantIndexed('tA'))).toEqual(['l1']); // backfilled
    expect(ids(await c.listForTenantIndexed('tB'))).toEqual(['l2']);
    // A row added AFTER backfill is indexed live (not via another backfill).
    await c.put({ id: 'l3', tenantId: 'tA', v: 3 });
    expect(ids(await c.listForTenantIndexed('tA'))).toEqual(['l1', 'l3']);
  });

  it('self-heals a STALE marker whose primary row was deleted out-of-band', async () => {
    const c = indexed();
    await c.put({ id: 'a', tenantId: 'tA', v: 1 });
    // Delete the primary row directly via storage (bypassing the collection) → marker is now stale.
    await storage.kvDelete('hostext:test:indexed:a');
    expect(ids(await c.listForTenantIndexed('tA'))).toEqual([]); // stale marker skipped
    // ...and removed, so the index slice is clean afterwards.
    expect(await storage.kvGet('hostextidx:test:indexed:tA:a')).toBeNull();
  });

  it('maintains the index through compareAndSwap', async () => {
    const c = indexed();
    const created = { id: 'a', tenantId: 'tA', v: 1 };
    expect(await c.compareAndSwap(null, created)).toBe(true); // insert-if-absent
    expect(ids(await c.listForTenantIndexed('tA'))).toEqual(['a']);
    expect(await c.compareAndSwap(created, { id: 'a', tenantId: 'tA', v: 2 })).toBe(true);
    expect((await c.listForTenantIndexed('tA'))[0].v).toBe(2);
  });

  it('a non-indexed collection (no tenantOf) refuses the indexed read (programming error)', async () => {
    await expect(legacy().listForTenantIndexed('tA')).rejects.toThrow(/requires a tenantOf/);
  });
});
