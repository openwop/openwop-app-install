/**
 * Ecommerce gap plan §5C C2 / ADR 0225 — the public `/store/:orgId` matcher
 * must accept the links the app itself generates (`storefrontPath` percent-
 * encodes, so a personal-workspace id arrives as `user%3A…`), the literal-`:`
 * form a user types by hand, and must never throw on malformed encoding.
 */
import { describe, it, expect } from 'vitest';
import { matchStoreOrgId } from '../storeRoute.js';
import { storefrontPath } from '../commerceClient.js';

describe('matchStoreOrgId', () => {
  it('decodes a percent-encoded personal-workspace id (the storefrontPath round-trip)', () => {
    const orgId = 'user:c51185914124375f328788edbc4a29f8';
    expect(matchStoreOrgId(storefrontPath(orgId))).toBe(orgId);
    expect(matchStoreOrgId('/store/user%3Aabc123')).toBe('user:abc123');
  });

  it('accepts a literal-colon and a plain org id', () => {
    expect(matchStoreOrgId('/store/user:abc123')).toBe('user:abc123');
    expect(matchStoreOrgId('/store/org_42-x')).toBe('org_42-x');
  });

  it('returns null (not a throw) for malformed percent-encoding', () => {
    expect(matchStoreOrgId('/store/100%')).toBeNull();
    expect(matchStoreOrgId('/store/bad%zzid')).toBeNull();
  });

  it('returns null for the bare /store and /store/ paths', () => {
    expect(matchStoreOrgId('/store')).toBeNull();
    expect(matchStoreOrgId('/store/')).toBeNull();
  });

  it('does NOT over-match a nested or trailing path', () => {
    expect(matchStoreOrgId('/store/org1/extra')).toBeNull();
    expect(matchStoreOrgId('/store/org1/')).toBeNull();
  });

  it('does not collide with other routes', () => {
    expect(matchStoreOrgId('/commerce')).toBeNull();
    expect(matchStoreOrgId('/shared/tok')).toBeNull();
    expect(matchStoreOrgId('/')).toBeNull();
  });
});
