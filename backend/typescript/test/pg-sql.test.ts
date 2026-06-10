import { afterEach, describe, expect, it } from 'vitest';
import type { SqlSurface } from '../src/host/inMemorySurfaces.js';
import {
  createPgSql, schemaForTenant, requireParametric, _resetPgSqlForTesting,
  type PgPool, type PgClient,
} from '../src/host/sql/pgSql.js';

describe('pg sql pure helpers', () => {
  it('schemaForTenant sanitizes + namespaces; strips injection chars', () => {
    expect(schemaForTenant('Acme-Corp')).toBe('tenant_acme_corp');
    expect(schemaForTenant('user:abc')).toBe('tenant_user_abc');
    expect(schemaForTenant('!!!')).toBe('tenant_unknown'); // degenerate → safe fallback
    // Any injection attempt reduces to a safe [a-z0-9_] identifier.
    const evil = schemaForTenant('a"; DROP SCHEMA x; --');
    expect(evil).toMatch(/^tenant_[a-z0-9_]+$/);
    expect(evil).not.toMatch(/["';-]| /);
  });
  it('requireParametric blocks template-literal + OR 1=1 shapes', () => {
    expect(() => requireParametric('SELECT 1')).not.toThrow();
    expect(() => requireParametric('SELECT * WHERE x = ${y}')).toThrow(/non-parametric/i);
    expect(() => requireParametric("SELECT * WHERE a='' OR '1'='1'")).toThrow(/non-parametric/i);
  });
});

// Recording fake pool: captures the SQL sequence + returns canned results.
function makeFakePool() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let released = 0;
  const client: PgClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^SELECT/i.test(sql)) return { rows: [{ n: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 2 };
    },
    release() { released++; },
  };
  const pool: PgPool = { connect: async () => client };
  return { pool, calls, sqls: () => calls.map((c) => c.sql), released: () => released };
}

describe('pg sql adapter orchestration (fake pool)', () => {
  afterEach(() => _resetPgSqlForTesting());

  const sqlFor = (tenantId: string, pool: PgPool): SqlSurface => createPgSql({ tenantId }, { pool });

  it('query scopes to the tenant schema and maps {rows,count}', async () => {
    const f = makeFakePool();
    const res = await sqlFor('t1', f.pool).query({ sql: 'SELECT * FROM items', params: [] }) as { rows: unknown[]; count: number };
    expect(res).toEqual({ rows: [{ n: 1 }], count: 1 });
    expect(f.sqls()[0]).toMatch(/CREATE SCHEMA IF NOT EXISTS "tenant_t1"/);
    expect(f.sqls()[1]).toBe('SET search_path TO "tenant_t1", public');
    expect(f.sqls()[2]).toBe('SELECT * FROM items');
    expect(f.released()).toBe(1); // client always released
  });

  it('schema DDL runs once per tenant (memoized)', async () => {
    const f = makeFakePool();
    const sql = sqlFor('t1', f.pool);
    await sql.query({ sql: 'SELECT 1' });
    await sql.query({ sql: 'SELECT 2' });
    expect(f.sqls().filter((s) => s.startsWith('CREATE SCHEMA')).length).toBe(1);
  });

  it('execute reports changes; lastInsertRowid is 0 (pg has no rowid)', async () => {
    const f = makeFakePool();
    expect(await sqlFor('t1', f.pool).execute({ sql: 'INSERT INTO t VALUES ($1)', params: [1] }))
      .toEqual({ changes: 2, lastInsertRowid: 0 });
  });

  it('transaction wraps statements in BEGIN/COMMIT', async () => {
    const f = makeFakePool();
    await sqlFor('t1', f.pool).transaction({ statements: [
      { sql: 'INSERT INTO t VALUES ($1)', params: [1] },
      { sql: 'INSERT INTO t VALUES ($1)', params: [2] },
    ] });
    const s = f.sqls();
    expect(s).toContain('BEGIN');
    expect(s).toContain('COMMIT');
    expect(s.indexOf('BEGIN')).toBeLessThan(s.indexOf('COMMIT'));
  });

  it('rejects non-parametric SQL before touching the pool', async () => {
    const f = makeFakePool();
    await expect(sqlFor('t1', f.pool).query({ sql: "SELECT * WHERE a='' OR '1'='1'" })).rejects.toThrow(/non-parametric/i);
    expect(f.calls.length).toBe(0); // never connected
  });
});
