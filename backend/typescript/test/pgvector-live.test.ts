/**
 * Live pgvector integration test — exercises the `pgvector` vector adapter
 * against a REAL Postgres + pgvector instance (testcontainers), closing the
 * one validation boundary the unit tests can't cover (the `<=>` cosine SQL and
 * fixed-dimension `vector(N)` column behaviour).
 *
 * Gated on Docker: skips locally when Docker is absent. The dedicated
 * `pgvector-live` CI job runs it on a Docker-capable runner. The Docker probe
 * is a TOP-LEVEL await so the `it.skipIf(...)` gate has the right value at
 * collection time (a beforeAll-set flag would still be false when skipIf reads it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import {
  createPgVectorVector, createTableSql, type SqlRunner,
} from '../src/host/vector/pgVectorVector.js';

async function isDockerReachable(): Promise<boolean> {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try {
    const { execSync } = await import('node:child_process');
    // Generous timeout: a cold `docker info` on a CI runner can take several
    // seconds; a 2s probe spuriously reports "no Docker" and silently skips.
    execSync('docker info > /dev/null 2>&1', { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// OPENWOP_PGVECTOR_LIVE=1 (set by the dedicated CI job) HARD-REQUIRES the live
// run: the probe is bypassed, so if Docker is genuinely unavailable the
// container start throws and the job goes RED — a green job then MEANS the live
// path was actually exercised, never a silent skip. Locally (flag unset) it
// probes and skips cleanly when Docker is absent.
const forceLive = process.env.OPENWOP_PGVECTOR_LIVE === '1';
// Top-level await: resolved BEFORE describe/it collection, so skipIf is correct.
const dockerAvailable = forceLive || await isDockerReachable();
if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[pgvector-live] Docker not reachable — skipping. Set OPENWOP_PGVECTOR_LIVE=1 to require it.');
}

const TABLE = 'host_vectors_test';
const DIM = 3;
let container: StartedPostgreSqlContainer | null = null;
let pool: Pool | null = null;
let run: SqlRunner;

beforeAll(async () => {
  if (!dockerAvailable) return;
  // pgvector/pgvector ships Postgres with the `vector` extension available.
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(createTableSql(TABLE, DIM));
  run = async (sql, params) => pool!.query(sql, params as unknown[]).then((r) => ({ rows: r.rows }));
}, 180_000); // first-run image pull can be slow

afterAll(async () => {
  if (pool) { try { await pool.end(); } catch { /* ignore */ } }
  if (container) { try { await container.stop(); } catch { /* ignore */ } }
}, 60_000);

const vec = (tenantId: string) => createPgVectorVector({ tenantId }, { run, dim: DIM, table: TABLE });

describe('pgvector live integration', () => {
  it.skipIf(!dockerAvailable)('upsert + real <=> nearest-neighbour query, ordered with cosine score', async () => {
    const v = vec('t1');
    await v.upsert({ namespace: 'n', items: [
      { id: 'a', vector: [1, 0, 0], metadata: { tag: 'x' } },
      { id: 'b', vector: [0, 1, 0] },
      { id: 'c', vector: [0.9, 0.1, 0] },
    ] });
    const res = await v.query({ namespace: 'n', vector: [1, 0, 0], topK: 2 }) as { matches: Array<{ id: string; score: number; metadata?: unknown }> };
    expect(res.matches.map((m) => m.id)).toEqual(['a', 'c']);  // nearest two by cosine
    expect(res.matches[0].score).toBeCloseTo(1, 5);            // identical vector → cosine sim 1
    expect(res.matches[0].metadata).toEqual({ tag: 'x' });     // jsonb round-trips
  });

  it.skipIf(!dockerAvailable)('upsert is idempotent on (tenant,namespace,id) via ON CONFLICT', async () => {
    const v = vec('t1');
    await v.upsert({ namespace: 'n', items: [{ id: 'a', vector: [0, 0, 1], metadata: { tag: 'y' } }] });
    const res = await v.query({ namespace: 'n', vector: [0, 0, 1], topK: 1 }) as { matches: Array<{ id: string; metadata?: unknown }> };
    expect(res.matches[0].id).toBe('a');
    expect(res.matches[0].metadata).toEqual({ tag: 'y' }); // overwritten, not duplicated
  });

  it.skipIf(!dockerAvailable)('delete removes by id', async () => {
    expect(await vec('t1').delete({ namespace: 'n', ids: ['a', 'missing'] })).toEqual({ deleted: 1 });
  });

  it.skipIf(!dockerAvailable)('isolates tenants in the shared table', async () => {
    await vec('tenant-a').upsert({ namespace: 'n', items: [{ id: 'secret', vector: [1, 1, 1] }] });
    const other = await vec('tenant-b').query({ namespace: 'n', vector: [1, 1, 1], topK: 5 }) as { matches: unknown[] };
    expect(other.matches).toEqual([]);
  });

  it.skipIf(!dockerAvailable)('rejects a dimension mismatch before hitting the DB', async () => {
    await expect(vec('t1').upsert({ namespace: 'n', items: [{ id: 'bad', vector: [1, 2] }] }))
      .rejects.toThrow(/dim 2 != configured 3/);
  });
});
