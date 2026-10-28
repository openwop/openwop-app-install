/**
 * S3 blob backend (ADR 0867, Phase 2) — `host/blob/s3SigV4.ts`, the AWS SigV4
 * QUERY-string presigner every S3 blob request is signed with. The published
 * AWS vector is an independent oracle (its signature is AWS's, not ours).
 *
 * Breaks it: an unsorted canonical query, a session token left out of the
 * signed canonical request, the virtual-host form dropping the bucket, a slash
 * encoded inside a key path, or `~` percent-encoded.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): `8fw2g3-sig-sort`,
 * `-sig-token`, `-sig-token-signed-r2`, `-sig-vhost`, `-sig-slash`, `-sig-tilde`.
 */
import { describe, expect, it } from 'vitest';
import { presignS3Url, awsUriEncode } from '../src/host/blob/s3SigV4.js';

describe('S3 SigV4 query-string presigner', () => {
  // Canonical AWS example — "Authenticating Requests: Using Query Parameters
  // (AWS Signature Version 4)". These exact inputs have a published signature.
  it('matches the published AWS GET presign vector', () => {
    const url = presignS3Url({
      method: 'GET',
      bucket: 'examplebucket',
      key: 'test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      endpoint: 'https://s3.amazonaws.com',
      forcePathStyle: false,
      expiresIn: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(url).toContain('https://examplebucket.s3.amazonaws.com/test.txt?');
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
    expect(url).toContain('X-Amz-Date=20130524T000000Z');
    expect(url).toContain('X-Amz-Expires=86400');
    expect(url).toContain('X-Amz-SignedHeaders=host');
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('includes the session token when present, and SIGNS it', () => {
    const base = {
      method: 'GET' as const, bucket: 'b', key: 'k', region: 'us-east-1',
      accessKeyId: 'AKID', secretAccessKey: 'secret', expiresIn: 60,
      now: new Date('2024-01-01T00:00:00Z'),
    };
    const url = presignS3Url({ ...base, sessionToken: 'TOKEN/123' });
    expect(url).toContain('X-Amz-Security-Token=TOKEN%2F123');
    const sig = (u: string): string | undefined => /X-Amz-Signature=([0-9a-f]{64})$/.exec(u)?.[1];
    expect(sig(url)).toMatch(/^[0-9a-f]{64}$/);
    // The token is part of the canonical request: the same request without it
    // signs differently. (A token appended after signing would leave these equal.)
    expect(sig(url)).not.toBe(sig(presignS3Url(base)));
  });

  it('path-style vs virtual-hosted host/URI', () => {
    const common = {
      method: 'GET' as const, bucket: 'bkt', key: 'a/b c.txt', region: 'us-east-1',
      accessKeyId: 'AKID', secretAccessKey: 'secret', endpoint: 'http://localhost:9000',
      expiresIn: 60, now: new Date('2024-01-01T00:00:00Z'),
    };
    // Path-style, and the query in sorted order (Algorithm sorts first).
    expect(presignS3Url({ ...common, forcePathStyle: true }).startsWith('http://localhost:9000/bkt/a/b%20c.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=')).toBe(true);
    expect(presignS3Url({ ...common, forcePathStyle: false })).toContain('http://bkt.localhost:9000/a/b%20c.txt?');
  });

  it('awsUriEncode encodes per RFC 3986 and honors encodeSlash', () => {
    expect(awsUriEncode('a b+c/d', true)).toBe('a%20b%2Bc%2Fd');
    expect(awsUriEncode('a b+c/d', false)).toBe('a%20b%2Bc/d');
    expect(awsUriEncode('keep-_.~', true)).toBe('keep-_.~');
  });
});
