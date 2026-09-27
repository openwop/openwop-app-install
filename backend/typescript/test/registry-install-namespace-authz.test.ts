/**
 * ADR 0660 D1/D3 — the install path's OWN witnesses. Born red on `84828d148`.
 *
 * Why this file did not exist: `installPackFromRegistry` is mocked in every test that
 * touches it (`marketplace-route.test.ts:20`, `workflow-chain-pack-install-route.test.ts:19`)
 * and `marketplace-install-error.test.ts` covers only error-string mapping. So the verify
 * path had ZERO coverage, and a wrong-namespace key, an unreachable discovery document or a
 * duplicate-`pack.json` tarball would all have installed silently.
 *
 * What is under test is the spec's STEP 4 (`spec/v1/registry-operations.md:405-409`), which
 * this host did not implement: the signature proves the key signed the pack; the registry's
 * `signingKeys[].permittedNamespaces` proves it was ALLOWED to. Steps 1-3 accept any key the
 * registry serves, so step 4 is the only thing separating publisher namespaces.
 *
 * No network: `globalThis.fetch` is stubbed and the installer already takes `registry`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { installPackFromRegistry } from '../src/packs/registryInstaller.js';
import { __resetRegistryDiscoveryCache } from '../src/host/packSignature.js';

const REGISTRY = 'https://registry.test';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

let workdir: string;
let packDir: string;
const realFetch = globalThis.fetch;

/** A real gzipped tar containing the given files, built with the same `tar` the installer runs. */
function tarball(files: Record<string, string>): Buffer {
  const src = mkdtempSync(join(workdir, 'src-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
  const out = join(workdir, `t-${Math.random().toString(16).slice(2)}.tar`);
  const r = spawnSync('tar', ['-cf', out, '-C', src, ...Object.keys(files)]);
  expect(r.status, 'the fixture tar must build — otherwise every leg here is vacuous').toBe(0);
  return gzipSync(readFileSync(out));
}

function packJson(name: string, version: string, keyId: string): string {
  return JSON.stringify({
    name, version, description: 'fixture', author: 'test', license: 'Apache-2.0',
    // This suite isolates v1 registry signing/namespace behavior while the
    // host serves major 2. Keep the fixture admissible on both majors so the
    // shared production admission gate does not (correctly) fail first.
    engines: { openwop: '>=1.0.0 <3.0.0' },
    signing: { method: 'ed25519', publicKeyRef: keyId },
    runtime: { language: 'javascript', format: 'esm', entry: './index.mjs', minRuntimeVersion: 'node>=20' },
    nodes: [],
  }, null, 2);
}

/** Stub the four registry endpoints the installer touches. */
function serve(opts: {
  name: string; version: string; keyId: string; tgz: Buffer; signedBytes: Buffer;
  signingKeys?: unknown; wellKnownStatus?: number;
}): void {
  const sig = edSign(null, opts.signedBytes, privateKey);
  const integrity = `sha256-${createHash('sha256').update(opts.tgz).digest('base64')}`;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    const ok = (body: string | Uint8Array, type = 'application/json'): Response =>
      new Response(body as unknown as string, { status: 200, headers: { 'content-type': type } });
    if (u.endsWith('.json') && u.includes('/v1/packs/')) {
      return ok(JSON.stringify({ name: opts.name, version: opts.version, integrity, signing: { method: 'ed25519', publicKeyRef: opts.keyId } }));
    }
    if (u.endsWith('.tgz')) return ok(new Uint8Array(opts.tgz), 'application/gzip');
    if (u.endsWith('.sig')) return ok(new Uint8Array(sig), 'application/octet-stream');
    if (u.endsWith('/keys/' + opts.keyId + '.pub')) return ok(PUB_PEM, 'text/plain');
    if (u.endsWith('/.well-known/openwop-registry.json')) {
      if (opts.wellKnownStatus && opts.wellKnownStatus !== 200) return new Response('nope', { status: opts.wellKnownStatus });
      // ADR 0663: a conformant registry serves `endpoints` alongside
      // `signingKeys` — the installer resolves paths through it rather than
      // constructing them, and this fixture is the same ONE document both
      // readers consume. The v1 templates keep this suite's URL shapes.
      return ok(JSON.stringify({
        signingKeys: opts.signingKeys ?? [{ keyId: opts.keyId, permittedNamespaces: ['acme.*'] }],
        endpoints: {
          publicKey: '/keys/{keyId}.pub',
          v1: {
            versionManifest: '/v1/packs/{name}/-/{version}.json',
            versionTarball: '/v1/packs/{name}/-/{version}.tgz',
            versionSignature: '/v1/packs/{name}/-/{version}.sig',
          },
        },
      }));
    }
    throw new Error(`unstubbed fetch: ${u}`);
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'adr0660-'));
  packDir = mkdtempSync(join(workdir, 'packs-'));
  __resetRegistryDiscoveryCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(workdir, { recursive: true, force: true });
  __resetRegistryDiscoveryCache();
});

const install = (name: string, version = '1.0.0') =>
  installPackFromRegistry({ name, version }, { packDir, registry: REGISTRY });

describe('ADR 0660 D1 — the registry must AUTHORIZE the key for the pack namespace', () => {
  it('refuses a key that is not permitted for the namespace (a key issued for acme.* signing core.openwop.*)', async () => {
    const pj = packJson('core.openwop.evil', '1.0.0', 'acme-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'core.openwop.evil', version: '1.0.0', keyId: 'acme-key', tgz, signedBytes: Buffer.from(pj) });

    await expect(install('core.openwop.evil')).rejects.toThrow(/pack_signature_invalid/);
    expect(existsSync(join(packDir, 'core.openwop.evil')), 'nothing reached disk').toBe(false);
  });

  it('CONTROL: the same key, the same signature, an authorized namespace ⇒ installs', async () => {
    const pj = packJson('acme.widgets', '1.0.0', 'acme-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'acme.widgets', version: '1.0.0', keyId: 'acme-key', tgz, signedBytes: Buffer.from(pj) });

    expect(await install('acme.widgets')).toEqual({ installed: true });
    expect(existsSync(join(packDir, 'acme.widgets', 'pack.json'))).toBe(true);
  });

  it('a key absent from signingKeys[] is refused even though its signature verifies', async () => {
    const pj = packJson('acme.widgets', '1.0.0', 'ghost-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'acme.widgets', version: '1.0.0', keyId: 'ghost-key', tgz, signedBytes: Buffer.from(pj), signingKeys: [{ keyId: 'someone-else', permittedNamespaces: ['acme.*'] }] });

    await expect(install('acme.widgets')).rejects.toThrow(/pack_signature_invalid/);
  });

  it('an UNREACHABLE discovery document is a typed refusal, never a pass', async () => {
    const pj = packJson('acme.widgets', '1.0.0', 'acme-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'acme.widgets', version: '1.0.0', keyId: 'acme-key', tgz, signedBytes: Buffer.from(pj), wellKnownStatus: 503 });

    // The whole point: a check that degrades to "allow" when the network hiccups is
    // not a check — it is the original defect with a nondeterministic trigger.
    await expect(install('acme.widgets')).rejects.toThrow(/pack_registry_unreachable/);
    expect(existsSync(join(packDir, 'acme.widgets'))).toBe(false);
  });

  it('a namespace prefix must respect the dot boundary (acme.* does not admit acmecorp.*)', async () => {
    const pj = packJson('acmecorp.widgets', '1.0.0', 'acme-key');
    const tgz = tarball({ 'pack.json': pj, 'index.mjs': 'export default {}' });
    serve({ name: 'acmecorp.widgets', version: '1.0.0', keyId: 'acme-key', tgz, signedBytes: Buffer.from(pj) });

    await expect(install('acmecorp.widgets')).rejects.toThrow(/pack_signature_invalid/);
  });
});

describe('ADR 0660 D3 — verify one artifact, install another', () => {
  it('refuses a tarball whose SECOND root pack.json overwrites the one that was verified', async () => {
    // `extractPackJsonFromTarball` reads the FIRST entry; `tar -xzf` lets the LAST win on
    // disk. So signature + canonical-manifest gate both validate bytes that never land.
    const benign = packJson('acme.widgets', '1.0.0', 'acme-key');
    const hostile = packJson('acme.widgets', '1.0.0', 'acme-key').replace('"fixture"', '"HOSTILE"');
    const src = mkdtempSync(join(workdir, 'dup-'));
    mkdirSync(join(src, 'a')); mkdirSync(join(src, 'b'));
    writeFileSync(join(src, 'a', 'pack.json'), benign);
    writeFileSync(join(src, 'b', 'pack.json'), hostile);
    writeFileSync(join(src, 'index.mjs'), 'export default {}');
    const out = join(workdir, 'dup.tar');
    // Two entries BOTH named `pack.json` at the root, in order: benign then hostile.
    const r = spawnSync('tar', ['-cf', out, '-C', join(src, 'a'), 'pack.json', '-C', join(src, 'b'), 'pack.json', '-C', src, 'index.mjs']);
    expect(r.status, 'the duplicate-entry fixture must build').toBe(0);
    const tgz = gzipSync(readFileSync(out));

    serve({ name: 'acme.widgets', version: '1.0.0', keyId: 'acme-key', tgz, signedBytes: Buffer.from(benign) });

    await expect(install('acme.widgets')).rejects.toThrow(/pack_integrity_mismatch/);
  });
});
