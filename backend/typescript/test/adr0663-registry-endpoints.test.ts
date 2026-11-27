import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expandEndpoint, resetRegistryEndpointCache, resolveRegistry, templateFor,
} from '../src/packs/registryEndpoints.js';
import { installPackFromRegistry } from '../src/packs/registryInstaller.js';

/**
 * ADR 0663 / `packs.md` §"The registry tree" — a client MUST resolve every
 * registry path through `.well-known/openwop-registry.json` `endpoints`
 * rather than constructing one, and a major-2 host must read the `v2` tree,
 * where the admissible versions live.
 *
 * Tracker TST-BG3-24. Red when: the host reads any tree but v2 (RFC 0266: no v1 or
 * flat fallback, no OPENWOP_REGISTRY_TREE pin back to v1), a registry with no v2 tree
 * is not refused (`no_v2_tree`, and the installer's typed `registry_v2_tree_missing`),
 * the flat alias is used for a versioned key or not used for an unversioned one, a non-OK status or a missing `endpoints` is not reported as its
 * own reason, or `expandEndpoint` stops percent-encoding. DOUBLE GUARD on "fetched
 * once": both `resolveRegistry`'s cache and `fetchRegistryDocument`'s docCache hold the
 * fetch count at 1, so removing either alone stays green (probe `0663-cache`).
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

let fetchMock = vi.fn<typeof fetch>();
function serve(doc: unknown, status = 200): void {
  fetchMock = vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify(doc), { status, headers: { 'content-type': 'application/json' } }));
  globalThis.fetch = fetchMock;
}
/** Every URL the code fetched — asserted OUTSIDE the mock, where a failure cannot be
 *  swallowed by `fetchRegistryDocument`'s catch. */
const fetchedUrls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

describe('ADR 0663 — registry paths are resolved, never constructed', () => {
  it('resolves the v2 tree, through the discovery document (RFC 0266: v2 only)', async () => {
    serve(DOC);
    const asV2 = await resolveRegistry(REG, 2);
    expect(fetchedUrls()).toEqual([WK]);
    expect(asV2.ok && asV2.resolved.tree).toBe('v2');
    expect(asV2.ok && templateFor(asV2.resolved, 'versionManifest')).toBe('/v2/packs/{name}/-/{version}.json');
  });

  it('a registry that advertises no v2 tree is refused (no_v2_tree), never read through v1', async () => {
    serve({ endpoints: { v1: DOC.endpoints.v1, publicKey: '/keys/{keyId}.pub' } });
    const r = await resolveRegistry(REG, 2);
    expect(r).toEqual({ ok: false, reason: 'no_v2_tree' });
  });

  it('OPENWOP_REGISTRY_TREE=v1 does not pin the host back to the v1 tree', async () => {
    process.env.OPENWOP_REGISTRY_TREE = 'v1';
    try {
      serve(DOC);
      const r = await resolveRegistry(REG, 2);
      expect(r.ok && r.resolved.tree).toBe('v2');
    } finally {
      delete process.env.OPENWOP_REGISTRY_TREE;
    }
  });

  it('a flat v1-era alias key is not used for a versioned endpoint the v2 tree omits', async () => {
    serve({ endpoints: { ...DOC.endpoints, v2: { registryIndex: '/v2/index.json' } } });
    const r = await resolveRegistry(REG, 2);
    expect(r.ok && templateFor(r.resolved, 'versionManifest')).toBeNull();
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
    fetchMock = vi.fn<typeof fetch>(async () => { throw new Error('ECONNREFUSED'); });
    globalThis.fetch = fetchMock;
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
    expect(fetchedUrls()).toEqual([WK]);
  });
});

describe('RFC 0266 — a boot install against a registry with no v2 tree', () => {
  it('is refused, typed, and fetches nothing but the discovery document', async () => {
    serve({ endpoints: { v1: DOC.endpoints.v1, publicKey: '/keys/{keyId}.pub' } });
    await expect(
      installPackFromRegistry({ name: 'core.openwop.ai', version: '1.5.2' }, { packDir: '/nonexistent-rfc0266', registry: REG }),
    ).rejects.toThrow(/^registry_v2_tree_missing: /);
    expect(fetchedUrls()).toEqual([WK]);
  });
});
