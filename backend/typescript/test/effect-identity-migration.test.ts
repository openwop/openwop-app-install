/**
 * ADR 0549 P3 — sqlite migration 39 / postgres migration 37: `invocation_log`
 * renames `provider_key` to `invocation_id` (RFC 0150 §B).
 *
 * The property under test is the one whose failure would be SILENT: a pre-P3
 * row must survive the migration and stay readable through the same primary
 * key, because that is what `spec/v1/replay.md` §E dual-read reads. A
 * drop-and-recreate would leave every green test green while quietly
 * invalidating the Layer-2 cache of every run in flight across the deploy — and
 * the observable consequence is not an error, it is a second paid provider call
 * (or a second charge on a node that wraps one).
 *
 * Uses `legacyDbAtVersion` rather than a hand-rolled schema, per that fixture's
 * own warning: a hand-rolled table models a database that has never existed,
 * and doing so caused three consecutive breaks (#1851, #1868).
 */

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { applyMigrations, LATEST_SCHEMA_VERSION } from '../src/storage/sqlite/schema.js';
import { legacyDbAtVersion } from './_legacyDbFixture.js';

/**
 * `legacyDbAtVersion` builds a FULLY migrated database and then rewinds only
 * the recorded version — it does not undo DDL. So the pre-P3 column name has to
 * be restored explicitly here; without this the test would replay migration 39
 * against a table that already had the new name and assert nothing.
 */
function dbAtV38WithLegacyColumn(): Database.Database {
  const db = legacyDbAtVersion(38);
  db.exec(`ALTER TABLE invocation_log RENAME COLUMN invocation_id TO provider_key;`);
  return db;
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe('ADR 0549 P3 — invocation_log identity migration (sqlite 39)', () => {
  it('renames provider_key → invocation_id', () => {
    const db = dbAtV38WithLegacyColumn();
    expect(columnsOf(db, 'invocation_log')).toContain('provider_key');

    applyMigrations(db);

    const cols = columnsOf(db, 'invocation_log');
    expect(cols).toContain('invocation_id');
    expect(cols).not.toContain('provider_key');
    db.close();
  });

  it('PRESERVES pre-P3 rows — the §E dual-read has something to read', () => {
    const db = dbAtV38WithLegacyColumn();
    db.prepare(
      `INSERT INTO invocation_log (run_id, node_id, attempt, provider_key, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('run-pre-p3', 'node-a', 1, 'legacy-hex-key', JSON.stringify({ content: 'cached' }), '2026-08-01T00:00:00Z');

    applyMigrations(db);

    const row = db
      .prepare(`SELECT invocation_id, attempt, result FROM invocation_log WHERE run_id = ?`)
      .get('run-pre-p3') as { invocation_id: string; attempt: number; result: string };
    expect(row.invocation_id, 'the old key value rides across under the new name').toBe('legacy-hex-key');
    expect(row.attempt, 'attempt is retained — §B retired it from the IDENTITY, not the record').toBe(1);
    expect(JSON.parse(row.result)).toEqual({ content: 'cached' });
    db.close();
  });

  it('keeps the primary key intact, so a legacy row is still reachable by its exact key', () => {
    const db = dbAtV38WithLegacyColumn();
    db.prepare(
      `INSERT INTO invocation_log (run_id, node_id, attempt, provider_key, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('run-pk', 'node-a', 1, 'k', '"first"', '2026-08-01T00:00:00Z');

    applyMigrations(db);

    // A conflicting insert on the same tuple must still conflict. If the
    // migration had rebuilt the table without its PRIMARY KEY, this would
    // silently insert a SECOND row and every read above would still pass.
    db.prepare(
      `INSERT OR REPLACE INTO invocation_log (run_id, node_id, attempt, invocation_id, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('run-pk', 'node-a', 1, 'k', '"second"', '2026-08-02T00:00:00Z');

    const rows = db.prepare(`SELECT result FROM invocation_log WHERE run_id = ?`).all('run-pk') as Array<{
      result: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('"second"');
    db.close();
  });

  it('is replay-safe — re-running the migration over an already-renamed table is a no-op', () => {
    // The migration runner replays forward migrations from the recorded
    // version, and rollback windows can re-run one. A bare `RENAME COLUMN`
    // would throw the second time and wedge boot.
    const db = dbAtV38WithLegacyColumn();
    db.prepare(
      `INSERT INTO invocation_log (run_id, node_id, attempt, provider_key, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('run-replay', 'node-a', 1, 'k', '"kept"', '2026-08-01T00:00:00Z');

    applyMigrations(db);
    db.prepare(`UPDATE __schema_version SET version = 38 WHERE id = 1`).run();
    expect(() => applyMigrations(db)).not.toThrow();

    const row = db.prepare(`SELECT result FROM invocation_log WHERE run_id = ?`).get('run-replay') as {
      result: string;
    };
    expect(row.result).toBe('"kept"');
    db.close();
  });

  it('the migration is actually reached by the runner', () => {
    // Guard against the `recipient_role` drift class: a migration that exists
    // but sits above the cap never executes, and every assertion above would
    // then be testing the fixture's own DDL.
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(39);
  });
});
