/**
 * pgvector-backed vector host surface (Phase 2 scale engine) — `host.db.vector`
 * over Postgres + the pgvector extension, selected with
 * `OPENWOP_SURFACE_VECTOR=pgvector`.
 *
 * The scale answer for vector search: real ANN/IVF indexing + the `<=>` cosine
 * distance operator instead of the durable-but-O(n) brute-force cosine.
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
 */

import type { BundleScope, VectorSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter, resolveBackendId } from '../surfaceBackends.js';
import { registerVectorTenantPurger, registerVectorNamespacePurger } from './vectorTenantPurge.js';

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
export function createTableSql(table: string, dim: number): string {
  return `CREATE TABLE IF NOT EXISTS ${ident(table)} (` +
    `tenant text NOT NULL, namespace text NOT NULL, id text NOT NULL, ` +
    `embedding vector(${Number(dim)}) NOT NULL, metadata jsonb, ` +
    `PRIMARY KEY (tenant, namespace, id))`;
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
      const { rows } = await deps.run(nearestSql(table), [toVectorLiteral(q), tenant, String(namespace ?? 'default'), k]);
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
export function registerPgVectorAdapter(): void {
  const dimRaw = process.env.OPENWOP_VECTOR_PG_DIM;
  const dsn = process.env.OPENWOP_VECTOR_PG_DSN;
  const table = process.env.OPENWOP_VECTOR_PG_TABLE || 'host_vectors';

  let runnerPromise: Promise<SqlRunner> | null = null;
  const getRunner = async (): Promise<SqlRunner> => {
    if (!runnerPromise) {
      runnerPromise = (async () => {
        const { Pool } = await import('pg');
        const pool = new Pool({ connectionString: dsn });
        await pool.query(createTableSql(table, Number(dimRaw)));
        return (sql, params) => pool.query(sql, params as unknown[]).then((r) => ({ rows: r.rows }));
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
  }
}
