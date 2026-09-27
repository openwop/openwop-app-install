/**
 * GEN-5 — teardown child-cascade DRIFT GUARD.
 *
 * `deleteAllTenantData` deletes a tenant's SQL rows two ways: (1) introspection —
 * every table with a `tenant_id` column (complete by construction), and (2) a
 * HAND-KEPT cascade for child tables keyed by a NON-tenant parent id (`run_id`,
 * `session_id`) — those rows carry no `tenant_id`, so introspection can't see them.
 * The hand-kept list is the drift risk: a future table keyed by `run_id`/`session_id`
 * with no `tenant_id` silently escapes BOTH teardown AND the fold (an orphan on
 * account-delete). This guard introspects the real migrated schema and fails if any
 * such table is neither cascaded nor explicitly allow-listed — forcing the author to
 * wire the cascade (both backends) or record why it's intentionally exempt.
 *
 * Keep the sets below in lockstep with `deleteAllTenantData` in
 * `storage/{sqlite,postgres}/index.ts`.
 *
 * LIMIT (`/grade-data` 2026-09-26, RUNCASC-1): this guard checks the schema
 * against its OWN copy of the lists, never against the code, and it was green
 * while `pruneTerminalRuns` omitted `invocation_claim`. The execution witness
 * is `run-child-cascade-witness.test.ts`, which destroys a seeded run through
 * all three sites.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/storage/sqlite/schema.js';

/** Child tables the teardown DELETEs via a run_id parent key. */
const CASCADED_BY_RUN_ID = new Set([
  'events', 'interrupts', 'invocation_log', 'invocation_claim', 'envelope_correlations',
  // ADR 0591 — the effect escape ledger. Run-keyed with no tenant_id (its rows
  // describe one run's effects), so it escapes introspection and only leaves
  // with the run. This guard is what caught it; the cascade is wired at all
  // three sites in BOTH backends (deleteRun, pruneTerminalRuns,
  // deleteAllTenantData).
  'effect_escape_ledger',
]);
/** Child tables the teardown DELETEs via a session_id parent key. */
const CASCADED_BY_SESSION_ID = new Set(['chat_messages']);
/** Tables with a run_id/session_id column that are INTENTIONALLY not tenant-cascaded. */
const ALLOWLIST = new Map<string, string>([
  ['idempotency', 'key-only L1 HTTP response cache; no tenant/run linkage to cascade on — aged out by pruneOnceByPrefix retention'],
]);

describe('GEN-5 — teardown child-cascade drift guard', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const colsOf = (t: string): string[] =>
    (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as Array<{ name: string }>).map((r) => r.name);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((r) => r.name);
  const has = (t: string, c: string): boolean => colsOf(t).includes(c);

  it('every run_id/session_id-keyed table (no tenant_id) is cascaded or explicitly allow-listed', () => {
    const uncovered: string[] = [];
    for (const t of tables) {
      const tenantKeyed = has(t, 'tenant_id');
      if (tenantKeyed) continue; // introspection covers it
      if (has(t, 'run_id') && !CASCADED_BY_RUN_ID.has(t) && !ALLOWLIST.has(t)) uncovered.push(`${t} (run_id)`);
      if (has(t, 'session_id') && !CASCADED_BY_SESSION_ID.has(t) && !ALLOWLIST.has(t)) uncovered.push(`${t} (session_id)`);
    }
    expect(
      uncovered,
      `A run_id/session_id-keyed table with no tenant_id escapes tenant teardown AND the fold. ` +
        `Add it to deleteAllTenantData's child cascade in BOTH backends, or to the GEN-5 ALLOWLIST with a reason. Uncovered: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('the cascade lists have no STALE entries (every listed table still exists with its parent key)', () => {
    for (const t of CASCADED_BY_RUN_ID) {
      expect(tables, `cascaded-by-run_id table '${t}' no longer exists`).toContain(t);
      expect(has(t, 'run_id'), `cascaded table '${t}' no longer has a run_id column`).toBe(true);
    }
    for (const t of CASCADED_BY_SESSION_ID) {
      expect(tables, `cascaded-by-session_id table '${t}' no longer exists`).toContain(t);
      expect(has(t, 'session_id'), `cascaded table '${t}' no longer has a session_id column`).toBe(true);
    }
  });
});
