/**
 * The sync auth path must not attach an EXPIRED Firebase ID token.
 *
 * Regression: `authedHeaders()` read `cachedIdToken` with no `exp` check, and the
 * only thing refilling it was the SDK's proactive-refresh `setTimeout` — throttled
 * in background tabs. A backgrounded session therefore attached a dead JWT to every
 * request; the host rejected each (`OIDC verify failed … code:"expired"`) and fell
 * through to the cookie path WITHOUT `oidcAuthTime`, silently breaking reveal-gated
 * surfaces for a signed-in user. Prod showed a continuous ~25s cadence of these.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authedHeaders, setCurrentIdToken, registerIdTokenRefresher } from '../config.js';

/** A syntactically real JWT whose payload carries `exp` (seconds). */
function jwtExpiringAt(expMs: number, marker = 'x'): string {
  const b64 = (o: unknown): string =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ exp: Math.floor(expMs / 1000), sub: marker })}.sig-${marker}`;
}

describe('authedHeaders — ID-token staleness', () => {
  beforeEach(() => {
    registerIdTokenRefresher(null);
    setCurrentIdToken(null);
  });

  it('attaches a token that is comfortably in-date', () => {
    const token = jwtExpiringAt(Date.now() + 30 * 60_000, 'fresh');
    setCurrentIdToken(token);
    expect(authedHeaders()['authorization']).toBe(`Bearer ${token}`);
  });

  it('does NOT attach an expired token, and asks for a refresh instead', () => {
    const refresh = vi.fn();
    registerIdTokenRefresher(refresh);
    setCurrentIdToken(jwtExpiringAt(Date.now() - 60_000, 'dead'));

    expect(authedHeaders()['authorization']).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('treats a token inside the pre-expiry window as already spent', () => {
    // 10s of life left — it would very likely die in flight.
    setCurrentIdToken(jwtExpiringAt(Date.now() + 10_000, 'dying'));
    expect(authedHeaders()['authorization']).toBeUndefined();
  });

  it('throttles the refresh so a failing refresher costs one call per window', () => {
    const refresh = vi.fn();
    registerIdTokenRefresher(refresh);
    setCurrentIdToken(jwtExpiringAt(Date.now() - 60_000, 'dead'));

    for (let i = 0; i < 25; i += 1) authedHeaders();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('resumes attaching once a fresh token lands', () => {
    const refresh = vi.fn();
    registerIdTokenRefresher(refresh);
    setCurrentIdToken(jwtExpiringAt(Date.now() - 60_000, 'dead'));
    expect(authedHeaders()['authorization']).toBeUndefined();

    const good = jwtExpiringAt(Date.now() + 30 * 60_000, 'renewed');
    setCurrentIdToken(good);
    expect(authedHeaders()['authorization']).toBe(`Bearer ${good}`);
  });

  it('still attaches a token whose exp cannot be parsed (never fail closed on an unreadable token)', () => {
    // Opaque / non-JWT bearer: behavior must match the pre-fix path exactly.
    setCurrentIdToken('not-a-jwt');
    expect(authedHeaders()['authorization']).toBe('Bearer not-a-jwt');
  });

  it('leaves the non-OIDC auth modes alone when signed out', () => {
    // No ID token → the pre-existing precedence resumes (bearer mode's configured
    // API key here; nothing at all in cookie mode). The staleness branch must not
    // intercept a request that was never carrying an ID token.
    setCurrentIdToken(null);
    const auth = authedHeaders()['authorization'];
    expect(auth === undefined || auth.startsWith('Bearer ')).toBe(true);
    expect(auth).not.toContain('.');
  });
});
