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

  it('includes the session token when present (still a valid signature)', () => {
    const url = presignS3Url({
      method: 'GET', bucket: 'b', key: 'k', region: 'us-east-1',
      accessKeyId: 'AKID', secretAccessKey: 'secret', expiresIn: 60,
      sessionToken: 'TOKEN/123', now: new Date('2024-01-01T00:00:00Z'),
    });
    expect(url).toContain('X-Amz-Security-Token=TOKEN%2F123');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
  });

  it('path-style vs virtual-hosted host/URI', () => {
    const common = {
      method: 'GET' as const, bucket: 'bkt', key: 'a/b c.txt', region: 'us-east-1',
      accessKeyId: 'AKID', secretAccessKey: 'secret', endpoint: 'http://localhost:9000',
      expiresIn: 60, now: new Date('2024-01-01T00:00:00Z'),
    };
    expect(presignS3Url({ ...common, forcePathStyle: true })).toContain('http://localhost:9000/bkt/a/b%20c.txt?');
    expect(presignS3Url({ ...common, forcePathStyle: false })).toContain('http://bkt.localhost:9000/a/b%20c.txt?');
  });

  it('awsUriEncode encodes per RFC 3986 and honors encodeSlash', () => {
    expect(awsUriEncode('a b+c/d', true)).toBe('a%20b%2Bc%2Fd');
    expect(awsUriEncode('a b+c/d', false)).toBe('a%20b%2Bc/d');
    expect(awsUriEncode('keep-_.~', true)).toBe('keep-_.~');
  });
});
