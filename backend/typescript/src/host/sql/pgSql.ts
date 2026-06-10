/**
 * Postgres schema-per-tenant SQL host surface (Phase 2) — `host.db.sql` over a
 * shared Postgres, selected with `OPENWOP_SURFACE_SQL=postgres`.
 *
 * The cross-instance variant of the durable (sqlite-file-per-tenant) sql
 * surface: every instance talks to the same Postgres, and each tenant is
 * isolated in its own schema (`tenant_<id>`) with `search_path` scoped per
 * operation — so two tenants can't see each other's tables and N app instances
 * stay consistent.
 *
 * Same query/execute/transaction contract + non-parametric-SQL guard (RFC 0018)
 * as the in-memory / durable impls. `lastInsertRowid` is sqlite-specific and is
 * reported as 0 here — portable SQL should use `RETURNING` on Postgres.
 *
 * Validation: the pure identifier/guard helpers are unit-tested; the live SQL
 * path is exercised by the gated `pg-sql-live` testcontainers spec.
 */

import type { BundleScope, SqlSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter, resolveBackendId } from '../surfaceBackends.js';

const PARAM_REJECT_RE = /\$\{|\b(?:OR|AND)\b\s+(?:'[^']*'|"[^"]*")\s*=\s*(?:'[^']*'|"[^"]*")/i;
export function requireParametric(sql: string): void {
  if (PARAM_REJECT_RE.test(sql)) {
    throw Object.assign(new Error('Non-parametric SQL rejected by host (RFC 0018).'), { code: 'SQL_NON_PARAMETRIC' });
  }
}

/** Deterministic, injection-safe Postgres schema name for a tenant. */
export function schemaForTenant(tenantId: string): string {
  const sanitized = String(tenantId).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 48);
  if (!sanitized || sanitized === '_'.repeat(sanitized.length)) {
    // Fall back to a hash-free stable token; never emit an empty/degenerate schema.
    return 'tenant_unknown';
  }
  return `tenant_${sanitized}`;
}

/** Minimal client-pool shape (compatible with `pg.Pool`). */
export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}
export interface PgPool {
  connect(): Promise<PgClient>;
}

// Per-process memo of schemas already CREATE-d, to skip the DDL on the hot path.
const ensuredSchemas = new Set<string>();

export interface PgSqlDeps { pool: PgPool }

export function createPgSql(scope: BundleScope, deps: PgSqlDeps): SqlSurface {
  const schema = schemaForTenant(scope.tenantId);

  async function withScopedClient<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
    const client = await deps.pool.connect();
    try {
      if (!ensuredSchemas.has(schema)) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        ensuredSchemas.add(schema);
      }
      // Scope every operation to the tenant schema; `public` retained as a
      // fallback for extensions/types but tenant tables resolve first.
      await client.query(`SET search_path TO "${schema}", public`);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  return {
    async query(args: Record<string, unknown>) {
      const sql = String(args.sql);
      requireParametric(sql);
      const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
      return withScopedClient(async (c) => {
        const res = await c.query(sql, params);
        return { rows: res.rows, count: res.rowCount ?? res.rows.length };
      });
    },
    async execute(args: Record<string, unknown>) {
      const sql = String(args.sql);
      requireParametric(sql);
      const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
      return withScopedClient(async (c) => {
        const res = await c.query(sql, params);
        // Postgres has no sqlite-style lastInsertRowid; use RETURNING instead.
        return { changes: res.rowCount ?? 0, lastInsertRowid: 0 };
      });
    },
    async transaction({ statements }) {
      const stmts = (statements as Array<{ sql: string; params?: unknown[] }>) ?? [];
      for (const s of stmts) requireParametric(s.sql);
      return withScopedClient(async (c) => {
        await c.query('BEGIN');
        try {
          for (const s of stmts) await c.query(s.sql, s.params ?? []);
          await c.query('COMMIT');
          return { ok: true };
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      });
    },
  };
}

/** Test affordance — clear the per-process schema memo. */
export function _resetPgSqlForTesting(): void {
  ensuredSchemas.clear();
}

/**
 * Register the Postgres sql adapter. Lazily builds a `pg` Pool from env on first
 * use. Fails fast at boot if `sql=postgres` but config is incomplete.
 */
export function registerPgSqlAdapter(): void {
  const dsn = process.env.OPENWOP_SQL_PG_DSN;
  let poolPromise: Promise<PgPool> | null = null;
  const getPool = async (): Promise<PgPool> => {
    if (!poolPromise) {
      poolPromise = (async () => {
        const { Pool } = await import('pg');
        return new Pool({ connectionString: dsn, max: 10, idleTimeoutMillis: 30_000 }) as unknown as PgPool;
      })();
    }
    return poolPromise;
  };

  registerSurfaceAdapter('sql', 'postgres', (scope: BundleScope) =>
    createPgSql(scope, {
      pool: { connect: async () => (await getPool()).connect() },
    }),
  );

  if (resolveBackendId('sql') === 'postgres' && !dsn) {
    throw new Error(
      'OPENWOP_SURFACE_SQL=postgres but OPENWOP_SQL_PG_DSN is unset. ' +
        'Set it, or unset OPENWOP_SURFACE_SQL to use the in-memory/durable sql surface.',
    );
  }
}
