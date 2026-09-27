/**
 * Legacy-DB fixture builder for migration tests.
 *
 * WHY THIS EXISTS (the lesson from three consecutive breaks): migration tests
 * need a DB that looks like a REAL deployment pinned at an OLD schema version.
 * Hand-rolling that with `CREATE TABLE runs (…the columns my migration reads…)`
 * models a database that has never existed, and it breaks every time a NEW
 * forward migration touches a column the hand-rolled table omitted:
 *
 *   - #1851 — mig 34 indexed `runs.workflow_id`  → fixtures lacked `workflow_id`
 *   - #1868 — mig 35 backfills on `runs.status`  → fixtures lacked `status`
 *
 * Adding one more column each time is a band-aid that guarantees a fourth break.
 * Instead: build a REAL, fully-migrated database (so every table is exactly what
 * production has), then rewind `__schema_version` to the target version — and,
 * where the test reproduces a historical anomaly, remove just that artifact.
 * Re-running `applyMigrations` then replays the forward migrations under test
 * against a genuine schema. Migrations here are written defensively
 * (`CREATE TABLE IF NOT EXISTS`, `addColumnIfTableExists`, `CREATE INDEX IF NOT
 * EXISTS`), so replaying them over a real schema is safe and idempotent.
 */
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/storage/sqlite/schema.js';

/**
 * A fully-migrated (i.e. REAL) sqlite DB whose recorded schema version has been
 * rewound to `version`, so `applyMigrations(db)` replays everything after it.
 *
 * `dropTables` removes artifacts that the historical state legitimately lacked
 * — e.g. the `annotations` table on a DB initialized before that declaration was
 * added to the v1 block (the real production bug mig 23 forward-fixes).
 */
export function legacyDbAtVersion(version: number, opts: { dropTables?: string[] } = {}): Database.Database {
  const db = new Database(':memory:');
  applyMigrations(db); // the REAL schema — every table production has
  for (const t of opts.dropTables ?? []) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.prepare(`UPDATE __schema_version SET version = ? WHERE id = 1`).run(version);
  return db;
}
