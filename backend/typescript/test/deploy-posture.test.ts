/**
 * Deploy-posture env contract (ADR 0195, `host/deployPosture.ts`) — TST-CVB-6.
 *
 * The posture decides whether the managed-tier wall asks an anonymous visitor to
 * sign in: the public demo (`cookie-per-visitor`) must NOT wall anonymous users,
 * and an `auth` deploy MUST. An explicit `OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED`
 * wins over the inference in both directions, and the legacy
 * `OPENWOP_AUTH_ENFORCE_BEARER=true` still infers `auth`.
 *
 * Red when: the unset default stops being `cookie-per-visitor`, `auth` is no
 * longer a recognised posture, the explicit `false` override is ignored, or the
 * legacy bearer flag stops inferring `auth`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { managedAnonSignInRequired, readDeployPosture } from '../src/host/deployPosture.js';

const VARS = ['OPENWOP_DEPLOY_POSTURE', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED'] as const;
const saved: Partial<Record<(typeof VARS)[number], string | undefined>> = {};

describe('deploy posture env contract', () => {
  beforeEach(() => {
    for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of VARS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to cookie-per-visitor demo posture with managed anon allowed', () => {
    expect(readDeployPosture()).toBe('cookie-per-visitor');
    expect(managedAnonSignInRequired()).toBe(false);
  });

  it('auth posture keeps the managed-tier sign-in wall', () => {
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    expect(readDeployPosture()).toBe('auth');
    expect(managedAnonSignInRequired()).toBe(true);
  });

  it('explicit managed anon override wins over posture inference', () => {
    process.env.OPENWOP_DEPLOY_POSTURE = 'cookie-per-visitor';
    process.env.OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED = 'true';
    expect(managedAnonSignInRequired()).toBe(true);

    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED = 'false';
    expect(managedAnonSignInRequired()).toBe(false);
  });

  it('legacy bearer enforcement infers auth posture', () => {
    process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
    expect(readDeployPosture()).toBe('auth');
    expect(managedAnonSignInRequired()).toBe(true);
  });
});
