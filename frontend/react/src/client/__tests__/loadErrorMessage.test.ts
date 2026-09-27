/**
 * KTUX-10 — the mapper must select a distinct localized message per failure
 * kind, and it must go through `t()` (a real KEY), so the four locales stay
 * honest. `check-i18n` verifies key parity and would NOT catch English leaking
 * through `classifyHttpError`'s hardcoded strings.
 */
import { describe, it, expect } from 'vitest';
import { loadErrorMessage, isRetryable } from '../loadErrorMessage.js';

const httpErr = (status: number): Error & { status: number } =>
  Object.assign(new Error(`HTTP ${status}`), { status });

// A `t` stub that echoes the KEY, so we can assert which key each error selects
// without depending on the copy.
const echo = (k: string): string => k;

describe('loadErrorMessage', () => {
  it('distinguishes the failures a user would act on differently', () => {
    expect(loadErrorMessage(echo, httpErr(429))).toBe('common:error_rate-limited');
    expect(loadErrorMessage(echo, httpErr(401))).toBe('common:error_auth');
    // 401 and 403 used to share `error_auth` — "your session may have expired,
    // sign in again". For a 403 that is a false instruction as well as a false
    // diagnosis: signing out and back in produces the identical message. This
    // test asserts the FILE'S OWN premise ("failures a user would act on
    // differently"), which the shared mapping quietly violated.
    expect(loadErrorMessage(echo, httpErr(403))).toBe('common:error_forbidden');
    expect(loadErrorMessage(echo, httpErr(404))).toBe('common:error_not-found');
    expect(loadErrorMessage(echo, httpErr(500))).toBe('common:error_server');
  });

  it('always selects a KEY, never emits English of its own', () => {
    for (const e of [httpErr(429), httpErr(500), new Error('boom'), null, undefined]) {
      const k = loadErrorMessage(echo, e);
      expect(k.startsWith('common:error_')).toBe(true);
      // If this ever returns prose, English is being shipped to every locale.
      expect(k).not.toMatch(/\s/);
    }
  });

  it('marks a rate-limit retryable and a 404 not', () => {
    expect(isRetryable(httpErr(429))).toBe(true);
    expect(isRetryable(httpErr(404))).toBe(false);
  });
});
