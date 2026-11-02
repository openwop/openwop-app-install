/**
 * Durable host.sql adapter (`src/host/durable/durableSql.ts`, Phase 2): one
 * SQLite file per tenant, parametric-only SQL (RFC 0018). TST-CWD-7.
 *
 * Every case uses its OWN tenant (so its own database file) and creates its own
 * table — no case reads another's rows, so the file passes alone and in any order.
 *
 * Red when (sabotage-witnessed, wave 69): tenants share one database file
 * (the isolation case); the non-parametric heuristic is removed; `transaction`
 * runs its statements outside a real transaction (a failing second statement
 * then leaves the first one's row behind).
 */
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
const CREATE_ITEMS = 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)';
const countItems = async (sql: SqlSurface): Promise<number> =>
  ((await sql.query({ sql: 'SELECT COUNT(*) AS n FROM items' })) as { rows: Array<{ n: number }> }).rows[0]!.n;

describe('durable SQL surface (sqlite-file per tenant)', () => {
  it('execute/query round-trip + persists in the tenant DB file', async () => {
    const sql = sqlFor('roundtrip');
    await sql.execute({ sql: CREATE_ITEMS });
    const ins = await sql.execute({ sql: 'INSERT INTO items (name) VALUES (?)', params: ['widget'] }) as { changes: number; lastInsertRowid: number };
    expect(ins.changes).toBe(1);
    const res = await sql.query({ sql: 'SELECT name FROM items WHERE id = ?', params: [ins.lastInsertRowid] }) as { rows: Array<{ name: string }>; count: number };
    expect(res.rows).toEqual([{ name: 'widget' }]);
    expect(res.count).toBe(1);
    // a fresh surface instance for the same tenant sees the same durable rows
    expect(await countItems(sqlFor('roundtrip'))).toBe(1);
  });

  it('transaction applies all statements atomically', async () => {
    const sql = sqlFor('txn');
    await sql.execute({ sql: CREATE_ITEMS });
    await sql.transaction({ statements: [
      { sql: 'INSERT INTO items (name) VALUES (?)', params: ['a'] },
      { sql: 'INSERT INTO items (name) VALUES (?)', params: ['b'] },
    ] });
    expect(await countItems(sql)).toBe(2);
    // All-or-nothing: the second statement fails, so the first must roll back.
    await expect(sql.transaction({ statements: [
      { sql: 'INSERT INTO items (name) VALUES (?)', params: ['c'] },
      { sql: 'INSERT INTO no_such_table (name) VALUES (?)', params: ['d'] },
    ] })).rejects.toThrow(/no such table/i);
    expect(await countItems(sql)).toBe(2);
  });

  it('isolates tenants — each has its own database file', async () => {
    const owner = sqlFor('iso-owner');
    await owner.execute({ sql: CREATE_ITEMS });
    await owner.execute({ sql: 'INSERT INTO items (name) VALUES (?)', params: ['secret'] });
    expect(await countItems(owner)).toBe(1); // positive control
    // The other tenant never created `items`, so querying it errors (table absent).
    await expect(sqlFor('iso-other').query({ sql: 'SELECT * FROM items' })).rejects.toThrow(/no such table/i);
  });

  it('rejects non-parametric SQL (RFC 0018)', async () => {
    const sql = sqlFor('param');
    await sql.execute({ sql: CREATE_ITEMS });
    await expect(sql.query({ sql: "SELECT * FROM items WHERE name = '' OR '1'='1'" }))
      .rejects.toMatchObject({ code: 'SQL_NON_PARAMETRIC', message: 'Non-parametric SQL rejected by host (RFC 0018).' });
  });
});
