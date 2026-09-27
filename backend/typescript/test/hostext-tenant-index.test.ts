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

  it('FU-DATA-4: a tenantOf that produces a non-string tenantId throws instead of minting an `undefined` marker', async () => {
    interface Loose { id: string; tenantId?: string }
    const c = new DurableCollection<Loose>('test:guard', (r) => r.id, undefined, (r) => r.tenantId as string);
    await expect(c.put({ id: 'x' })).rejects.toThrow(/tenantId/);
    expect(await storage.kvList('hostextidx:test:guard:')).toEqual([]); // no `undefined` slice
    expect(await c.get('x')).toBeNull(); // marker-first ordering: the row write never ran either
  });

  it('FU-DATA-2: a FAILED compareAndSwap repairs the pre-written marker from the authoritative row', async () => {
    const c = indexed();
    await c.put({ id: 'a', tenantId: 'tA', v: 1 });
    // Stale `expected` → swap refused, index still describes the stored row.
    expect(await c.compareAndSwap({ id: 'a', tenantId: 'tA', v: 99 }, { id: 'a', tenantId: 'tA', v: 2 })).toBe(false);
    expect((await c.listForTenantIndexed('tA'))[0].v).toBe(1);
    // Failed insert-if-absent over an existing row: marker stays coherent.
    expect(await c.compareAndSwap(null, { id: 'a', tenantId: 'tA', v: 3 })).toBe(false);
    expect(ids(await c.listForTenantIndexed('tA'))).toEqual(['a']);
    // Failed swap on a genuinely-ABSENT row leaves no orphan marker behind.
    expect(await c.compareAndSwap({ id: 'zz', tenantId: 'tA', v: 0 }, { id: 'zz', tenantId: 'tA', v: 1 })).toBe(false);
    expect(await storage.kvGet('hostextidx:test:indexed:tA:zz')).toBeNull();
  });

  // GC-CV-11 — projected tenant index: the marker carries an identity projection
  // so a tenant listing never decodes the (possibly large) primary rows.
  interface BlobRow { id: string; tenantId: string; v: number; blob: string }
  const projected = () => new DurableCollection<BlobRow>(
    'test:projected', (r) => r.id, undefined, (r) => r.tenantId,
    (r) => ({ id: r.id, v: r.v }), // projection: identity fields, NOT the blob
  );

  it('listForTenantProjected returns the marker projection without the full row (no blob)', async () => {
    const c = projected();
    await c.put({ id: 'a', tenantId: 'tA', v: 1, blob: 'x'.repeat(10000) });
    await c.put({ id: 'b', tenantId: 'tA', v: 2, blob: 'y'.repeat(10000) });
    await c.put({ id: 'z', tenantId: 'tB', v: 9, blob: 'z' });
    const rows = await c.listForTenantProjected('tA');
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    // The projection carries the identity fields but NOT the blob.
    expect(rows.every((r) => r.v !== undefined && r.blob === undefined)).toBe(true);
    expect((await c.listForTenantProjected('tB')).map((r) => r.id)).toEqual(['z']);
  });

  it('projected read self-heals a legacy bare-id marker (written before the projection)', async () => {
    // A legacy writer (no projection) leaves bare-id markers; the same backend
    // read through the projecting collection upgrades them on first read.
    const legacyProj = new DurableCollection<BlobRow>('test:projected', (r) => r.id, undefined, (r) => r.tenantId);
    await legacyProj.put({ id: 'a', tenantId: 'tA', v: 5, blob: 'big' });
    const marker0 = await storage.kvGet('hostextidx:test:projected:tA:a');
    expect(marker0).toBe('a'); // bare id, no projection

    const c = projected();
    const rows = await c.listForTenantProjected('tA');
    expect(rows).toEqual([{ id: 'a', v: 5 }]); // projected via a one-time row read
    // ...and the marker is upgraded so the next read pays no primary read.
    const marker1 = await storage.kvGet('hostextidx:test:projected:tA:a');
    expect(marker1).toContain('"p"');
  });

  it('listForTenantIndexed still works over projected {id,p} markers (reads the id out)', async () => {
    const c = projected();
    await c.put({ id: 'a', tenantId: 'tA', v: 1, blob: 'b' });
    const full = await c.listForTenantIndexed('tA');
    expect(full).toEqual([{ id: 'a', tenantId: 'tA', v: 1, blob: 'b' }]); // full row, incl. blob
  });

  it('listForTenantProjected requires an indexProjection', async () => {
    await expect(indexed().listForTenantProjected('tA')).rejects.toThrow(/indexProjection/);
  });
});
