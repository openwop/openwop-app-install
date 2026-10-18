/**
 * The sync auth path must not attach an EXPIRED Firebase ID token.
 *
 * Regression: `authedHeaders()` read `cachedIdToken` with no `exp` check, and the
 * only thing refilling it was the SDK's proactive-refresh `setTimeout` — throttled
 * in background tabs. A backgrounded session therefore attached a dead JWT to every
 * request; the host rejected each (`OIDC verify failed … code:"expired"`) and fell
 * through to the cookie path WITHOUT `oidcAuthTime`, silently breaking reveal-gated
 * surfaces for a signed-in user. Prod showed a continuous ~25s cadence of these.
 *
 * ADR 0141 / ADR 0143 (#2639). Breaks it: an expired or about-to-expire JWT
 * attached as a bearer, a refresh storm from a failing refresher, or a token
 * whose `exp` cannot be read being refused (fail-closed).
 *
 * Module state: `lastRefreshAt` (the refresh cooldown) is zeroed by every
 * `setCurrentIdToken(<token>)`, which is why each case can expect its own first
 * refresh without a test seam; `config.authMode` is restored in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authedHeaders, config, setCurrentIdToken, registerIdTokenRefresher } from '../config.js';

const originalMode = config.authMode;

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
  afterEach(() => { config.authMode = originalMode; });

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

  it('leaves the non-OIDC auth modes alone when signed out — bearer sends the apiKey, cookie sends nothing, and no refresh is asked', () => {
    // Twin: config.authmode.test.ts › 'bearer mode sends Authorization: Bearer
    // <apiKey>' / 'cookie mode sends no Authorization header' pin the same
    // precedence; this leg pins it FROM the staleness side — with no ID token
    // the staleness branch must neither intercept nor kick a refresh.
    const refresh = vi.fn();
    registerIdTokenRefresher(refresh);
    setCurrentIdToken(null);
    config.authMode = 'bearer';
    expect(authedHeaders()['authorization']).toBe(`Bearer ${config.apiKey}`);
    config.authMode = 'cookie';
    expect(authedHeaders()['authorization']).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});
