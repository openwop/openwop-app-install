/** PostgreSQL SQL surface: tenant-authenticated sessions (ADR 0867 correction). */
import { createHash } from 'node:crypto';
import type { BundleScope, SqlSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter, resolveBackendId } from '../surfaceBackends.js';
import { registerTenantPurgeHook } from '../hostExtPersistence.js';
import { poolMaxFromEnv } from '../vector/pgVectorVector.js';
import { createPgSqlRuntime } from './pgSqlRuntime.js';

const PARAM_REJECT_RE = /\$\{|\b(?:OR|AND)\b\s+(?:'[^']*'|"[^"]*")\s*=\s*(?:'[^']*'|"[^"]*")/i;
export function requireParametric(sql: string): void {
  if (PARAM_REJECT_RE.test(sql)) {
    throw Object.assign(new Error('Non-parametric SQL rejected by host (RFC 0018).'), { code: 'SQL_NON_PARAMETRIC' });
  }
}

/** Exact tenant identity, bounded to PostgreSQL's 63-byte identifier limit. */
export function schemaForTenant(tenantId: string): string {
  if (!tenantId) throw new Error('SQL tenant identity is required.');
  return `owp_sql_${createHash('sha256').update(tenantId).digest('hex').slice(0, 48)}`;
}
export function roleForTenant(tenantId: string): string {
  return schemaForTenant(tenantId).replace('owp_sql_', 'owp_sql_role_');
}
export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void | Promise<void>;
}
/** Only tenant-authenticated connections cross the pack-facing boundary. */
export interface PgSqlDeps { connectTenant(tenantId: string): Promise<PgClient> }

export function createPgSql(scope: BundleScope, deps: PgSqlDeps): SqlSurface {
  const schema = schemaForTenant(scope.tenantId);

  async function withScopedClient<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
    const client = await deps.connectTenant(scope.tenantId);
    try {
      // pg_catalog is searched implicitly before this schema. Listing it
      // explicitly first would make CREATE TABLE target the protected catalog.
      await client.query(`SET search_path TO "${schema}"`);
      return await fn(client);
    } finally {
      await client.release();
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


let bootCheck: (() => Promise<void>) | null = null;
export async function verifyPgSqlBackend(): Promise<void> {
  if (bootCheck) await bootCheck();
}
export function registerPgSqlAdapter(): void {
  bootCheck = null;
  const dsn = process.env.OPENWOP_SQL_PG_DSN;
  const rolePasswordKey = process.env.OPENWOP_SQL_PG_ROLE_PASSWORD_KEY;
  const max = poolMaxFromEnv('OPENWOP_SQL_PG_POOL_MAX');
  const selected = resolveBackendId('sql') === 'postgres';
  if (selected && (!dsn || !rolePasswordKey || rolePasswordKey.length < 32 || max < 2)) {
    throw new Error('Postgres SQL requires OPENWOP_SQL_PG_DSN, a stable OPENWOP_SQL_PG_ROLE_PASSWORD_KEY of at least 32 characters, and OPENWOP_SQL_PG_POOL_MAX >= 2.');
  }
  let runtime: ReturnType<typeof createPgSqlRuntime> | null = null;
  const getRuntime = () => {
    if (!dsn || !rolePasswordKey || rolePasswordKey.length < 32 || max < 2) {
      throw new Error('Postgres SQL provisioning configuration is incomplete.');
    }
    return runtime ??= createPgSqlRuntime({ dsn, rolePasswordKey, max });
  };
  registerSurfaceAdapter('sql', 'postgres', (scope: BundleScope) =>
    createPgSql(scope, { connectTenant: async (tenant) => (await getRuntime()).connectTenant(tenant) }));
  if (dsn) {
    // Existing teardown seam covers account deletion and anonymous retention.
    // Missing provisioning credentials remain a reported purge failure, not a skip.
    registerTenantPurgeHook('postgres-sql', async (tenant) => (await getRuntime()).purgeTenant(tenant));
  }
  if (selected) bootCheck = async () => (await getRuntime()).verify();
}
