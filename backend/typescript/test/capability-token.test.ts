/**
 * ADR 0448 — the capability-token helper's own invariants. This is the ONE
 * primitive every bearer-token store now routes through, so its guarantees are
 * pinned directly (not just transitively via consumers):
 *  - mintToken produces `<prefix>_<base64url>` with 256-bit entropy, distinct
 *    per call, and its hash === hashToken(raw);
 *  - a minted raw token can NEVER be mistaken for a hash (isTokenHash false) —
 *    this is load-bearing: sharing's public path hashes unconditionally and
 *    relies on isTokenHash to keep the at-rest hash from being a credential;
 *  - hashToken is deterministic sha256-hex; isTokenHash accepts EXACTLY
 *    64 lowercase hex and rejects everything else.
 *
 * Expectations are independent of the helper: sha256 is pinned as a literal / computed
 * with node:crypto in the test, never with hashToken itself.
 * Tracker TST-CBT-1 (bearer-secret primitive). Red when: mint draws fewer than 32
 * random bytes or derives the token deterministically; hashToken stops being plain
 * sha256 hex (another digest, a salt, a pepper); isTokenHash accepts uppercase, a
 * longer string, or any `<prefix>_…` raw token (w67g1-tok-* probes, wave 67).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashToken, isTokenHash, mintToken } from '../src/host/capabilityToken.js';

describe('mintToken', () => {
  it('produces `<prefix>_<base64url>` with 256-bit entropy and a matching hash', () => {
    const { raw, hash } = mintToken('owk');
    expect(raw).toMatch(/^owk_[A-Za-z0-9_-]{43}$/); // 32 bytes base64url = 43 chars (no padding)
    expect(hash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(isTokenHash(hash)).toBe(true);
  });

  it('is unguessable — distinct on every call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(mintToken('t').raw);
    expect(seen.size).toBe(200);
  });

  it('a minted raw token is NEVER classified as a hash (the sharing public-path invariant)', () => {
    for (const prefix of ['owk', 'orginv', 'ucps', 'ucpt', 'ktinv', 'ktfeed', 'shr']) {
      expect(isTokenHash(mintToken(prefix).raw)).toBe(false);
    }
  });
});

describe('hashToken', () => {
  it('is deterministic sha256 hex', () => {
    // FIPS 180-2 test vector for "abc"
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('isTokenHash', () => {
  it('accepts EXACTLY 64 lowercase hex and rejects everything else', () => {
    expect(isTokenHash('a'.repeat(64))).toBe(true);
    expect(isTokenHash('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881')).toBe(true); // sha256("x")
    expect(isTokenHash('A'.repeat(64))).toBe(false);   // uppercase
    expect(isTokenHash('a'.repeat(63))).toBe(false);   // too short
    expect(isTokenHash('a'.repeat(65))).toBe(false);   // too long
    expect(isTokenHash('g'.repeat(64))).toBe(false);   // non-hex
    expect(isTokenHash('')).toBe(false);
  });
});
