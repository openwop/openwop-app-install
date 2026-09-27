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
 */
import { describe, expect, it } from 'vitest';
import { hashToken, isTokenHash, mintToken } from '../src/host/capabilityToken.js';

describe('mintToken', () => {
  it('produces `<prefix>_<base64url>` with 256-bit entropy and a matching hash', () => {
    const { raw, hash } = mintToken('owk');
    expect(raw).toMatch(/^owk_[A-Za-z0-9_-]{43}$/); // 32 bytes base64url = 43 chars (no padding)
    expect(hash).toBe(hashToken(raw));
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
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('isTokenHash', () => {
  it('accepts EXACTLY 64 lowercase hex and rejects everything else', () => {
    expect(isTokenHash('a'.repeat(64))).toBe(true);
    expect(isTokenHash(hashToken('x'))).toBe(true);
    expect(isTokenHash('A'.repeat(64))).toBe(false);   // uppercase
    expect(isTokenHash('a'.repeat(63))).toBe(false);   // too short
    expect(isTokenHash('a'.repeat(65))).toBe(false);   // too long
    expect(isTokenHash('g'.repeat(64))).toBe(false);   // non-hex
    expect(isTokenHash('')).toBe(false);
  });
});
