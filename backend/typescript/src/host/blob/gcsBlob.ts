/**
 * Google Cloud Storage blob host surface — `host.blobStorage` over the GCS JSON
 * API, selected with `OPENWOP_SURFACE_BLOB=gcs` (ADR 0867 phase 2b).
 *
 * KEYLESS. It authenticates as the workload's own service account through the
 * metadata server, and signs presigned URLs with IAM Credentials `signBlob`, so
 * no key is created, stored or rotated. ADR 0867 first planned the `s3` adapter
 * against GCS's S3-compatible API; that needs an HMAC key, and the
 * `openwop-dev` org policy `constraints/iam.disableServiceAccountKeyCreation`
 * refuses one (MEASURED 2026-10-09, HTTP 412). This adapter is the answer that
 * policy is asking for.
 *
 * IAM the workload's service account needs: `roles/storage.objectAdmin` on the
 * bucket, and `roles/iam.serviceAccountTokenCreator` on ITSELF (for `signBlob`,
 * i.e. presign). Method-for-method parity with `s3Blob.ts`: the same tenant root
 * (`<prefix>tenants/<tenantId>/`), list pinned under it with the root stripped,
 * idempotent delete, the same read cap, and `presign` returning `{found:false}`
 * for an absent object.
 *
 * Config (env):
 *   OPENWOP_BLOB_GCS_BUCKET               (required)
 *   OPENWOP_BLOB_GCS_PREFIX               (optional key prefix, e.g. "openwop/")
 *   OPENWOP_BLOB_GCS_PRESIGN_TTL_SECONDS  (default 300; at most 7 days)
 *   OPENWOP_BLOB_GCS_SIGNER_EMAIL         (optional; default: the metadata server's account)
 *   OPENWOP_BLOB_S3_MAX_GET_BYTES         (shared read cap, default 64 MiB)
 */
import { createHash } from 'node:crypto';
import { blobListLimit, type BundleScope, type BlobSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter, resolveBackendId } from '../surfaceBackends.js';
import { BLOB_BOOT_CHECK_TENANT, blobBootRoundTrip } from './blobBootCheck.js';

export const GCS_BACKEND_ID = 'gcs';
const API = 'https://storage.googleapis.com';
const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;

export interface GcsConfig {
  bucket: string;
  keyPrefix: string;
  presignTtlSeconds: number;
  signerEmail?: string;
}

export interface GcsBlobDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  config?: GcsConfig;
  /** OAuth access token for the Storage + IAM Credentials APIs. */
  token?: () => Promise<string>;
  /** RSA-SHA256 signature of `bytes` by the signer account (IAM `signBlob`). */
  signBlob?: (bytes: Buffer, email: string) => Promise<Buffer>;
  /** The signer account's email. */
  signerEmail?: () => Promise<string>;
}

export function loadGcsConfigFromEnv(): { config: GcsConfig | null; missing: string[] } {
  const env = process.env;
  if (!env.OPENWOP_BLOB_GCS_BUCKET) return { config: null, missing: ['OPENWOP_BLOB_GCS_BUCKET'] };
  const ttl = Number(env.OPENWOP_BLOB_GCS_PRESIGN_TTL_SECONDS);
  return {
    config: {
      bucket: env.OPENWOP_BLOB_GCS_BUCKET,
      keyPrefix: env.OPENWOP_BLOB_GCS_PREFIX || '',
      presignTtlSeconds: Number.isInteger(ttl) && ttl > 0 ? Math.min(ttl, MAX_PRESIGN_SECONDS) : 300,
      signerEmail: env.OPENWOP_BLOB_GCS_SIGNER_EMAIL || undefined,
    },
    missing: [],
  };
}

function maxGetBytes(): number {
  const n = Number(process.env.OPENWOP_BLOB_S3_MAX_GET_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024 * 1024;
}

async function drainBody(res: { body?: { cancel?: () => Promise<void> } | null }): Promise<void> {
  try { await res.body?.cancel?.(); } catch { /* already consumed / no body */ }
}

/** RFC 3986 percent-encoding (encodeURIComponent leaves !'()* unescaped). */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Metadata-server access token, cached until a minute before it expires. */
function metadataTokenProvider(fetchFn: typeof fetch, now: () => Date): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > now().getTime()) return cached.token;
    const res = await fetchFn(`${METADATA}/token`, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) { await drainBody(res); throw new Error(`gcs blob: metadata token failed: HTTP ${res.status}`); }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('gcs blob: metadata token response had no access_token');
    cached = { token: body.access_token, expiresAt: now().getTime() + Math.max(0, (body.expires_in ?? 0) - 60) * 1000 };
    return cached.token;
  };
}

/** The V4 signed-URL pieces for one GET of `objectName` (GOOG4-RSA-SHA256). Pure; exported for tests. */
export function gcsV4StringToSign(args: {
  bucket: string; objectName: string; email: string; now: Date; expiresIn: number;
}): { url: string; canonicalQuery: string; stringToSign: string } {
  const iso = args.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const date = iso.slice(0, 8);
  const scope = `${date}/auto/storage/goog4_request`;
  const path = `/${args.bucket}/${args.objectName.split('/').map(rfc3986).join('/')}`;
  const params: Array<[string, string]> = [
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', `${args.email}/${scope}`],
    ['X-Goog-Date', iso],
    ['X-Goog-Expires', String(args.expiresIn)],
    ['X-Goog-SignedHeaders', 'host'],
  ];
  const canonicalQuery = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = ['GET', path, canonicalQuery, 'host:storage.googleapis.com', '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['GOOG4-RSA-SHA256', iso, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  return { url: `${API}${path}`, canonicalQuery, stringToSign };
}

export function createGcsBlob(scope: BundleScope, deps: GcsBlobDeps = {}): BlobSurface {
  const fetchFn = deps.fetch ?? fetch;
  const clock = deps.now ?? (() => new Date());
  const cfg = deps.config ?? loadGcsConfigFromEnv().config;
  if (!cfg) throw new Error('host.blob backend "gcs" selected but OPENWOP_BLOB_GCS_BUCKET is unset.');
  const token = deps.token ?? metadataTokenProvider(fetchFn, clock);
  const signerEmail = deps.signerEmail ?? (async () => {
    if (cfg.signerEmail) return cfg.signerEmail;
    const res = await fetchFn(`${METADATA}/email`, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) { await drainBody(res); throw new Error(`gcs blob: metadata email failed: HTTP ${res.status}`); }
    return (await res.text()).trim();
  });
  const signBlob = deps.signBlob ?? (async (bytes: Buffer, email: string) => {
    const res = await fetchFn(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signBlob`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: bytes.toString('base64') }),
    });
    if (!res.ok) { await drainBody(res); throw new Error(`gcs blob presign: signBlob failed: HTTP ${res.status}`); }
    const body = (await res.json()) as { signedBlob?: string };
    if (!body.signedBlob) throw new Error('gcs blob presign: signBlob returned no signedBlob');
    return Buffer.from(body.signedBlob, 'base64');
  });

  // Tenant isolation: every object lives under a per-tenant key prefix.
  const tenantRoot = `${cfg.keyPrefix}tenants/${encodeURIComponent(scope.tenantId)}/`;
  const objName = (key: unknown) => `${tenantRoot}${String(key)}`;
  const objUrl = (key: unknown) => `${API}/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o/${encodeURIComponent(objName(key))}`;
  const auth = async () => ({ authorization: `Bearer ${await token()}` });

  return {
    async put({ key, contentBase64, contentType }) {
      const body = Buffer.from(String(contentBase64), 'base64');
      const url = `${API}/upload/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o?uploadType=media&name=${encodeURIComponent(objName(key))}`;
      const res = await fetchFn(url, {
        method: 'POST',
        body,
        headers: { ...(await auth()), 'content-type': contentType ? String(contentType) : 'application/octet-stream' },
      });
      await drainBody(res);
      if (!res.ok) throw new Error(`gcs blob put failed: HTTP ${res.status}`);
      return { ok: true, key, sizeBytes: body.byteLength };
    },

    async get({ key }) {
      const res = await fetchFn(`${objUrl(key)}?alt=media`, { headers: await auth() });
      if (res.status === 404) { await drainBody(res); return { found: false }; }
      if (!res.ok) { await drainBody(res); throw new Error(`gcs blob get failed: HTTP ${res.status}`); }
      const cap = maxGetBytes();
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > cap) {
        await drainBody(res);
        throw new Error(`gcs blob get refused: object ${declared} bytes exceeds cap ${cap}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > cap) throw new Error(`gcs blob get refused: object ${buf.byteLength} bytes exceeds cap ${cap}`);
      return { found: true, contentBase64: buf.toString('base64'), contentType: res.headers.get('content-type') ?? undefined };
    },

    // Idempotent like S3: a 404 means "absent now".
    async delete({ key }) {
      const res = await fetchFn(objUrl(key), { method: 'DELETE', headers: await auth() });
      await drainBody(res);
      if (!res.ok && res.status !== 404) throw new Error(`gcs blob delete failed: HTTP ${res.status}`);
      return { ok: true, deleted: true };
    },

    // Listing is pinned under the tenant root; the root is stripped from every key.
    async list({ prefix, cursor, limit }) {
      const q = new URLSearchParams({
        prefix: `${tenantRoot}${typeof prefix === 'string' ? prefix : ''}`,
        maxResults: String(blobListLimit(limit)),
        fields: 'items(name,size),nextPageToken',
      });
      if (typeof cursor === 'string' && cursor) q.set('pageToken', cursor);
      const res = await fetchFn(`${API}/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o?${q.toString()}`, { headers: await auth() });
      if (!res.ok) { await drainBody(res); throw new Error(`gcs blob list failed: HTTP ${res.status}`); }
      const body = (await res.json()) as { items?: Array<{ name?: unknown; size?: unknown }>; nextPageToken?: unknown };
      const entries = (body.items ?? []).map((o) => {
        const size = Number(o.size);
        if (typeof o.name !== 'string' || !Number.isSafeInteger(size)) throw new Error('gcs blob list refused: invalid object metadata');
        return { name: o.name, size };
      });
      return {
        entries: entries
          .filter((o) => o.name.startsWith(tenantRoot))
          .map((o) => ({ key: o.name.slice(tenantRoot.length), sizeBytes: o.size })),
        ...(typeof body.nextPageToken === 'string' && body.nextPageToken ? { nextCursor: body.nextPageToken } : {}),
      };
    },

    async presign({ key, expiresInSeconds }) {
      const head = await fetchFn(objUrl(key), { headers: await auth() });
      await drainBody(head);
      if (head.status === 404) return { found: false };
      if (!head.ok) throw new Error(`gcs blob presign: metadata read failed: HTTP ${head.status}`);
      const requested = Number(expiresInSeconds);
      const ttl = Math.min(requested > 0 ? requested : cfg.presignTtlSeconds, MAX_PRESIGN_SECONDS);
      const email = await signerEmail();
      const now = clock();
      const { url, canonicalQuery, stringToSign } = gcsV4StringToSign({ bucket: cfg.bucket, objectName: objName(key), email, now, expiresIn: ttl });
      const signature = (await signBlob(Buffer.from(stringToSign, 'utf8'), email)).toString('hex');
      return { url: `${url}?${canonicalQuery}&X-Goog-Signature=${signature}`, expiresAtMs: now.getTime() + ttl * 1000, expiresInSeconds: ttl };
    },
  };
}

/** Register the GCS adapter; fail fast at boot when `blob=gcs` is selected without a bucket. */
export function registerGcsBlobAdapter(): void {
  registerSurfaceAdapter('blob', GCS_BACKEND_ID, (scope: BundleScope) => createGcsBlob(scope));
  if (resolveBackendId('blob') === GCS_BACKEND_ID) {
    const { config, missing } = loadGcsConfigFromEnv();
    if (!config) {
      throw new Error(
        `OPENWOP_SURFACE_BLOB=gcs but missing required config: ${missing.join(', ')}. ` +
          'Set it, or unset OPENWOP_SURFACE_BLOB to use the in-memory demo blob store.',
      );
    }
  }
}

/** ADR 0867 — prove the selected GCS backend works (incl. `signBlob`) before taking traffic. */
export async function verifyGcsBlobBackend(deps: GcsBlobDeps = {}): Promise<void> {
  if (resolveBackendId('blob') !== GCS_BACKEND_ID) return;
  await blobBootRoundTrip(createGcsBlob({ tenantId: BLOB_BOOT_CHECK_TENANT }, deps), deps.fetch ?? fetch);
}
