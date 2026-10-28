/**
 * ADR 0812 P3d — the migration that drops webhook subscriptions registered under
 * the RETIRED major 1 (sqlite mig 50, postgres mig 48).
 *
 * `protocol_major` 1, and NULL (which the column's own migration defined to read
 * as 1), are subscriptions decision 2 already sends nothing to. The migration has
 * the shape of an unsubscribe (WHD-16): the row and its PENDING deliveries go;
 * delivered and dead rows stay as history; a major-2 subscription is untouched.
 *
 * The Postgres leg runs against `OPENWOP_PG_TEST_DSN` (a PGlite socket server
 * works) and skips without it, so `npm run ci` runs only the sqlite leg.
 * Tracker: TST-BVC-6.
 *
 * Red when (wave 60 probes w60g4-mig-*, sqlite): a NULL-major row survives;
 * a major-2 row is deleted; delivered/dead history is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import pg from 'pg';
import { applyMigrations as applySqlite } from '../src/storage/sqlite/schema.js';
import { applyMigrations as applyPostgres, MIGRATIONS as PG_MIGRATIONS } from '../src/storage/postgres/schema.js';
import { legacyDbAtVersion } from './_legacyDbFixture.js';

const SUBS: Array<{ id: string; major: number | null }> = [
  { id: 'sub-null', major: null },
  { id: 'sub-v1', major: 1 },
  { id: 'sub-v2', major: 2 },
];
const STATUSES = ['pending', 'delivered', 'dead'] as const;

/** Every (subscription, status) pair that must survive, as `sub:status`. */
const EXPECTED_SUBS = ['sub-v2'];
const EXPECTED_DELIVERIES = [
  'sub-null:dead', 'sub-null:delivered',
  'sub-v1:dead', 'sub-v1:delivered',
  'sub-v2:dead', 'sub-v2:delivered', 'sub-v2:pending',
];

function seedSqlite(db: Database.Database): void {
  const sub = db.prepare(
    `INSERT INTO webhooks (subscription_id, url, events, secret, created_at, protocol_major) VALUES (?, ?, '["*"]', 's', '2026-10-01T00:00:00Z', ?)`,
  );
  const del = db.prepare(
    `INSERT INTO webhook_deliveries (delivery_id, subscription_id, url, secret, event_type, payload, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'https://example.test/hook', 's', 'run.completed', '{}', ?, 0, 5, 0, 0, 0)`,
  );
  for (const s of SUBS) {
    sub.run(s.id, 'https://example.test/hook', s.major);
    for (const st of STATUSES) del.run(`${s.id}:${st}`, s.id, st);
  }
}

describe('ADR 0812 P3d — sqlite mig 50 drops major-1 webhook subscriptions', () => {
  it('deletes major-1 and NULL subscriptions with their PENDING deliveries; keeps history and major 2', () => {
    const db = legacyDbAtVersion(49);
    seedSqlite(db);
    applySqlite(db);
    const subs = (db.prepare(`SELECT subscription_id AS id FROM webhooks ORDER BY 1`).all() as Array<{ id: string }>).map((r) => r.id);
    const dels = (db.prepare(`SELECT delivery_id AS id FROM webhook_deliveries ORDER BY 1`).all() as Array<{ id: string }>).map((r) => r.id);
    expect(subs).toEqual(EXPECTED_SUBS);
    expect(dels).toEqual(EXPECTED_DELIVERIES);
    db.close();
  });

  it('is a no-op on a database with no major-1 rows, and safe to re-run', () => {
    const db = legacyDbAtVersion(49);
    db.prepare(
      `INSERT INTO webhooks (subscription_id, url, events, secret, created_at, protocol_major) VALUES ('only-v2', 'https://example.test/hook', '["*"]', 's', '2026-10-01T00:00:00Z', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO webhook_deliveries (delivery_id, subscription_id, url, secret, event_type, payload, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
       VALUES ('only-v2:pending', 'only-v2', 'https://example.test/hook', 's', 'run.completed', '{}', 'pending', 0, 5, 0, 0, 0)`,
    ).run();
    applySqlite(db);
    db.prepare(`UPDATE __schema_version SET version = 49 WHERE id = 1`).run();
    expect(() => applySqlite(db)).not.toThrow();
    // The same row and its pending delivery, by id, after both runs.
    expect(db.prepare(`SELECT subscription_id AS id FROM webhooks`).all()).toEqual([{ id: 'only-v2' }]);
    expect(db.prepare(`SELECT delivery_id AS id FROM webhook_deliveries`).all()).toEqual([{ id: 'only-v2:pending' }]);
    db.close();
  });
});

const dsn = process.env.OPENWOP_PG_TEST_DSN;
describe.skipIf(!dsn)('ADR 0812 P3d — postgres mig 48 drops major-1 webhook subscriptions', () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: dsn });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS p3d_mig CASCADE; CREATE SCHEMA p3d_mig; SET search_path TO p3d_mig;`);
    await applyPostgres(client);
  });
  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS p3d_mig CASCADE;`);
    await client?.end();
  });

  it('deletes major-1 and NULL subscriptions with their PENDING deliveries; keeps history and major 2', async () => {
    for (const s of SUBS) {
      await client.query(
        `INSERT INTO webhooks (subscription_id, url, events, secret, created_at, protocol_major) VALUES ($1, 'https://example.test/hook', '["*"]', 's', '2026-10-01T00:00:00Z', $2)`,
        [s.id, s.major],
      );
      for (const st of STATUSES) {
        await client.query(
          `INSERT INTO webhook_deliveries (delivery_id, subscription_id, url, secret, event_type, payload, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
           VALUES ($1, $2, 'https://example.test/hook', 's', 'run.completed', '{}', $3, 0, 5, 0, 0, 0)`,
          [`${s.id}:${st}`, s.id, st],
        );
      }
    }
    await PG_MIGRATIONS[48]!(client);
    const subs = (await client.query<{ id: string }>(`SELECT subscription_id AS id FROM webhooks ORDER BY 1`)).rows.map((r) => r.id);
    const dels = (await client.query<{ id: string }>(`SELECT delivery_id AS id FROM webhook_deliveries ORDER BY 1`)).rows.map((r) => r.id);
    expect(subs).toEqual(EXPECTED_SUBS);
    expect(dels).toEqual(EXPECTED_DELIVERIES);
  });
});
