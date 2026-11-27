/**
 * ADR 0718 × ADR 1031 — the adopter-declared path-collision seam. The guard must stay
 * on in every tree; an adopter may excuse only its OWN deliberate claim, exactly as it
 * stands, with a reason. Each case below fails if that rule is loosened:
 * - excusing by path alone (a third claimant slips through);
 * - letting an adopter excuse two host features;
 * - accepting an empty reason;
 * - keeping a stale entry.
 */
import { describe, it, expect } from 'vitest';
import { checkPathCollisions, collectAdopterKnownPathCollisions } from '../pathCollisions.js';

const ROUTES = [
  { path: '/leaderboard', ownerFeatureId: 'evals' },
  { path: '/leaderboard', ownerFeatureId: 'kicktodo-engagement' },
  { path: '/runs', ownerFeatureId: 'runs' },
];
const ADOPTER = new Set(['kicktodo-engagement']);
const NONE = new Set<string>();
const ENTRY = { path: '/leaderboard', owners: ['kicktodo-engagement', 'evals'], reason: 'site-tier public board; the distribution ships no evals' };

describe('checkPathCollisions', () => {
  it('reports a collision nothing excuses', () => {
    expect(checkPathCollisions(ROUTES, NONE, [], ADOPTER)).toEqual({ unexpected: ['/leaderboard <- evals, kicktodo-engagement'], invalidAdopterEntries: [] });
  });

  it('an adopter entry with the exact owner set, an adopter owner and a reason excuses it', () => {
    expect(checkPathCollisions(ROUTES, NONE, [ENTRY], ADOPTER)).toEqual({ unexpected: [], invalidAdopterEntries: [] });
  });

  it('a third claimant is a NEW collision: the entry no longer matches and goes stale', () => {
    const routes = [...ROUTES, { path: '/leaderboard', ownerFeatureId: 'other' }];
    const v = checkPathCollisions(routes, NONE, [ENTRY], ADOPTER);
    expect(v.unexpected).toEqual(['/leaderboard <- evals, kicktodo-engagement, other']);
    expect(v.invalidAdopterEntries).toEqual([expect.stringContaining('STALE')]);
  });

  it('an adopter cannot excuse a host-only collision', () => {
    const routes = [{ path: '/x', ownerFeatureId: 'a' }, { path: '/x', ownerFeatureId: 'b' }];
    const v = checkPathCollisions(routes, NONE, [{ path: '/x', owners: ['a', 'b'], reason: 'r' }], ADOPTER);
    expect(v.unexpected).toEqual(['/x <- a, b']);
    expect(v.invalidAdopterEntries).toEqual([expect.stringContaining('host collision')]);
  });

  it('an entry without a reason excuses nothing', () => {
    const v = checkPathCollisions(ROUTES, NONE, [{ ...ENTRY, reason: '  ' }], ADOPTER);
    expect(v.unexpected).toHaveLength(1);
    expect(v.invalidAdopterEntries).toEqual([expect.stringContaining('no reason')]);
  });

  it('an entry whose collision is gone is STALE', () => {
    const v = checkPathCollisions([{ path: '/leaderboard', ownerFeatureId: 'kicktodo-engagement' }], NONE, [ENTRY], ADOPTER);
    expect(v).toEqual({ unexpected: [], invalidAdopterEntries: [expect.stringContaining('STALE')] });
  });

  it('the host list still excuses host collisions', () => {
    expect(checkPathCollisions(ROUTES, new Set(['/leaderboard']), [], ADOPTER).unexpected).toEqual([]);
  });
});

describe('collectAdopterKnownPathCollisions', () => {
  it('reads the export, and refuses a module without it or with a malformed entry', () => {
    expect(collectAdopterKnownPathCollisions({})).toEqual([]);
    expect(collectAdopterKnownPathCollisions({ f: { KNOWN_PATH_COLLISIONS: [ENTRY] } })).toEqual([ENTRY]);
    expect(() => collectAdopterKnownPathCollisions({ f: {} })).toThrow(/must export/);
    expect(() => collectAdopterKnownPathCollisions({ f: { KNOWN_PATH_COLLISIONS: [{ path: '/x' }] } })).toThrow(/needs/);
  });
});
