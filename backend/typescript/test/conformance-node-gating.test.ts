/**
 * ENG-2 / ENG-1 (CODEBASE-ASSESSMENT.md): the conformance-only node typeIds
 * must be OFF by default in production, and the sub-run dispatcher must NOT
 * fall back to a guessable literal credential under enforced auth.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { conformanceNodesEnabled } from '../src/bootstrap/conformanceMockAgent.js';
import { resolveInternalToken } from '../src/subruns/subRunDispatcher.js';

const SAVED = { ...process.env };
afterEach(() => {
  // Restore the keys these tests mutate.
  for (const k of [
    'NODE_ENV',
    'OPENWOP_ENABLE_CONFORMANCE_NODES',
    'OPENWOP_AUTH_ENFORCE_BEARER',
    'OPENWOP_INTERNAL_TOKEN',
    'OPENWOP_API_KEYS',
    'OPENWOP_API_KEY',
  ]) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('conformanceNodesEnabled', () => {
  it('is ON by default outside production (dev/test/conformance)', () => {
    delete process.env.NODE_ENV;
    delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
    expect(conformanceNodesEnabled()).toBe(true);
  });

  it('is OFF by default under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
    expect(conformanceNodesEnabled()).toBe(false);
  });

  it('can be force-enabled in production (reference conformance host)', () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
    expect(conformanceNodesEnabled()).toBe(true);
  });

  it('can be force-disabled outside production', () => {
    delete process.env.NODE_ENV;
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
    expect(conformanceNodesEnabled()).toBe(false);
  });
});

describe('resolveInternalToken', () => {
  it('prefers an explicit service token', () => {
    process.env.OPENWOP_INTERNAL_TOKEN = 'svc-abc';
    process.env.OPENWOP_API_KEYS = 'k1,k2';
    expect(resolveInternalToken()).toBe('svc-abc');
  });

  it('falls back to the first configured API key', () => {
    delete process.env.OPENWOP_INTERNAL_TOKEN;
    process.env.OPENWOP_API_KEYS = ' k1 , k2 ';
    expect(resolveInternalToken()).toBe('k1');
  });

  it('uses the dev literal only when auth is not enforced and no creds exist', () => {
    delete process.env.OPENWOP_INTERNAL_TOKEN;
    delete process.env.OPENWOP_API_KEYS;
    delete process.env.OPENWOP_API_KEY;
    delete process.env.NODE_ENV;
    delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
    expect(resolveInternalToken()).toBe('dev-token');
  });

  it('FAILS CLOSED under OPENWOP_AUTH_ENFORCE_BEARER when no real credential is set', () => {
    delete process.env.OPENWOP_INTERNAL_TOKEN;
    delete process.env.OPENWOP_API_KEYS;
    delete process.env.OPENWOP_API_KEY;
    delete process.env.NODE_ENV;
    process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
    expect(() => resolveInternalToken()).toThrow(/service credential|refusing to fall back/i);
  });

  it('does NOT throw under plain NODE_ENV=production (cookie-per-visitor) — uses the dev literal', () => {
    // A prod cookie deploy isn't bearer-enforcing; throwing would break sub-run
    // dispatch. The dev literal isn't honored as a wildcard API key in prod
    // (readValidKeys withdraws it), so the round-trip falls through to anon.
    delete process.env.OPENWOP_INTERNAL_TOKEN;
    delete process.env.OPENWOP_API_KEYS;
    delete process.env.OPENWOP_API_KEY;
    delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
    process.env.NODE_ENV = 'production';
    expect(resolveInternalToken()).toBe('dev-token');
  });
});
