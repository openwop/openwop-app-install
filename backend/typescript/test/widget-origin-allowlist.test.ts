/**
 * ADR 0127 Phase 2a — Origin/Referer domain-allowlist matcher (security).
 */
import { describe, it, expect } from 'vitest';
import { originAllowed, hostOf } from '../src/features/chat-widget/originAllowlist.js';

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
  });

  it('is case-insensitive + accepts a Referer URL or bare host', () => {
    expect(originAllowed('https://APP.ACME.com/x', ['acme.com'])).toBe(true);
    expect(originAllowed('app.acme.com', ['acme.com'])).toBe(true);
    expect(hostOf('https://x.acme.com/p?q=1')).toBe('x.acme.com');
  });
});
