/**
 * ADR 0871 — the hourly storage-growth gauge, on sqlite storage.
 *
 *   - `surfaceRowStats` aggregates by family and tenant, and a tenant id holding
 *     the key delimiter (`anon:…`, encoded by durableStore) is still ONE tenant;
 *   - its totals account for every `hostsurf:` row (no row lost to the parse);
 *   - the gauge runs once per UTC hour across instances sharing one Storage;
 *   - no gauge line carries a tenant id;
 *   - `OPENWOP_STORAGE_GROWTH_GAUGE=false` turns it off. *
 * Tracker TST-BFC-6. Red when: the hourly lease check is removed; the off
 * switch is ignored; the sqlite aggregate stops cutting the tenant at its
 * delimiter.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { createDurableKv } from '../src/host/durable/durableKv.js';
import { createDurableTable } from '../src/host/durable/durableTable.js';
import { runStorageGrowthGaugeOnce } from '../src/host/storageGrowthGauge.js';

const HOUR = 60 * 60_000;
const ANON = 'anon:growth-1';

let storage: Storage;

beforeAll(async () => {
  storage = await openStorage('memory://');
  setDurableStorage(storage);
  const a = createDurableKv({ tenantId: ANON });
  for (const k of ['a', 'b', 'c']) await a.set({ key: k, value: k });
  await createDurableKv({ tenantId: 'growth-2' }).set({ key: 'only', value: 1 });
  const t = createDurableTable({ tenantId: 'growth-2' });
  for (const id of ['r1', 'r2']) await t.insert({ table: 'items', row: { id } });
});
afterAll(async () => {
  setDurableStorage(null);
  await storage.close();
});

describe('surfaceRowStats (sqlite)', () => {
  it('counts an encoded anon: tenant as one tenant', async () => {
    const kv = (await storage.surfaceRowStats!(3)).find((s) => s.family === 'kv');
    expect(kv).toEqual({ family: 'kv', tenants: 2, maxTenantRows: 3, totalRows: 4, tenantsAtOrOver: 1 });
  });

  it('accounts for every hostsurf: row across families', async () => {
    const stats = await storage.surfaceRowStats!(1);
    const sum = stats.reduce((n, s) => n + s.totalRows, 0);
    expect(sum).toBe(await storage.kvCount!('hostsurf:'));
    expect(stats.length).toBeGreaterThanOrEqual(2);
  });
});

describe('runStorageGrowthGaugeOnce', () => {
  let out: string[] = [];
  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENWOP_STORAGE_GROWTH_GAUGE;
  });

  it('runs once per hour across instances, and logs no tenant id', async () => {
    const t0 = 1_000 * HOUR + 5_000;
    expect(await runStorageGrowthGaugeOnce(storage, t0)).toBe(true);
    // A second instance in the same hour loses the lease.
    expect(await runStorageGrowthGaugeOnce(storage, t0 + 60_000)).toBe(false);
    const lines = out.filter((l) => l.includes('surface_rows_gauge'));
    expect(lines.some((l) => l.includes('"family":"kv"') && l.includes('"maxTenantRows":3'))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain('growth-1');
      expect(l).not.toContain('growth-2');
    }
    // pgvector is not selected here, so there is no vector line.
    expect(out.some((l) => l.includes('vector_rows_gauge'))).toBe(false);

    out = [];
    expect(await runStorageGrowthGaugeOnce(storage, t0 + HOUR)).toBe(true);
    expect(out.some((l) => l.includes('surface_rows_gauge'))).toBe(true);
  });

  it('is off when OPENWOP_STORAGE_GROWTH_GAUGE=false', async () => {
    process.env.OPENWOP_STORAGE_GROWTH_GAUGE = 'false';
    expect(await runStorageGrowthGaugeOnce(storage, 5_000 * HOUR)).toBe(false);
    expect(out.some((l) => l.includes('surface_rows_gauge'))).toBe(false);
  });
});
