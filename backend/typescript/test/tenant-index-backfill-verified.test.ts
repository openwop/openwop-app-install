/**
 * ADR 1155 P0 follow-up — the one-time tenant-index backfill is skipped once the
 * index is verified (ADR 0866).
 *
 * `ensureTenantIndex` runs at the start of every indexed read. Until its sentinel
 * exists it lists the WHOLE collection, every tenant, and rewrites one marker per
 * row. On a verified index every one of those markers already exists (the reconcile
 * pass that verified it wrote them), so the scan only rewrote identical values: the
 * P0 baseline measured 25,000 writes on one board GET. A verified index now just
 * seals the sentinel.
 *
 * Red if: the first indexed read after verification scans the collection or writes
 * a marker; or an UNverified index stops backfilling a row that has no marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';

interface Row { id: string; tenantId: string; v: number }
const NAME = 'test:backfill-verified';
const indexed = () => new DurableCollection<Row>(NAME, (r) => r.id, undefined, (r) => r.tenantId);
const legacy = () => new DurableCollection<Row>(NAME, (r) => r.id); // same backend, no tenantOf: writes no marker
const SENTINEL = `hostextidxmeta:${NAME}:backfilled`;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-23T00:00:00Z');
const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(() => { vi.restoreAllMocks(); });

async function seedLegacy(): Promise<void> {
  const old = legacy();
  await old.put({ id: 'a1', tenantId: 'tA', v: 1 });
  await old.put({ id: 'a2', tenantId: 'tA', v: 2 });
  await old.put({ id: 'b1', tenantId: 'tB', v: 3 });
}

describe('tenant index — backfill on a verified index', () => {
  it('the first indexed read after verification seals the sentinel without scanning or writing markers', async () => {
    await seedLegacy();
    const c = indexed();
    expect((await c.reconcileTenantIndex({ windowMs: 3 * HOUR, now: T0 })).repaired).toBe(3);
    expect((await c.reconcileTenantIndex({ windowMs: 3 * HOUR, now: T0 + 3 * HOUR })).verified).toBe(true);
    expect(await storage.kvGet(SENTINEL)).toBeNull();

    const sets = vi.spyOn(storage, 'kvSet');
    const lists = vi.spyOn(storage, 'kvList');
    expect(ids(await c.listForTenantIndexed('tA'))).toEqual(['a1', 'a2']);

    expect(sets.mock.calls.map(([k]) => k), 'a verified read must not rewrite markers').toEqual([SENTINEL]);
    expect(lists.mock.calls.map(([p]) => p), 'a verified read must list only the tenant slice').toEqual([`hostextidx:${NAME}:tA:`]);
    expect(await storage.kvGet(SENTINEL)).toBe('1');
  });

  it('an unverified index still backfills a row that has no marker', async () => {
    await seedLegacy();
    const c = indexed();
    const sets = vi.spyOn(storage, 'kvSet');
    expect(ids(await c.listForTenantIndexed('tB'))).toEqual(['b1']);
    expect(sets.mock.calls.map(([k]) => k).filter((k) => k.startsWith('hostextidx:')).sort())
      .toEqual([`hostextidx:${NAME}:tA:a1`, `hostextidx:${NAME}:tA:a2`, `hostextidx:${NAME}:tB:b1`]);
    expect(await storage.kvGet(SENTINEL)).toBe('1');
  });
});
