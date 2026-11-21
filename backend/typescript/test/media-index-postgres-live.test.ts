/**
 * #5928 ask 2 — the media index's WEIGHTED counter (count + bytes per org), the capacity
 * gate that reads it, its drift heal and the keyset-paged list, on REAL Postgres.
 * `media-org-indexed-reads.test.ts` pins the same behaviour on the memory store; this
 * file exists because production is Postgres and the train runs with
 * OPENWOP_SKIP_TESTCONTAINERS=1, so the counter's CAS writes, `kvListPage` recounts and
 * the byte-order cursor had never run there.
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set, else a `postgres:15-alpine`
 * testcontainer (production is 15) when Docker is reachable, else skips. Every row is
 * under a run-unique tenant id and deleted afterwards, so a shared DSN is safe. Pins:
 *   1. create / delete / an org move / a size change each move the org counter's count
 *      AND bytes (the move and size change go through the index hooks directly: no
 *      media API changes `orgId` or `sizeBytes`);
 *   2. `assertOrgCapacity` refuses at the count cap and at the byte cap, and admits an
 *      upload that fits when the counter is over-counted (the exact recount at the cap);
 *   3. a counter corrupted under and over is healed by `repairMediaIndex`;
 *   4. keyset paging with an insert and a delete between pages: no repeat, no skip;
 *   5. concurrent `withOrgCapacity` writes: exactly N fit (as adr0818's race test).
 *
 * Live-infra: skipped in `npm run ci` (OPENWOP_SKIP_TESTCONTAINERS=1), so it is not
 * sabotage-probed in the gate.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import pg from 'pg';
import type { Storage } from '../src/storage/storage.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();

// Loaded only when the suite runs: the media module registers its indexes at import.
type Media = typeof import('../src/features/media/mediaService.js');
type Index = typeof import('../src/features/entities/systemIndex.js');
let media: Media;
let idx: Index;

const RUN = `mipg${Date.now().toString(36)}`;
let n = 0;
const tenant = (): string => `${RUN}-t${++n}`;
let storage: Storage | null = null;
let client: pg.Client | null = null;
let stopContainer: (() => Promise<unknown>) | null = null;

beforeAll(async () => {
  if (!available) {
    console.warn('[media-index-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  let dsn = externalDsn ?? '';
  if (!externalDsn) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  storage = await openPostgresStorage(dsn);
  initHostExtPersistence(storage);
  client = new pg.Client({ connectionString: dsn });
  await client.connect();
  media = await import('../src/features/media/mediaService.js');
  idx = await import('../src/features/entities/systemIndex.js');
}, 180_000);

afterEach(() => {
  delete process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS;
  delete process.env.OPENWOP_MEDIA_ORG_MAX_BYTES;
  delete process.env.OPENWOP_MEDIA_TENANT_MAX_BYTES;
});

afterAll(async () => {
  if (client) {
    // Every row this run wrote names its tenant (primary rows, tenant-index markers and
    // the `entity:sysidx*` rows all carry it in the key or the value).
    await client.query(`DELETE FROM host_ext_kv WHERE k LIKE $1 OR v LIKE $1`, [`%${RUN}-t%`]).catch(() => {});
    await client.end().catch(() => {});
  }
  if (storage) await storage.close().catch(() => {});
  if (stopContainer) await stopContainer().catch(() => {});
}, 60_000);

const s = (): Storage => storage!;
const T_ASSET = 'media.asset';

/** One asset, created a few ms after the last so newest-first order is total. */
async function seed(T: string, ORG: string, bytes = 100): Promise<import('../src/features/media/mediaService.js').MediaAsset> {
  await new Promise((r) => setTimeout(r, 3));
  const k = `${T}-${++n}`;
  return media.createAsset({ tenantId: T, orgId: ORG, name: `${k}.png`, contentType: 'image/png', sizeBytes: bytes, storageRef: `ref-${k}`, serveToken: `tok-${k}`, uploadedBy: 'u' });
}

/** Rewrite a stored asset row through the media index's own hooks (what `assetStore`
 *  does): the path a size change or an org move would take. */
async function rewrite(a: import('../src/features/media/mediaService.js').MediaAsset): Promise<void> {
  await idx.beforeSystemWrite(T_ASSET, a.tenantId, a.assetId, a);
  await s().kvSet(`hostext:media:asset:${a.assetId}`, JSON.stringify(a));
  await idx.afterSystemWrite(T_ASSET, a.tenantId, a.assetId, a);
}

const totals = (T: string, org: string, exact = false): Promise<{ count: number; sum: number }> => idx.indexedTotals(T, T_ASSET, org, { exact });

async function corruptCounter(T: string, org: string, count: number, sum: number): Promise<void> {
  const k = `${T}:${T_ASSET}:${org}`;
  await s().kvSet(`hostext:entity:sysidx-count:${k}`, JSON.stringify({ k, tenantId: T, orgId: org, type: T_ASSET, count, sum }));
}

/** `repairMediaIndex` runs its drift check once per UTC hour fleet-wide; clear the lease
 *  so this run's check is not skipped by an earlier one on a shared database. */
async function repairNow(): Promise<void> {
  await s().kvDelete('hostext:media:index-hour:hour');
  await media.repairMediaIndex();
}

describe.skipIf(!available)('#5928 — the media index on real Postgres', () => {
  it('1. create, delete, an org move and a size change move the counter count AND bytes', async () => {
    const T = tenant();
    const a = await seed(T, 'org-a', 100);
    const b = await seed(T, 'org-a', 200);
    await seed(T, 'org-a', 300);
    await media.assertOrgCapacity(T, 'org-a', 1); // builds and verifies the tenant's index
    expect(await totals(T, 'org-a')).toEqual({ count: 3, sum: 600 });
    expect(await media.deleteAsset(T, 'org-a', a.assetId)).toBe(true);
    expect(await totals(T, 'org-a')).toEqual({ count: 2, sum: 500 });
    await rewrite({ ...b, sizeBytes: 250 });
    expect(await totals(T, 'org-a')).toEqual({ count: 2, sum: 550 });
    await rewrite({ ...b, sizeBytes: 250, orgId: 'org-b' });
    expect(await totals(T, 'org-a')).toEqual({ count: 1, sum: 300 });
    expect(await totals(T, 'org-b')).toEqual({ count: 1, sum: 250 });
    expect(await idx.indexedTenantTotals(T, T_ASSET)).toEqual({ count: 2, sum: 550 });
    // The maintained rows agree with an exact recount of the markers.
    expect(await totals(T, 'org-a', true)).toEqual({ count: 1, sum: 300 });
    expect(await idx.indexedTenantTotals(T, T_ASSET, { exact: true })).toEqual({ count: 2, sum: 550 });
  });

  it('2. the gate refuses at the count cap and the byte cap, recounting exactly at the cap', async () => {
    const T = tenant();
    for (let i = 0; i < 3; i += 1) await seed(T, 'org-a', 1000);
    process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS = '3';
    await expect(media.assertOrgCapacity(T, 'org-a', 1)).rejects.toMatchObject({ httpStatus: 409, details: { max: 3 } });
    delete process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS;
    process.env.OPENWOP_MEDIA_ORG_MAX_BYTES = '3500';
    await expect(media.assertOrgCapacity(T, 'org-a', 501)).rejects.toMatchObject({ httpStatus: 409, details: { maxBytes: 3500 } });
    await media.assertOrgCapacity(T, 'org-a', 500);
    // Over-counted: the counter claims the org is full, the exact recount says it is not.
    process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS = '5';
    await corruptCounter(T, 'org-a', 9, 99_999);
    await media.assertOrgCapacity(T, 'org-a', 500);
    expect(await totals(T, 'org-a')).toEqual({ count: 3, sum: 3000 });
  });

  it('3. a counter corrupted under and over is healed by repairMediaIndex', async () => {
    const T = tenant();
    for (let i = 0; i < 3; i += 1) await seed(T, 'org-a', 400);
    await seed(T, 'org-b', 50);
    await media.assertOrgCapacity(T, 'org-a', 1);
    await corruptCounter(T, 'org-a', 1, 1); // under
    await corruptCounter(T, 'org-b', 40, 1_000_000); // over
    await repairNow();
    expect(await totals(T, 'org-a')).toEqual({ count: 3, sum: 1200 });
    expect(await totals(T, 'org-b')).toEqual({ count: 1, sum: 50 });
    process.env.OPENWOP_MEDIA_ORG_MAX_BYTES = '1000';
    await expect(media.assertOrgCapacity(T, 'org-a', 1)).rejects.toMatchObject({ details: { maxBytes: 1000 } });
  });

  it('4. keyset paging with an insert and a delete between pages: no repeat, no skip', async () => {
    const T = tenant();
    const rows = [];
    for (let i = 0; i < 10; i += 1) rows.push(await seed(T, 'org-a'));
    await seed(T, 'org-b');
    const newestFirst = [...rows].reverse().map((a) => a.assetId);
    const deletedSeen = newestFirst[0]!;
    const deletedUnseen = newestFirst[8]!;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const page = await media.listAssetsPage(T, 'org-a', { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.assets.map((a) => a.assetId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (i === 0) await media.deleteAsset(T, 'org-a', deletedSeen); // an offset cursor would now skip
      if (i === 1) { await seed(T, 'org-a'); await media.deleteAsset(T, 'org-a', deletedUnseen); } // and repeat
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(newestFirst.filter((id) => id !== deletedUnseen));
    expect((await media.listAssetsPage(T, 'org-a', { limit: 1 })).total).toBe(9);
  });

  it('5. concurrent capacity-gated writes: exactly N fit', async () => {
    const T = tenant();
    await media.assertOrgCapacity(T, 'org-a', 1); // build the (empty) index first
    process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS = '4';
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => media.withOrgCapacity(T, 'org-a', 100, () => {
      const k = `${T}-race-${i}`;
      return media.createAsset({ tenantId: T, orgId: 'org-a', name: `${k}.png`, contentType: 'image/png', sizeBytes: 100, storageRef: `ref-${k}`, serveToken: `tok-${k}`, uploadedBy: 'u' });
    })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(6);
    for (const r of refused) expect(r.reason).toMatchObject({ httpStatus: 409 });
    expect(await totals(T, 'org-a', true)).toEqual({ count: 4, sum: 400 });
    // The byte cap races the same way.
    delete process.env.OPENWOP_MEDIA_ORG_MAX_ASSETS;
    process.env.OPENWOP_MEDIA_ORG_MAX_BYTES = '700';
    const bytes = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => media.withOrgCapacity(T, 'org-a', 100, () => {
      const k = `${T}-brace-${i}`;
      return media.createAsset({ tenantId: T, orgId: 'org-a', name: `${k}.png`, contentType: 'image/png', sizeBytes: 100, storageRef: `ref-${k}`, serveToken: `tok-${k}`, uploadedBy: 'u' });
    })));
    expect(bytes.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await totals(T, 'org-a', true)).toEqual({ count: 7, sum: 700 });
  });
});
