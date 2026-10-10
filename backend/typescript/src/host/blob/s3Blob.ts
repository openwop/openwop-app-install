/**
 * S3-compatible blob host surface (Phase 2) — `host.blobStorage` over any
 * S3 API object store (AWS S3, GCS S3-interop, Cloudflare R2, Backblaze B2,
 * MinIO), selected with `OPENWOP_SURFACE_BLOB=s3`.
 *
 * This is the "blob done properly" the architecture review called for: unlike a
 * kv-backed blob, `presign()` returns a REAL presigned URL that the client uses
 * directly against the bucket (no host bandwidth, no synthetic token route), and
 * objects live in durable, horizontally-shared storage.
 *
 * Cloud-agnostic + dependency-free: requests are SigV4-presigned with node:crypto
 * (see s3SigV4.ts) and issued with global `fetch` — no @aws-sdk dependency. Point
 * it at any S3-compatible endpoint via env.
 *
 * Config (env):
 *   OPENWOP_BLOB_S3_BUCKET            (required)
 *   OPENWOP_BLOB_S3_ACCESS_KEY_ID     (required)
 *   OPENWOP_BLOB_S3_SECRET_ACCESS_KEY (required)
 *   OPENWOP_BLOB_S3_REGION            (default us-east-1)
 *   OPENWOP_BLOB_S3_ENDPOINT          (optional; for non-AWS / custom)
 *   OPENWOP_BLOB_S3_FORCE_PATH_STYLE  (true for MinIO/local)
 *   OPENWOP_BLOB_S3_SESSION_TOKEN     (optional; temporary creds)
 *   OPENWOP_BLOB_S3_PREFIX            (optional key prefix, e.g. "openwop/")
 *   OPENWOP_BLOB_S3_PRESIGN_TTL_SECONDS (default 300)
 */

import { blobListLimit, type BundleScope, type BlobSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter, resolveBackendId } from '../surfaceBackends.js';
import { presignS3Url } from './s3SigV4.js';
import { BLOB_BOOT_CHECK_TENANT, blobBootRoundTrip } from './blobBootCheck.js';

export const S3_BACKEND_ID = 's3';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle: boolean;
  sessionToken?: string;
  keyPrefix: string;
  presignTtlSeconds: number;
}

export interface S3BlobDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  config?: S3Config;
}

/** Read config from env. Returns null + the missing-var list when incomplete. */
export function loadS3ConfigFromEnv(): { config: S3Config | null; missing: string[] } {
  const env = process.env;
  const required: Array<[string, string | undefined]> = [
    ['OPENWOP_BLOB_S3_BUCKET', env.OPENWOP_BLOB_S3_BUCKET],
    ['OPENWOP_BLOB_S3_ACCESS_KEY_ID', env.OPENWOP_BLOB_S3_ACCESS_KEY_ID],
    ['OPENWOP_BLOB_S3_SECRET_ACCESS_KEY', env.OPENWOP_BLOB_S3_SECRET_ACCESS_KEY],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) return { config: null, missing };
  return {
    config: {
      bucket: env.OPENWOP_BLOB_S3_BUCKET!,
      region: env.OPENWOP_BLOB_S3_REGION || 'us-east-1',
      accessKeyId: env.OPENWOP_BLOB_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.OPENWOP_BLOB_S3_SECRET_ACCESS_KEY!,
      endpoint: env.OPENWOP_BLOB_S3_ENDPOINT || undefined,
      forcePathStyle: env.OPENWOP_BLOB_S3_FORCE_PATH_STYLE === 'true',
      sessionToken: env.OPENWOP_BLOB_S3_SESSION_TOKEN || undefined,
      keyPrefix: env.OPENWOP_BLOB_S3_PREFIX || '',
      presignTtlSeconds: Number(env.OPENWOP_BLOB_S3_PRESIGN_TTL_SECONDS) || 300,
    },
    missing: [],
  };
}

/** Hard cap on how many bytes `get()` will buffer into memory. An unbounded
 *  read of an attacker-or-bug-sized object is an OOM vector (DATA-5).
 *  Read per-call (cheap) so it stays operationally tunable + testable.
 *  Overridable via OPENWOP_BLOB_S3_MAX_GET_BYTES (default 64 MiB). */
function maxGetBytes(): number {
  const n = Number(process.env.OPENWOP_BLOB_S3_MAX_GET_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024 * 1024;
}

/** Discard a response body we won't read, so the underlying connection can be
 *  reused instead of leaking (un-drained fetch bodies pin a socket). */
async function drainBody(res: { body?: { cancel?: () => Promise<void> } | null }): Promise<void> {
  try {
    await res.body?.cancel?.();
  } catch {
    /* already consumed / no body */
  }
}

/** XML text → string (the five predefined entities plus numeric refs). */
function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l.startsWith('#x')) return String.fromCodePoint(parseInt(l.slice(2), 16));
    if (l.startsWith('#')) return String.fromCodePoint(parseInt(l.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[l]!;
  });
}

/** The fields `list` needs from a ListObjectsV2 response body. */
export function parseListObjectsV2(xml: string): { objects: Array<{ key: string; size: number }>; nextToken?: string } {
  if (!/<ListBucketResult\b[^>]*>[\s\S]*<\/ListBucketResult>/.test(xml)) {
    throw new Error('s3 blob list refused: invalid ListObjectsV2 response');
  }
  const objects: Array<{ key: string; size: number }> = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]!)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1];
    if (key === undefined || size === undefined || !Number.isSafeInteger(Number(size))) {
      throw new Error('s3 blob list refused: invalid object metadata');
    }
    objects.push({ key: xmlText(key), size: Number(size) });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  if (truncated && (token === undefined || xmlText(token).trim() === '')) {
    throw new Error('s3 blob list refused: truncated page has no continuation token');
  }
  return { objects, ...(truncated && token ? { nextToken: xmlText(token) } : {}) };
}

export function createS3Blob(scope: BundleScope, deps: S3BlobDeps = {}): BlobSurface {
  const fetchFn = deps.fetch ?? fetch;
  const clock = deps.now ?? (() => new Date());
  const cfg = deps.config ?? loadS3ConfigFromEnv().config;
  if (!cfg) {
    throw new Error(
      'host.blob backend "s3" selected but not configured — set OPENWOP_BLOB_S3_BUCKET, ' +
        'OPENWOP_BLOB_S3_ACCESS_KEY_ID, OPENWOP_BLOB_S3_SECRET_ACCESS_KEY (+ optional REGION/ENDPOINT).',
    );
  }

  // Tenant isolation: every object lives under a per-tenant key prefix.
  const tenantRoot = `${cfg.keyPrefix}tenants/${encodeURIComponent(scope.tenantId)}/`;
  const objKey = (key: unknown) => `${tenantRoot}${String(key)}`;
  const sign = (method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: unknown, expiresIn: number) =>
    presignS3Url({
      method, key: objKey(key), bucket: cfg.bucket, region: cfg.region,
      accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
      endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle, sessionToken: cfg.sessionToken,
      expiresIn, now: clock(),
    });

  return {
    async put({ key, contentBase64, contentType }) {
      const url = sign('PUT', key, 60);
      const body = Buffer.from(String(contentBase64), 'base64');
      const res = await fetchFn(url, {
        method: 'PUT',
        body,
        headers: contentType ? { 'content-type': String(contentType) } : {},
      });
      if (!res.ok) { await drainBody(res); throw new Error(`s3 blob put failed: HTTP ${res.status}`); }
      await drainBody(res);
      return { ok: true, key, sizeBytes: body.byteLength };
    },

    async get({ key }) {
      const res = await fetchFn(sign('GET', key, 60));
      if (res.status === 404 || res.status === 403) { await drainBody(res); return { found: false }; }
      if (!res.ok) { await drainBody(res); throw new Error(`s3 blob get failed: HTTP ${res.status}`); }
      // Reject oversized objects via the declared Content-Length BEFORE
      // buffering, so we never load a multi-GB body into memory (DATA-5).
      const cap = maxGetBytes();
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > cap) {
        await drainBody(res);
        throw new Error(`s3 blob get refused: object ${declared} bytes exceeds cap ${cap}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Belt-and-suspenders for responses without a Content-Length header.
      if (buf.byteLength > cap) {
        throw new Error(`s3 blob get refused: object ${buf.byteLength} bytes exceeds cap ${cap}`);
      }
      return {
        found: true,
        contentBase64: buf.toString('base64'),
        contentType: res.headers.get('content-type') ?? undefined,
      };
    },

    // S3 DELETE is idempotent (204 whether or not the object existed), so
    // `deleted: true` means "absent now", not "was present".
    async delete({ key }) {
      const res = await fetchFn(sign('DELETE', key, 60), { method: 'DELETE' });
      await drainBody(res);
      if (!res.ok && res.status !== 404) throw new Error(`s3 blob delete failed: HTTP ${res.status}`);
      return { ok: true, deleted: true };
    },

    // ListObjectsV2 under the tenant's root ONLY: the prefix is the tenant root
    // plus the caller's prefix, so a caller can never widen it to another
    // tenant, and the root is stripped from every returned key.
    async list({ prefix, cursor, limit }) {
      const query: Record<string, string> = {
        'list-type': '2',
        prefix: `${tenantRoot}${typeof prefix === 'string' ? prefix : ''}`,
        'max-keys': String(blobListLimit(limit)),
        ...(typeof cursor === 'string' && cursor ? { 'continuation-token': cursor } : {}),
      };
      const url = presignS3Url({
        method: 'GET', key: '', query, bucket: cfg.bucket, region: cfg.region,
        accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
        endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle, sessionToken: cfg.sessionToken,
        expiresIn: 60, now: clock(),
      });
      const res = await fetchFn(url);
      if (!res.ok) { await drainBody(res); throw new Error(`s3 blob list failed: HTTP ${res.status}`); }
      const { objects, nextToken } = parseListObjectsV2(await res.text());
      return {
        entries: objects
          .filter((o) => o.key.startsWith(tenantRoot))
          .map((o) => ({ key: o.key.slice(tenantRoot.length), sizeBytes: o.size })),
        ...(nextToken ? { nextCursor: nextToken } : {}),
      };
    },

    async presign({ key, expiresInSeconds }) {
      // Existence check so an absent object surfaces { found: false } (parity
      // with the in-memory surface) rather than a URL that 404s on use.
      const head = await fetchFn(sign('HEAD', key, 60), { method: 'HEAD' });
      await drainBody(head);
      if (head.status === 404 || head.status === 403) return { found: false };
      const ttl = Number(expiresInSeconds) > 0 ? Number(expiresInSeconds) : cfg.presignTtlSeconds;
      const url = sign('GET', key, ttl);
      return { url, expiresAtMs: clock().getTime() + ttl * 1000, expiresInSeconds: ttl };
    },
  };
}

/**
 * Register the S3 blob adapter behind the seam, and — if `blob` is actually
 * selected as `s3` — fail fast at boot when its config is incomplete (rather
 * than on the first blob op). Call once at boot, before initInMemorySurfaces().
 */
/**
 * ADR 0867 — prove the selected S3 backend works before taking traffic (see
 * `blobBootCheck.ts`). No-op unless `blob=s3` is selected.
 */
export async function verifyS3BlobBackend(deps: S3BlobDeps = {}): Promise<void> {
  if (resolveBackendId('blob') !== S3_BACKEND_ID) return;
  await blobBootRoundTrip(createS3Blob({ tenantId: BLOB_BOOT_CHECK_TENANT }, deps), deps.fetch ?? fetch);
}

export function registerS3BlobAdapter(): void {
  registerSurfaceAdapter('blob', S3_BACKEND_ID, (scope: BundleScope) => createS3Blob(scope));
  if (resolveBackendId('blob') === S3_BACKEND_ID) {
    const { config, missing } = loadS3ConfigFromEnv();
    if (!config) {
      throw new Error(
        `OPENWOP_SURFACE_BLOB=s3 but missing required config: ${missing.join(', ')}. ` +
          'Set them, or unset OPENWOP_SURFACE_BLOB to use the in-memory demo blob store.',
      );
    }
  }
}
