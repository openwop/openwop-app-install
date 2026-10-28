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
import { matchPrivacyRoute, privacyRedirect } from '../privacyRoute.js';
import { privacyHref, PRIVACY_HREF } from '../../../brand/privacyHref.js';
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

describe('VITE_BRAND_PRIVACY_URL — where the app links Privacy', () => {
  it('unset, the links go to the built-in /privacy page', () => {
    expect(PRIVACY_HREF).toBe('/privacy');
    expect(privacyHref(undefined)).toBe('/privacy');
    expect(privacyHref('  ')).toBe('/privacy');
  });

  it('an app path is honoured; anything else falls back', () => {
    expect(privacyHref('/p/privacy')).toBe('/p/privacy');
    expect(privacyHref(' /p/privacy ')).toBe('/p/privacy');
    expect(privacyHref('https://example.com/privacy')).toBe('/privacy');
    expect(privacyHref('//evil.example/privacy')).toBe('/privacy');
    expect(privacyHref('javascript:alert(1)')).toBe('/privacy');
  });
});

// bookai.openwop.dev served BOTH the generic /privacy page and the operator's
// adopted /p/privacy (2026-10-27): typed URLs, old links and crawlers landed on a
// policy the operator never adopted. App.tsx renders <Navigate replace> to this
// target instead of PrivacyPage.
describe('privacyRedirect — a brand with its own policy does not also serve the generic one', () => {
  it('brand URL set: /privacy (with or without the slash) goes to the adopted policy', () => {
    const href = privacyHref('/p/privacy');
    expect(privacyRedirect('/privacy', href)).toBe('/p/privacy');
    expect(privacyRedirect('/privacy/', href)).toBe('/p/privacy');
  });

  it('unset (or an invalid value that falls back): /privacy renders the built-in page', () => {
    expect(privacyRedirect('/privacy', PRIVACY_HREF)).toBeNull();
    expect(privacyRedirect('/privacy', privacyHref(undefined))).toBeNull();
    expect(privacyRedirect('/privacy', privacyHref('https://example.com/privacy'))).toBeNull();
  });

  it('only /privacy redirects; the adopted page itself and other paths never do', () => {
    const href = privacyHref('/p/privacy');
    expect(privacyRedirect('/p/privacy', href)).toBeNull();
    expect(privacyRedirect('/privacy/cookies', href)).toBeNull();
    expect(privacyRedirect('/pricing', href)).toBeNull();
  });
});
