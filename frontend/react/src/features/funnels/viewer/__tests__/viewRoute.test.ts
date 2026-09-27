/**
 * ADR 0339 — the `/fn/:orgId/:slug` matcher: both segments decode (org ids
 * contain `:`), malformed encoding is a non-match, anchored (no over-match).
 */
import { describe, it, expect } from 'vitest';
import { matchFunnelView } from '../viewRoute.js';

describe('matchFunnelView', () => {
  it('decodes encoded + literal org ids and the slug', () => {
    expect(matchFunnelView('/fn/user%3Aabc/launch-1')).toEqual({ orgId: 'user:abc', slug: 'launch-1' });
    expect(matchFunnelView('/fn/user:abc/launch-1')).toEqual({ orgId: 'user:abc', slug: 'launch-1' });
  });
  it('rejects malformed encoding without throwing', () => {
    expect(matchFunnelView('/fn/100%/x')).toBeNull();
    expect(matchFunnelView('/fn/org/100%')).toBeNull();
  });
  it('rejects bare, nested, and foreign paths', () => {
    expect(matchFunnelView('/fn/org')).toBeNull();
    expect(matchFunnelView('/fn/org/slug/extra')).toBeNull();
    expect(matchFunnelView('/funnels')).toBeNull();
    expect(matchFunnelView('/f/form:1')).toBeNull();
  });
});
