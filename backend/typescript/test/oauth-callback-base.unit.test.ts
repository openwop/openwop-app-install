/**
 * OAuth callback-base resolution (ADR 0024 Phase B) — the seam that decides the
 * redirect URI registered with each provider. Misconfiguration here fails only
 * at the provider redirect (a 404 the host never sees), so the resolution order
 * MUST be pinned by tests:
 *
 *   1. OPENWOP_OAUTH_CALLBACK_BASE_URL  — the browser-reachable BACKEND base.
 *      In the Firebase-fronted production topology this is the app origin plus
 *      the `/api` rewrite prefix (e.g. https://app.openwop.dev/api), because
 *      Firebase routes ONLY /api/** to Cloud Run.
 *   2. OPENWOP_PUBLIC_BASE_URL          — the SPA origin (local/dev topologies
 *      where backend === app origin).
 *   3. the request origin               — bare local dev.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appBaseUrl, callbackBaseUrl, redirectUri } from '../src/features/connections/oauthFlow.js';

const REQ_ORIGIN = 'http://localhost:8787';

describe('OAuth callback base resolution', () => {
  let savedCallbackBase: string | undefined;
  let savedPublicBase: string | undefined;

  beforeEach(() => {
    savedCallbackBase = process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL;
    savedPublicBase = process.env.OPENWOP_PUBLIC_BASE_URL;
    delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL;
    delete process.env.OPENWOP_PUBLIC_BASE_URL;
  });

  afterEach(() => {
    if (savedCallbackBase === undefined) delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL;
    else process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = savedCallbackBase;
    if (savedPublicBase === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL;
    else process.env.OPENWOP_PUBLIC_BASE_URL = savedPublicBase;
  });

  it('explicit OPENWOP_OAUTH_CALLBACK_BASE_URL wins (the /api rewrite topology)', () => {
    process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = 'https://app.openwop.dev/api/';
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.openwop.dev';
    expect(callbackBaseUrl(REQ_ORIGIN)).toBe('https://app.openwop.dev/api');
    expect(redirectUri('google', REQ_ORIGIN)).toBe(
      'https://app.openwop.dev/api/v1/host/openwop-app/connections/google/callback',
    );
  });

  it('falls back to OPENWOP_PUBLIC_BASE_URL when no callback base is set', () => {
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.openwop.dev/';
    expect(callbackBaseUrl(REQ_ORIGIN)).toBe('https://app.openwop.dev');
    // NOTE: in the Firebase-fronted topology this fallback is NOT browser-routable
    // (no /api prefix) — production MUST set OPENWOP_OAUTH_CALLBACK_BASE_URL.
    expect(redirectUri('google', REQ_ORIGIN)).toBe(
      'https://app.openwop.dev/v1/host/openwop-app/connections/google/callback',
    );
  });

  it('falls back to the request origin in bare local dev', () => {
    expect(appBaseUrl(REQ_ORIGIN)).toBe(REQ_ORIGIN);
    expect(callbackBaseUrl(REQ_ORIGIN)).toBe(REQ_ORIGIN);
    expect(redirectUri('microsoft-graph', REQ_ORIGIN)).toBe(
      `${REQ_ORIGIN}/v1/host/openwop-app/connections/microsoft-graph/callback`,
    );
  });

  it('provider ids are URL-encoded into the redirect path', () => {
    expect(redirectUri('some provider', REQ_ORIGIN)).toBe(
      `${REQ_ORIGIN}/v1/host/openwop-app/connections/some%20provider/callback`,
    );
  });

  // ONE FIXED REDIRECT URI (RFC 0199 / oauth.md rule 5): production never derives
  // the redirect URI from the request origin.
  it('production with NO configured base refuses rather than using the request origin', () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => callbackBaseUrl(REQ_ORIGIN)).toThrow(/not configured/);
      process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = 'https://app.openwop.dev/api';
      expect(callbackBaseUrl(REQ_ORIGIN)).toBe('https://app.openwop.dev/api');
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
