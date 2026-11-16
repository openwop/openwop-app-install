/**
 * ADR 0867 — a SELECTED storage engine proves itself before the process takes
 * traffic (`main()` awaits these and exits on failure, so a misconfigured
 * revision fails its startup probe instead of every storage call).
 *
 * pgvector: `CREATE EXTENSION IF NOT EXISTS vector` runs BEFORE the table DDL
 * (without it the `vector(n)` column cannot be created on a fresh database),
 * then one round trip. Postgres sql: registration refuses missing role
 * credentials and a one-connection budget before any pool opens; the
 * CREATE/CREATEROLE check itself (`pgSqlRuntime` verify) is witnessed by
 * `pg-sql-live.test.ts`, which needs Docker and skips in the gate. S3 blob: a put,
 * read-back, list and delete under a reserved tenant root, cleaned up even
 * when a step fails. Each is a no-op when its backend is not selected. The
 * vector pool honours OPENWOP_VECTOR_PG_POOL_MAX and the sql registration refuses
 * a budget below 2 (the sql pool's own size is opened by `pgSqlRuntime`, which
 * only `pg-sql-live` reaches); preflight Gate 5 counts both.
 *
 * ADR 0904 P3: the KB's lexical side table rides the SAME vector pool, and after
 * a switch away from pgvector a configured DSN still reaches it for teardown
 * without creating `vector(NaN)` or the unused extension.
 *
 * Tracker TST-BFB-4. Red when: the extension DDL runs after the table DDL; the
 * vector pool ignores OPENWOP_VECTOR_PG_POOL_MAX; the lexical DDL leaves the
 * vector pool or a second pool opens; maintenance after a switch is unreachable,
 * serves reads, skips the purge DELETE, or runs the vector DDL; the sql
 * registration accepts a pool of 1 or a missing role key; the blob boot check
 * accepts an object that did not read back, skips the list or the presigned
 * fetch, writes outside the reserved tenant root, or skips its cleanup; the s3
 * check runs when s3 is not selected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  queries: [] as string[],
  poolOpts: [] as Array<Record<string, unknown>>,
  failOn: null as RegExp | null,
}));
vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<typeof import('pg')>();
  class Pool {
    constructor(opts: Record<string, unknown>) { pg.poolOpts.push(opts); }
    async query(sql: string) {
      pg.queries.push(sql);
      if (pg.failOn?.test(sql)) throw new Error(`refused: ${sql}`);
      if (/format_type/.test(sql)) return { rows: [{ embedding_type: `vector(${process.env.OPENWOP_VECTOR_PG_DIM})` }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    async connect() { return { query: (sql: string) => this.query(sql), release: () => {} }; }
  }
  return { ...original, default: { ...original.default, Pool }, Pool };
});

import { registerPgVectorAdapter, verifyPgVectorBackend, CREATE_EXTENSION_SQL } from '../src/host/vector/pgVectorVector.js';
import { lexicalIndex, lexicalMaintenanceIndex } from '../src/host/vector/pgLexical.js';
import { registerPgSqlAdapter, verifyPgSqlBackend } from '../src/host/sql/pgSql.js';
import { verifyS3BlobBackend, type S3Config } from '../src/host/blob/s3Blob.js';

const ENV_KEYS = [
  'OPENWOP_SURFACE_BACKEND', 'OPENWOP_SURFACE_VECTOR', 'OPENWOP_SURFACE_SQL', 'OPENWOP_SURFACE_BLOB',
  'OPENWOP_VECTOR_PG_DSN', 'OPENWOP_VECTOR_PG_DIM', 'OPENWOP_VECTOR_PG_POOL_MAX',
  'OPENWOP_SQL_PG_DSN', 'OPENWOP_SQL_PG_POOL_MAX', 'OPENWOP_SQL_PG_ROLE_PASSWORD_KEY',
] as const;
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  pg.queries.length = 0; pg.poolOpts.length = 0; pg.failOn = null;
});
afterEach(() => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const PG = 'postgresql://u:p@/db?host=/cloudsql/x';

describe('ADR 0867 — pgvector boot check', () => {
  it('creates the extension BEFORE the table, then round-trips, on a pool sized by OPENWOP_VECTOR_PG_POOL_MAX', async () => {
    Object.assign(process.env, { OPENWOP_SURFACE_VECTOR: 'pgvector', OPENWOP_VECTOR_PG_DSN: PG, OPENWOP_VECTOR_PG_DIM: '256', OPENWOP_VECTOR_PG_POOL_MAX: '2' });
    registerPgVectorAdapter();
    await verifyPgVectorBackend();
    expect(pg.queries[0]).toBe(CREATE_EXTENSION_SQL);
    expect(pg.queries[1]).toMatch(/^CREATE TABLE IF NOT EXISTS host_vectors .*vector\(256\)/);
    expect(pg.queries[2]).toMatch(/format_type/);
    // ADR 0904 P3 — the KB's persisted lexical side table, on the SAME pool (one pool).
    expect(pg.queries[3]).toMatch(/^CREATE TABLE IF NOT EXISTS kb_lexical /);
    expect(pg.queries[4]).toMatch(/^CREATE TABLE IF NOT EXISTS kb_lexical_state /);
    expect(pg.queries[5]).toMatch(/^ALTER TABLE kb_lexical /);
    expect(pg.queries[6]).toMatch(/^ALTER TABLE kb_lexical_state /);
    expect(pg.queries[7]).toMatch(/^CREATE INDEX IF NOT EXISTS kb_lexical_tsv_gin /);
    expect(pg.queries[8]).toBe('SELECT 1');
    expect(pg.poolOpts).toHaveLength(1);
    expect(pg.poolOpts[0]?.['max']).toBe(2);
  });
  it('configured lexical maintenance works after a backend switch without a vector dimension', async () => {
    delete process.env.OPENWOP_SURFACE_VECTOR;
    delete process.env.OPENWOP_VECTOR_PG_DIM;
    process.env.OPENWOP_VECTOR_PG_DSN = 'postgres://fixture';
    registerPgVectorAdapter();
    expect(lexicalIndex()).toBeNull();
    const maintenance = lexicalMaintenanceIndex();
    expect(maintenance).not.toBeNull();
    await expect(maintenance!.purgeTenant('retired-fixture')).resolves.toBe(0);
    // The purge itself reached the lexical table (not only its DDL).
    expect(pg.queries).toContain('DELETE FROM kb_lexical WHERE tenant = $1 RETURNING chunk_id');
    expect(pg.poolOpts).toHaveLength(1);
    expect(pg.queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS kb_lexical '))).toBe(true);
    expect(pg.queries.some(q => q.includes('vector(NaN)') || q === CREATE_EXTENSION_SQL)).toBe(false);
  });
  it('rejects when the extension cannot be created, so main() exits before listening', async () => {
    Object.assign(process.env, { OPENWOP_SURFACE_VECTOR: 'pgvector', OPENWOP_VECTOR_PG_DSN: PG, OPENWOP_VECTOR_PG_DIM: '256' });
    pg.failOn = /CREATE EXTENSION/;
    registerPgVectorAdapter();
    await expect(verifyPgVectorBackend()).rejects.toThrow(/CREATE EXTENSION/);
  });
  it('is a no-op when pgvector is not selected', async () => {
    registerPgVectorAdapter();
    await verifyPgVectorBackend();
    expect(pg.queries).toEqual([]);
  });
});

describe('ADR 0867 — Postgres sql boot check', () => {
  it('rejects missing stable role credentials before any privileged pool opens', () => {
    Object.assign(process.env, { OPENWOP_SURFACE_SQL: 'postgres', OPENWOP_SQL_PG_DSN: PG });
    expect(() => registerPgSqlAdapter()).toThrow(/ROLE_PASSWORD_KEY/);
    expect(pg.poolOpts).toEqual([]);
  });
  it('rejects a one-connection budget, which cannot reserve both provisioning and tenant sessions', () => {
    Object.assign(process.env, { OPENWOP_SURFACE_SQL: 'postgres', OPENWOP_SQL_PG_DSN: PG,
      OPENWOP_SQL_PG_ROLE_PASSWORD_KEY: 'disposable-test-key-minimum-32-characters', OPENWOP_SQL_PG_POOL_MAX: '1' });
    expect(() => registerPgSqlAdapter()).toThrow(/POOL_MAX/);
    expect(pg.poolOpts).toEqual([]);
  });
  it('is a no-op when postgres sql is not selected', async () => {
    registerPgSqlAdapter();
    await verifyPgSqlBackend();
    expect(pg.queries).toEqual([]);
  });
});

/** Path-style fake S3 (object PUT/GET/HEAD/DELETE + ListObjectsV2); `failGet` serves 404 on GET. */
function fakeS3(opts: { failGet?: boolean } = {}) {
  const store = new Map<string, Buffer>();
  const deletes: string[] = [];
  /** `<METHOD> list|object` per request, in order. */
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const [, , ...rest] = u.pathname.split('/');
    calls.push(`${method} ${rest.length === 0 ? 'list' : 'object'}`);
    if (rest.length === 0) {
      const prefix = u.searchParams.get('prefix') ?? '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><Size>${store.get(k)!.byteLength}</Size></Contents>`).join('')}</ListBucketResult>`, { status: 200 });
    }
    const key = rest.map(decodeURIComponent).join('/');
    if (method === 'PUT') {
      if (!(init.body instanceof Uint8Array)) throw new Error('fake S3: PUT body must be bytes');
      store.set(key, Buffer.from(init.body));
      return new Response(null, { status: 200 });
    }
    if (method === 'DELETE') { deletes.push(key); store.delete(key); return new Response(null, { status: 204 }); }
    const body = store.get(key);
    if (!body || opts.failGet) return new Response(null, { status: 404 });
    return new Response(method === 'HEAD' ? null : body, { status: 200 });
  };
  return { store, deletes, calls, fetchFn };
}
const S3: S3Config = {
  bucket: 'b', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK',
  endpoint: 'http://localhost:9000', forcePathStyle: true, keyPrefix: 'p/', presignTtlSeconds: 300,
};

describe('ADR 0867 — S3 blob boot check', () => {
  it('writes, reads back, lists, fetches presigned and deletes one object under the reserved tenant root', async () => {
    process.env.OPENWOP_SURFACE_BLOB = 's3';
    const s3 = fakeS3();
    await verifyS3BlobBackend({ fetch: s3.fetchFn, config: S3 });
    // Every step of the round trip, in order (HEAD is presign's existence check, not a step).
    expect(s3.calls.filter((c) => !c.startsWith('HEAD'))).toEqual(['PUT object', 'GET object', 'GET list', 'GET object', 'DELETE object']);
    expect(s3.deletes).toHaveLength(1);
    // A literal, not the imported BLOB_BOOT_CHECK_TENANT, so a moved root cannot move the expectation.
    expect(s3.deletes[0]).toMatch(/^p\/tenants\/__openwop_boot_check__\/boot-check-[0-9a-f-]{36}$/);
    expect(s3.store.size).toBe(0);
  });
  it('rejects when the object does not read back, and still deletes it', async () => {
    process.env.OPENWOP_SURFACE_BLOB = 's3';
    const s3 = fakeS3({ failGet: true });
    await expect(verifyS3BlobBackend({ fetch: s3.fetchFn, config: S3 })).rejects.toThrow(/did not read back/);
    expect(s3.deletes).toHaveLength(1);
    expect(s3.store.size).toBe(0);
  });
  it('is a no-op when s3 is not selected', async () => {
    const s3 = fakeS3();
    await verifyS3BlobBackend({ fetch: s3.fetchFn, config: S3 });
    expect(s3.deletes).toEqual([]);
  });
});
