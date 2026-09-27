/**
 * CDP-H — connector-pack certification lint (ADR 0270). Enforces the trust rules a
 * certified RFC 0095 connection pack must satisfy: https-only, exactly-one transport,
 * no embedded credential material, required identity fields.
 */
import { describe, expect, it } from 'vitest';
import { certifyConnectionPack } from '../src/features/marketplace/certService.js';

const valid = {
  kind: 'connection',
  name: 'Acme Connector',
  version: '1.0.0',
  description: 'Connects to the Acme REST API for contacts.',
  provider: { id: 'acme', reach: { openapi: { spec: 'https://api.acme.test/openapi.json' } } },
};

describe('CDP-H certifyConnectionPack', () => {
  it('passes a clean manifest', () => {
    const r = certifyConnectionPack(valid);
    expect(r.passed).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('fails a non-https endpoint', () => {
    const r = certifyConnectionPack({ ...valid, provider: { id: 'acme', reach: { openapi: { spec: 'http://api.acme.test/x' } } } });
    expect(r.passed).toBe(false);
    expect(r.errors.some((e) => e.includes('non-https'))).toBe(true);
  });

  it('fails embedded credential material', () => {
    const r = certifyConnectionPack({ ...valid, provider: { id: 'acme', reach: { openapi: {} }, auth: { client_secret: 'sk_live_leaked' } } });
    expect(r.passed).toBe(false);
    expect(r.errors.some((e) => e.includes('credential material'))).toBe(true);
  });

  it('fails wrong kind / missing fields / multi-transport', () => {
    expect(certifyConnectionPack({ ...valid, kind: 'nodes' }).passed).toBe(false);
    expect(certifyConnectionPack({ ...valid, version: 'v1' }).passed).toBe(false);
    expect(certifyConnectionPack({ ...valid, provider: { id: 'Acme_Bad', reach: { openapi: {}, mcp: {} } } }).passed).toBe(false);
    expect(certifyConnectionPack('not-an-object').passed).toBe(false);
  });
});
