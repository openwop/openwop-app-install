/**
 * ADR 0871 — the growth gauge's SQL on REAL Postgres with pgvector.
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set (a PGlite socket server with
 * pglite-pgvector works), else a `pgvector/pgvector:pg15` container, else skips.
 * pg-mem cannot parse `split_part` over `~>=~` ranges or pgvector types, which is
 * why the unit test runs on sqlite and this one exists.
 *
 *   - `surfaceRowStats`: an encoded `anon:` tenant is one tenant, and the totals
 *     equal `kvCount('hostsurf:')`;
 *   - the pgvector stats probe counts (tenant, namespace) groups and reads the
 *     extension version from the live database.
 *
 * Tracker TST-BFC-7. Live-infra: skipped in `npm run ci`
 * (OPENWOP_SKIP_TESTCONTAINERS=1), so it is not sabotage-probed in the gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import pg from 'pg';
import type { Storage } from '../src/storage/storage.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { createDurableKv } from '../src/host/durable/durableKv.js';
import { createPgVectorVector, readPgVectorStatsWith, createTableSql, CREATE_EXTENSION_SQL } from '../src/host/vector/pgVectorVector.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();

const TABLE = 'adr0871_vectors';
const ANON = 'anon:adr0871-live';
let storage: Storage | null = null;
let client: pg.Client | null = null;
let stopContainer: (() => Promise<unknown>) | null = null;

beforeAll(async () => {
  if (!available) {
    console.warn('[adr0871-storage-growth-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  let dsn = externalDsn ?? '';
  if (!externalDsn) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('pgvector/pgvector:pg15').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  storage = await openPostgresStorage(dsn);
  client = new pg.Client({ connectionString: dsn });
  await client.connect();
  await client.query(`DELETE FROM host_ext_kv WHERE k LIKE 'hostsurf:%'`);
  setDurableStorage(storage);
  const a = createDurableKv({ tenantId: ANON });
  for (const k of ['a', 'b', 'c']) await a.set({ key: k, value: k });
  await createDurableKv({ tenantId: 'adr0871-b' }).set({ key: 'x', value: 1 });

  await client.query(CREATE_EXTENSION_SQL);
  await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await client.query(createTableSql(TABLE, 3));
}, 180_000);

afterAll(async () => {
  setDurableStorage(null);
  if (client) {
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await client.end().catch(() => {});
  }
  if (storage) await storage.close().catch(() => {});
  if (stopContainer) await stopContainer().catch(() => {});
}, 60_000);

describe.skipIf(!available)('ADR 0871 gauge SQL on real Postgres', () => {
  it('surfaceRowStats counts an encoded anon: tenant once, and totals every hostsurf: row', async () => {
    const stats = await storage!.surfaceRowStats!(3);
    expect(stats.find((s) => s.family === 'kv')).toEqual({
      family: 'kv', tenants: 2, maxTenantRows: 3, totalRows: 4, tenantsAtOrOver: 1,
    });
    const sum = stats.reduce((n, s) => n + s.totalRows, 0);
    expect(sum).toBe(await storage!.kvCount!('hostsurf:'));
  });

  it('the pgvector probe counts (tenant, namespace) groups and reads the live extension version', async () => {
    const run = async (sql: string, params: unknown[]) => ({ rows: (await client!.query(sql, params)).rows });
    const t1 = createPgVectorVector({ tenantId: 't1' }, { run, dim: 3, table: TABLE });
    const t2 = createPgVectorVector({ tenantId: 't2' }, { run, dim: 3, table: TABLE });
    await t1.upsert({ namespace: 'docs', items: [1, 2, 3].map((i) => ({ id: `d${i}`, vector: [i, 1, 0] })) });
    await t1.upsert({ namespace: 'notes', items: [{ id: 'n1', vector: [0, 1, 0] }] });
    await t2.upsert({ namespace: 'docs', items: [{ id: 'd1', vector: [1, 0, 0] }, { id: 'd2', vector: [0, 0, 1] }] });

    const s = await readPgVectorStatsWith(run, TABLE, 3, 2);
    expect(s).toMatchObject({ namespaces: 3, maxNamespaceRows: 3, totalRows: 6, namespacesAtOrOver: 2, dim: 3 });
    expect(s.extversion).toMatch(/^\d+\.\d+/);
  });
});
