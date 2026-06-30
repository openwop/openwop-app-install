/**
 * RFC 0120 — pack-declarable provider `apiHosts` (the credentialed-egress allow-list).
 *
 * This is the reference-host arm openwop-app committed to as the RFC 0120 witness.
 * Before this, `host/brokeredEgress.ts` could pin egress only to a BUILT-IN
 * `ProviderManifest.apiHosts`; a pack-delivered provider had no way to declare its
 * hosts, so a pure ad pack (meta-ads/google-ads/tiktok-ads) failed closed on egress
 * (the documented confused-deputy gap — the Meta cascade-delete DELETE no-opped).
 *
 * Verified here:
 *  - the loader reads `provider.apiHosts` into the registered ProviderManifest, so
 *    `getProvider(id).apiHosts` is populated for a PACK-delivered provider;
 *  - the vendored connection-pack-manifest schema REQUIRES apiHosts when reach is
 *    `openapi` (the provider-level `allOf`) and accepts its ABSENCE for MCP/metadata
 *    reach (the conditional-MUST disposition);
 *  - the egress allow-list matcher (`hostMatchesApi`) permits the provider's api host
 *    and its subdomains (eTLD+1 floor) and FAILS CLOSED on look-alikes — no substring
 *    escape (RFC 0120 §A / RFC 0079 audience binding).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConnectionPacks } from '../src/features/connections/connectionPackLoader.js';
import { getProvider } from '../src/features/connections/providerRegistry.js';
import { hostMatchesApi } from '../src/host/connectionInjection.js';

/** Write a connection pack `pack.json` into a fresh dir under `root`. */
function writePack(root: string, dir: string, manifest: unknown): void {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'pack.json'), JSON.stringify(manifest));
}

/** The ad-pack shape: oauth2 + reach `openapi` ⇒ credentialed egress ⇒ apiHosts REQUIRED. */
const adPack = (id: string, apiHosts?: string[]) => ({
  name: `core.openwop.connections.${id}`,
  version: '1.0.0',
  kind: 'connection',
  engines: { openwop: '>=1.0.0' },
  provider: {
    id,
    displayName: 'Ads (test)',
    category: 'marketing',
    auth: {
      kind: 'oauth2',
      authFlow: 'manual',
      scopeModel: 'groups',
      endpoints: {
        authorize: 'https://www.facebook.com/v19.0/dialog/oauth',
        token: 'https://graph.facebook.com/v19.0/oauth/access_token',
      },
      scopes: {
        read: [{ key: 'ads.read', label: 'Read', scopes: ['ads_read'] }],
        write: [{ key: 'ads.manage', label: 'Manage', scopes: ['ads_management'] }],
      },
    },
    reach: { openapi: { ref: 'https://developers.facebook.com/docs/marketing-api/reference' } },
    consumerNodes: ['core.openwop.http'],
    ...(apiHosts ? { apiHosts } : {}),
  },
});

/** An MCP-reach pack: no credentialed openapi egress ⇒ apiHosts is OPTIONAL. */
const mcpPack = (id: string) => ({
  name: `core.openwop.connections.${id}`,
  version: '1.0.0',
  kind: 'connection',
  engines: { openwop: '>=1.0.0' },
  provider: {
    id,
    displayName: 'MCP (test)',
    category: 'dev',
    auth: {
      kind: 'oauth2',
      authFlow: 'pkce',
      scopeModel: 'groups',
      endpoints: { authorize: 'https://example.com/authorize', token: 'https://example.com/token' },
      scopes: { read: [{ key: 'r', label: 'Read', scopes: ['public'] }], write: [{ key: 'w', label: 'Write', scopes: ['all'] }] },
    },
    reach: { mcp: { server: { url: 'https://api.example.com/mcp/', transport: 'http' } } },
    consumerNodes: ['core.openwop.mcp.invoke-tool'],
  },
});

describe('RFC 0120 connection-pack provider apiHosts (egress allow-list)', () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'owp-apihosts-')); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('loader reads provider.apiHosts into the registered ProviderManifest (§A)', () => {
    writePack(root, 'ad-ok', adPack('cp-ad-ok', ['facebook.com']));
    const { installed, errors } = loadConnectionPacks({ roots: [root] });
    expect(errors.find((e) => e.pack.includes('cp-ad-ok'))).toBeUndefined();
    expect(installed.find((r) => r.providerId === 'cp-ad-ok')).toBeTruthy();
    // The load-bearing assertion: brokeredEgress pins to exactly this list.
    expect(getProvider('cp-ad-ok')?.apiHosts).toEqual(['facebook.com']);
  });

  it('REJECTS an openapi-reach pack that omits apiHosts (provider allOf conditional-MUST)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-ad-noapi-'));
    writePack(dir, 'ad-missing', adPack('cp-ad-missing')); // no apiHosts
    try {
      const { installed, errors } = loadConnectionPacks({ roots: [dir] });
      expect(installed.find((r) => r.providerId === 'cp-ad-missing')).toBeUndefined();
      const e = errors.find((x) => x.pack.includes('cp-ad-missing'));
      expect(e?.code).toBe('validation_error'); // schema allOf failure, not a generic 500
      expect(getProvider('cp-ad-missing')).toBeNull(); // never registered → fails closed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ACCEPTS an mcp-reach pack with no apiHosts (apiHosts optional off credentialed-openapi)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-mcp-'));
    writePack(dir, 'mcp-ok', mcpPack('cp-mcp-ok'));
    try {
      const { installed, errors } = loadConnectionPacks({ roots: [dir] });
      expect(errors.find((e) => e.pack.includes('cp-mcp-ok'))).toBeUndefined();
      expect(installed.find((r) => r.providerId === 'cp-mcp-ok')).toBeTruthy();
      expect(getProvider('cp-mcp-ok')?.apiHosts).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('egress allow-list matching (hostMatchesApi) — RFC 0079 audience binding', () => {
    it('PERMITS the api host and its subdomains (eTLD+1 floor)', () => {
      expect(hostMatchesApi('facebook.com', 'facebook.com')).toBe(true);
      expect(hostMatchesApi('graph.facebook.com', 'facebook.com')).toBe(true);
      expect(hostMatchesApi('graph.facebook.com.', 'facebook.com')).toBe(true); // trailing dot
    });

    it('FAILS CLOSED on look-alikes — no substring / suffix escape', () => {
      expect(hostMatchesApi('evil.com', 'facebook.com')).toBe(false);
      expect(hostMatchesApi('notfacebook.com', 'facebook.com')).toBe(false); // suffix, not dot-anchored
      expect(hostMatchesApi('facebook.com.evil.com', 'facebook.com')).toBe(false); // prefix attack
    });
  });
});
