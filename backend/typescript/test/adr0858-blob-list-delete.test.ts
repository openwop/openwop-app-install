/**
 * ADR 0858 P3 blob — `blobStorage.list` and `delete` (storage.md §Operations),
 * the two operations whose absence kept the family withheld at v2.
 *
 * Both backends: memory (the default, and what production selects) and s3
 * (ListObjectsV2 + DELETE against a fake bucket). Pins, per backend: list by
 * prefix with sizes, cursor pagination that neither repeats nor skips, tenant
 * isolation of list (another tenant's identical key never appears), and delete
 * removing the object. Plus the replay guard: `delete` is a write, so a replay
 * reaching it fails closed exactly as `put` does.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHostSurfaceBundle, initInMemorySurfaces, type BlobSurface } from '../src/host/inMemorySurfaces.js';
import { createS3Blob, parseListObjectsV2, type S3Config } from '../src/host/blob/s3Blob.js';
import { runWithEffectContext, ReplayEffectError } from '../src/host/runEffectContext.js';

beforeAll(() => { initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'blob-ld-')) }); });

describe('S3 list response completeness', () => {
  it('refuses a truncated page without a usable next token', () => {
    for (const token of ['', '<NextContinuationToken></NextContinuationToken>', '<NextContinuationToken> </NextContinuationToken>']) {
      expect(() => parseListObjectsV2(`<ListBucketResult><IsTruncated>true</IsTruncated>${token}</ListBucketResult>`)).toThrow(/continuation token/);
    }
    expect(parseListObjectsV2('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken></ListBucketResult>')).toEqual({ objects: [], nextToken: 'a&b' });
  });

  it('refuses error documents and invalid object sizes instead of reporting an empty complete page', () => {
    expect(() => parseListObjectsV2('<Error><Code>InternalError</Code></Error>')).toThrow(/invalid ListObjectsV2/);
    for (const size of ['', '<Size>nope</Size>', '<Size>9007199254740992</Size>']) {
      expect(() => parseListObjectsV2(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>one</Key>${size}</Contents></ListBucketResult>`)).toThrow(/invalid object metadata/);
    }
    expect(parseListObjectsV2('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({ objects: [] });
  });
});

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A path-style fake S3: object PUT/GET/HEAD/DELETE plus ListObjectsV2 on the bucket. */
function makeFakeS3() {
  const store = new Map<string, Buffer>(); // object key (decoded, under the bucket) → body
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? 'GET').toUpperCase();
    const [, bucket, ...rest] = u.pathname.split('/');
    expect(bucket).toBe('test-bucket');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    if (rest.length === 0) {
      expect(u.searchParams.get('list-type')).toBe('2');
      const prefix = u.searchParams.get('prefix') ?? '';
      const max = Number(u.searchParams.get('max-keys') ?? 1000);
      const after = u.searchParams.get('continuation-token');
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix) && (after === null || k > after)).sort();
      const page = keys.slice(0, max);
      const truncated = keys.length > page.length;
      const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
        page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key><Size>${store.get(k)!.byteLength}</Size></Contents>`).join('') +
        (truncated ? `<NextContinuationToken>${xmlEscape(page.at(-1)!)}</NextContinuationToken>` : '') +
        '</ListBucketResult>';
      return new Response(body, { status: 200 });
    }
    const key = rest.map(decodeURIComponent).join('/');
    if (method === 'PUT') { store.set(key, Buffer.from(init.body as Buffer)); return new Response(null, { status: 200 }); }
    if (method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }); }
    const body = store.get(key);
    if (!body) return new Response(null, { status: 404 });
    return new Response(method === 'HEAD' ? null : body, { status: 200 });
  }) as unknown as typeof fetch;
  return { store, fetchFn };
}

const CONFIG: S3Config = {
  bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'secret',
  endpoint: 'http://localhost:9000', forcePathStyle: true, keyPrefix: 'p/', presignTtlSeconds: 300,
};

const s3 = makeFakeS3();
const BACKENDS: Array<[string, (tenantId: string) => BlobSurface]> = [
  ['memory', (tenantId) => buildHostSurfaceBundle({ tenantId }).storage.blob],
  ['s3', (tenantId) => createS3Blob({ tenantId }, { fetch: s3.fetchFn, config: CONFIG })],
];

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
type ListOut = { entries: Array<{ key: string; sizeBytes: number }>; nextCursor?: string };

for (const [name, blobFor] of BACKENDS) {
  describe(`blob list + delete — ${name}`, () => {
    const ns = `${name}-${Math.random().toString(36).slice(2)}`;

    it('list returns only keys under the prefix, with their sizes', async () => {
      const blob = blobFor(`${ns}-a`);
      await blob.put({ key: 'dir/one', contentBase64: b64('1') });
      await blob.put({ key: 'dir/three', contentBase64: b64('333') });
      await blob.put({ key: 'other', contentBase64: b64('x') });
      const out = (await blob.list({ prefix: 'dir/' })) as ListOut;
      expect(out.entries).toEqual([{ key: 'dir/one', sizeBytes: 1 }, { key: 'dir/three', sizeBytes: 3 }]);
      expect(out.nextCursor).toBeUndefined();
    });

    it('pages with an opaque cursor: every key once, none skipped, none repeated', async () => {
      const blob = blobFor(`${ns}-p`);
      const keys = ['k/a', 'k/b', 'k/c', 'k/d', 'k/e'];
      for (const k of keys) await blob.put({ key: k, contentBase64: b64(k) });
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const out = (await blob.list({ prefix: 'k/', limit: 2, ...(cursor ? { cursor } : {}) })) as ListOut;
        expect(out.entries.length).toBeLessThanOrEqual(2);
        seen.push(...out.entries.map((e) => e.key));
        cursor = out.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(seen).toEqual(keys);
      expect(pages).toBe(3);
    });

    it("another tenant's identical key never appears in list or get", async () => {
      await blobFor(`${ns}-x`).put({ key: 'same', contentBase64: b64('secret') });
      const other = blobFor(`${ns}-y`);
      expect(((await other.list({ prefix: 'same' })) as ListOut).entries).toEqual([]);
      expect(((await other.list({})) as ListOut).entries).toEqual([]);
      expect(await other.get({ key: 'same' })).toMatchObject({ found: false });
      // positive control: the writer sees it
      expect(((await blobFor(`${ns}-x`).list({ prefix: 'same' })) as ListOut).entries.map((e) => e.key)).toEqual(['same']);
    });

    it('delete removes the object from get and list, and only that object', async () => {
      const blob = blobFor(`${ns}-d`);
      await blob.put({ key: 'gone', contentBase64: b64('g') });
      await blob.put({ key: 'kept', contentBase64: b64('k') });
      expect(await blob.delete({ key: 'gone' })).toMatchObject({ deleted: true });
      expect(await blob.get({ key: 'gone' })).toMatchObject({ found: false });
      expect(((await blob.list({})) as ListOut).entries.map((e) => e.key)).toEqual(['kept']);
    });

    it("a tenant's delete cannot remove another tenant's object under the same key", async () => {
      await blobFor(`${ns}-v`).put({ key: 'k', contentBase64: b64('victim') });
      await blobFor(`${ns}-w`).delete({ key: 'k' });
      expect(await blobFor(`${ns}-v`).get({ key: 'k' })).toMatchObject({ found: true });
    });
  });
}

describe('blob list — s3 response parsing', () => {
  it('decodes XML entities in keys and the continuation token', () => {
    const out = parseListObjectsV2(
      '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a&amp;b&lt;c&#x2F;d</Key><Size>7</Size></Contents>' +
      '<NextContinuationToken>t&amp;1</NextContinuationToken></ListBucketResult>',
    );
    expect(out).toEqual({ objects: [{ key: 'a&b<c/d', size: 7 }], nextToken: 't&1' });
  });

  it('a non-truncated page carries no token even when the body has one', () => {
    expect(parseListObjectsV2('<ListBucketResult><IsTruncated>false</IsTruncated><NextContinuationToken>x</NextContinuationToken></ListBucketResult>').nextToken).toBeUndefined();
  });
});

describe('blob delete is a guarded write (ADR 0563 seam)', () => {
  it('a replay reaching delete fails closed; the object survives', async () => {
    const blob = buildHostSurfaceBundle({ tenantId: 'replay-t' }).storage.blob;
    await blob.put({ key: 'r', contentBase64: b64('r') });
    await expect(
      runWithEffectContext({ runId: 'run-replay', replaying: true }, () => blob.delete({ key: 'r' })),
    ).rejects.toBeInstanceOf(ReplayEffectError);
    expect(await blob.get({ key: 'r' })).toMatchObject({ found: true });
  });

  it('list is a read and runs during replay', async () => {
    const blob = buildHostSurfaceBundle({ tenantId: 'replay-list-t' }).storage.blob;
    await blob.put({ key: 'l', contentBase64: b64('l') });
    await expect(
      runWithEffectContext({ runId: 'run-replay', replaying: true }, () => blob.list({ prefix: 'l' })),
    ).resolves.toMatchObject({ entries: [{ key: 'l', sizeBytes: 1 }] });
  });
});
