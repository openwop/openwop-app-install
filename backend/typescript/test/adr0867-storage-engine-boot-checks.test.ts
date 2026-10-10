/**
 * ADR 0867 — a SELECTED storage engine proves itself before the process takes
 * traffic (`main()` awaits these and exits on failure, so a misconfigured
 * revision fails its startup probe instead of every storage call).
 *
 * pgvector: `CREATE EXTENSION IF NOT EXISTS vector` runs BEFORE the table DDL
 * (without it the `vector(n)` column cannot be created on a fresh database),
 * then one round trip. Postgres sql: the user must hold CREATE, which
 * `ensureSchema` needs for every tenant's first statement. S3 blob: a put,
 * read-back, list and delete under a reserved tenant root, cleaned up even
 * when a step fails. Each is a no-op when its backend is not selected, and both
 * pg pools honour their `*_POOL_MAX`, which preflight Gate 5 counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  queries: [] as string[],
  poolOpts: [] as Array<Record<string, unknown>>,
  failOn: null as RegExp | null,
  canCreate: true,
}));
vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<typeof import('pg')>();
  class Pool {
    constructor(opts: Record<string, unknown>) { pg.poolOpts.push(opts); }
    async query(sql: string) {
      pg.queries.push(sql);
      if (pg.failOn?.test(sql)) throw new Error(`refused: ${sql}`);
      if (/format_type/.test(sql)) return { rows: [{ embedding_type: `vector(${process.env.OPENWOP_VECTOR_PG_DIM})` }], rowCount: 1 };
      return { rows: [{ can_create: pg.canCreate }], rowCount: 1 };
    }
    async connect() { return { query: (sql: string) => this.query(sql), release: () => {} }; }
  }
  return { ...original, default: { ...original.default, Pool }, Pool };
});

import { registerPgVectorAdapter, verifyPgVectorBackend, CREATE_EXTENSION_SQL } from '../src/host/vector/pgVectorVector.js';
import { registerPgSqlAdapter, verifyPgSqlBackend } from '../src/host/sql/pgSql.js';
import { verifyS3BlobBackend, type S3Config } from '../src/host/blob/s3Blob.js';
import { BLOB_BOOT_CHECK_TENANT } from '../src/host/blob/blobBootCheck.js';

const ENV_KEYS = [
  'OPENWOP_SURFACE_BACKEND', 'OPENWOP_SURFACE_VECTOR', 'OPENWOP_SURFACE_SQL', 'OPENWOP_SURFACE_BLOB',
  'OPENWOP_VECTOR_PG_DSN', 'OPENWOP_VECTOR_PG_DIM', 'OPENWOP_VECTOR_PG_POOL_MAX',
  'OPENWOP_SQL_PG_DSN', 'OPENWOP_SQL_PG_POOL_MAX', 'OPENWOP_SQL_PG_ROLE_PASSWORD_KEY',
] as const;
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  pg.queries.length = 0; pg.poolOpts.length = 0; pg.failOn = null; pg.canCreate = true;
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
    expect(pg.queries[3]).toBe('SELECT 1');
    expect(pg.poolOpts[0]?.['max']).toBe(2);
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
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? 'GET').toUpperCase();
    const [, , ...rest] = u.pathname.split('/');
    if (rest.length === 0) {
      const prefix = u.searchParams.get('prefix') ?? '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><Size>${store.get(k)!.byteLength}</Size></Contents>`).join('')}</ListBucketResult>`, { status: 200 });
    }
    const key = rest.map(decodeURIComponent).join('/');
    if (method === 'PUT') { store.set(key, Buffer.from(init.body as Buffer)); return new Response(null, { status: 200 }); }
    if (method === 'DELETE') { deletes.push(key); store.delete(key); return new Response(null, { status: 204 }); }
    const body = store.get(key);
    if (!body || opts.failGet) return new Response(null, { status: 404 });
    return new Response(method === 'HEAD' ? null : body, { status: 200 });
  }) as unknown as typeof fetch;
  return { store, deletes, fetchFn };
}
const S3: S3Config = {
  bucket: 'b', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK',
  endpoint: 'http://localhost:9000', forcePathStyle: true, keyPrefix: 'p/', presignTtlSeconds: 300,
};

describe('ADR 0867 — S3 blob boot check', () => {
  it('writes, reads back, lists and deletes one object under the reserved tenant root', async () => {
    process.env.OPENWOP_SURFACE_BLOB = 's3';
    const s3 = fakeS3();
    await verifyS3BlobBackend({ fetch: s3.fetchFn, config: S3 });
    expect(s3.deletes).toHaveLength(1);
    expect(s3.deletes[0]).toMatch(new RegExp(`^p/tenants/${BLOB_BOOT_CHECK_TENANT}/boot-check-`));
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
