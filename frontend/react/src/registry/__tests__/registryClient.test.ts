import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPackDetail,
  fetchRegistryIndex,
  latestInstallable,
  resetRegistryEndpoints,
  sbomUrlFor,
  type PackVersionRecord,
} from '../registryClient.js';

/**
 * RFC 0177 §A.3 / RFC 0222: the registry is versioned by TREE, and the
 * well-known `endpoints` map is the negotiation. This client used to hard-code
 * `/v1/index.json`. These tests assert the URLs actually requested, since a
 * mocked client would hide exactly that.
 */
const WELL_KNOWN = {
  endpoints: {
    registryIndex: '/v1/index.json',
    packMetadata: '/v1/packs/{name}/index.json',
    v1: { registryIndex: '/v1/index.json', packMetadata: '/v1/packs/{name}/index.json' },
    v2: { registryIndex: '/v2/index.json', packMetadata: '/v2/packs/{name}/index.json' },
  },
};

let requested: string[] = [];
function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    requested.push(new URL(url).pathname);
    const body = routes[new URL(url).pathname];
    return body === undefined
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

beforeEach(() => { requested = []; resetRegistryEndpoints(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('registry paths are resolved through endpoints.v2, never constructed', () => {
  it('reads the v2 index named by the well-known map', async () => {
    serve({ '/.well-known/openwop-registry.json': WELL_KNOWN, '/v2/index.json': { packs: [] } });
    await fetchRegistryIndex();
    expect(requested).toEqual(['/.well-known/openwop-registry.json', '/v2/index.json']);
  });

  it('falls back to the flat v1-era aliases when a registry publishes no v2 map', async () => {
    const { v2: _v2, ...flat } = WELL_KNOWN.endpoints;
    serve({ '/.well-known/openwop-registry.json': { endpoints: flat }, '/v1/index.json': { packs: [] } });
    await fetchRegistryIndex();
    expect(requested.at(-1)).toBe('/v1/index.json');
  });

  it('fails, rather than guessing a path, when there is no endpoints map', async () => {
    serve({ '/.well-known/openwop-registry.json': { name: 'x' } });
    await expect(fetchRegistryIndex()).rejects.toThrow(/endpoints/);
    expect(requested).not.toContain('/v1/index.json');
  });

  it('fills {name} in packMetadata, and normalizes a v2 version record', async () => {
    serve({
      '/.well-known/openwop-registry.json': WELL_KNOWN,
      '/v2/packs/core.x/index.json': {
        name: 'core.x', latest: '1.0.0',
        versions: [{
          version: '1.0.0', manifestUrl: '/v2/packs/core.x/-/1.0.0.json', tarballUrl: 't', signatureUrl: 's',
          sbomUrl: '/v2/packs/core.x/-/1.0.0.sbom.json', signingScheme: 'ed25519-canonical-json',
          signingKeyId: 'k', integrity: 'sha256-x', versionDeprecated: true, yanked: false,
        }],
      },
    });
    const d = await fetchPackDetail('core.x');
    expect(requested.at(-1)).toBe('/v2/packs/core.x/index.json');
    const v = d.versions[0]!;
    expect(v.signingMethod).toBe('ed25519-canonical-json');
    expect(v.deprecated).toBe(true);
    expect(v.publishedAt).toBeUndefined();
    expect(sbomUrlFor(v)).toMatch(/\/v2\/packs\/core\.x\/-\/1\.0\.0\.sbom\.json$/);
  });
});

describe('RFC 0222 — a yanked version is never presented as latest', () => {
  const rec = (version: string, yanked = false) => ({ version, yanked } as PackVersionRecord);

  it('keeps the named latest when it is not yanked', () => {
    expect(latestInstallable({ latest: '1.2.0', versions: [rec('1.0.0'), rec('1.2.0')] })?.version).toBe('1.2.0');
  });

  it('skips a yanked named latest for the newest unyanked version (semver, not list order)', () => {
    const versions = [rec('1.10.0'), rec('1.9.0'), rec('2.0.0', true), rec('1.2.0')];
    expect(latestInstallable({ latest: '2.0.0', versions })?.version).toBe('1.10.0');
  });

  it('a release outranks its own prerelease', () => {
    expect(latestInstallable({ latest: 'x', versions: [rec('1.0.0'), rec('1.0.0-rc.1')] })?.version).toBe('1.0.0');
  });

  it('is undefined when every version is yanked — there is nothing to install', () => {
    expect(latestInstallable({ latest: '1.0.0', versions: [rec('1.0.0', true)] })).toBeUndefined();
  });
});
