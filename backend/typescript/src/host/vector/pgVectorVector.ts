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
