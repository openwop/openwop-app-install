import { afterEach, describe, expect, it } from 'vitest';
import type { BlobSurface } from '../src/host/inMemorySurfaces.js';
import { createS3Blob, registerS3BlobAdapter, type S3Config } from '../src/host/blob/s3Blob.js';
import { _resetSurfaceAdaptersForTesting } from '../src/host/surfaceBackends.js';

// A fake S3 over a Map, addressed by the presigned URL's path (path-style).
function makeFakeS3() {
  const store = new Map<string, { body: Buffer; contentType?: string }>();
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname; // /bucket/tenants/<t>/<key>
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      const headers = (init.headers ?? {}) as Record<string, string>;
      store.set(path, { body: Buffer.from(init.body as Buffer), contentType: headers['content-type'] });
      return new Response(null, { status: 200 });
    }
    const entry = store.get(path);
    if (method === 'HEAD') return new Response(null, { status: entry ? 200 : 404 });
    if (method === 'GET') {
      if (!entry) return new Response(null, { status: 404 });
      return new Response(entry.body, { status: 200, headers: entry.contentType ? { 'content-type': entry.contentType } : {} });
    }
    return new Response(null, { status: 400 });
  }) as unknown as typeof fetch;
  return { store, fetchFn };
}

const CONFIG: S3Config = {
  bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'secret',
  endpoint: 'http://localhost:9000', forcePathStyle: true, keyPrefix: '', presignTtlSeconds: 300,
};

const blobFor = (tenantId: string, fetchFn: typeof fetch): BlobSurface =>
  createS3Blob({ tenantId }, { fetch: fetchFn, config: CONFIG, now: () => new Date('2024-01-01T00:00:00Z') });

describe('S3 blob surface', () => {
  it('put then get round-trips bytes + content-type', async () => {
    const { fetchFn } = makeFakeS3();
    const blob = blobFor('t1', fetchFn);
    const b64 = Buffer.from('hello world').toString('base64');
    expect(await blob.put({ key: 'f.txt', contentBase64: b64, contentType: 'text/plain' })).toEqual({ ok: true, key: 'f.txt' });
    const got = await blob.get({ key: 'f.txt' }) as { found: boolean; contentBase64: string; contentType?: string };
    expect(got.found).toBe(true);
    expect(Buffer.from(got.contentBase64, 'base64').toString()).toBe('hello world');
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
    const pre = await blob.presign({ key: 'real', expiresInSeconds: 120 }) as { url: string; expiresAtMs: number; expiresInSeconds: number };
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
    const a = await blobFor('tenant-a', fetchFn).get({ key: 'shared' }) as { found: boolean; contentBase64: string };
    expect(Buffer.from(a.contentBase64, 'base64').toString()).toBe('A');
  });

  it('throws a clear error if constructed without config', () => {
    expect(() => createS3Blob({ tenantId: 't' }, { config: null as unknown as S3Config }))
      .toThrow(/not configured/);
  });
});

describe('registerS3BlobAdapter boot guard', () => {
  afterEach(() => {
    _resetSurfaceAdaptersForTesting();
    delete process.env.OPENWOP_SURFACE_BLOB;
    delete process.env.OPENWOP_BLOB_S3_BUCKET;
    delete process.env.OPENWOP_BLOB_S3_ACCESS_KEY_ID;
    delete process.env.OPENWOP_BLOB_S3_SECRET_ACCESS_KEY;
  });

  it('registers without throwing when blob is not selected as s3', () => {
    expect(() => registerS3BlobAdapter()).not.toThrow();
  });

  it('fails fast when blob=s3 but config is missing', () => {
    process.env.OPENWOP_SURFACE_BLOB = 's3';
    expect(() => registerS3BlobAdapter()).toThrow(/missing required config/);
  });

  it('registers cleanly when blob=s3 and config is present', () => {
    process.env.OPENWOP_SURFACE_BLOB = 's3';
    process.env.OPENWOP_BLOB_S3_BUCKET = 'b';
    process.env.OPENWOP_BLOB_S3_ACCESS_KEY_ID = 'akid';
    process.env.OPENWOP_BLOB_S3_SECRET_ACCESS_KEY = 'secret';
    expect(() => registerS3BlobAdapter()).not.toThrow();
  });
});
