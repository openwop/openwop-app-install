/**
 * RFC 0095 §B.6 — connection-pack loader (openwop-app reference host, Task T3).
 * Verifies the loader: installs a kind:"connection" pack into the provider
 * registry, rejects credential material (§B.2), enforces §B.6 precedence/conflict,
 * and that the discovery doc advertises capabilities.connections.packsSupported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { loadConnectionPacks } from '../src/features/connections/connectionPackLoader.js';
import { getProvider } from '../src/features/connections/providerRegistry.js';

/** Write a connection pack `pack.json` into a fresh dir under `root`. */
function writePack(root: string, dir: string, manifest: unknown): void {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'pack.json'), JSON.stringify(manifest));
}

const githubPack = (id = 'ct-github', version = '1.0.0') => ({
  name: `core.openwop.connections.${id}`,
  version,
  kind: 'connection',
  engines: { openwop: '>=1.0.0' },
  provider: {
    id,
    displayName: 'GitHub (test)',
    category: 'dev',
    auth: {
      kind: 'oauth2', authFlow: 'pkce', scopeModel: 'groups',
      endpoints: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token' },
      scopes: { read: [{ key: 'repo.read', label: 'Read', scopes: ['public_repo'] }], write: [{ key: 'repo.write', label: 'Write', scopes: ['repo'] }] },
    },
    reach: { mcp: { server: { url: 'https://api.githubcopilot.com/mcp/', transport: 'http' } } },
    consumerNodes: ['core.openwop.mcp.invoke-tool'],
  },
});

describe('RFC 0095 connection-pack loader (T3)', () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'owp-connpacks-')); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  it('installs a kind:"connection" pack → provider resolves via getProvider (§B.6)', () => {
    writePack(root, 'github', githubPack('ct-github'));
    const { installed } = loadConnectionPacks({ roots: [root] });
    expect(installed.find((r) => r.providerId === 'ct-github')).toBeTruthy();
    const p = getProvider('ct-github');
    expect(p?.label).toBe('GitHub (test)');
    expect(p?.reach).toBe('mcp');
    expect(p?.mcpServer?.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(p?.scopes.read[0]?.scopes).toContain('public_repo');
    expect(p?.defaultScopes).toContain('public_repo');
    expect(p?.refreshable).toBe(true); // oauth2
  });

  it('rejects a pack carrying credential material with connection_pack_credential_material (§B.2)', () => {
    const leaky = githubPack('ct-leak') as Record<string, unknown>;
    (leaky.provider as { auth: Record<string, unknown> }).auth.clientSecret = 'ghs_should_be_rejected';
    const dir = mkdtempSync(join(tmpdir(), 'owp-leak-'));
    writePack(dir, 'leak', leaky);
    try {
      // A rejected pack is collected in `errors`, not thrown — boot must not abort.
      const { installed, errors } = loadConnectionPacks({ roots: [dir] });
      expect(installed.find((r) => r.providerId === 'ct-leak')).toBeUndefined();
      const e = errors.find((x) => x.pack.endsWith('ct-leak'));
      expect(e?.code).toBe('connection_pack_credential_material');
      expect(e?.details?.property).toBe('clientSecret'); // not endpoints.token
      expect(getProvider('ct-leak')).toBeNull(); // never registered
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two packs with same provider id: older loses with connection_provider_conflict (§B.6)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-conflict-'));
    writePack(dir, 'a-new', githubPack('ct-dup', '2.0.0'));
    writePack(dir, 'b-old', githubPack('ct-dup', '1.0.0'));
    // readdir order is name-sorted: a-new (2.0.0) installs first, then b-old (1.0.0) conflicts.
    try {
      const { errors } = loadConnectionPacks({ roots: [dir] });
      expect(errors.some((e) => e.code === 'connection_provider_conflict')).toBe(true);
      expect(getProvider('ct-dup')?.label).toBe('GitHub (test)'); // the 2.0.0 one stayed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a PRERELEASE pack does NOT silently supersede a release of the same id (§B.6; myndhyve-1 937c)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-prerelease-'));
    writePack(dir, 'a-release', githubPack('ct-pre', '1.0.0'));      // installs first (name-sorted)
    writePack(dir, 'b-prerelease', githubPack('ct-pre', '1.0.0-alpha.1')); // 1.0.0-alpha.1 < 1.0.0
    try {
      const { errors } = loadConnectionPacks({ roots: [dir] });
      expect(errors.some((e) => e.code === 'connection_provider_conflict')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a smuggled endpoints.token OUTSIDE provider.auth is still rejected (full-path exemption; myndhyve-1 937c)', () => {
    const smuggled = githubPack('ct-smuggle') as Record<string, unknown>;
    // a stray `endpoints.token` not at provider.auth.endpoints.token must NOT be exempt
    (smuggled.provider as Record<string, unknown>).endpoints = { token: 'ghs_smuggled' };
    const dir = mkdtempSync(join(tmpdir(), 'owp-smuggle-'));
    writePack(dir, 'smuggle', smuggled);
    try {
      const { errors } = loadConnectionPacks({ roots: [dir] });
      expect(errors.some((e) => e.code === 'connection_pack_credential_material')).toBe(true);
      expect(getProvider('ct-smuggle')).toBeNull(); // never registered
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schema-invalid pack (two reach modes) is rejected (§B.5)', () => {
    const bad = githubPack('ct-badreach') as Record<string, unknown>;
    (bad.provider as { reach: Record<string, unknown> }).reach = { mcp: { server: { url: 'https://x/', transport: 'http' } }, openapi: { ref: 'https://x/o' } };
    const dir = mkdtempSync(join(tmpdir(), 'owp-badreach-'));
    writePack(dir, 'bad', bad);
    try {
      const { errors } = loadConnectionPacks({ roots: [dir] });
      const e = errors.find((x) => x.pack.endsWith('ct-badreach'));
      expect(e?.code).toBe('validation_error');
      expect(e?.message).toMatch(/connection-pack-manifest|reach/i);
      expect(getProvider('ct-badreach')).toBeNull(); // never registered
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovery doc advertises capabilities.connections.packsSupported (§C)', async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    const server: http.Server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const PORT = (server.address() as AddressInfo).port;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/.well-known/openwop`);
      const doc = await r.json() as { capabilities?: { connections?: { packsSupported?: boolean } } };
      expect(doc.capabilities?.connections?.packsSupported).toBe(true);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('the in-tree example pack auto-loads at boot, and an unknown provider → connection_provider_unresolved (§B.6, Option C)', async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    const server: http.Server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const PORT = (server.address() as AddressInfo).port;
    const hdrs = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
    try {
      // examples/connection-packs/github auto-loaded → `github` resolvable, honest oauthConfigured:false (no host creds).
      const provs = await (await fetch(`http://127.0.0.1:${PORT}/v1/host/openwop-app/providers`, { headers: hdrs })).json() as { providers: { id: string; reach: string; oauthConfigured?: boolean }[] };
      const gh = provs.providers.find((p) => p.id === 'github');
      expect(gh?.reach).toBe('mcp');
      expect(gh?.oauthConfigured).toBe(false);
      // ADR 0149 Phase 4: the new connection packs auto-load + resolve (schema-valid),
      // honest oauthConfigured:false (no host creds in CI).
      for (const id of ['google-ads', 'meta-ads', 'netsuite']) {
        const p = provs.providers.find((x) => x.id === id);
        expect(p, `provider ${id} should resolve`).toBeTruthy();
        expect(p?.reach).toBe('openapi');
        expect(p?.oauthConfigured).toBe(false);
      }
      // Option C: an unknown provider at the create seam → the spec code, 404.
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/host/openwop-app/connections`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ provider: 'doesnotexist', kind: 'api_key', secret: 'x', scope: 'user' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error?: string; code?: string };
      expect(body.error ?? body.code).toBe('connection_provider_unresolved');
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
