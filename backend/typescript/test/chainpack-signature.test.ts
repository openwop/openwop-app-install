/**
 * ADR 0427 P1 — registry-fetch chain-pack signature verification:
 *  - REGISTRY-INSTALLED packs verify against the pinned keyring at load time;
 *    with OPENWOP_REQUIRE_CHAINPACK_SIGNATURES set, an unsigned pack is
 *    REJECTED fail-closed (collected error, no chains registered, boot alive)
 *  - unset, the same pack loads (observable warn — today's behavior)
 *  - the exemption boundary holds: non-registry roots (operator override /
 *    in-tree vendored) load unsigned even under the flag (the R7 posture)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setUnpinnedChainPackWaiversForTests } from '../src/host/unpinnedChainPackAllowlist.js';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkflowChainPacks,
  _resetChainRegistryForTest,
  getChain,
} from '../src/host/workflowChainPackLoader.js';

const EXAMPLE = join(process.cwd(), '..', '..', 'examples', 'workflow-chain-packs', 'approvals');

const waivedSigtestPacks: string[] = [];
let installRoot = '';
let otherRoot = '';

/** Copy the vendored approvals pack under `root` with a unique name + chainIds. */
function plantPack(root: string, suffix: string): string[] {
  const dir = join(root, `sigtest-${suffix}`);
  cpSync(EXAMPLE, dir, { recursive: true });
  const manifestPath = join(dir, 'pack.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string;
    chains: Array<{ chainId: string; dag: { nodes: Array<{ typeId: string }> } }>;
  };
  manifest.name = `private.sigtest.${suffix}`;
  // ADR 0766 D5 — this file exercises the V1 signing block (`publicKeyRef` /
  // `signatureRef`). A v1 block can only ride a v1-shaped manifest: a node pin
  // routes the manifest to the v2 schema, which refuses a v1 block, and the v1
  // schema refuses a pin. So the copy is made v1-shaped (pins stripped) and, being
  // unpinned, registers only when waived — which is exactly a legacy v1 pack.
  for (const c of manifest.chains) for (const n of c.dag.nodes) n.typeId = n.typeId.replace(/@[0-9.]+$/, '');
  waivedSigtestPacks.push(manifest.name);
  __setUnpinnedChainPackWaiversForTests(waivedSigtestPacks);
  for (const c of manifest.chains) c.chainId = `sigtest-${suffix}.${c.chainId}`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest.chains.map((c) => c.chainId);
}

let keysDir = '';

/** Sign the planted pack's FINAL manifest bytes with a freshly pinned key. */
function signPack(root: string, suffix: string, keyId: string): void {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${keyId}.pem`), publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(keysDir, 'index.json'), JSON.stringify([{ keyId, file: `${keyId}.pem` }]));
  const dir = join(root, `sigtest-${suffix}`);
  const manifestPath = join(dir, 'pack.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.signing = { signatureRef: 'pack.sig', publicKeyRef: keyId }; // keyId rides the documented publicKeyRef alias
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'pack.sig'), edSign(null, readFileSync(manifestPath), privateKey));
}

let prevPackDir: string | undefined;

beforeEach(() => {
  _resetChainRegistryForTest();
  prevPackDir = process.env.OPENWOP_PACK_DIR;
  installRoot = mkdtempSync(join(tmpdir(), 'owp-chainpack-install-'));
  otherRoot = mkdtempSync(join(tmpdir(), 'owp-chainpack-other-'));
  keysDir = mkdtempSync(join(tmpdir(), 'owp-chainpack-keys-'));
  process.env.OPENWOP_PACK_DIR = installRoot; // resolveDefaultPackDir() → installRoot
  process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR = keysDir;
});

afterEach(() => {
  waivedSigtestPacks.length = 0;
  __setUnpinnedChainPackWaiversForTests(null);
  // RESTORE, never delete: `test/setup/isolatePackDir.ts` assigns this ONCE PER
  // WORKER and only when unset, and process.env outlives a FILE inside a worker.
  // Deleting it dropped every LATER file in this worker to the shared
  // `~/.openwop-packs` — the cross-session contended dir — because
  // `resolveDefaultPackDir()` reads this at call time.
  if (prevPackDir === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = prevPackDir;
  delete process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES;
  delete process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
  delete process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
  rmSync(installRoot, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });
  rmSync(keysDir, { recursive: true, force: true });
  _resetChainRegistryForTest();
});

describe('chain-pack signature posture (ADR 0427)', () => {
  it('flag unset: an unsigned registry-installed pack loads (observable, not enforced)', () => {
    const chainIds = plantPack(installRoot, 'warn');
    const outcome = loadWorkflowChainPacks({ roots: [installRoot] });
    expect(outcome.errors).toHaveLength(0);
    expect(outcome.installed.map((p) => p.packName)).toContain('private.sigtest.warn');
    expect(getChain(chainIds[0])).not.toBeNull();
  });

  it('flag set: the same pack is REJECTED fail-closed — collected error, zero chains, boot alive', () => {
    process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES = 'true';
    const chainIds = plantPack(installRoot, 'closed');
    const outcome = loadWorkflowChainPacks({ roots: [installRoot] });
    expect(outcome.installed).toHaveLength(0);
    expect(outcome.errors.map((e) => e.code)).toContain('workflow_chain_pack_signature_unsigned');
    expect(getChain(chainIds[0])).toBeNull(); // nothing partial
  });

  it('a properly signed pack under a pinned key loads with the flag SET (trusted)', () => {
    process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES = 'true';
    const chainIds = plantPack(installRoot, 'signed');
    signPack(installRoot, 'signed', 'pub-1');
    const outcome = loadWorkflowChainPacks({ roots: [installRoot] });
    expect(outcome.errors).toHaveLength(0);
    expect(getChain(chainIds[0])).not.toBeNull();
  });

  it('a REVOKED version is rejected even when correctly signed (revocation wins)', () => {
    process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES = 'true';
    const chainIds = plantPack(installRoot, 'revoked');
    signPack(installRoot, 'revoked', 'pub-2');
    const manifest = JSON.parse(readFileSync(join(installRoot, 'sigtest-revoked', 'pack.json'), 'utf8')) as { name: string; version: string };
    const revPath = join(keysDir, 'revocations.json');
    writeFileSync(revPath, JSON.stringify([`${manifest.name}@${manifest.version}`]));
    process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS = revPath;
    const outcome = loadWorkflowChainPacks({ roots: [installRoot] });
    expect(outcome.errors.map((e) => e.code)).toContain('workflow_chain_pack_signature_revoked');
    expect(getChain(chainIds[0])).toBeNull();
  });

  it('exemption boundary: a non-registry root loads unsigned even under the flag (R7 posture)', () => {
    process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES = 'true';
    const chainIds = plantPack(otherRoot, 'vendored');
    const outcome = loadWorkflowChainPacks({ roots: [otherRoot] });
    expect(outcome.errors).toHaveLength(0);
    expect(getChain(chainIds[0])).not.toBeNull();
  });
});

/** ADR 0713 OQ3 — a v2 registry install: pins kept (the v2 manifest shape), the
 *  `{ keyId, scheme }` signing block, and the installer's marker hashing pack.json.
 *  The v2 signature itself was verified at INSTALL time; at load the marker is the
 *  attestation. */
function plantV2Pack(root: string, suffix: string, opts: { marker?: boolean } = {}): { chainIds: string[]; name: string; version: string } {
  const dir = join(root, `sigtest-v2-${suffix}`);
  cpSync(EXAMPLE, dir, { recursive: true });
  const manifestPath = join(dir, 'pack.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string; version: string; signing?: unknown; chains: Array<{ chainId: string }>;
  };
  manifest.name = `private.sigtest.v2.${suffix}`;
  for (const c of manifest.chains) c.chainId = `sigtest-v2-${suffix}.${c.chainId}`;
  manifest.signing = { keyId: 'openwop-team-1', scheme: 'ed25519-canonical-json' };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (opts.marker !== false) {
    writeFileSync(join(dir, '.openwop-installed.json'), JSON.stringify({
      name: manifest.name, version: manifest.version, integrity: 'sha256-fixture', publicKeyRef: 'openwop-team-1',
      registry: 'https://packs.example.test', installedAt: new Date(0).toISOString(),
      contentHashes: { 'pack.json': createHash('sha256').update(readFileSync(manifestPath)).digest('hex') },
    }));
  }
  return { chainIds: manifest.chains.map((c) => c.chainId), name: manifest.name, version: manifest.version };
}

describe('v2 chain-pack signature posture at load (ADR 0713 OQ3, A-04)', () => {
  // Sabotage (witnessed): routing the v2 shape back to `verifyPinned` reds the
  // first case (`unsigned`); dropping the keyring revocation check from the v2
  // branch reds the last.
  it('flag set: a v2 install whose marker still matches loads (trusted, not `unsigned`)', () => {
    process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES = 'true';
    const { chainIds } = plantV2Pack(installRoot, 'ok');
    const outcome = loadWorkflowChainPacks({ roots: [installRoot] });
    expect(outcome.errors).toEqual([]);
    expect(getChain(chainIds[0])).not.toBeNull();
  });

  it('flag set: a v2 install edited after its marker was written is refused', () => {
    process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES = 'true';
    const { chainIds } = plantV2Pack(installRoot, 'tampered');
    const p = join(installRoot, 'sigtest-v2-tampered', 'pack.json');
    writeFileSync(p, `${readFileSync(p, 'utf8')}\n`);
    const outcome = loadWorkflowChainPacks({ roots: [installRoot] });
    expect(outcome.errors.map((e) => e.code)).toContain('workflow_chain_pack_signature_failed');
    expect(getChain(chainIds[0])).toBeNull();
  });

  it('flag set: a v2-shaped pack with no install marker is refused', () => {
    process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES = 'true';
    const { chainIds } = plantV2Pack(installRoot, 'unmarked', { marker: false });
    const outcome = loadWorkflowChainPacks({ roots: [installRoot] });
    expect(outcome.errors.map((e) => e.code)).toContain('workflow_chain_pack_signature_failed');
    expect(getChain(chainIds[0])).toBeNull();
  });

  it('flag set: a keyring-REVOKED v2 version is refused even with a matching marker', () => {
    process.env.OPENWOP_REQUIRE_CHAINPACK_SIGNATURES = 'true';
    const { chainIds, name, version } = plantV2Pack(installRoot, 'revoked');
    const revPath = join(keysDir, 'revocations.json');
    writeFileSync(revPath, JSON.stringify([`${name}@${version}`]));
    process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS = revPath;
    const outcome = loadWorkflowChainPacks({ roots: [installRoot] });
    expect(outcome.errors.map((e) => e.code)).toContain('workflow_chain_pack_signature_revoked');
    expect(getChain(chainIds[0])).toBeNull();
  });
});
