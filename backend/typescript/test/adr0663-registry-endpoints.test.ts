import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expandEndpoint, preferredTree, resetRegistryEndpointCache, resolveRegistry, templateFor,
} from '../src/packs/registryEndpoints.js';

/**
 * ADR 0663 / `packs.md` §"The registry tree" — a client MUST resolve every
 * registry path through `.well-known/openwop-registry.json` `endpoints`
 * rather than constructing one, and a major-2 host must read the `v2` tree,
 * where the admissible versions live.
 */
const REG = 'https://registry.test';
const WK = `${REG}/.well-known/openwop-registry.json`;
const DOC = {
  endpoints: {
    publicKey: '/keys/{keyId}.pub',
    versionManifest: '/v1/packs/{name}/-/{version}.json',
    v1: { versionManifest: '/v1/packs/{name}/-/{version}.json', versionTarball: '/v1/packs/{name}/-/{version}.tgz' },
    v2: { versionManifest: '/v2/packs/{name}/-/{version}.json', versionTarball: '/v2/packs/{name}/-/{version}.tgz' },
  },
};
const origFetch = globalThis.fetch;

beforeEach(() => {
  resetRegistryEndpointCache();
  delete process.env.OPENWOP_REGISTRY_TREE;
});
afterEach(() => { globalThis.fetch = origFetch; resetRegistryEndpointCache(); delete process.env.OPENWOP_REGISTRY_TREE; });

function serve(doc: unknown, status = 200): void {
  globalThis.fetch = vi.fn(async (u: string | URL) => {
    expect(String(u)).toBe(WK);
    return new Response(JSON.stringify(doc), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('ADR 0663 — registry paths are resolved, never constructed', () => {
  it('a major-2 host resolves the v2 tree; a major-1 host resolves v1; the same registry serves both', async () => {
    serve(DOC);
    const asV2 = await resolveRegistry(REG, 2);
    expect(asV2.ok && asV2.resolved.tree).toBe('v2');
    expect(asV2.ok && templateFor(asV2.resolved, 'versionManifest')).toBe('/v2/packs/{name}/-/{version}.json');
    resetRegistryEndpointCache();
    serve(DOC);
    const asV1 = await resolveRegistry(REG, 1);
    expect(asV1.ok && asV1.resolved.tree).toBe('v1');
    expect(asV1.ok && templateFor(asV1.resolved, 'versionManifest')).toBe('/v1/packs/{name}/-/{version}.json');
  });

  it('falls back to v1 when the registry advertises no v2 tree — the overlap tree, not a guess', async () => {
    serve({ endpoints: { v1: DOC.endpoints.v1, publicKey: '/keys/{keyId}.pub' } });
    const r = await resolveRegistry(REG, 2);
    expect(r.ok && r.resolved.tree).toBe('v1');
  });

  it('OPENWOP_REGISTRY_TREE pins the tree explicitly, over the host major', () => {
    process.env.OPENWOP_REGISTRY_TREE = 'v1';
    expect(preferredTree(DOC.endpoints, 2)).toBe('v1');
    process.env.OPENWOP_REGISTRY_TREE = 'v2';
    expect(preferredTree(DOC.endpoints, 1)).toBe('v2');
  });

  it('an unversioned endpoint (publicKey) comes from the flat alias, because keys are not protocol-versioned', async () => {
    serve(DOC);
    const r = await resolveRegistry(REG, 2);
    expect(r.ok && templateFor(r.resolved, 'publicKey')).toBe('/keys/{keyId}.pub'); // no v2.publicKey in the doc
  });

  it('separates a registry that did not ANSWER from one that answered without `endpoints` — two causes, two fixes', async () => {
    serve({ notEndpoints: true });
    expect(await resolveRegistry(REG, 2)).toEqual({ ok: false, reason: 'no_endpoints' });
    resetRegistryEndpointCache();
    serve(DOC, 503);
    expect(await resolveRegistry(REG, 2)).toEqual({ ok: false, reason: 'unreachable' });
    resetRegistryEndpointCache();
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await resolveRegistry(REG, 2)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('expansion percent-encodes every variable — a registry-supplied template is not a path-traversal seam', () => {
    expect(expandEndpoint('/v2/packs/{name}/-/{version}.json', { name: 'core.openwop.rag', version: '1.0.2' }))
      .toBe('/v2/packs/core.openwop.rag/-/1.0.2.json');
    expect(expandEndpoint('/v2/packs/{name}.json', { name: '../../etc/passwd' }))
      .toBe('/v2/packs/..%2F..%2Fetc%2Fpasswd.json');
    expect(() => expandEndpoint('/v2/{missing}.json', {})).toThrow(/unbound_variable/);
  });

  it('the well-known is fetched once per registry and reused', async () => {
    serve(DOC);
    await resolveRegistry(REG, 2);
    await resolveRegistry(REG, 2);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});
