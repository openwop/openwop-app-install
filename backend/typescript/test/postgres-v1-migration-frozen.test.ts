/**
 * The Postgres v1 migration is FROZEN, and ADR 0618's `invocation_claim` is
 * created by a forward migration (v44) — the third instance of one trap.
 *
 * Migrations are forward-only: a DB stamped at version N never re-runs v1..N.
 * So a table added to the v1 block exists on every FRESH database (every test,
 * every local boot) and on NO long-lived one. It happened with `annotations`
 * (fixed by v20), with a v23 column (fixed by v28), and with `invocation_claim`,
 * added to v1 on 2026-09-01. MEASURED in production 2026-09-21: every
 * run-retention tick since at least 2026-09-14 failed on
 * `relation "invocation_claim" does not exist` (99 logged in a week), and the
 * notification emitter ran with duplicate suppression OFF. The whole test suite
 * was green throughout, because every test starts from an empty database.
 *
 * Two guards:
 *  1. v1's DDL is pinned to a LITERAL list, so adding to it is a red test with
 *     a message that says what to do instead.
 *  2. A long-lived DB (pg-mem, at v43, WITHOUT the table) gains it from the
 *     forward migrations and accepts the exact write retention was failing on.
 */
import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, applyMigrations, type Queryable } from '../src/storage/postgres/schema.js';

/** The objects v1 creates. Never grows. Everything here shipped with v1
 *  (30f88964a, 2026-05-17) EXCEPT the two `idx_runs_*` indexes, added to v1 by
 *  #1822 (2026-07-14) — the same trap, survived only because that PR also
 *  applied both to production by hand (`CREATE INDEX CONCURRENTLY`, recorded in
 *  the schema comment). They stay: removing them now would change nothing on
 *  any real database. */
const V1_FROZEN = [
  'index idx_audit_ts',
  'index idx_events_run_seq',
  'index idx_interrupts_run_node',
  'index idx_runs_parent',
  'index idx_runs_tenant_created',
  'index idx_runs_tenant_status',
  'table audit_log',
  'table byok_secrets',
  'table events',
  'table idempotency',
  'table interrupts',
  'table invocation_log',
  'table runs',
  'table webhooks',
  'table workflows',
];

async function v1Objects(): Promise<string[]> {
  const sql: string[] = [];
  const recorder: Queryable = {
    async query(text: string) { sql.push(text); return { rows: [] }; },
  };
  await MIGRATIONS[1]!(recorder);
  const found = new Set<string>();
  for (const m of sql.join('\n').matchAll(/CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)) {
    found.add(`${m[1]!.toLowerCase()} ${m[2]}`);
  }
  return [...found].sort();
}

async function freshPgMem() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  const client = await pool.connect();
  return { pool, client };
}

describe('postgres migrations — v1 is frozen', () => {
  it('v1 creates exactly the objects it shipped with', async () => {
    const actual = await v1Objects();
    // Guard against a vacuous pass: the extractor must have found SOMETHING.
    expect(actual.length).toBe(V1_FROZEN.length);
    expect(
      actual,
      'Do NOT add DDL to MIGRATIONS[1]: no existing database re-runs it, so the object will exist in every test and be MISSING in production. Add a new numbered migration (CREATE … IF NOT EXISTS) instead.',
    ).toEqual(V1_FROZEN);
  });
});

describe('postgres migration v44 — invocation_claim on a long-lived DB', () => {
  it('creates the table on a DB stamped at v43 that never had it, and the retention write succeeds', async () => {
    const { pool, client } = await freshPgMem();
    try {
      // The production state, built the way production built it: every
      // migration through v43, in order, on an empty database.
      for (let v = 1; v <= 43; v++) await MIGRATIONS[v]!(client);
      await expect(client.query(`DELETE FROM invocation_claim WHERE run_id = 'r1'`)).rejects.toThrow(/invocation_claim/);

      // What `applyMigrations` then does for a DB stamped at 43: v44..LATEST.
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
      for (let v = 44; v <= LATEST_SCHEMA_VERSION; v++) await MIGRATIONS[v]!(client);

      await client.query(
        `INSERT INTO invocation_claim (run_id, node_id, invocation_id, claimed_at) VALUES ('r1','n1','i1', 1)`,
      );
      // The exact statement `deleteRun` issues on every retention tick.
      await client.query(`DELETE FROM invocation_claim WHERE run_id = 'r1'`);
      const left = await client.query(`SELECT run_id FROM invocation_claim`);
      expect(left.rows.length).toBe(0);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('a fresh DB has the table (from v44 alone — v1 no longer declares it)', async () => {
    const { pool, client } = await freshPgMem();
    try {
      await applyMigrations(client);
      const r = await client.query(`SELECT run_id FROM invocation_claim`);
      expect(r.rows).toEqual([]);
    } finally {
      client.release();
      await pool.end();
    }
  });
});
