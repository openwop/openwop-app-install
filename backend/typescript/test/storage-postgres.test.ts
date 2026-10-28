/**
 * Hermetic Postgres tests on `pg-mem`: the `listAudit` query builder and the
 * real migrated `audit_log` schema.
 *
 * WAVE 61 CUT (grade-tests, 8f slice). This file used to open with a
 * `Postgres storage (pg-mem)` describe (4 cases) driven by `makeStorage()`, a
 * ~540-line HAND-WRITTEN `Storage` double whose SQL re-implemented the
 * adapter. The production adapter (`src/storage/postgres/index.ts`) was never
 * called: sabotaging its `getUserAgent` tenant predicate (8fw3g2-pg-ua-copy)
 * and its run row mapping (8fw3g2-pg-run-copy) left every one of those cases
 * green. The same run-mapping sabotage reds
 * `storage-adapter-parity` "insertRun → getRun returns identical record" and
 * "listRuns filters by tenantId" on the REAL adapter (8fw3g2-pg-run-cover), and
 * `applyMigrations` still runs here (the last case below) and in that file.
 * The double's user_agents / appendEvent cases covered only the double; the
 * real adapter's versions have no in-gate pg coverage (recorded gap). Doc
 * citations of the double's line numbers carry a correction note.
 */

import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { applyMigrations } from '../src/storage/postgres/schema.js';
import { buildListAuditQuery } from '../src/storage/postgres/index.js';

/**
 * `listAudit` SQL shape — the prod-only TIMESTAMPTZ trap.
 *
 * `audit_log.timestamp` is TIMESTAMPTZ on Postgres but TEXT on sqlite. The
 * adapter used to bind `filter.sinceIso ?? ''` unconditionally: harmless on
 * sqlite (`>= ''` is an always-true string compare), a hard 500 on Postgres
 * (`invalid input syntax for type timestamp with time zone: ""`). That killed
 * every unfiltered audit read in production — the CDP console's governance
 * decision log and the superadmin `/governance/audit` view — while the whole
 * test suite stayed green. These assert the clause is DROPPED when no
 * `sinceIso` is given, and that the SQL actually executes against the real
 * migrated schema.
 */
describe('buildListAuditQuery (TIMESTAMPTZ binding)', () => {
  it('omits the timestamp clause — and never binds an empty string — with no sinceIso', () => {
    const { sql, params } = buildListAuditQuery({ actionPrefix: 'governance.decision.', limit: 200 });
    expect(sql).not.toContain('timestamp >=');
    expect(params).not.toContain('');
    expect(params).toEqual(['governance.decision.%', 200]);
  });

  it('binds the timestamp clause when sinceIso IS given', () => {
    const { sql, params } = buildListAuditQuery({ actionPrefix: 'a.', sinceIso: '2026-01-01T00:00:00.000Z' });
    expect(sql).toContain('timestamp >= $2::timestamptz');
    expect(params).toEqual(['a.%', '2026-01-01T00:00:00.000Z', 100]);
  });

  it('clamps the limit into [1, 500] and escapes LIKE metacharacters in the prefix', () => {
    expect(buildListAuditQuery({ limit: 5000 }).params.at(-1)).toBe(500);
    expect(buildListAuditQuery({ limit: 0 }).params.at(-1)).toBe(1);
    expect(buildListAuditQuery({ actionPrefix: '50%_off' }).params[0]).toBe('50\\%\\_off%');
  });

  it('binds the resource pushdown as an EXACT match, never a pattern (PR #3409 F2)', () => {
    const { sql, params } = buildListAuditQuery({ actionPrefix: 'twin.recall', resource: 'user:u1', limit: 200 });
    expect(sql).toContain('resource = $2');
    expect(sql).not.toContain('resource LIKE'); // prefix semantics would let user:a read user:ab's rows
    expect(params).toEqual(['twin.recall%', 'user:u1', 200]);
    // Absent ⇒ no clause, no empty-string binding (the sinceIso lesson).
    const bare = buildListAuditQuery({ actionPrefix: 'twin.recall', limit: 200 });
    expect(bare.sql).not.toContain('resource =');
    expect(bare.params).toEqual(['twin.recall%', 200]);
  });

  it('executes against the real migrated audit_log schema (both shapes)', async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const pg = db.adapters.createPg();
    const pool = new pg.Pool();
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO audit_log (audit_id, timestamp, principal_id, action, resource, outcome, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ['a-1', '2026-07-23T00:00:00.000Z', null, 'governance.decision.consent', null, 'allow', null],
    );

    const unfiltered = buildListAuditQuery({ actionPrefix: 'governance.decision.' });
    expect((await pool.query(unfiltered.sql, unfiltered.params)).rows).toHaveLength(1);

    const filtered = buildListAuditQuery({ actionPrefix: 'governance.decision.', sinceIso: '2027-01-01T00:00:00.000Z' });
    expect((await pool.query(filtered.sql, filtered.params)).rows).toHaveLength(0);

    await pool.end();
  });
});
