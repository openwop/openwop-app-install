/**
 * ADR 0549 P2 — migration integrity and log hygiene for the idempotency ledger.
 *
 * Two things this phase must guarantee:
 *
 *  1. **Migration.** `idempotent_response` (sqlite 37 / postgres 35) applies
 *     cleanly to a REAL pre-existing database, is safe to replay, and does NOT
 *     disturb the `idempotency` table it was split away from. The old table is
 *     NOT dropped — ADR 0549 CORRECTION 4 — because it remains the daemons'
 *     fire-once mutex, so a migration test that only checked "new table exists"
 *     would miss the failure that actually matters.
 *
 *  2. **Log hygiene.** ADR 0549: "the key and request digest are never logged
 *     in plaintext". A caller-supplied key routinely embeds customer
 *     identifiers (order numbers, emails) because clients derive it from their
 *     own domain objects, and logs have a different retention and access model
 *     than the ledger row does.
 *
 * Uses `legacyDbAtVersion` rather than hand-rolling a schema: a hand-rolled
 * table models a database that has never existed, which is the documented cause
 * of three consecutive breaks (#1851, #1868).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { applyMigrations, LATEST_SCHEMA_VERSION } from '../src/storage/sqlite/schema.js';
import { legacyDbAtVersion } from './_legacyDbFixture.js';
import { openStorage } from '../src/storage/index.js';
import { canonicalRequestDigest, redactKey } from '../src/host/idempotentResponse.js';

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
    .map((r) => r.name)
    .sort();
}

describe('ADR 0549 P2 — forward migration onto a real pre-ledger database', () => {
  it('creates idempotent_response with the full P0+P1 column set', () => {
    // Rewound to 36, i.e. the last version before the ledger existed.
    const db = legacyDbAtVersion(36, { dropTables: ['idempotent_response'] });
    expect(tableExists(db, 'idempotent_response')).toBe(false);

    applyMigrations(db);

    expect(tableExists(db, 'idempotent_response')).toBe(true);
    expect(columns(db, 'idempotent_response')).toEqual([
      'claim_expires_at',
      'claim_token',
      'created_at',
      'endpoint_id',
      'idempotency_key',
      'request_digest',
      'response_body',
      'response_status',
      'run_id',
      'state',
      'tenant_id',
      'updated_at',
    ]);
    db.close();
  });

  it('keys the new table on (tenant_id, endpoint_id, idempotency_key)', () => {
    // The composite key IS the security fix. A migration that created the table
    // with the wrong key would leave the cross-tenant leak wide open while
    // every other test still passed.
    const db = legacyDbAtVersion(36, { dropTables: ['idempotent_response'] });
    applyMigrations(db);
    const pk = (db.prepare(`SELECT name, pk FROM pragma_table_info('idempotent_response')`).all() as
      { name: string; pk: number }[])
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
    expect(pk).toEqual(['tenant_id', 'endpoint_id', 'idempotency_key']);
    db.close();
  });

  it('every primary-key column is NOT NULL', () => {
    // SQLite permits NULLs in a PRIMARY KEY and treats multiple NULL rows as
    // non-conflicting — which would silently make the atomic claim non-atomic
    // on this adapter while Postgres (where PK implies NOT NULL) rejected the
    // same insert. Explicit NOT NULL keeps the two schemas honestly identical.
    const db = legacyDbAtVersion(36, { dropTables: ['idempotent_response'] });
    applyMigrations(db);
    const cols = db.prepare(`SELECT name, "notnull" AS nn FROM pragma_table_info('idempotent_response')`).all() as
      { name: string; nn: number }[];
    for (const key of ['tenant_id', 'endpoint_id', 'idempotency_key']) {
      expect(cols.find((c) => c.name === key)?.nn, `${key} must be NOT NULL`).toBe(1);
    }
    db.close();
  });

  it('does NOT drop or disturb the mutex table it was split from', () => {
    // ADR 0549 CORRECTION 4 — "retain the old table for one rollback window,
    // then drop it" was REVERSED. `idempotency` stays permanently: it is the
    // ~11 daemons' fire-once mutex. Dropping it would silently break every
    // scheduled sweep.
    const db = legacyDbAtVersion(36, { dropTables: ['idempotent_response'] });
    db.prepare(
      `INSERT INTO idempotency (key, response_body, response_status, created_at) VALUES (?,?,?,?)`,
    ).run('schedule-fire:job-1:slot-1', '__pending__', 0, '2026-01-01T00:00:00.000Z');

    applyMigrations(db);

    expect(tableExists(db, 'idempotency')).toBe(true);
    const row = db.prepare(`SELECT key FROM idempotency WHERE key = ?`).get('schedule-fire:job-1:slot-1');
    expect(row).toBeTruthy();
    db.close();
  });

  it('does NOT backfill legacy rows into the ledger', () => {
    // A raw legacy key cannot be attributed to a tenant after the fact, and
    // guessing an owner is precisely the defect being fixed. The accepted cost
    // (an in-flight key loses its cache across the deploy) is documented in the
    // ADR rather than discovered in production.
    const db = legacyDbAtVersion(36, { dropTables: ['idempotent_response'] });
    db.prepare(
      `INSERT INTO idempotency (key, response_body, response_status, created_at) VALUES (?,?,?,?)`,
    ).run('caller-supplied-key', '{"runId":"legacy"}', 201, '2026-01-01T00:00:00.000Z');

    applyMigrations(db);

    const count = db.prepare(`SELECT count(*) AS n FROM idempotent_response`).get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });

  it('is idempotent — replaying the migration over a live table preserves rows', () => {
    // The rollback story: reverting the CODE leaves the table in place, and
    // rolling forward again must not wipe it. `CREATE TABLE IF NOT EXISTS`
    // makes that true, but only a test keeps it true.
    const db = legacyDbAtVersion(36, { dropTables: ['idempotent_response'] });
    applyMigrations(db);
    db.prepare(
      `INSERT INTO idempotent_response
         (tenant_id, endpoint_id, idempotency_key, request_digest, state, created_at, updated_at)
       VALUES (?,?,?,?,'pending',?,?)`,
    ).run('t', 'POST:/v1/runs', 'k', 'd', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    db.prepare(`UPDATE __schema_version SET version = 36 WHERE id = 1`).run();
    applyMigrations(db); // replay

    const count = db.prepare(`SELECT count(*) AS n FROM idempotent_response`).get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('a fresh database lands at the latest version with the ledger present', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const v = db.prepare(`SELECT version FROM __schema_version WHERE id = 1`).get() as { version: number };
    expect(v.version).toBe(LATEST_SCHEMA_VERSION);
    expect(tableExists(db, 'idempotent_response')).toBe(true);
    db.close();
  });
});

describe('ADR 0549 P2 — the key and digest never reach a log in plaintext', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redactKey does not leak the key, and is stable within a process', () => {
    const key = 'order-12345-customer@example.com';
    const red = redactKey(key);
    expect(red).not.toContain('order-12345');
    expect(red).not.toContain('example.com');
    expect(red).toMatch(/^idk_[0-9a-f]{12}$/);
    // Stable within a process so two log lines about the same key correlate…
    expect(redactKey(key)).toBe(red);
    // …and distinct keys do not collide into one identifier.
    expect(redactKey('a-different-key')).not.toBe(red);
  });

  it('is SALTED, so a log identifier cannot be precomputed from a guessed key', () => {
    // The property that matters: someone who can guess a key must not be able
    // to confirm the guess by matching a log line. An unsalted digest would let
    // them do exactly that, offline, for every candidate.
    //
    // (First attempt asserted this by importing a second module instance with a
    // fresh salt — vitest's module cache returns the same instance, so it was
    // testing nothing. Comparing against the UNSALTED digest tests the real
    // property directly and needs no module trickery.)
    const key = 'guessable-key-0001';
    const unsalted = createHash('sha256').update(key).digest('hex').slice(0, 12);
    expect(redactKey(key)).not.toBe(`idk_${unsalted}`);
    expect(redactKey(key)).not.toContain(unsalted);
  });

  it('a real claim/complete/release cycle writes no plaintext key to any log stream', async () => {
    // The canary: exercise the whole ledger with a key that is trivially
    // greppable, capturing every console stream, and assert none of it appears.
    const key = 'CANARY-PLAINTEXT-IDEMPOTENCY-KEY';
    const secretBody = { text: 'CANARY-BODY-CONTENT' };
    const captured: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }

    const s = await openStorage(':memory:');
    const digest = canonicalRequestDigest(secretBody, 'POST:/v1/runs');
    const now = new Date().toISOString();
    const c = await s.claimIdempotentResponse({
      tenantId: 't', endpoint: 'POST:/v1/runs', key, requestDigest: digest, createdAt: now, leaseMs: 90_000,
    });
    if (c.outcome !== 'claimed') throw new Error(`expected claimed, got ${c.outcome}`);
    await s.completeIdempotentResponse({
      tenantId: 't', endpoint: 'POST:/v1/runs', key, responseStatus: 201,
      responseBody: '{"runId":"canary"}', updatedAt: now, claimToken: c.claimToken,
    });
    await s.releaseIdempotentResponse({
      tenantId: 't', endpoint: 'POST:/v1/runs', key, claimToken: c.claimToken,
    });

    const all = captured.join('\n');
    expect(all).not.toContain(key);
    expect(all).not.toContain(digest);
    expect(all).not.toContain('CANARY-BODY-CONTENT');
  });
});
