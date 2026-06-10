/**
 * Live Postgres schema-per-tenant SQL test — exercises the `postgres` sql
 * adapter against a REAL Postgres (testcontainers), validating the part the
 * unit tests can't: real DDL/DML, transaction commit/rollback, and — the whole
 * point — cross-tenant isolation via separate schemas.
 *
 * Gated on Docker; OPENWOP_PG_SQL_LIVE=1 (set by the dedicated CI job)
 * hard-requires the run so a green job means validated, never a silent skip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import type { SqlSurface } from '../src/host/inMemorySurfaces.js';
import { createPgSql, _resetPgSqlForTesting, type PgPool } from '../src/host/sql/pgSql.js';

async function isDockerReachable(): Promise<boolean> {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('docker info > /dev/null 2>&1', { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const forceLive = process.env.OPENWOP_PG_SQL_LIVE === '1';
const dockerAvailable = forceLive || await isDockerReachable();
if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[pg-sql-live] Docker not reachable — skipping. Set OPENWOP_PG_SQL_LIVE=1 to require it.');
}

let container: StartedPostgreSqlContainer | null = null;
let pgPool: Pool | null = null;
let pool: PgPool;

beforeAll(async () => {
  if (!dockerAvailable) return;
  _resetPgSqlForTesting();
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pgPool = new Pool({ connectionString: container.getConnectionUri() });
  pool = { connect: async () => pgPool!.connect() as unknown as ReturnType<PgPool['connect']> };
}, 180_000);

afterAll(async () => {
  if (pgPool) { try { await pgPool.end(); } catch { /* ignore */ } }
  if (container) { try { await container.stop(); } catch { /* ignore */ } }
}, 60_000);

const sqlFor = (tenantId: string): SqlSurface => createPgSql({ tenantId }, { pool });

describe('pg sql live integration (schema-per-tenant)', () => {
  it.skipIf(!dockerAvailable)('create/insert/query round-trips in the tenant schema', async () => {
    const sql = sqlFor('t1');
    await sql.execute({ sql: 'CREATE TABLE items (id serial PRIMARY KEY, name text)' });
    const ins = await sql.execute({ sql: 'INSERT INTO items (name) VALUES ($1)', params: ['widget'] }) as { changes: number };
    expect(ins.changes).toBe(1);
    const res = await sql.query({ sql: 'SELECT name FROM items WHERE name = $1', params: ['widget'] }) as { rows: Array<{ name: string }>; count: number };
    expect(res.rows[0].name).toBe('widget');
    expect(res.count).toBe(1);
  });

  it.skipIf(!dockerAvailable)('transaction commits all statements', async () => {
    const sql = sqlFor('t1');
    await sql.transaction({ statements: [
      { sql: 'INSERT INTO items (name) VALUES ($1)', params: ['a'] },
      { sql: 'INSERT INTO items (name) VALUES ($1)', params: ['b'] },
    ] });
    expect((await sql.query({ sql: 'SELECT count(*)::int AS n FROM items' }) as { rows: Array<{ n: number }> }).rows[0].n).toBe(3);
  });

  it.skipIf(!dockerAvailable)('transaction rolls back on error', async () => {
    const sql = sqlFor('t1');
    await expect(sql.transaction({ statements: [
      { sql: 'INSERT INTO items (name) VALUES ($1)', params: ['c'] },
      { sql: 'INSERT INTO nonexistent_table VALUES ($1)', params: ['x'] },
    ] })).rejects.toThrow();
    // the 'c' insert must have rolled back → still 3 rows
    expect((await sql.query({ sql: 'SELECT count(*)::int AS n FROM items' }) as { rows: Array<{ n: number }> }).rows[0].n).toBe(3);
  });

  it.skipIf(!dockerAvailable)('isolates tenants — t2 cannot see t1 tables (separate schema)', async () => {
    // t2's search_path is its own schema; `items` does not exist there.
    await expect(sqlFor('t2').query({ sql: 'SELECT * FROM items' })).rejects.toThrow(/does not exist|relation/i);
  });
});
