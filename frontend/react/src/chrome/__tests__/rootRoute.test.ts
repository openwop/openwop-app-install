/**
 * ADR 0487 — the root-route gate. Pins the two rules that decide whether `/`
 * renders the PUBLIC marketing home, INCLUDING the one the app-entered marker
 * used to mask: a legacy chat deep link ('/?agent='/'?conversation='/'?new=')
 * must NOT show marketing even for an anonymous visitor — it has to fall through
 * to the app shell's RootRedirect so it forwards to /chat.
 */
import { describe, it, expect } from 'vitest';
import { shouldShowFrontPage, hasLegacyChatParams, LEGACY_CHAT_PARAMS, rootSplashPending } from '../rootRoute.js';

const base = { onRoot: true, hasUser: false, search: '', authLoading: false, frontPageLoading: false, frontPageEnabled: true };

describe('hasLegacyChatParams', () => {
  it.each(['?agent=host:kickbot', '?conversation=abc', '?new=1', '?foo=1&agent=x'])('detects %s', (search) => {
    expect(hasLegacyChatParams(search)).toBe(true);
  });
  it.each(['', '?utm_source=news', '?ref=twitter'])('ignores %s', (search) => {
    expect(hasLegacyChatParams(search)).toBe(false);
  });
  it('covers exactly the params RootRedirect forwards', () => {
    expect([...LEGACY_CHAT_PARAMS]).toEqual(['conversation', 'agent', 'new']);
  });
});

describe('shouldShowFrontPage', () => {
  it('anonymous visitor on / with the front page enabled → marketing', () => {
    expect(shouldShowFrontPage(base)).toBe(true);
  });

  it('CRITICAL: a legacy chat deep link is NOT marketing, even for anon (→ app shell RootRedirect → /chat)', () => {
    expect(shouldShowFrontPage({ ...base, search: '?agent=host:kickbot' })).toBe(false);
    expect(shouldShowFrontPage({ ...base, search: '?conversation=abc123' })).toBe(false);
    expect(shouldShowFrontPage({ ...base, search: '?new=1' })).toBe(false);
  });

  // CORRECTION 2026-09-11 — this asserted the inverse until today. The operator
  // toggle's label promises the front page at `/` without qualifying by visitor
  // class, and it was enforced anonymous-only in two places. See ADR 0487's
  // correction note.
  it('a signed-in visitor IS shown marketing when the toggle is on (the label makes no exception)', () => {
    expect(shouldShowFrontPage({ ...base, hasUser: true })).toBe(true);
  });

  it('with the toggle OFF a signed-in visitor gets the app shell (→ RootRedirect → /dashboard)', () => {
    expect(shouldShowFrontPage({ ...base, hasUser: true, frontPageEnabled: false })).toBe(false);
  });

  it('CRITICAL: a legacy chat deep link still bypasses marketing for a SIGNED-IN visitor too', () => {
    // The forward to /chat is load-bearing (stored notification actionUrls) and
    // must not become reachable-only-when-anonymous.
    expect(shouldShowFrontPage({ ...base, hasUser: true, search: '?agent=host:kickbot' })).toBe(false);
  });

  it('auth state alone never decides: same inputs, both hasUser values, same verdict', () => {
    for (const enabled of [true, false]) {
      const anon = shouldShowFrontPage({ ...base, hasUser: false, frontPageEnabled: enabled });
      const signedIn = shouldShowFrontPage({ ...base, hasUser: true, frontPageEnabled: enabled });
      expect(signedIn).toBe(anon);
    }
  });

  it('off root → not marketing', () => {
    expect(shouldShowFrontPage({ ...base, onRoot: false })).toBe(false);
  });

  it('unrelated marketing params (utm/ref) still show marketing', () => {
    expect(shouldShowFrontPage({ ...base, search: '?utm_source=news' })).toBe(true);
  });

  it('while auth or the pointer is still resolving, an anon visitor stays on the public path (neutral splash)', () => {
    expect(shouldShowFrontPage({ ...base, frontPageEnabled: false, authLoading: true })).toBe(true);
    expect(shouldShowFrontPage({ ...base, frontPageEnabled: false, frontPageLoading: true })).toBe(true);
  });

  it('front page disabled + resolved → not marketing (falls through to the app shell)', () => {
    expect(shouldShowFrontPage({ ...base, frontPageEnabled: false })).toBe(false);
  });
});

/**
 * First-visit splash hang (2026-11-05). The `/` branch used to splash on
 * `authLoading || frontPageLoading`, so an auth SDK that never answered held the
 * splash over a loaded, enabled pointer until the visitor reloaded.
 *
 * Sabotage that turns it red: return `o.authLoading || o.frontPageLoading`
 * (the first case fails); drop the `!o.frontPageEnabled &&` guard (same); drop
 * the auth term entirely (the pointer-off case fails, flashing an empty page
 * before the app shell takes over); make the pointer term depend on the
 * last-known pointer (`frontPageLoading && !frontPageEnabled`) or drop it (the
 * pointer-resolving case fails).
 */
describe('rootSplashPending', () => {
  const settled = { authLoading: false, frontPageLoading: false, frontPageEnabled: true };

  it('CRITICAL: an enabled, resolved pointer renders the front page while auth is still resolving', () => {
    expect(rootSplashPending({ ...settled, authLoading: true })).toBe(false);
  });

  it('splashes while the pointer itself is resolving', () => {
    expect(rootSplashPending({ ...settled, frontPageLoading: true, frontPageEnabled: false })).toBe(true);
    expect(rootSplashPending({ ...settled, frontPageLoading: true, authLoading: true, frontPageEnabled: false })).toBe(true);
    // A re-resolving pointer whose last value was ON still splashes: the splash
    // waits for the pointer, whatever it last said.
    expect(rootSplashPending({ ...settled, frontPageLoading: true })).toBe(true);
  });

  it('pointer OFF: holds the splash until auth settles, so the app shell can take over without a flash', () => {
    expect(rootSplashPending({ ...settled, frontPageEnabled: false, authLoading: true })).toBe(true);
  });

  it('everything settled → no splash', () => {
    expect(rootSplashPending(settled)).toBe(false);
  });
});
