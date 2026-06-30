/**
 * ADR 0122 Phase 6 — the public `/shared/:token` route matcher must be anchored
 * (no over-match into nested paths) and must NOT collide with `/p/:slug` or any
 * authed route. These cases pin the precedence App.tsx relies on.
 */
import { describe, it, expect } from 'vitest';
import { matchSharedToken } from '../shareRoute.js';

describe('matchSharedToken', () => {
  it('extracts a base64url-safe token', () => {
    expect(matchSharedToken('/shared/abc123_-XYZ')).toBe('abc123_-XYZ');
  });

  it('returns null for the bare /shared and /shared/ paths', () => {
    expect(matchSharedToken('/shared')).toBeNull();
    expect(matchSharedToken('/shared/')).toBeNull();
  });

  it('does NOT over-match a nested or trailing path', () => {
    expect(matchSharedToken('/shared/tok/extra')).toBeNull();
    expect(matchSharedToken('/shared/tok?x=1')).toBeNull();
    expect(matchSharedToken('/shared/tok/')).toBeNull();
  });

  it('does not collide with /p/:slug or other routes', () => {
    expect(matchSharedToken('/p/features')).toBeNull();
    expect(matchSharedToken('/model-router')).toBeNull();
    expect(matchSharedToken('/')).toBeNull();
    expect(matchSharedToken('/sharing')).toBeNull();
  });

  it('rejects a token with disallowed characters', () => {
    expect(matchSharedToken('/shared/has space')).toBeNull();
    expect(matchSharedToken('/shared/has.dot')).toBeNull();
  });
});
