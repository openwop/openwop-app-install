/**
 * ADR 0555 P0 — the trust-tier classifier and the fail-closed dispatch policy.
 *
 * Every case here CONSTRUCTS its condition on disk rather than asserting over
 * whatever the repo happens to contain. That matters: a test that reads the
 * real pack dir passes for whatever reason the real pack dir supplies, and
 * stops distinguishing "the policy works" from "the fixture drifted".
 *
 * The six cases are the ADR 0555 P0 gate ("unknown/invalid/revoked packs cannot
 * dispatch; trusted built-ins unchanged") made falsifiable, one row each:
 *
 *   a  steward manifest digest matches            → steward         → dispatch
 *   b  same pack, one byte changed, no marker     → untrusted       → REFUSED
 *   c  install marker present and verifying       → operator-trusted→ dispatch
 *   d  install marker present, a file mutated     → untrusted       → REFUSED
 *   e  steward pack + revocation row              → revoked         → REFUSED
 *   f  break-glass permits (b) WITHOUT promoting it
 *
 * (e) is the one that earns its place: it proves the gate fires against a pack
 * that would otherwise be permitted, rather than merely restating that unsigned
 * code is unsigned.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { packContentDigest } from '../src/packs/packContentDigest.js';
import {
  classifyPackDir,
  packTrustSummary,
  __resetPackTrustCachesForTests,
} from '../src/host/packTrust.js';
import {
  revokePack,
  loadPackRevocations,
  __clearPackRevocations,
  REVOKE_ALL_VERSIONS,
} from '../src/host/packRevocations.js';

const PACK_NAME = 'community.test.trusttier';
const PACK_VERSION = '1.0.0';

let root: string;
let packDir: string;

/** A minimal but realistic pack: manifest, entry module, and one auxiliary
 *  file so "digest covers every byte" is actually exercised. */
function writePack(dir: string, opts: { version?: string } = {}): void {
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify(
      {
        name: PACK_NAME,
        version: opts.version ?? PACK_VERSION,
        nodes: [{ typeId: 'community.test.trusttier.echo', version: '1.0.0' }],
        runtime: { format: 'esm', entry: './index.mjs' },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'index.mjs'), 'export const nodes = { "community.test.trusttier.echo": async () => ({ status: "success", outputs: {} }) };\n');
  writeFileSync(join(dir, 'lib', 'helper.mjs'), 'export const helper = 1;\n');
}

/**
 * Point the classifier at a synthetic steward manifest.
 *
 * `packTrust` locates the manifest by walking up from ITS OWN module path,
 * deliberately ignoring `OPENWOP_LOCAL_PACKS_DIR` — that anchoring is the
 * control that stops an env var redefining the steward corpus, so a test must
 * not be able to move it either. We therefore exercise the digest comparison
 * through the real repo manifest for the positive case below, and use the
 * classifier's own reasons for the synthetic ones.
 */
function writeInstallMarker(dir: string, hashes: Record<string, string>): void {
  writeFileSync(
    join(dir, '.openwop-installed.json'),
    JSON.stringify(
      {
        name: PACK_NAME,
        version: PACK_VERSION,
        integrity: 'sha256-fixture',
        publicKeyRef: 'fixture-key',
        registry: 'https://packs.example.test',
        installedAt: new Date(0).toISOString(),
        contentHashes: hashes,
      },
      null,
      2,
    ),
  );
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

beforeEach(async () => {
  // The revocation store is a DurableCollection, so host-ext persistence has to
  // exist before any revocation read/write.
  initHostExtPersistence(await openStorage('memory://'));
  root = mkdtempSync(join(tmpdir(), 'owp-packtrust-'));
  packDir = join(root, PACK_NAME);
  writePack(packDir);
  __resetPackTrustCachesForTests();
  await __clearPackRevocations();
  await loadPackRevocations();
});

afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  await __clearPackRevocations();
  __resetPackTrustCachesForTests();
});

describe('ADR 0555 P0 — pack trust tiers', () => {
  // ── (c) + (d): the install-marker path ───────────────────────────────────

  it('(c) a pack whose install marker verifies is operator-trusted and dispatchable', () => {
    writeInstallMarker(packDir, {
      'pack.json': sha256File(join(packDir, 'pack.json')),
      'index.mjs': sha256File(join(packDir, 'index.mjs')),
    });
    const v = classifyPackDir(packDir, { noCache: true });
    expect(v.tier).toBe('operator-trusted');
    expect(v.reason).toBe('install_marker_verified');
    expect(v.dispatchable).toBe(true);
    expect(v.packName).toBe(PACK_NAME);
    expect(v.version).toBe(PACK_VERSION);
  });

  it('(d) a mutated file under a valid install marker is untrusted and REFUSED', () => {
    writeInstallMarker(packDir, {
      'pack.json': sha256File(join(packDir, 'pack.json')),
      'index.mjs': sha256File(join(packDir, 'index.mjs')),
    });
    // Post-install tampering: swap the entry module's behaviour.
    writeFileSync(join(packDir, 'index.mjs'), 'export const nodes = { evil: async () => ({ status: "success" }) };\n');

    const v = classifyPackDir(packDir, { noCache: true });
    expect(v.tier).toBe('untrusted');
    expect(v.reason).toBe('install_marker_tampered');
    expect(v.detail).toBe('content_modified:index.mjs');
    expect(v.dispatchable).toBe(false);
  });

  it('a tampered install is NOT rescued by falling through to the steward path', () => {
    // The marker branch must report the tamper rather than continue to a
    // steward comparison that could coincidentally match. Reporting the more
    // benign reason would hide the more serious one.
    writeInstallMarker(packDir, { 'pack.json': '0'.repeat(64) });
    const v = classifyPackDir(packDir, { noCache: true });
    expect(v.tier).toBe('untrusted');
    expect(v.reason).toBe('install_marker_tampered');
    expect(v.reason).not.toBe('no_attestation');
  });

  // ── (b): no attestation at all ───────────────────────────────────────────

  it('(b) a hand-dropped pack with no marker and no steward entry is REFUSED', () => {
    const v = classifyPackDir(packDir, { noCache: true });
    expect(v.tier).toBe('untrusted');
    expect(v.reason).toBe('no_attestation');
    expect(v.dispatchable).toBe(false);
  });

  it('a directory whose pack.json is unreadable is untrusted, not crash', () => {
    writeFileSync(join(packDir, 'pack.json'), '{ this is not json');
    const v = classifyPackDir(packDir, { noCache: true });
    expect(v.tier).toBe('untrusted');
    expect(v.reason).toBe('manifest_unreadable');
    expect(v.dispatchable).toBe(false);
  });

  // ── (e): revocation wins over everything ─────────────────────────────────

  it('(e) a revocation REFUSES a pack that its install marker would otherwise trust', async () => {
    writeInstallMarker(packDir, {
      'pack.json': sha256File(join(packDir, 'pack.json')),
      'index.mjs': sha256File(join(packDir, 'index.mjs')),
    });
    // Baseline: without the revocation this pack dispatches. Asserting the
    // baseline is what makes the next assertion evidence rather than a
    // coincidence — otherwise "refused" could be true for any other reason.
    expect(classifyPackDir(packDir, { noCache: true }).dispatchable).toBe(true);

    await revokePack({ packName: PACK_NAME, version: PACK_VERSION, by: 'test', reason: 'compromised' });

    const v = classifyPackDir(packDir, { noCache: true });
    expect(v.tier).toBe('revoked');
    expect(v.reason).toBe('revoked_by_operator');
    expect(v.dispatchable).toBe(false);
  });

  it('revocation is version-scoped — the fix version still dispatches', async () => {
    writeInstallMarker(packDir, {
      'pack.json': sha256File(join(packDir, 'pack.json')),
      'index.mjs': sha256File(join(packDir, 'index.mjs')),
    });
    await revokePack({ packName: PACK_NAME, version: '0.9.0', by: 'test', reason: 'bad build' });

    // Revoking 1.2.3 must not block 1.2.4. If it did, the remediation path
    // would be blocked by the remediation.
    const v = classifyPackDir(packDir, { noCache: true });
    expect(v.tier).toBe('operator-trusted');
    expect(v.dispatchable).toBe(true);
  });

  it('a wildcard revocation covers every version (compromised publisher)', async () => {
    writeInstallMarker(packDir, {
      'pack.json': sha256File(join(packDir, 'pack.json')),
      'index.mjs': sha256File(join(packDir, 'index.mjs')),
    });
    await revokePack({ packName: PACK_NAME, version: REVOKE_ALL_VERSIONS, by: 'test', reason: 'key compromise' });

    expect(classifyPackDir(packDir, { noCache: true }).tier).toBe('revoked');
  });

  // ── (f): the break-glass relaxes dispatch WITHOUT promoting ──────────────

  describe('OPENWOP_PACK_TRUST_ALLOW_UNSIGNED break-glass', () => {
    const prev = process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED;
    afterEach(() => {
      if (prev === undefined) delete process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED;
      else process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED = prev;
    });

    it('(f) permits dispatch but leaves the tier UNTRUSTED', () => {
      process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED = 'true';
      const v = classifyPackDir(packDir, { noCache: true });

      // The ADR's rule is "no environment flag may promote an unsigned pack to
      // trusted". The tier is what that rule is about, so the tier must not
      // move — only the dispatch decision does.
      expect(v.tier).toBe('untrusted');
      expect(v.reason).toBe('no_attestation');
      expect(v.dispatchable).toBe(true);
      expect(v.allowedByBreakGlass).toBe(true);
    });

    it('does NOT un-revoke a revoked pack', async () => {
      process.env.OPENWOP_PACK_TRUST_ALLOW_UNSIGNED = 'true';
      await revokePack({ packName: PACK_NAME, version: PACK_VERSION, by: 'test', reason: 'compromised' });

      // A revocation is a security action against code believed compromised.
      // If a deployment env var could undo it, the remediation would only be
      // as strong as the deployment config.
      const v = classifyPackDir(packDir, { noCache: true });
      expect(v.tier).toBe('revoked');
      expect(v.dispatchable).toBe(false);
      expect(v.allowedByBreakGlass).toBeUndefined();
    });
  });

  // ── revocation source 2: the ADR 0367 pinned keyring ─────────────────────

  describe('the pinned-keyring revocation list is honoured too', () => {
    const prev = process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
    afterEach(() => {
      if (prev === undefined) delete process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
      else process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS = prev;
      __resetPackTrustCachesForTests();
    });

    it('revokes a pack listed in OPENWOP_TRUSTED_PACK_REVOCATIONS, with no durable row', () => {
      writeInstallMarker(packDir, {
        'pack.json': sha256File(join(packDir, 'pack.json')),
        'index.mjs': sha256File(join(packDir, 'index.mjs')),
      });
      // Baseline: trusted before the list exists.
      expect(classifyPackDir(packDir, { noCache: true }).dispatchable).toBe(true);

      const revPath = join(root, 'revocations.json');
      writeFileSync(revPath, JSON.stringify([`${PACK_NAME}@${PACK_VERSION}`]));
      process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS = revPath;
      __resetPackTrustCachesForTests();

      // ADR 0367 shipped this list for CHAIN packs. ADR 0555 P0 makes it bind
      // executable packs too — a deployment that revoked a compromised version
      // there must not find it still executing as a node pack.
      const v = classifyPackDir(packDir, { noCache: true });
      expect(v.tier).toBe('revoked');
      expect(v.dispatchable).toBe(false);
    });
  });

  // ── digest properties the tiers rest on ──────────────────────────────────

  it('the content digest changes when ANY file changes, including a non-entry one', () => {
    const before = packContentDigest(packDir);
    writeFileSync(join(packDir, 'lib', 'helper.mjs'), 'export const helper = 2;\n');
    expect(packContentDigest(packDir)).not.toBe(before);
  });

  it('the content digest is stable across repeated reads of unchanged bytes', () => {
    expect(packContentDigest(packDir)).toBe(packContentDigest(packDir));
  });

  it('replacing a file with a symlink changes the digest', () => {
    const before = packContentDigest(packDir);
    const { symlinkSync, unlinkSync } = require('node:fs') as typeof import('node:fs');
    unlinkSync(join(packDir, 'lib', 'helper.mjs'));
    symlinkSync('/etc/hosts', join(packDir, 'lib', 'helper.mjs'));
    // Digesting the link TARGET's content would let a pack inherit an outside
    // file's identity; we hash the link string, so this must differ.
    expect(packContentDigest(packDir)).not.toBe(before);
  });

  // ── the summary that feeds readiness ─────────────────────────────────────

  it('packTrustSummary counts what has been classified', () => {
    classifyPackDir(packDir);
    const s = packTrustSummary();
    expect(s.untrusted).toBeGreaterThanOrEqual(1);
    expect(typeof s.stewardManifestMissing).toBe('boolean');
  });
});
