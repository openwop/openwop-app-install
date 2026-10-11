/**
 * pgvector-backed vector host surface (Phase 2 scale engine) — `host.db.vector`
 * over Postgres + the pgvector extension, selected with
 * `OPENWOP_SURFACE_VECTOR=pgvector`.
 *
 * Shared across instances, durable, and ordered by pgvector's `<=>` cosine
 * distance in the database instead of brute-force cosine in the app.
 *
 * > **CORRECTED 2026-10-09 (ADR 0867).** This said "real ANN/IVF indexing". No
 * > index was ever created: `createTableSql` builds only the
 * > `(tenant, namespace, id)` primary key, so a query is an EXACT scan of one
 * > tenant's namespace through that key's prefix. That is deliberate for now:
 * > an HNSW/IVF index post-filters by tenant, so a small tenant in a large table
 * > can get fewer than `topK` (or zero) matches unless iterative scans are on
 * > (pgvector ≥ 0.8). Exact is correct; ANN is an ADR 0867 follow-up.
 *
 * Validation boundary (honest): this environment has no Postgres+pgvector, so
 * the live path is NOT exercised here. The risk — SQL correctness — is pinned by
 * unit tests over the pure SQL builders below, and the adapter orchestration is
 * tested through an injectable query runner. An end-to-end test against a real
 * pgvector (CI service container) is the remaining follow-up.
 *
 * Fixed dimension: pgvector columns are fixed-width, so the embedding dimension
 * is configured (`OPENWOP_VECTOR_PG_DIM`) and enforced per upsert/query.
 *
 * Config (env):
 *   OPENWOP_VECTOR_PG_DSN   (required; postgres://… — may equal OPENWOP_STORAGE_DSN)
 *   OPENWOP_VECTOR_PG_DIM   (required; embedding dimension, e.g. 1536)
 *   OPENWOP_VECTOR_PG_TABLE (default "host_vectors")
 *   OPENWOP_VECTOR_PG_POOL_MAX (default 10; counted by preflight-deploy.sh Gate 5)
 *   OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS (default 30000, as the storage pool) — ADR 0871
 *   OPENWOP_VECTOR_QUERY_WARN_MS (default 200) — `vector_query_slow` threshold, ADR 0871
 *
 * The extension is created on first use (`CREATE EXTENSION IF NOT EXISTS
 * vector`); on Cloud SQL the app's database user may create it. `main()` calls
 * `verifyPgVectorBackend()` before listening, so a host that cannot reach or
 * prepare pgvector fails its startup probe and never takes traffic.
 */

import type { BundleScope, VectorSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter, resolveBackendId } from '../surfaceBackends.js';
import { registerVectorTenantPurger, registerVectorNamespacePurger } from './vectorTenantPurge.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('host.vector.pgvector');

/** Minimal runner so the adapter is testable without a live pg client. */
export type SqlRunner = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

// ── pure SQL builders (unit-tested) ─────────────────────────────────
const ident = (table: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) throw new Error(`unsafe table identifier: ${table}`);
  return table;
};
/** pgvector literal form: `[1,2,3]`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
export const CREATE_EXTENSION_SQL = 'CREATE EXTENSION IF NOT EXISTS vector';
export function createTableSql(table: string, dim: number): string {
  return `CREATE TABLE IF NOT EXISTS ${ident(table)} (` +
    `tenant text NOT NULL, namespace text NOT NULL, id text NOT NULL, ` +
    `embedding vector(${Number(dim)}) NOT NULL, metadata jsonb, ` +
    `PRIMARY KEY (tenant, namespace, id))`;
}
/** CREATE IF NOT EXISTS does not validate a table left by an earlier config. */
export async function verifyPgVectorDimension(run: SqlRunner, table: string, dim: number): Promise<void> {
  const { rows } = await run(`SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
    FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attname = 'embedding'
      AND NOT a.attisdropped`, [ident(table)]);
  if (rows[0]?.['embedding_type'] !== `vector(${dim})`) {
    throw new Error('pgvector embedding column differs from OPENWOP_VECTOR_PG_DIM; migrate explicitly before activation.');
  }
}
export function upsertSql(table: string): string {
  return `INSERT INTO ${ident(table)} (tenant, namespace, id, embedding, metadata) ` +
    `VALUES ($1, $2, $3, $4::vector, $5::jsonb) ` +
    `ON CONFLICT (tenant, namespace, id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`;
}
/** Cosine *similarity* = 1 - cosine distance (`<=>`), ordered nearest-first. */
export function nearestSql(table: string): string {
  return `SELECT id, metadata, 1 - (embedding <=> $1::vector) AS score ` +
    `FROM ${ident(table)} WHERE tenant = $2 AND namespace = $3 ` +
    `ORDER BY embedding <=> $1::vector LIMIT $4`;
}
export function deleteSql(table: string): string {
  return `DELETE FROM ${ident(table)} WHERE tenant = $1 AND namespace = $2 AND id = ANY($3)`;
}
/**
 * KB-2 — the TENANT-wide delete account teardown needs.
 *
 * `deleteAllTenantData` enumerates public tables whose column is literally
 * `tenant_id`; this table's column is `tenant`, so it was never enumerated — and on
 * a separate `OPENWOP_VECTOR_PG_DSN` it would not have been reachable even if it
 * were. KB chunk rows carry the chunk's full text in `metadata`, so without this a
 * deleted tenant's document text survived account deletion forever.
 *
 * Deliberately NOT exposed through `VectorSurface` (the pack-facing RFC 0018
 * surface); it is reached through the host-internal `vectorTenantPurge` registry.
 */
export function purgeTenantSql(table: string): string {
  return `DELETE FROM ${ident(table)} WHERE tenant = $1`;
}

/** ADR 0664 D1 — the namespace-scoped sibling. Both predicates are bound parameters;
 *  only the table name is interpolated, through `ident()`, as above. */
export function purgeNamespaceSql(table: string): string {
  return `DELETE FROM ${ident(table)} WHERE tenant = $1 AND namespace = $2`;
}

/**
 * ADR 0871 — the HNSW trigger's inputs, aggregated over (tenant, namespace) in the
 * database: how many namespaces hold vectors, the largest one's row count, the
 * total, and how many namespaces hold at least `minNamespaceRows`. No tenant id
 * leaves the database.
 */
export function namespaceStatsSql(table: string): string {
  return `SELECT count(*)::int AS namespaces, coalesce(max(n), 0)::int AS max_rows, ` +
    `coalesce(sum(n), 0)::bigint AS total_rows, count(*) FILTER (WHERE n >= $1)::int AS over ` +
    `FROM (SELECT count(*) AS n FROM ${ident(table)} GROUP BY tenant, namespace) s`;
}
/** HNSW needs pgvector >= 0.5 and filtered ANN (`hnsw.iterative_scan`) >= 0.8. */
export const EXTENSION_VERSION_SQL = `SELECT extversion FROM pg_extension WHERE extname = 'vector'`;

export interface PgVectorStats {
  namespaces: number;
  maxNamespaceRows: number;
  totalRows: number;
  namespacesAtOrOver: number;
  dim: number;
  extversion: string | null;
}

export async function readPgVectorStatsWith(run: SqlRunner, table: string, dim: number, minNamespaceRows: number): Promise<PgVectorStats> {
  const { rows } = await run(namespaceStatsSql(table), [minNamespaceRows]);
  const r = rows[0] ?? {};
  const v = await run(EXTENSION_VERSION_SQL, []);
  return {
    namespaces: Number(r['namespaces'] ?? 0),
    maxNamespaceRows: Number(r['max_rows'] ?? 0),
    totalRows: Number(r['total_rows'] ?? 0),
    namespacesAtOrOver: Number(r['over'] ?? 0),
    dim,
    extversion: (v.rows[0]?.['extversion'] as string | undefined) ?? null,
  };
}

/** ADR 0871 — a pgvector query at or over this many ms logs `vector_query_slow`. */
export function vectorQueryWarnMs(): number {
  const raw = process.env.OPENWOP_VECTOR_QUERY_WARN_MS;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

interface VectorEntry { id: string; vector: number[]; metadata?: Record<string, unknown> }

export interface PgVectorDeps { run: SqlRunner; dim: number; table?: string }

export function createPgVectorVector(scope: BundleScope, deps: PgVectorDeps): VectorSurface {
  const table = deps.table ?? 'host_vectors';
  const tenant = scope.tenantId;
  const checkDim = (v: number[]) => {
    if (v.length !== deps.dim) {
      throw Object.assign(new Error(`vector dim ${v.length} != configured ${deps.dim}`), { code: 'vector_dim_mismatch' });
    }
  };
  return {
    async upsert({ namespace, items }) {
      const arr = items as VectorEntry[];
      const ns = String(namespace ?? 'default');
      for (const it of arr) {
        checkDim(it.vector);
        await deps.run(upsertSql(table), [tenant, ns, it.id, toVectorLiteral(it.vector), JSON.stringify(it.metadata ?? null)]);
      }
      return { upserted: arr.length };
    },
    async query({ namespace, vector, topK }) {
      const q = vector as number[];
      checkDim(q);
      const k = typeof topK === 'number' && topK > 0 ? topK : 10;
      const started = Date.now();
      const { rows } = await deps.run(nearestSql(table), [toVectorLiteral(q), tenant, String(namespace ?? 'default'), k]);
      // ADR 0871 — the query is an exact scan of the namespace; its latency is the
      // HNSW trigger. No tenant or namespace in the line.
      const ms = Date.now() - started;
      if (ms >= vectorQueryWarnMs()) log.warn('vector_query_slow', { ms, k, matches: rows.length });
      return {
        matches: rows.map((r) => ({
          id: String(r.id),
          score: Number(r.score),
          metadata: (r.metadata ?? undefined) as Record<string, unknown> | undefined,
        })),
      };
    },
    async delete({ namespace, ids }) {
      const arr = ids as string[];
      const { rows } = await deps.run(
        `${deleteSql(table)} RETURNING id`, [tenant, String(namespace ?? 'default'), arr],
      );
      return { deleted: rows.length };
    },
  };
}

/**
 * Register the pgvector adapter. Lazily builds a `pg` Pool from env on first use
 * and ensures the table exists. Fails fast at boot if `vector=pgvector` but
 * config is incomplete.
 */
/** Set by `registerPgVectorAdapter` while pgvector is SELECTED: prepares the
 *  extension + table and runs one round trip. Null otherwise. */
let bootCheck: (() => Promise<void>) | null = null;
/** Set while pgvector is SELECTED: the ADR 0871 gauge's read. Null otherwise. */
let statsProbe: ((minNamespaceRows: number) => Promise<PgVectorStats>) | null = null;

/** ADR 0871 — the selected pgvector backend's size, or null when it is not selected. */
export async function readPgVectorStats(minNamespaceRows: number): Promise<PgVectorStats | null> {
  return statsProbe ? statsProbe(minNamespaceRows) : null;
}

/** Statement timeout for the vector pool, as the storage pool's (ADR 0871). */
export function vectorStatementTimeoutMs(): number {
  return poolMaxFromEnv('OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS', 30_000);
}

/** ADR 0867 — prove the selected pgvector backend works before taking traffic. */
export async function verifyPgVectorBackend(): Promise<void> {
  if (bootCheck) await bootCheck();
}

/** A positive-integer pool size from `name`, else `fallback`. Exported for Gate 5 parity. */
export function poolMaxFromEnv(name: string, fallback = 10): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function registerPgVectorAdapter(): void {
  bootCheck = null;
  statsProbe = null;
  const dimRaw = process.env.OPENWOP_VECTOR_PG_DIM;
  const dsn = process.env.OPENWOP_VECTOR_PG_DSN;
  const table = process.env.OPENWOP_VECTOR_PG_TABLE || 'host_vectors';

  let runnerPromise: Promise<SqlRunner> | null = null;
  const getRunner = async (): Promise<SqlRunner> => {
    if (!runnerPromise) {
      runnerPromise = (async () => {
        const { Pool } = await import('pg');
        // ADR 0871 — statement_timeout: production runs this pool at 1, so one
        // runaway exact scan would otherwise hold every vector operation.
        const pool = new Pool({
          connectionString: dsn, max: poolMaxFromEnv('OPENWOP_VECTOR_PG_POOL_MAX'), idleTimeoutMillis: 30_000,
          statement_timeout: vectorStatementTimeoutMs(),
        });
        await pool.query(CREATE_EXTENSION_SQL);
        await pool.query(createTableSql(table, Number(dimRaw)));
        const run: SqlRunner = (sql, params) => pool.query(sql, params as unknown[]).then((r) => ({ rows: r.rows }));
        await verifyPgVectorDimension(run, table, Number(dimRaw));
        return run;
      })();
    }
    return runnerPromise;
  };

  registerSurfaceAdapter('vector', 'pgvector', (scope: BundleScope) =>
    createPgVectorVector(scope, {
      dim: Number(dimRaw),
      table,
      run: async (sql, params) => (await getRunner())(sql, params),
    }),
  );

  // KB-2 — teardown reachability. Registered beside the adapter so the two can never
  // drift apart: if this backend can be WRITTEN to on this host, it can be purged.
  //
  // KB-3 R2 (CORRECTION). This registration was UNCONDITIONAL, and `registerPgVectorAdapter()`
  // itself is called unconditionally from `index.ts`. So on a DEFAULT deployment — no
  // `OPENWOP_SURFACE_VECTOR`, no DSN — the first account delete built
  // `new Pool({ connectionString: undefined })`, ran `CREATE TABLE … vector(NaN)`, threw,
  // and landed 'pgvector' in `failed`: `routes/account.ts` then logged "vector mirror not
  // fully reclaimed" on EVERY delete and EVERY anon teardown sweep, forever
  // (`runnerPromise` memoizes the REJECTED promise, so it never recovers). That turned the
  // one honest signal this seam exists to produce into permanent false noise — and where
  // `PGHOST`/`PGDATABASE` happen to be set in the environment, into an unintended
  // CREATE TABLE at account-delete time.
  //
  // A purger is registered when this backend is SELECTED or CONFIGURED. The
  // "register every backend, not just the selected one" rationale in
  // `vectorTenantPurge.ts` is about a host that SWITCHED backends and still holds
  // residue in the old one — which needs the DSN to reach it anyway, so a configured
  // DSN is exactly the right condition, and an unconfigured host has no pgvector
  // residue by construction.
  if (resolveBackendId('vector') === 'pgvector' || dsn) {
    registerVectorTenantPurger('pgvector', async (tenantId) => {
      const { rows } = await (await getRunner())(`${purgeTenantSql(table)} RETURNING id`, [tenantId]);
      return rows.length;
    });
    // ADR 0664 D1 — the namespace purge registers under the SAME condition, for the same
    // reason: a host that switched backends still holds this agent's residue in the old
    // one, and reaching it needs the DSN either way.
    registerVectorNamespacePurger('pgvector', async (tenantId, namespace) => {
      const { rows } = await (await getRunner())(`${purgeNamespaceSql(table)} RETURNING id`, [tenantId, namespace]);
      return rows.length;
    });
  }

  if (resolveBackendId('vector') === 'pgvector') {
    const missing = [
      !dsn && 'OPENWOP_VECTOR_PG_DSN',
      !dimRaw && 'OPENWOP_VECTOR_PG_DIM',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `OPENWOP_SURFACE_VECTOR=pgvector but missing required config: ${missing.join(', ')}. ` +
          'Set them, or unset OPENWOP_SURFACE_VECTOR to use the in-memory/durable vector store.',
      );
    }
    bootCheck = async () => {
      // A rejected first attempt is memoized by `getRunner`; let the boot check
      // see it, and let the process exit rather than serve a broken surface.
      const run = await getRunner();
      await run('SELECT 1', []);
    };
    statsProbe = async (minNamespaceRows) =>
      readPgVectorStatsWith(await getRunner(), table, Number(dimRaw), minNamespaceRows);
  }
}
