/**
 * packSignature (ADR 0367 Phase 1) — the trust-boundary pins. The load-bearing
 * distinction: `verifySelfAttested` (pack-supplied key — integrity only) can
 * never yield trust; `verifyPinned` trusts ONLY a valid signature by an
 * operator-pinned key on a non-revoked version, and every failure path is
 * closed (unsigned / unknown key id / tampered manifest / revoked / missing
 * files → never 'trusted').
 *
 * The tampered-manifest case carries the GENUINE signature beside the altered
 * pack.json, so only the tamper can fail it: a verifier that checked the
 * in-memory manifest instead of the on-disk bytes goes red (probe
 * 8fw1g1-sg-tamper-bytes; with a garbage sig.bin it was vacuous).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { copyFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySelfAttested, verifyPinned, loadPinnedKeyring, type PinnedKeyring } from '../src/host/packSignature.js';

let packDir: string;
let keyring: PinnedKeyring;
let strangerKeyring: PinnedKeyring;
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
const manifest = { name: 'vendor.demo', version: '1.0.0', signing: { publicKeyRef: 'pub.pem', signatureRef: 'sig.bin', keyId: 'openwop-team-1' } };

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const stranger = generateKeyPairSync('ed25519');
  packDir = tempDir('packsig-');
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(packDir, 'pack.json'), manifestBytes);
  writeFileSync(join(packDir, 'pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(packDir, 'sig.bin'), edSign(null, manifestBytes, privateKey));
  keyring = { keys: { 'openwop-team-1': publicKey.export({ type: 'spki', format: 'pem' }).toString() }, revoked: new Set() };
  strangerKeyring = { keys: { 'openwop-team-1': stranger.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, revoked: new Set() };
});

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('verifyPinned (the ADR 0367 trust boundary)', () => {
  it('trusts a valid signature by a pinned key on a non-revoked version', () => {
    expect(verifyPinned(packDir, manifest, keyring)).toBe('trusted');
  });
  it('a self-consistent pack signed by the WRONG key fails — the pack cannot vouch for itself', () => {
    expect(verifyPinned(packDir, manifest, strangerKeyring)).toBe('failed');
  });
  it('unknown key id fails closed', () => {
    expect(verifyPinned(packDir, { ...manifest, signing: { ...manifest.signing, keyId: 'nobody' } }, keyring)).toBe('failed');
  });
  it('no signing block / no keyId → unsigned (tier 2, never trusted)', () => {
    expect(verifyPinned(packDir, { name: 'x', version: '1' }, keyring)).toBe('unsigned');
    expect(verifyPinned(packDir, { ...manifest, signing: { signatureRef: 'sig.bin' } }, keyring)).toBe('unsigned');
  });
  it('a revoked version is refused even with a valid signature', () => {
    const revokedRing: PinnedKeyring = { keys: keyring.keys, revoked: new Set(['vendor.demo@1.0.0']) };
    expect(verifyPinned(packDir, manifest, revokedRing)).toBe('revoked');
  });
  it('a tampered manifest fails', () => {
    const dir2 = tempDir('packsig-t-');
    // The on-disk pack.json is altered; the signature is the GENUINE one over
    // the original bytes, and the caller passes the original manifest object.
    // Only reading the tampered bytes from disk can fail this.
    writeFileSync(join(dir2, 'pack.json'), Buffer.from(JSON.stringify({ ...manifest, version: '6.6.6' })));
    copyFileSync(join(packDir, 'sig.bin'), join(dir2, 'sig.bin'));
    expect(verifyPinned(dir2, manifest, keyring)).toBe('failed');
    // Positive control: the same genuine signature beside the ORIGINAL bytes passes.
    copyFileSync(join(packDir, 'pack.json'), join(dir2, 'pack.json'));
    expect(verifyPinned(dir2, manifest, keyring)).toBe('trusted');
  });
});

describe('loadPinnedKeyring failure semantics (grade pass 2026-07-14)', () => {
  it('an unreadable revocation file fails CLOSED — empty keyring, not empty revocations', () => {
    const dir = tempDir('packsig-rev-');
    const keysDir = join(dir, 'keys');
    mkdirSync(keysDir);
    writeFileSync(join(keysDir, 'k.pem'), keyring.keys['openwop-team-1'] ?? '');
    writeFileSync(join(keysDir, 'index.json'), JSON.stringify([{ keyId: 'openwop-team-1', file: 'k.pem' }]));
    const revPath = join(dir, 'revoked.json');
    writeFileSync(revPath, 'not json at all');
    const savedKeysDir = process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
    const savedRevocations = process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
    process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR = keysDir;
    process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS = revPath;
    try {
      const ring = loadPinnedKeyring();
      expect(Object.keys(ring.keys)).toHaveLength(0); // nothing trusted while revocations are unreadable
      // and a healthy revocation file restores the keys
      writeFileSync(revPath, JSON.stringify(['some.pack@1.0.0']));
      const healthy = loadPinnedKeyring();
      expect(Object.keys(healthy.keys)).toHaveLength(1);
      expect(healthy.revoked.has('some.pack@1.0.0')).toBe(true);
    } finally {
      if (savedKeysDir === undefined) delete process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
      else process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR = savedKeysDir;
      if (savedRevocations === undefined) delete process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
      else process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS = savedRevocations;
    }
  });
});

describe('verifySelfAttested (integrity only — the pre-existing semantics)', () => {
  it('verifies the pack-supplied key/signature pair', () => {
    expect(verifySelfAttested(packDir, manifest.signing, manifest.name)).toBe('verified');
  });
  it('skips when there is no signing block; fails on missing refs', () => {
    expect(verifySelfAttested(packDir, undefined, 'x')).toBe('skipped');
    expect(verifySelfAttested(packDir, { publicKeyRef: 'pub.pem' }, 'x')).toBe('failed');
  });
});
