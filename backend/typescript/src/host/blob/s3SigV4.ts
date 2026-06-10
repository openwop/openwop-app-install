/**
 * Minimal AWS Signature Version 4 query-string presigner for S3-compatible
 * object stores — dependency-free (node:crypto only).
 *
 * Why hand-rolled rather than @aws-sdk/client-s3: the backend keeps a tight
 * runtime-dependency budget, and a query-string presigner is ~80 lines. It is
 * cloud-agnostic by construction — point `endpoint` at AWS S3, GCS in S3-interop
 * mode, Cloudflare R2, Backblaze B2, MinIO, etc. The output is a plain HTTPS URL
 * the client uses directly against the bucket (no host round-trip), which is the
 * whole point of presigning.
 *
 * Verified against the canonical AWS example ("Authenticating Requests: Using
 * Query Parameters") in s3-sigv4.test.ts.
 */

import { createHash, createHmac } from 'node:crypto';

const sha256hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 / AWS URI encoding. Every byte except unreserved is %-encoded;
 *  `/` is preserved only in path segments when `encodeSlash` is false. */
export function awsUriEncode(input: string, encodeSlash: boolean): string {
  const bytes = Buffer.from(input, 'utf8');
  let out = '';
  for (const b of bytes) {
    const unreserved =
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e; // - _ . ~
    if (unreserved) out += String.fromCharCode(b);
    else if (b === 0x2f && !encodeSlash) out += '/';
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function amzDate(d: Date): { amzdate: string; datestamp: string } {
  const datestamp = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  const amzdate = `${datestamp}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
  return { amzdate, datestamp };
}

export interface PresignOptions {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  bucket: string;
  /** Object key (may contain `/`; encoded per-segment). */
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Base endpoint, e.g. `https://s3.amazonaws.com` or a custom S3-compatible
   *  endpoint. Defaults to `https://s3.<region>.amazonaws.com`. */
  endpoint?: string;
  /** Path-style (`<endpoint>/<bucket>/<key>`) vs virtual-hosted
   *  (`<bucket>.<endpoint>/<key>`). MinIO/local typically need path-style. */
  forcePathStyle?: boolean;
  /** Presigned-URL lifetime in seconds. */
  expiresIn: number;
  /** Temporary-credential session token (optional). */
  sessionToken?: string;
  /** Injected clock for deterministic tests. Defaults to now. */
  now?: Date;
}

/**
 * Produce a SigV4 query-string-presigned HTTPS URL for an S3 object request.
 * UNSIGNED-PAYLOAD is used, so the client may stream any body (for PUT).
 */
export function presignS3Url(opts: PresignOptions): string {
  const now = opts.now ?? new Date();
  const { amzdate, datestamp } = amzDate(now);
  const algorithm = 'AWS4-HMAC-SHA256';
  const service = 's3';
  const credentialScope = `${datestamp}/${opts.region}/${service}/aws4_request`;
  const signedHeaders = 'host';

  const base = opts.endpoint ?? `https://s3.${opts.region}.amazonaws.com`;
  const baseHost = new URL(base).host;
  const proto = new URL(base).protocol; // http: for local MinIO, https: otherwise
  const encKey = opts.key.split('/').map((s) => awsUriEncode(s, true)).join('/');
  let host: string;
  let canonicalUri: string;
  if (opts.forcePathStyle) {
    host = baseHost;
    canonicalUri = `/${awsUriEncode(opts.bucket, true)}/${encKey}`;
  } else {
    host = `${opts.bucket}.${baseHost}`;
    canonicalUri = `/${encKey}`;
  }

  const params: Record<string, string> = {
    'X-Amz-Algorithm': algorithm,
    'X-Amz-Credential': `${opts.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzdate,
    'X-Amz-Expires': String(opts.expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  if (opts.sessionToken) params['X-Amz-Security-Token'] = opts.sessionToken;

  // Canonical query string: sorted by key, both key and value AWS-URI-encoded.
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(params[k], true)}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [algorithm, amzdate, credentialScope, sha256hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, datestamp), opts.region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${proto}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
