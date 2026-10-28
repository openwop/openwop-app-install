/**
 * ADR 0871 — pgvector telemetry and the vector pool's statement timeout.
 *
 *   - a query at or over OPENWOP_VECTOR_QUERY_WARN_MS logs `vector_query_slow`,
 *     with no tenant or namespace; a faster one logs nothing;
 *   - the vector Pool is built with a statement_timeout (default 30 s, as the
 *     storage pool), overridable by OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS;
 *   - `readPgVectorStats` is null unless pgvector is selected, and maps the
 *     database's aggregate when it is.
 *
 * Tracker TST-BFC-5. Red when: the slow-query line carries the tenant; the
 * threshold is ignored; the statement_timeout default or its env override is
 * ignored; a re-registration leaves a stale stats probe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolOptions: Array<Record<string, unknown>> = [];
vi.mock('pg', () => {
  class Pool {
    constructor(opts: Record<string, unknown>) { poolOptions.push(opts); }
    async query(sql: string) {
      if (sql.includes('format_type')) return { rows: [{ embedding_type: 'vector(3)' }] };
      if (sql.includes('GROUP BY tenant, namespace')) return { rows: [{ namespaces: 4, max_rows: 70, total_rows: '120', over: 1 }] };
      if (sql.includes('pg_extension')) return { rows: [{ extversion: '0.8.0' }] };
      return { rows: [] };
    }
  }
  return { default: { Pool }, Pool };
});

const ENV = ['OPENWOP_SURFACE_VECTOR', 'OPENWOP_VECTOR_PG_DSN', 'OPENWOP_VECTOR_PG_DIM',
  'OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS', 'OPENWOP_VECTOR_QUERY_WARN_MS'];

let out: string[] = [];
beforeEach(() => {
  out = [];
  poolOptions.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV) delete process.env[k];
});

async function load() {
  vi.resetModules();
  return import('../src/host/vector/pgVectorVector.js');
}

describe('vector_query_slow', () => {
  const slowRunner = (ms: number) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return { rows: [{ id: 'x', metadata: null, score: 0.9 }] };
  };

  it('logs a slow query with no tenant or namespace', async () => {
    process.env.OPENWOP_VECTOR_QUERY_WARN_MS = '10';
    const { createPgVectorVector } = await load();
    const v = createPgVectorVector({ tenantId: 'secret-tenant' }, { run: slowRunner(30), dim: 3 });
    await v.query({ namespace: 'secret-ns', vector: [1, 0, 0], topK: 5 });
    const lines = out.filter((l) => l.includes('vector_query_slow'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"k":5');
    expect(lines[0]).not.toContain('secret-tenant');
    expect(lines[0]).not.toContain('secret-ns');
  });

  it('logs nothing under the threshold', async () => {
    process.env.OPENWOP_VECTOR_QUERY_WARN_MS = '5000';
    const { createPgVectorVector } = await load();
    const v = createPgVectorVector({ tenantId: 't' }, { run: slowRunner(1), dim: 3 });
    await v.query({ namespace: 'n', vector: [1, 0, 0] });
    expect(out.some((l) => l.includes('vector_query_slow'))).toBe(false);
  });
});

describe('the vector pool and its stats probe', () => {
  function select() {
    process.env.OPENWOP_SURFACE_VECTOR = 'pgvector';
    process.env.OPENWOP_VECTOR_PG_DSN = 'postgres://unused/db';
    process.env.OPENWOP_VECTOR_PG_DIM = '3';
  }

  it('builds the pool with a 30 s statement_timeout by default', async () => {
    select();
    const m = await load();
    m.registerPgVectorAdapter();
    await m.verifyPgVectorBackend();
    expect(poolOptions).toHaveLength(1);
    expect(poolOptions[0]!['statement_timeout']).toBe(30_000);
  });

  it('honours OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS', async () => {
    select();
    process.env.OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS = '5000';
    const m = await load();
    m.registerPgVectorAdapter();
    await m.verifyPgVectorBackend();
    expect(poolOptions[0]!['statement_timeout']).toBe(5000);
  });

  it('readPgVectorStats is null when pgvector is not selected, including after a re-registration', async () => {
    const m = await load();
    m.registerPgVectorAdapter();
    expect(await m.readPgVectorStats(50_000)).toBeNull();
    select();
    m.registerPgVectorAdapter();
    expect(await m.readPgVectorStats(50_000)).not.toBeNull();
    delete process.env.OPENWOP_SURFACE_VECTOR;
    m.registerPgVectorAdapter();
    expect(await m.readPgVectorStats(50_000)).toBeNull();
  });

  it('readPgVectorStats maps the aggregate and the extension version when selected', async () => {
    select();
    const m = await load();
    m.registerPgVectorAdapter();
    expect(await m.readPgVectorStats(50)).toEqual({
      namespaces: 4, maxNamespaceRows: 70, totalRows: 120, namespacesAtOrOver: 1, dim: 3, extversion: '0.8.0',
    });
  });
});
