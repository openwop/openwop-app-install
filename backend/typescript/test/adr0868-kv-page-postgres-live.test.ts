/**
 * ADR 0868 — `kvListPage` / `kvCount` on REAL Postgres (pg-mem cannot parse the
 * `~>~` / `USING ~<~` byte-order operators these use).
 *
 * Runs against `OPENWOP_PG_TEST_DSN` when set (any Postgres; the ADR's own
 * evidence used a PGlite socket server, no Docker), else a `postgres:15-alpine`
 * testcontainer (production is 15) when Docker is reachable, else skips with a
 * notice. Pins:
 *   - a page is `limit` rows, key > `after`, in UTF-8 BYTE order — the same
 *     order the sqlite adapter and the JS fallback use, so a cursor from one
 *     page resumes exactly on the next;
 *   - LIKE metacharacters in the prefix are literal;
 *   - the plan is an ordered index scan that STOPS at the page: EXPLAIN ANALYZE
 *     reports the index node returned `limit` rows, not the prefix's 5000;
 *   - `kvCount` counts in the database;
 *   - the durable table and queue surfaces page on it end to end.
 *
 * Tracker TST-BFC-2. Live-infra: skipped in `npm run ci`
 * (OPENWOP_SKIP_TESTCONTAINERS=1), so it is not sabotage-probed in the gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import pg from 'pg';
import type { Storage } from '../src/storage/storage.js';
import { openPostgresStorage } from '../src/storage/postgres/index.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { createDurableTable } from '../src/host/durable/durableTable.js';
import { createDurableQueue } from '../src/host/durable/durableQueue.js';

function dockerReachable(): boolean {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try { execSync('docker info > /dev/null 2>&1', { timeout: 5000 }); return true; } catch { return false; }
}
const externalDsn = process.env.OPENWOP_PG_TEST_DSN;
const available = !!externalDsn || dockerReachable();

let storage: Storage | null = null;
let dsn = '';
let stopContainer: (() => Promise<unknown>) | null = null;

beforeAll(async () => {
  if (!available) {
    console.warn('[adr0868-kv-page-postgres-live] no OPENWOP_PG_TEST_DSN and no Docker — skipping.');
    return;
  }
  if (externalDsn) {
    dsn = externalDsn;
  } else {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const c = await new PostgreSqlContainer('postgres:15-alpine').start();
    dsn = c.getConnectionUri();
    stopContainer = () => c.stop();
  }
  storage = await openPostgresStorage(dsn);
  const P = 'adr0868:big:';
  const c = new pg.Client({ connectionString: dsn });
  await c.connect();
  await c.query(`DELETE FROM host_ext_kv WHERE k LIKE 'adr0868:%'`);
  await c.query(
    `INSERT INTO host_ext_kv (k, v, updated_at)
     SELECT $1 || lpad(i::text, 6, '0'), repeat('x', 100), '' FROM generate_series(1, 5000) i`,
    [P],
  );
  await c.query('ANALYZE host_ext_kv');
  await c.end();
}, 180_000);

afterAll(async () => {
  setDurableStorage(null);
  if (storage) await storage.close().catch(() => {});
  if (stopContainer) await stopContainer().catch(() => {});
}, 60_000);

const s = (): Storage => storage!;

describe.skipIf(!available)('ADR 0868 — kvListPage on real Postgres', () => {
  it('pages in byte order with an exclusive cursor, and LIKE metacharacters are literal', async () => {
    const keys = ['adr0868:o:a', 'adr0868:o:B', 'adr0868:o:_x', 'adr0868:o:%y', 'adr0868:o:é', 'adr0868:o:😀', 'adr0868:o:\uE000', 'adr0868:oX:z'];
    for (const k of keys) await s().kvSet(k, k);
    const want = keys.filter((k) => k.startsWith('adr0868:o:'))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const got: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await s().kvListPage!('adr0868:o:', { after, limit: 3 });
      got.push(...page.map((r) => r.key));
      if (page.length < 3) break;
      after = page[page.length - 1]!.key;
    }
    expect(got).toEqual(want);
    expect((await s().kvListPage!('adr0868:o:_', { limit: 10 })).map((r) => r.key)).toEqual(['adr0868:o:_x']);
    expect((await s().kvListPage!('adr0868:o:%', { limit: 10 })).map((r) => r.key)).toEqual(['adr0868:o:%y']);
    expect(await s().kvCount!('adr0868:o:')).toBe(want.length);
  });

  it('the plan is an ordered index scan that stops at the page (rows read = limit, not 5000)', async () => {
    const c = new pg.Client({ connectionString: dsn });
    await c.connect();
    try {
      const { rows } = await c.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) SELECT k, v FROM host_ext_kv WHERE k LIKE $1 ESCAPE '\\' AND k ~>~ $2 ORDER BY k USING ~<~ LIMIT $3`,
        ['adr0868:big:%', 'adr0868:big:001000', 10],
      );
      const plan = (rows[0] as { 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> })['QUERY PLAN'][0]!.Plan;
      const scan = (plan['Plans'] as Array<Record<string, unknown>>)[0]!;
      expect(plan['Node Type']).toBe('Limit');
      expect(scan['Node Type']).toBe('Index Scan');
      expect(scan['Actual Rows']).toBe(10);
    } finally {
      await c.end();
    }
    const page = await s().kvListPage!('adr0868:big:', { after: 'adr0868:big:001000', limit: 10 });
    expect(page.map((r) => r.key)).toEqual(Array.from({ length: 10 }, (_, i) => `adr0868:big:${String(1001 + i).padStart(6, '0')}`));
    expect(await s().kvCount!('adr0868:big:')).toBe(5000);
  });

  it('the durable table and queue page on it end to end', async () => {
    setDurableStorage(s());
    const table = createDurableTable({ tenantId: 'adr0868-pg' });
    for (let i = 0; i < 25; i++) await table.insert({ table: 't', row: { id: `r${String(i).padStart(2, '0')}`, n: i } });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const r = await table.query({ table: 't', limit: 10, cursor }) as { rows: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...r.rows.map((x) => x.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `r${String(i).padStart(2, '0')}`));
    expect(await table.count({ table: 't' })).toEqual({ count: 25 });

    const q = createDurableQueue({ tenantId: 'adr0868-pg' });
    for (let i = 0; i < 20; i++) await q.enqueue({ queue: 'jobs', payload: i });
    const order: unknown[] = [];
    for (let i = 0; i < 20; i++) order.push((await q.dequeue({ queue: 'jobs' }) as { payload: unknown }).payload);
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(await q.dequeue({ queue: 'jobs' })).toEqual({ found: false });
  });
});
