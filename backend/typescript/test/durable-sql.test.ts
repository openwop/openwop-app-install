import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqlSurface } from '../src/host/inMemorySurfaces.js';
import { createDurableSql, _resetDurableSqlForTesting } from '../src/host/durable/durableSql.js';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'durable-sql-')); });
afterAll(() => { _resetDurableSqlForTesting(); rmSync(dir, { recursive: true, force: true }); });

const sqlFor = (tenantId: string): SqlSurface => createDurableSql({ tenantId }, { dir });

describe('durable SQL surface (sqlite-file per tenant)', () => {
  it('execute/query round-trip + persists in the tenant DB file', async () => {
    const sql = sqlFor('a');
    await sql.execute({ sql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)' });
    const ins = await sql.execute({ sql: 'INSERT INTO items (name) VALUES (?)', params: ['widget'] }) as { changes: number };
    expect(ins.changes).toBe(1);
    const res = await sql.query({ sql: 'SELECT name FROM items WHERE id = ?', params: [1] }) as { rows: Array<{ name: string }>; count: number };
    expect(res.rows[0].name).toBe('widget');
    expect(res.count).toBe(1);
    // a fresh surface instance for the same tenant sees the same durable rows
    expect((await sqlFor('a').query({ sql: 'SELECT COUNT(*) AS n FROM items' }) as { rows: Array<{ n: number }> }).rows[0].n).toBe(1);
  });

  it('transaction applies all statements atomically', async () => {
    const sql = sqlFor('a');
    await sql.transaction({ statements: [
      { sql: 'INSERT INTO items (name) VALUES (?)', params: ['a'] },
      { sql: 'INSERT INTO items (name) VALUES (?)', params: ['b'] },
    ] });
    expect((await sql.query({ sql: 'SELECT COUNT(*) AS n FROM items' }) as { rows: Array<{ n: number }> }).rows[0].n).toBe(3);
  });

  it('isolates tenants — each has its own database file', async () => {
    // tenant b never created `items`, so querying it errors (table absent).
    await expect(sqlFor('b').query({ sql: 'SELECT * FROM items' })).rejects.toThrow(/no such table/i);
  });

  it('rejects non-parametric SQL (RFC 0018)', async () => {
    await expect(sqlFor('a').query({ sql: "SELECT * FROM items WHERE name = '' OR '1'='1'" }))
      .rejects.toThrow(/non-parametric/i);
  });
});
