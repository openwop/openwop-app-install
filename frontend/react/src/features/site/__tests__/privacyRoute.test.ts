/**
 * `/privacy` is a public disclosure: App.tsx renders it in the bare PublicShell,
 * so the matcher is a fixed-path predicate and the route manifest must NOT also
 * declare it (a workspace entry would put the signed-in sidebar back around it
 * the moment the public branch stopped matching).
 *
 * Witness for fix 7380eceb1 (2026-10-14): a visitor reading the privacy policy
 * landed inside the signed-in workspace layout, whose sidebar links Dashboard,
 * Chat, Agents and Workflows. Sabotages that red it (/grade-tests w50): a
 * matcher without the trailing-slash form, a prefix match, and a manifest
 * entry at `/privacy` (chrome/features.tsx).
 */
import { describe, it, expect } from 'vitest';
import { matchPrivacyRoute } from '../privacyRoute.js';
import { FEATURES } from '../../../chrome/features.js';

describe('matchPrivacyRoute', () => {
  it('matches /privacy with and without a trailing slash', () => {
    expect(matchPrivacyRoute('/privacy')).toBe(true);
    expect(matchPrivacyRoute('/privacy/')).toBe(true);
  });

  it('does not match a nested or adjacent path', () => {
    expect(matchPrivacyRoute('/privacy/cookies')).toBe(false);
    expect(matchPrivacyRoute('/privacys')).toBe(false);
    expect(matchPrivacyRoute('/pricing')).toBe(false);
    expect(matchPrivacyRoute('/')).toBe(false);
  });

  it('is not also a manifest route', () => {
    expect(FEATURES.some((f) => f.path === '/privacy')).toBe(false);
  });
});
