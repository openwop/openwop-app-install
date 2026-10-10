/**
 * ADR 0867 phase 2b — the keyless GCS blob adapter (`host/blob/gcsBlob.ts`).
 *
 * Driven against a fake of the GCS JSON API (upload / alt=media / metadata /
 * delete / list) plus the path-style XML GET that a V4 signed URL hits. Pins:
 *   - tenant isolation: every object lives under `<prefix>tenants/<tenant>/`, a
 *     list is pinned under it and strips it, and another tenant cannot get,
 *     list or delete it;
 *   - parity with s3: absent → `{found:false}`, delete idempotent, list paginates
 *     by the provider token;
 *   - presign: a GOOG4-RSA-SHA256 URL whose signature verifies over the string
 *     to sign with the signer's public key, TTL clamped to 7 days, absent →
 *     `{found:false}`;
 *   - the metadata token is fetched once and reused;
 *   - the boot round trip (put/get/list/presign-fetch/delete) passes and cleans up.
 */
import { describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createGcsBlob, gcsV4StringToSign, verifyGcsBlobBackend, type GcsConfig } from '../src/host/blob/gcsBlob.js';

const BUCKET = 'bkt';
const CFG: GcsConfig = { bucket: BUCKET, keyPrefix: 'p/', presignTtlSeconds: 300, signerEmail: 'svc@proj.iam.gserviceaccount.com' };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signBlob = async (bytes: Buffer) => sign('RSA-SHA256', bytes, privateKey);

function fakeGcs() {
  const store = new Map<string, { body: Buffer; type: string }>();
  const calls: string[] = [];
  let tokenFetches = 0;
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${u.pathname}`);
    if (u.hostname === 'metadata.google.internal') {
      tokenFetches++;
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    const authed = (init.headers as Record<string, string> | undefined)?.['authorization'] === 'Bearer tok';
    if (u.pathname === `/upload/storage/v1/b/${BUCKET}/o`) {
      expect(authed).toBe(true);
      store.set(u.searchParams.get('name')!, { body: Buffer.from(init.body as Buffer), type: String((init.headers as Record<string, string>)['content-type']) });
      return new Response('{}', { status: 200 });
    }
    if (u.pathname === `/storage/v1/b/${BUCKET}/o`) {
      expect(authed).toBe(true);
      const prefix = u.searchParams.get('prefix') ?? '';
      const max = Number(u.searchParams.get('maxResults'));
      const after = u.searchParams.get('pageToken');
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix) && (after === null || k > after)).sort();
      const page = keys.slice(0, max);
      return new Response(JSON.stringify({
        items: page.map((k) => ({ name: k, size: String(store.get(k)!.body.byteLength) })),
        ...(keys.length > page.length ? { nextPageToken: page.at(-1) } : {}),
      }), { status: 200 });
    }
    const objPrefix = `/storage/v1/b/${BUCKET}/o/`;
    if (u.pathname.startsWith(objPrefix)) {
      expect(authed).toBe(true);
      const name = decodeURIComponent(u.pathname.slice(objPrefix.length));
      const obj = store.get(name);
      if (method === 'DELETE') { store.delete(name); return new Response(null, { status: obj ? 204 : 404 }); }
      if (!obj) return new Response('{}', { status: 404 });
      if (u.searchParams.get('alt') === 'media') return new Response(obj.body, { status: 200, headers: { 'content-type': obj.type } });
      return new Response(JSON.stringify({ name, size: String(obj.body.byteLength) }), { status: 200 });
    }
    if (u.pathname.startsWith(`/${BUCKET}/`) && u.searchParams.get('X-Goog-Signature')) {
      const name = u.pathname.slice(BUCKET.length + 2).split('/').map(decodeURIComponent).join('/');
      const obj = store.get(name);
      return obj ? new Response(obj.body, { status: 200 }) : new Response(null, { status: 404 });
    }
    throw new Error(`unexpected ${method} ${u.href}`);
  }) as unknown as typeof fetch;
  return { store, calls, fetchFn, tokenFetches: () => tokenFetches };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const blobFor = (tenantId: string, gcs: ReturnType<typeof fakeGcs>, now = () => new Date('2026-10-09T12:00:00Z')) =>
  createGcsBlob({ tenantId }, { fetch: gcs.fetchFn, config: CFG, signBlob, now });

describe('ADR 0867 — GCS blob: tenant isolation and s3 parity', () => {
  it('stores under the tenant root, reads back, and is invisible to another tenant', async () => {
    const gcs = fakeGcs();
    const a = blobFor('tenant-a', gcs);
    const b = blobFor('tenant-b', gcs);
    await a.put({ key: 'dir/x.txt', contentBase64: b64('hello'), contentType: 'text/plain' });
    expect([...gcs.store.keys()]).toEqual(['p/tenants/tenant-a/dir/x.txt']);
    const got = (await a.get({ key: 'dir/x.txt' })) as { found: boolean; contentBase64: string; contentType: string };
    expect(Buffer.from(got.contentBase64, 'base64').toString()).toBe('hello');
    expect(got.contentType).toBe('text/plain');
    expect(await b.get({ key: 'dir/x.txt' })).toEqual({ found: false });
    expect(((await b.list({ prefix: '' })) as { entries: unknown[] }).entries).toEqual([]);
    await b.delete({ key: 'dir/x.txt' });
    expect(gcs.store.size).toBe(1);
  });

  it('lists only under the tenant root, strips it, and pages by the provider token', async () => {
    const gcs = fakeGcs();
    const a = blobFor('tenant-a', gcs);
    for (const k of ['k1', 'k2', 'k3']) await a.put({ key: k, contentBase64: b64(k) });
    await blobFor('tenant-b', gcs).put({ key: 'k9', contentBase64: b64('x') });
    const p1 = (await a.list({ prefix: 'k', limit: 2 })) as { entries: Array<{ key: string; sizeBytes: number }>; nextCursor?: string };
    expect(p1.entries).toEqual([{ key: 'k1', sizeBytes: 2 }, { key: 'k2', sizeBytes: 2 }]);
    const p2 = (await a.list({ prefix: 'k', limit: 2, cursor: p1.nextCursor })) as { entries: Array<{ key: string }>; nextCursor?: string };
    expect(p2.entries.map((e) => e.key)).toEqual(['k3']);
    expect(p2.nextCursor).toBeUndefined();
  });

  it('delete is idempotent: absent-now is success', async () => {
    const gcs = fakeGcs();
    await expect(blobFor('t', gcs).delete({ key: 'never' })).resolves.toEqual({ ok: true, deleted: true });
  });

  it('fetches the metadata token once and reuses it', async () => {
    const gcs = fakeGcs();
    const blob = createGcsBlob({ tenantId: 't' }, { fetch: gcs.fetchFn, config: CFG, signBlob });
    await blob.put({ key: 'a', contentBase64: b64('1') });
    await blob.get({ key: 'a' });
    await blob.list({ prefix: '' });
    expect(gcs.tokenFetches()).toBe(1);
  });
});

describe('ADR 0867 — GCS blob: V4 presign', () => {
  it('returns a GOOG4-RSA-SHA256 URL whose signature verifies over the string to sign', async () => {
    const gcs = fakeGcs();
    const now = new Date('2026-10-09T12:00:00Z');
    const blob = blobFor('tenant-a', gcs, () => now);
    await blob.put({ key: 'a b/c!.txt', contentBase64: b64('hi') });
    const out = (await blob.presign({ key: 'a b/c!.txt', expiresInSeconds: 120 })) as { url: string; expiresInSeconds: number };
    const u = new URL(out.url);
    expect(u.origin + u.pathname).toBe('https://storage.googleapis.com/bkt/p/tenants/tenant-a/a%20b/c%21.txt');
    expect(u.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(u.searchParams.get('X-Goog-Credential')).toBe('svc@proj.iam.gserviceaccount.com/20261009/auto/storage/goog4_request');
    expect(u.searchParams.get('X-Goog-Expires')).toBe('120');
    const { stringToSign } = gcsV4StringToSign({ bucket: BUCKET, objectName: 'p/tenants/tenant-a/a b/c!.txt', email: CFG.signerEmail!, now, expiresIn: 120 });
    const sig = Buffer.from(u.searchParams.get('X-Goog-Signature')!, 'hex');
    expect(verify('RSA-SHA256', Buffer.from(stringToSign), createPublicKey(privateKey), sig)).toBe(true);
    expect(out.expiresInSeconds).toBe(120);
  });

  it('clamps the TTL to 7 days and answers {found:false} for an absent object', async () => {
    const gcs = fakeGcs();
    const blob = blobFor('t', gcs);
    await blob.put({ key: 'k', contentBase64: b64('v') });
    expect(((await blob.presign({ key: 'k', expiresInSeconds: 10 ** 9 })) as { expiresInSeconds: number }).expiresInSeconds).toBe(604800);
    expect(await blob.presign({ key: 'absent' })).toEqual({ found: false });
  });
});

describe('ADR 0867 — GCS blob: boot round trip', () => {
  it('cleans up an accepted PUT whose response is lost', async () => {
    process.env.OPENWOP_SURFACE_BLOB = 'gcs';
    try {
      const gcs = fakeGcs();
      const losePutReply: typeof fetch = async (input, init = {}) => {
        const url = input instanceof Request ? input.url : input;
        const reply = await gcs.fetchFn(url, init);
        if (new URL(String(url)).pathname.startsWith('/upload/')) throw new Error('accepted upload response lost');
        return reply;
      };
      await expect(verifyGcsBlobBackend({ fetch: losePutReply, config: CFG, signBlob })).rejects.toThrow(/response lost/);
      expect(gcs.calls.some((c) => c.startsWith('DELETE '))).toBe(true);
      expect(gcs.store.size).toBe(0);
    } finally { delete process.env.OPENWOP_SURFACE_BLOB; }
  });
  it('passes against a working bucket and leaves nothing behind', async () => {
    process.env.OPENWOP_SURFACE_BLOB = 'gcs';
    try {
      const gcs = fakeGcs();
      await verifyGcsBlobBackend({ fetch: gcs.fetchFn, config: CFG, signBlob });
      expect(gcs.store.size).toBe(0);
      expect(gcs.calls.some((c) => c.startsWith('GET /bkt/p/tenants/__openwop_boot_check__/boot-check-'))).toBe(true);
    } finally {
      delete process.env.OPENWOP_SURFACE_BLOB;
    }
  });
  it('fails when signing is refused, and still deletes the object', async () => {
    process.env.OPENWOP_SURFACE_BLOB = 'gcs';
    try {
      const gcs = fakeGcs();
      const refuse = async (): Promise<Buffer> => { throw new Error('gcs blob presign: signBlob failed: HTTP 403'); };
      await expect(verifyGcsBlobBackend({ fetch: gcs.fetchFn, config: CFG, signBlob: refuse })).rejects.toThrow(/signBlob failed/);
      expect(gcs.store.size).toBe(0);
    } finally {
      delete process.env.OPENWOP_SURFACE_BLOB;
    }
  });
});
