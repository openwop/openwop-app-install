/**
 * ADR 0339 — the `/fn/:orgId/:slug` matcher: both segments decode (org ids
 * contain `:`), malformed encoding is a non-match, anchored at BOTH ends (no
 * over-match: `/x/fn/…` and `/fn/…/extra` are not the viewer).
 * This matcher decides which paths render the PUBLIC viewer to an anonymous
 * visitor, so an over-match hands a foreign path to it.
 * Sabotage-witnessed (round 2): dropping `^` or `$`, the colon from the org
 * class, either decode, or the decode's catch.
 */
import { describe, it, expect } from 'vitest';
import { matchFunnelView } from '../viewRoute.js';

describe('matchFunnelView', () => {
  it('decodes encoded + literal org ids and the slug', () => {
    expect(matchFunnelView('/fn/user%3Aabc/launch-1')).toEqual({ orgId: 'user:abc', slug: 'launch-1' });
    expect(matchFunnelView('/fn/user:abc/launch-1')).toEqual({ orgId: 'user:abc', slug: 'launch-1' });
    expect(matchFunnelView('/fn/org/a%2Db')).toEqual({ orgId: 'org', slug: 'a-b' });
  });
  it('rejects malformed encoding without throwing', () => {
    expect(matchFunnelView('/fn/100%/x')).toBeNull();
    expect(matchFunnelView('/fn/org/100%')).toBeNull();
  });
  it('rejects bare, nested, and foreign paths', () => {
    expect(matchFunnelView('/fn/org')).toBeNull();
    expect(matchFunnelView('/fn/org/slug/extra')).toBeNull();
    expect(matchFunnelView('/x/fn/org/slug')).toBeNull();
    expect(matchFunnelView('/funnels')).toBeNull();
    expect(matchFunnelView('/f/form:1')).toBeNull();
  });
});
