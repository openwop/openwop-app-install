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

import type { BundleScope, BlobSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter, resolveBackendId } from '../surfaceBackends.js';
import { presignS3Url } from './s3SigV4.js';

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
  const objKey = (key: unknown) => `${cfg.keyPrefix}tenants/${encodeURIComponent(scope.tenantId)}/${String(key)}`;
  const sign = (method: 'GET' | 'PUT' | 'HEAD', key: unknown, expiresIn: number) =>
    presignS3Url({
      method, key: objKey(key), bucket: cfg.bucket, region: cfg.region,
      accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
      endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle, sessionToken: cfg.sessionToken,
      expiresIn, now: clock(),
    });

  return {
    async put({ key, contentBase64, contentType }) {
      const url = sign('PUT', key, 60);
      const res = await fetchFn(url, {
        method: 'PUT',
        body: Buffer.from(String(contentBase64), 'base64'),
        headers: contentType ? { 'content-type': String(contentType) } : {},
      });
      if (!res.ok) throw new Error(`s3 blob put failed: HTTP ${res.status}`);
      return { ok: true, key };
    },

    async get({ key }) {
      const res = await fetchFn(sign('GET', key, 60));
      if (res.status === 404 || res.status === 403) return { found: false };
      if (!res.ok) throw new Error(`s3 blob get failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        found: true,
        contentBase64: buf.toString('base64'),
        contentType: res.headers.get('content-type') ?? undefined,
      };
    },

    async presign({ key, expiresInSeconds }) {
      // Existence check so an absent object surfaces { found: false } (parity
      // with the in-memory surface) rather than a URL that 404s on use.
      const head = await fetchFn(sign('HEAD', key, 60), { method: 'HEAD' });
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
