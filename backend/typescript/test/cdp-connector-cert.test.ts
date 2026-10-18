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
    expect(r.errors).toEqual(['non-https URL at manifest.provider.reach.openapi.spec: http://api.acme.test/x']);
  });

  it('fails embedded credential material', () => {
    const r = certifyConnectionPack({ ...valid, provider: { id: 'acme', reach: { openapi: {} }, auth: { client_secret: 'sk_live_leaked' } } });
    expect(r.passed).toBe(false);
    expect(r.errors).toEqual(['embedded credential material is forbidden (manifest.provider.auth.client_secret) — credentials are supplied at runtime via BYOK/Connections']);
  });

  // One rule per fixture: each breaks ONLY its rule, so one check cannot mask another.
  it('fails wrong kind / missing fields / multi-transport', () => {
    const only = (m: unknown): string[] => {
      const r = certifyConnectionPack(m);
      expect(r.passed).toBe(false);
      return r.errors;
    };
    const reach = { openapi: { spec: 'https://api.acme.test/openapi.json' } };
    expect(only({ ...valid, kind: 'nodes' })).toEqual(["`kind` must be 'connection'"]);
    expect(only({ ...valid, version: 'v1' })).toEqual(['`version` must be semver (x.y.z)']);
    expect(only({ ...valid, provider: { id: 'Acme_Bad', reach } })).toEqual(['`provider.id` must be a kebab-case identifier']);
    expect(only({ ...valid, provider: { id: 'acme', reach: { ...reach, mcp: {} } } })).toEqual(['`provider.reach` must declare exactly one transport (RFC 0095 §A)']);
    expect(only('not-an-object')).toEqual(['manifest must be a JSON object']);
  });
});
