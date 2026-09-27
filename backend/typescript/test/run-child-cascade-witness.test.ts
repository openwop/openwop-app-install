/**
 * `/grade-data` 2026-09-26 (RUNCASC-1) — the run-child cascade, witnessed by
 * EXECUTION at all three run-destroying sites.
 *
 * `teardown-child-drift-guard.test.ts` (GEN-5) proves every run_id-keyed table
 * with no `tenant_id` is NAMED in its `CASCADED_BY_RUN_ID` set — but that set is
 * a copy "kept in lockstep" by hand with three hand-kept lists in each backend
 * (`deleteRun`, `pruneTerminalRuns`, `deleteAllTenantData`). Nothing compared the
 * copy to the code, and the retention list had drifted: `invocation_claim` was
 * cascaded by `deleteRun` and tenant teardown but NOT by `pruneTerminalRuns`, so
 * every crash-stranded claim outlived its run forever once retention reaped it.
 *
 * This test seeds one row in EVERY such table for a terminal run, destroys the run
 * through each site, and asserts nothing is left. A new run-keyed table that a
 * site forgets fails here, whatever any list says.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';

/** Same exemption as the GEN-5 guard: a key-only cache with no run linkage. */
const EXEMPT = new Set(['idempotency']);

interface Col { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }

const RUN = 'run-cascade-witness';
const TENANT = 'tenant-cascade-witness';
const OLD = '2000-01-01T00:00:00.000Z';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function setup(): { storage: Storage; db: Database.Database; childTables: string[] } {
  dir = mkdtempSync(join(tmpdir(), 'run-cascade-'));
  const path = join(dir, 'db.sqlite');
  const storage = openSqliteStorage(path); // applies migrations
  const db = new Database(path);
  const colsOf = (t: string): Col[] => db.prepare(`SELECT * FROM pragma_table_info(?)`).all(t) as Col[];
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((r) => r.name);
  const childTables = tables.filter((t) => {
    const cols = colsOf(t).map((c) => c.name);
    return t !== 'runs' && cols.includes('run_id') && !cols.includes('tenant_id') && !EXEMPT.has(t);
  });

  // A NOT NULL column gets a type-shaped filler; nullable columns are left out.
  const insert = (t: string, fixed: Record<string, unknown>): void => {
    const row: Record<string, unknown> = { ...fixed };
    for (const c of colsOf(t)) {
      if (c.name in row || (!c.notnull && !c.pk) || c.dflt_value !== null) continue;
      row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 1 : `${t}-${c.name}`;
    }
    const names = Object.keys(row);
    db.prepare(`INSERT INTO ${t} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
  };
  insert('runs', { run_id: RUN, tenant_id: TENANT, status: 'completed', created_at: OLD, updated_at: OLD });
  for (const t of childTables) insert(t, { run_id: RUN });
  return { storage, db, childTables };
}

function leftovers(db: Database.Database, childTables: string[]): string[] {
  return childTables.filter((t) => (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE run_id = ?`).get(RUN) as { n: number }).n > 0);
}

describe('RUNCASC-1 — every run-keyed child dies with its run, at every site', () => {
  it('the witness covers the tables the GEN-5 guard names (not vacuous)', () => {
    const { db, childTables } = setup();
    expect(childTables).toEqual(expect.arrayContaining(['events', 'interrupts', 'invocation_log', 'invocation_claim', 'effect_escape_ledger', 'envelope_correlations']));
    for (const t of childTables) {
      expect((db.prepare(`SELECT count(*) AS n FROM ${t} WHERE run_id = ?`).get(RUN) as { n: number }).n, `seed row in ${t}`).toBe(1);
    }
    db.close();
  });

  it('deleteRun', async () => {
    const { storage, db, childTables } = setup();
    expect(await storage.deleteRun(RUN)).toBe(true);
    expect(leftovers(db, childTables)).toEqual([]);
    db.close();
  });

  it('pruneTerminalRuns (retention)', async () => {
    const { storage, db, childTables } = setup();
    expect((await storage.pruneTerminalRuns(new Date().toISOString(), 10)).runs).toBe(1);
    expect(leftovers(db, childTables)).toEqual([]);
    db.close();
  });

  it('deleteAllTenantData (account teardown)', async () => {
    const { storage, db, childTables } = setup();
    await storage.deleteAllTenantData(TENANT);
    expect(leftovers(db, childTables)).toEqual([]);
    db.close();
  });
});
