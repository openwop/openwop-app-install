/**
 * ADR 0487 — the root-route gate. Pins the two rules that decide whether `/`
 * renders the PUBLIC marketing home, INCLUDING the one the app-entered marker
 * used to mask: a legacy chat deep link ('/?agent='/'?conversation='/'?new=')
 * must NOT show marketing even for an anonymous visitor — it has to fall through
 * to the app shell's RootRedirect so it forwards to /chat.
 */
import { describe, it, expect } from 'vitest';
import { shouldShowFrontPage, hasLegacyChatParams, LEGACY_CHAT_PARAMS } from '../rootRoute.js';

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
