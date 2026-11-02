/**
 * SEC-2 (docs/steward/CODEBASE-ASSESSMENT.md): the built-in `dev-token` is withdrawn in
 * production by readKeyTenants (the security control). apiKeyConfigError() only
 * flags a deploy that EXPLICITLY enforces bearer auth yet configured no bearer
 * credential at all (no API key + no OIDC) — it must NOT fire for a plain
 * NODE_ENV=production cookie-per-visitor deploy, which legitimately has no API
 * keys (else /readiness would wrongly 503 the live demo).
 *
 * TST-BXC-1. Red when: the guard fires without OPENWOP_AUTH_ENFORCE_BEARER (or
 * keys off NODE_ENV=production), a real key or OIDC stops satisfying it, an
 * all-whitespace key list counts as a key, or the unconfigured case stops
 * returning its message (w66 probes akg-prod/key/oidc/trim/flag).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { apiKeyConfigError } from '../src/middleware/auth.js';

const OIDC_KEYS = ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL'];
const SAVED = { ...process.env };
afterEach(() => {
  for (const k of ['NODE_ENV', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_API_KEYS', 'OPENWOP_API_KEY', ...OIDC_KEYS]) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('apiKeyConfigError', () => {
  it('is null in local dev (no NODE_ENV, no enforce flag) even with no keys configured', () => {
    delete process.env.NODE_ENV;
    delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
    delete process.env.OPENWOP_API_KEYS;
    delete process.env.OPENWOP_API_KEY;
    expect(apiKeyConfigError()).toBeNull();
  });

  it('is null under plain NODE_ENV=production (cookie-per-visitor — no bearer enforcement)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
    delete process.env.OPENWOP_API_KEYS;
    delete process.env.OPENWOP_API_KEY;
    expect(apiKeyConfigError()).toBeNull();
  });

  it('flags an enforce-bearer deploy with NO credential (no API key + no OIDC)', () => {
    process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
    delete process.env.OPENWOP_API_KEYS;
    delete process.env.OPENWOP_API_KEY;
    for (const k of OIDC_KEYS) delete process.env[k];
    expect(apiKeyConfigError()).toMatch(/every request is rejected|no bearer credential/i);
  });

  it('is null under enforce-bearer when a real API key is configured', () => {
    process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
    process.env.OPENWOP_API_KEYS = 'real-key-123';
    for (const k of OIDC_KEYS) delete process.env[k]; // the KEY, not OIDC, must be what satisfies it
    expect(apiKeyConfigError()).toBeNull();
  });

  it('is null under enforce-bearer when OIDC is the bearer path (no API key)', () => {
    process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
    delete process.env.OPENWOP_API_KEYS;
    delete process.env.OPENWOP_API_KEY;
    process.env.OPENWOP_OIDC_ISSUER = 'https://idp.example.com';
    process.env.OPENWOP_OIDC_AUDIENCE = 'openwop';
    process.env.OPENWOP_OIDC_JWKS_URL = 'https://idp.example.com/jwks';
    expect(apiKeyConfigError()).toBeNull();
  });

  it('treats an all-whitespace key list as unconfigured under enforce-bearer', () => {
    process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
    process.env.OPENWOP_API_KEYS = ' , , ';
    for (const k of OIDC_KEYS) delete process.env[k];
    expect(apiKeyConfigError()).toMatch(/no bearer credential is configured/);
  });
});
