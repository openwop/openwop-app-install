/**
 * ADR 0027 — the public `/p/:slug` matcher must accept both the literal and
 * percent-encoded forms of a CMS slug, never throw on malformed encoding, and
 * keep the strict slug shape on the DECODED value (encoding tolerance must
 * not widen what counts as a slug).
 */
import { describe, it, expect } from 'vitest';
import { matchPublicPageSlug } from '../publicPageRoute.js';

describe('matchPublicPageSlug', () => {
  it('extracts a literal CMS slug', () => {
    expect(matchPublicPageSlug('/p/features')).toBe('features');
    expect(matchPublicPageSlug('/p/my-page-2')).toBe('my-page-2');
  });

  it('decodes a percent-encoded slug to the same value', () => {
    expect(matchPublicPageSlug('/p/f%65atures')).toBe('features');
    expect(matchPublicPageSlug('/p/my%2Dpage')).toBe('my-page');
  });

  it('returns null (not a throw) for malformed percent-encoding', () => {
    expect(matchPublicPageSlug('/p/100%')).toBeNull();
    expect(matchPublicPageSlug('/p/bad%zzslug')).toBeNull();
  });

  it('rejects a decoded value that is not a valid slug', () => {
    expect(matchPublicPageSlug('/p/%2E%2E')).toBeNull(); // ..
    expect(matchPublicPageSlug('/p/UPPER')).toBeNull();
    expect(matchPublicPageSlug('/p/%55PPER')).toBeNull(); // UPPER, encoded
    expect(matchPublicPageSlug('/p/-leading')).toBeNull();
    expect(matchPublicPageSlug('/p/has%20space')).toBeNull();
  });

  it('returns null for the bare /p and /p/ paths', () => {
    expect(matchPublicPageSlug('/p')).toBeNull();
    expect(matchPublicPageSlug('/p/')).toBeNull();
  });

  it('does NOT over-match a nested or trailing path', () => {
    expect(matchPublicPageSlug('/p/slug/extra')).toBeNull();
    expect(matchPublicPageSlug('/p/slug/')).toBeNull();
  });

  it('does not collide with other routes', () => {
    expect(matchPublicPageSlug('/store/org1')).toBeNull();
    expect(matchPublicPageSlug('/projects')).toBeNull();
    expect(matchPublicPageSlug('/')).toBeNull();
  });
});
