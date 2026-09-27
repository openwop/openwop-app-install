/**
 * ADR 0713 — the installer reads a v2 manifest's signing block the way v2 defines it.
 *
 * MEASURED 2026-09-16 on the production boot: 0 registry installs succeeded. Every
 * v2-tree pack failed `pack_signature_unverifiable: no signing.publicKeyRef in
 * manifest`, because v2 manifests carry `signing: { keyId, scheme }` and
 * `spec/v2/core/packs.md` §Signing says "`publicKeyRef` does not exist". ADR 0663
 * had moved the host onto the v2 tree without moving this reader, and the
 * image-vendored copy served every pack instead. Reproduced against the LIVE
 * registry (`core.openwop.rag@1.0.2`): origin/main fails exactly so; this change installs.
 *
 * `registry-install-namespace-authz.test.ts` keeps the v1-tree legs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { installPackFromRegistry, manifestSigningKeyId, V2_SIGNING_SCHEME } from '../src/packs/registryInstaller.js';
import { __resetRegistryDiscoveryCache } from '../src/host/packSignature.js';
import { resetRegistryEndpointCache } from '../src/packs/registryEndpoints.js';

const REGISTRY = 'https://registry-v2.test';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
/** The signing block a live v2 manifest carries (packs.openwop.dev, 2026-09-16). */
const LIVE_V2_SIGNING = { keyId: 'openwop-team-1', scheme: 'ed25519-canonical-json' };

let workdir: string;
let packDir: string;
const realFetch = globalThis.fetch;

function tarball(files: Record<string, string>): Buffer {
  const src = mkdtempSync(join(workdir, 'src-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
  const out = join(workdir, `t-${Math.random().toString(16).slice(2)}.tar`);
  const r = spawnSync('tar', ['-cf', out, '-C', src, ...Object.keys(files)]);
  expect(r.status, 'the fixture tar must build — otherwise every leg here is vacuous').toBe(0);
  return gzipSync(readFileSync(out));
}

function packJson(name: string, keyId: string): string {
  return JSON.stringify({
    name, version: '1.0.0', kind: 'node', description: 'fixture', author: 'test', license: 'Apache-2.0',
    engines: { openwop: '>=1.0.0 <3.0.0' },
    signing: { keyId, scheme: V2_SIGNING_SCHEME },
    runtime: { language: 'javascript', format: 'esm', entry: './index.mjs', minRuntimeVersion: 'node>=20' },
    nodes: [],
  }, null, 2);
}

/** A registry that publishes BOTH trees, like packs.openwop.dev: the host (major 2)
 *  must choose `v2`, and only the v2 paths answer. */
function serve(opts: { name: string; keyId: string; signing: unknown; tgz: Buffer; signedBytes: Buffer; permitted?: string[] }): void {
  const sig = edSign(null, opts.signedBytes, privateKey);
  const integrity = `sha256-${createHash('sha256').update(opts.tgz).digest('base64')}`;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    const ok = (body: string | Uint8Array, type = 'application/json'): Response =>
      new Response(body as unknown as string, { status: 200, headers: { 'content-type': type } });
    if (u.includes('/v1/packs/')) return new Response('not in the v1 tree', { status: 404 });
    if (u.endsWith('.json') && u.includes('/v2/packs/')) {
      return ok(JSON.stringify({ name: opts.name, version: '1.0.0', kind: 'node', integrity, signing: opts.signing }));
    }
    if (u.endsWith('.tgz')) return ok(new Uint8Array(opts.tgz), 'application/gzip');
    if (u.endsWith('.sig')) return ok(new Uint8Array(sig), 'application/octet-stream');
    if (u.endsWith(`/keys/${opts.keyId}.pub`)) return ok(PUB_PEM, 'text/plain');
    if (u.endsWith('/.well-known/openwop-registry.json')) {
      return ok(JSON.stringify({
        signingKeys: [{ keyId: opts.keyId, permittedNamespaces: opts.permitted ?? ['acme.*'] }],
        endpoints: {
          publicKey: '/keys/{keyId}.pub',
          versionManifest: '/v1/packs/{name}/-/{version}.json',
          v1: { versionManifest: '/v1/packs/{name}/-/{version}.json', versionTarball: '/v1/packs/{name}/-/{version}.tgz', versionSignature: '/v1/packs/{name}/-/{version}.sig' },
          v2: { versionManifest: '/v2/packs/{name}/-/{version}.json', versionTarball: '/v2/packs/{name}/-/{version}.tgz', versionSignature: '/v2/packs/{name}/-/{version}.sig' },
        },
      }));
    }
    throw new Error(`unstubbed fetch: ${u}`);
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'adr0713-'));
  packDir = mkdtempSync(join(workdir, 'packs-'));
  __resetRegistryDiscoveryCache();
  resetRegistryEndpointCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(workdir, { recursive: true, force: true });
  __resetRegistryDiscoveryCache();
  resetRegistryEndpointCache();
});

const install = (name: string) => installPackFromRegistry({ name, version: '1.0.0' }, { packDir, registry: REGISTRY });

describe('ADR 0713 — manifestSigningKeyId reads the block its tree defines', () => {
  it('v2: the live block yields its keyId', () => {
    expect(manifestSigningKeyId(LIVE_V2_SIGNING, 'v2')).toBe('openwop-team-1');
  });
  it('v2: no keyId, another scheme, or a v1 field is refused', () => {
    expect(() => manifestSigningKeyId({ scheme: V2_SIGNING_SCHEME }, 'v2')).toThrow(/pack_signature_unverifiable/);
    expect(() => manifestSigningKeyId({ keyId: 'k', scheme: 'ed25519' }, 'v2')).toThrow(/pack_signature_unverifiable/);
    expect(() => manifestSigningKeyId({ ...LIVE_V2_SIGNING, method: 'manual' }, 'v2')).toThrow(/v1 field/);
    expect(() => manifestSigningKeyId({ method: 'manual', publicKeyRef: 'k' }, 'v2')).toThrow(/pack_signature_unverifiable/);
    expect(() => manifestSigningKeyId(undefined, 'v2')).toThrow(/pack_signature_unverifiable/);
  });
  it('v1: publicKeyRef, unchanged — and a v2 block is not a v1 one', () => {
    expect(manifestSigningKeyId({ method: 'manual', publicKeyRef: 'openwop-team-1' }, 'v1')).toBe('openwop-team-1');
    expect(() => manifestSigningKeyId(LIVE_V2_SIGNING, 'v1')).toThrow(/no signing.publicKeyRef/);
  });
});

describe('ADR 0713 — a v2-tree install verifies and lands', () => {
  it('installs a pack whose manifest carries the v2 signing block, and records the keyId', async () => {
    const pj = packJson('acme.widgets', 'acme-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'acme.widgets', keyId: 'acme-key', signing: { keyId: 'acme-key', scheme: V2_SIGNING_SCHEME }, tgz, signedBytes: Buffer.from(pj) });

    expect(await install('acme.widgets')).toEqual({ installed: true });
    const marker = JSON.parse(readFileSync(join(packDir, 'acme.widgets', '.openwop-installed.json'), 'utf-8')) as { publicKeyRef: string };
    expect(marker.publicKeyRef).toBe('acme-key');
  });

  it('still verifies the SIGNATURE — a v2 block over bytes the key did not sign is refused', async () => {
    const pj = packJson('acme.widgets', 'acme-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'acme.widgets', keyId: 'acme-key', signing: { keyId: 'acme-key', scheme: V2_SIGNING_SCHEME }, tgz, signedBytes: Buffer.from(`${pj} `) });

    await expect(install('acme.widgets')).rejects.toThrow(/pack_signature_invalid/);
    expect(existsSync(join(packDir, 'acme.widgets'))).toBe(false);
  });

  it('still checks the NAMESPACE — a v2 keyId not permitted for the pack is refused', async () => {
    const pj = packJson('core.openwop.evil', 'acme-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'core.openwop.evil', keyId: 'acme-key', signing: { keyId: 'acme-key', scheme: V2_SIGNING_SCHEME }, tgz, signedBytes: Buffer.from(pj) });

    await expect(install('core.openwop.evil')).rejects.toThrow(/pack_signature_invalid/);
  });

  it('refuses a v1-shaped signing block served from the v2 tree', async () => {
    const pj = packJson('acme.widgets', 'acme-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'acme.widgets', keyId: 'acme-key', signing: { method: 'manual', publicKeyRef: 'acme-key' }, tgz, signedBytes: Buffer.from(pj) });

    await expect(install('acme.widgets')).rejects.toThrow(/pack_signature_unverifiable/);
  });
});
