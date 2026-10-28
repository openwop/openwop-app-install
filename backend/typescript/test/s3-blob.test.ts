/**
 * ADR 0867 / S3 blob backend (Phase 2) — `host/blob/s3Blob.ts` over a fake S3
 * addressed by the presigned URL's path (path-style).
 *
 * Pins: put/get round-trip with content-type; a missing object reads
 * `found:false`; presign signs only an existing object and honours the
 * requested TTL; every object lives under the tenant root `tenants/<id>/`, so
 * another tenant's read is `found:false` (owner positive control); the DATA-5
 * get cap; and the boot guard that refuses `OPENWOP_SURFACE_BLOB=s3` without
 * its config.
 *
 * DATA-5 is a DOUBLE guard and each half has its own leg: the declared
 * `Content-Length` refuses BEFORE buffering (driven by a response whose header
 * declares more than the body holds, so only the declared check can refuse it),
 * and the post-buffer `byteLength` check catches a response with NO
 * Content-Length (the fake's default). Round 1's `8fw2g3-s3b-cap-declared` was
 * vacuous because no fake response carried the header.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): the tenant segment dropped
 * from the root (`8fw2g3-s3b-tenantroot`), 404 not mapped to found:false
 * (`-s3b-get404`, `-s3b-presign-head`), the requested TTL ignored
 * (`-s3b-presign-ttl`), the declared-length check removed
 * (`-s3b-cap-declared-r2`), the buffer check removed (`-s3b-cap-buffer`), the
 * content-type dropped (`-s3b-content-type`), the boot guard removed
 * (`-s3b-boot-guard`), and the adapter left unregistered (`-s3b-register-r2`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BlobSurface } from '../src/host/inMemorySurfaces.js';
import { createS3Blob, registerS3BlobAdapter, type S3Config } from '../src/host/blob/s3Blob.js';
import { _resetSurfaceAdaptersForTesting, hasAdapter } from '../src/host/surfaceBackends.js';

interface FakeS3Options {
  /** Answer GET with a `content-length` header that declares this many bytes
   *  (more than the stored body), so only the pre-buffer check can refuse it. */
  declareLength?: number;
}

// A fake S3 over a Map, addressed by the presigned URL's path (path-style).
function makeFakeS3(opts: FakeS3Options = {}) {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>();
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url).pathname; // /bucket/tenants/<t>/<key>
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      const body = new Uint8Array(await new Response(init.body ?? null).arrayBuffer());
      store.set(path, { body, contentType: new Headers(init.headers).get('content-type') ?? undefined });
      return new Response(null, { status: 200 });
    }
    const entry = store.get(path);
    if (method === 'HEAD') return new Response(null, { status: entry ? 200 : 404 });
    if (method === 'GET') {
      if (!entry) return new Response(null, { status: 404 });
      const headers = new Headers(entry.contentType ? { 'content-type': entry.contentType } : {});
      if (opts.declareLength !== undefined) headers.set('content-length', String(opts.declareLength));
      return new Response(entry.body, { status: 200, headers });
    }
    return new Response(null, { status: 400 });
  };
  return { store, fetchFn };
}

/** The S3 blob `get` result when the object exists (`s3Blob.ts` get). */
interface FoundBlob { found: true; contentBase64: string; contentType?: string }
function asFound(x: Record<string, unknown>): FoundBlob {
  if (x.found !== true || typeof x.contentBase64 !== 'string') throw new Error(`expected a found blob, got ${JSON.stringify(x)}`);
  return { found: true, contentBase64: x.contentBase64, ...(typeof x.contentType === 'string' ? { contentType: x.contentType } : {}) };
}
const text = (b: FoundBlob): string => Buffer.from(b.contentBase64, 'base64').toString();

const CONFIG: S3Config = {
  bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'secret',
  endpoint: 'http://localhost:9000', forcePathStyle: true, keyPrefix: '', presignTtlSeconds: 300,
};

const blobFor = (tenantId: string, fetchFn: typeof fetch): BlobSurface =>
  createS3Blob({ tenantId }, { fetch: fetchFn, config: CONFIG, now: () => new Date('2024-01-01T00:00:00Z') });

const S3_ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_BLOB_S3_BUCKET', 'OPENWOP_BLOB_S3_ACCESS_KEY_ID', 'OPENWOP_BLOB_S3_SECRET_ACCESS_KEY'] as const;

describe('S3 blob surface', () => {
  it('put then get round-trips bytes + content-type', async () => {
    const { fetchFn } = makeFakeS3();
    const blob = blobFor('t1', fetchFn);
    const b64 = Buffer.from('hello world').toString('base64');
    expect(await blob.put({ key: 'f.txt', contentBase64: b64, contentType: 'text/plain' })).toEqual({ ok: true, key: 'f.txt', sizeBytes: 11 });
    const got = asFound(await blob.get({ key: 'f.txt' }));
    expect(text(got)).toBe('hello world');
    expect(got.contentType).toBe('text/plain');
  });

  it('get of a missing object reports found:false', async () => {
    const { fetchFn } = makeFakeS3();
    expect(await blobFor('t1', fetchFn).get({ key: 'nope' })).toEqual({ found: false });
  });

  it('presign returns a signed URL for an existing object; found:false when absent', async () => {
    const { fetchFn } = makeFakeS3();
    const blob = blobFor('t1', fetchFn);
    expect(await blob.presign({ key: 'ghost' })).toEqual({ found: false });
    await blob.put({ key: 'real', contentBase64: Buffer.from('x').toString('base64') });
    const pre = await blob.presign({ key: 'real', expiresInSeconds: 120 });
    expect(pre.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    expect(pre.url).toContain('/test-bucket/tenants/t1/real');
    expect(pre.expiresInSeconds).toBe(120);
    expect(pre.expiresAtMs).toBe(new Date('2024-01-01T00:00:00Z').getTime() + 120_000);
  });

  it('isolates tenants by key prefix', async () => {
    const { fetchFn } = makeFakeS3();
    await blobFor('tenant-a', fetchFn).put({ key: 'shared', contentBase64: Buffer.from('A').toString('base64') });
    // tenant-b cannot read tenant-a's object
    expect(await blobFor('tenant-b', fetchFn).get({ key: 'shared' })).toEqual({ found: false });
    expect(text(asFound(await blobFor('tenant-a', fetchFn).get({ key: 'shared' })))).toBe('A');
  });

  it('throws a clear error if constructed without config', () => {
    const saved = S3_ENV.map((k) => [k, process.env[k]] as const);
    for (const k of S3_ENV) delete process.env[k];
    try {
      // No `deps.config` and no env: the env loader returns null.
      expect(() => createS3Blob({ tenantId: 't' }, {})).toThrow(/not configured — set OPENWOP_BLOB_S3_BUCKET/);
    } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('refuses to buffer an object larger than the get cap (DATA-5)', async () => {
    process.env.OPENWOP_BLOB_S3_MAX_GET_BYTES = '16';
    try {
      // (1) Declared length: the header says 32 bytes while the body holds 2.
      // Only the pre-buffer Content-Length check can refuse this one.
      const declared = makeFakeS3({ declareLength: 32 });
      const lying = blobFor('t1', declared.fetchFn);
      await lying.put({ key: 'declared', contentBase64: Buffer.from('hi').toString('base64') });
      await expect(lying.get({ key: 'declared' })).rejects.toThrow('s3 blob get refused: object 32 bytes exceeds cap 16');

      // (2) No Content-Length: 32 real bytes > 16-byte cap → the post-buffer check refuses.
      const { fetchFn } = makeFakeS3();
      const blob = blobFor('t1', fetchFn);
      await blob.put({ key: 'big', contentBase64: Buffer.from('x'.repeat(32)).toString('base64') });
      await expect(blob.get({ key: 'big' })).rejects.toThrow('s3 blob get refused: object 32 bytes exceeds cap 16');
      // A small object under the cap still round-trips.
      await blob.put({ key: 'small', contentBase64: Buffer.from('hi').toString('base64') });
      expect(text(asFound(await blob.get({ key: 'small' })))).toBe('hi');
    } finally {
      delete process.env.OPENWOP_BLOB_S3_MAX_GET_BYTES;
    }
  });
});

describe('registerS3BlobAdapter boot guard', () => {
  afterEach(() => {
    _resetSurfaceAdaptersForTesting();
    for (const k of S3_ENV) delete process.env[k];
  });

  it('registers without throwing when blob is not selected as s3', () => {
    expect(() => registerS3BlobAdapter()).not.toThrow();
    expect(hasAdapter('blob', 's3')).toBe(true);
  });

  it('fails fast when blob=s3 but config is missing', () => {
    process.env.OPENWOP_SURFACE_BLOB = 's3';
    expect(() => registerS3BlobAdapter()).toThrow(/missing required config: OPENWOP_BLOB_S3_BUCKET, OPENWOP_BLOB_S3_ACCESS_KEY_ID, OPENWOP_BLOB_S3_SECRET_ACCESS_KEY/);
  });

  it('registers cleanly when blob=s3 and config is present', () => {
    process.env.OPENWOP_SURFACE_BLOB = 's3';
    process.env.OPENWOP_BLOB_S3_BUCKET = 'b';
    process.env.OPENWOP_BLOB_S3_ACCESS_KEY_ID = 'akid';
    process.env.OPENWOP_BLOB_S3_SECRET_ACCESS_KEY = 'secret';
    expect(() => registerS3BlobAdapter()).not.toThrow();
    expect(hasAdapter('blob', 's3')).toBe(true);
  });
});
