/**
 * ADR 0127 Phase 2a — Origin/Referer domain-allowlist matcher (security). Breaks if a
 * suffix-substring host (`acme.com.evil.com`, `evilacme.com`) is admitted, if a
 * subdomain entry admits its siblings or apex, or if an empty/absent/unparseable
 * input is allowed (default-deny).
 *
 * Double guard (recorded): `allowedDomains.length === 0` is backed by `.some([])`
 * being false, so removing that early return alone changes no outcome.
 */
import { describe, it, expect } from 'vitest';
import { originAllowed, hostOf, normalizeAllowedDomain } from '../src/features/chat-widget/originAllowlist.js';

describe('originAllowed', () => {
  it('matches the apex + subdomains of a bare-domain entry', () => {
    expect(originAllowed('https://acme.com', ['acme.com'])).toBe(true);
    expect(originAllowed('https://app.acme.com', ['acme.com'])).toBe(true);
    expect(originAllowed('https://deep.app.acme.com/page', ['acme.com'])).toBe(true);
  });

  it('a subdomain entry admits ONLY that host', () => {
    expect(originAllowed('https://app.acme.com', ['app.acme.com'])).toBe(true);
    expect(originAllowed('https://other.acme.com', ['app.acme.com'])).toBe(false);
    expect(originAllowed('https://acme.com', ['app.acme.com'])).toBe(false);
  });

  it('REJECTS the eTLD+1 spoof class (suffix-substring attack)', () => {
    expect(originAllowed('https://acme.com.evil.com', ['acme.com'])).toBe(false);
    expect(originAllowed('https://evilacme.com', ['acme.com'])).toBe(false);
    expect(originAllowed('https://notacme.com', ['acme.com'])).toBe(false);
  });

  it('DEFAULT-DENY: empty allowlist / absent / unparseable origin', () => {
    expect(originAllowed('https://acme.com', [])).toBe(false);
    expect(originAllowed(undefined, ['acme.com'])).toBe(false);
    expect(originAllowed('not a url', ['acme.com'])).toBe(false);
    expect(originAllowed('https://acme.com', ['', '  '])).toBe(false); // blank entries admit nothing
  });

  it('is case-insensitive + accepts a Referer URL or bare host', () => {
    expect(originAllowed('https://APP.ACME.com/x', ['acme.com'])).toBe(true);
    expect(originAllowed('app.acme.com', ['acme.com'])).toBe(true);
    // The ALLOWLIST side is normalized too (the URL parser already lowercases the origin).
    expect(originAllowed('https://app.acme.com', ['ACME.COM'])).toBe(true);
    expect(originAllowed('https://acme.com', [' acme.com '])).toBe(true);
    expect(hostOf('https://x.acme.com/p?q=1')).toBe('x.acme.com');
  });
});

// ADR 1018 D5 — the allowlist is a HOST list, checked at match time too, so a legacy
// row stored before the write-time check fails closed instead of staying live.
describe('normalizeAllowedDomain + match-time grammar (ADR 1018 D5)', () => {
  it('a stored bare label admits NOTHING (it used to admit every .com site)', () => {
    expect(originAllowed('https://evil.com', ['com'])).toBe(false);
    expect(originAllowed('https://anything.com', ['acme.com', 'com'])).toBe(false);
    expect(originAllowed('https://acme.com', ['acme.com', 'com'])).toBe(true); // a good sibling still matches
  });

  it('a stored pasted URL matches its host (it used to match nothing)', () => {
    expect(originAllowed('https://app.acme.com', ['https://Acme.com/pricing'])).toBe(true);
  });

  it('refuses wildcards, ports, credentials, empty labels and bare labels', () => {
    for (const bad of ['com', '*.acme.com', 'acme.com:8443', 'user@acme.com', 'acme..com', '-acme.com', '', '  ', 'https://']) {
      expect(normalizeAllowedDomain(bad), bad).toBeNull();
    }
  });

  it('accepts hosts, localhost and a pasted URL, lowercased', () => {
    expect(normalizeAllowedDomain(' ACME.com ')).toBe('acme.com');
    expect(normalizeAllowedDomain('https://App.Acme.com/x?q=1')).toBe('app.acme.com');
    expect(normalizeAllowedDomain('localhost')).toBe('localhost');
    expect(normalizeAllowedDomain('acme.com.')).toBe('acme.com');
  });
});
