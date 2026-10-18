/**
 * KTUX-10 — the mapper must select a distinct localized message per failure
 * kind, and it must go through `t()` (a real KEY), so the four locales stay
 * honest. `check-i18n` verifies key parity and would NOT catch English leaking
 * through `classifyHttpError`'s hardcoded strings.
 */
import { describe, it, expect } from 'vitest';
import { loadErrorMessage, isRetryable } from '../loadErrorMessage.js';
import { messages as enCommon } from '../../i18n/locales/en/common.js';

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

  it('always selects a KEY that exists in the en `common` catalog, for every failure kind, never English of its own', () => {
    // One error per ClassifiedError kind — the echo `t` returns ANY string, so
    // the key must be checked against the catalog the app actually loads, or a
    // new kind with no `common:error_<kind>` entry ships a raw key to users.
    const refused = (code: string) => Object.assign(new Error('GET /me → 401'), { status: 401, body: { error: code, message: 'x' } });
    const errors: unknown[] = [
      httpErr(429),
      Object.assign(new Error('429'), { status: 429, body: { error: 'rate_limited', message: 'b', details: { reason: 'workflow_budget_exhausted' } } }),
      new TypeError('Failed to fetch'),
      httpErr(401), httpErr(403), httpErr(404), httpErr(500),
      refused('account_disabled'), refused('account_erased'), refused('session_revoked'),
      new Error('boom'), null, undefined,
    ];
    const catalog: Record<string, unknown> = enCommon;
    const seen = new Set<string>();
    for (const e of errors) {
      const k = loadErrorMessage(echo, e);
      expect(k.startsWith('common:error_')).toBe(true);
      // If this ever returns prose, English is being shipped to every locale.
      expect(k).not.toMatch(/\s/);
      const entry = catalog[k.slice('common:'.length)];
      expect(typeof entry === 'string' && entry.length > 0, `${k} is not in en/common.ts`).toBe(true);
      seen.add(k);
    }
    // Non-vacuous: the list really did reach every kind (11 distinct keys).
    expect(seen.size).toBe(11);
  });

  it('marks a rate-limit retryable and a 404 not', () => {
    expect(isRetryable(httpErr(429))).toBe(true);
    expect(isRetryable(httpErr(404))).toBe(false);
  });
});
