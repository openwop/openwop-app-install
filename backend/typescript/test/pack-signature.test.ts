/**
 * packSignature (ADR 0367 Phase 1) — the trust-boundary pins. The load-bearing
 * distinction: `verifySelfAttested` (pack-supplied key — integrity only) can
 * never yield trust; `verifyPinned` trusts ONLY a valid signature by an
 * operator-pinned key on a non-revoked version, and every failure path is
 * closed (unsigned / unknown key id / tampered manifest / revoked / missing
 * files → never 'trusted').
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySelfAttested, verifyPinned, type PinnedKeyring } from '../src/host/packSignature.js';

let packDir: string;
let keyring: PinnedKeyring;
let strangerKeyring: PinnedKeyring;
const manifest = { name: 'vendor.demo', version: '1.0.0', signing: { publicKeyRef: 'pub.pem', signatureRef: 'sig.bin', keyId: 'openwop-team-1' } };

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const stranger = generateKeyPairSync('ed25519');
  packDir = mkdtempSync(join(tmpdir(), 'packsig-'));
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(packDir, 'pack.json'), manifestBytes);
  writeFileSync(join(packDir, 'pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(packDir, 'sig.bin'), edSign(null, manifestBytes, privateKey));
  keyring = { keys: { 'openwop-team-1': publicKey.export({ type: 'spki', format: 'pem' }).toString() }, revoked: new Set() };
  strangerKeyring = { keys: { 'openwop-team-1': stranger.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, revoked: new Set() };
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
    const dir2 = mkdtempSync(join(tmpdir(), 'packsig-t-'));
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'pack.json'), Buffer.from(JSON.stringify({ ...manifest, version: '6.6.6' })));
    writeFileSync(join(dir2, 'sig.bin'), Buffer.from('not a real signature'));
    expect(verifyPinned(dir2, manifest, keyring)).toBe('failed');
  });
});

describe('loadPinnedKeyring failure semantics (grade pass 2026-07-14)', () => {
  it('an unreadable revocation file fails CLOSED — empty keyring, not empty revocations', async () => {
    const { loadPinnedKeyring } = await import('../src/host/packSignature.js');
    const dir = mkdtempSync(join(tmpdir(), 'packsig-rev-'));
    const keysDir = join(dir, 'keys');
    mkdirSync(keysDir);
    writeFileSync(join(keysDir, 'k.pem'), keyring.keys['openwop-team-1'] ?? '');
    writeFileSync(join(keysDir, 'index.json'), JSON.stringify([{ keyId: 'openwop-team-1', file: 'k.pem' }]));
    const revPath = join(dir, 'revoked.json');
    writeFileSync(revPath, 'not json at all');
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
      delete process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
      delete process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
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
