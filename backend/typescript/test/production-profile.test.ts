/**
 * ADR 0981 P1 — the strict production profile reports EVERY missing control at
 * once (D3) and readiness labels the profile without naming hatches (D5, Q5).
 * Witness S02-T1, cases 1–3 and 5 for the rows that exist today.
 *
 * Why: before this, each guard in `main()` exited on its own failure, so an
 * operator missing three controls found them over three failed boots. The
 * strict/evaluation label makes "evaluation remains clearly labeled" something a
 * deploy smoke can read.
 *
 * Sabotage-witnessed (2026-10-26): dropping the KMS row from
 * `productionProfileStartupErrors` reds 4 of 7 (per-row, three-at-once,
 * cross-owner, hatch); making `serverStartupErrors` keep only the first entry
 * reds 2 (three-at-once, cross-owner); adding hatch names to the readiness body
 * reds the readiness case.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deployProfile, productionProfileStartupErrors } from '../src/host/deployPosture.js';
import { serverStartupErrors, strictProfileRuleErrors } from '../src/host/startupChecks.js';
import { createApp } from '../src/index.js';

const PG = 'postgres://u:p@h/db';
const NODE_ENV_ROW = /requires NODE_ENV=production/;
const DSN_ROW = /requires a durable control-plane store/;
const KMS_ROW = /requires BYOK secret encryption/;

/** A coherent strict deploy: auth posture, production, KMS key, real session secret. */
function strictEnv(): void {
  vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('OPENWOP_BYOK_KMS_KEY', 'projects/p/locations/l/keyRings/r/cryptoKeys/k');
  vi.stubEnv('OPENWOP_SESSION_SECRET', 'x'.repeat(48));
  vi.stubEnv('OPENWOP_ALLOW_INSECURE_AUTH_POSTURE', '');
  vi.stubEnv('OPENWOP_ALLOW_EPHEMERAL_STORAGE', '');
  vi.stubEnv('OPENWOP_TEST_AUTH_ENABLED', '');
  vi.stubEnv('OPENWOP_WORKSPACE_REQUIRE_DURABLE', '');
  // ADR 0981 P3 rows: membership enforced, no superadmins listed, no hatches.
  vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', 'true');
  vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', '');
  vi.stubEnv('OPENWOP_SUPERADMIN_REQUIRE_MFA', '');
  vi.stubEnv('OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION', '');
  vi.stubEnv('OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA', '');
  // The trust-root guard reads these; a developer shell must not leak them in.
  for (const k of ['OPENWOP_TEST_OIDC_ISSUER_URL', 'OPENWOP_TEST_OIDC_AUDIENCE', 'OPENWOP_CONFORMANCE_HARNESS_HOST', 'OPENWOP_CONFORMANCE_OIDC_PORT', 'OPENWOP_OIDC_ISSUER']) {
    vi.stubEnv(k, '');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ADR 0981 D3 — every strict-profile row, reported together', () => {
  it('a coherent strict deploy has no startup errors and is labelled strict', () => {
    strictEnv();
    expect(serverStartupErrors(PG)).toEqual([]);
    expect(deployProfile()).toBe('strict');
  });

  it('each missing row reports exactly its own error', () => {
    strictEnv();
    vi.stubEnv('NODE_ENV', 'test');
    const insecure = productionProfileStartupErrors(PG);
    expect(insecure).toHaveLength(1);
    expect(insecure[0]).toMatch(NODE_ENV_ROW);

    strictEnv();
    const ephemeral = productionProfileStartupErrors('sqlite://./data/x.db');
    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]).toMatch(DSN_ROW);

    strictEnv();
    vi.stubEnv('OPENWOP_BYOK_KMS_KEY', '');
    const noKms = productionProfileStartupErrors(PG);
    expect(noKms).toHaveLength(1);
    expect(noKms[0]).toMatch(KMS_ROW);
  });

  it('three missing rows come back in one report, not one per boot', () => {
    strictEnv();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENWOP_BYOK_KMS_KEY', '');
    const errors = serverStartupErrors('memory://');
    expect(errors).toHaveLength(3);
    expect(errors.some((e) => NODE_ENV_ROW.test(e))).toBe(true);
    expect(errors.some((e) => DSN_ROW.test(e))).toBe(true);
    expect(errors.some((e) => KMS_ROW.test(e))).toBe(true);
  });

  it('collects across owners: a profile row and the test-login seam refusal together', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_BYOK_KMS_KEY', '');
    vi.stubEnv('OPENWOP_TEST_AUTH_ENABLED', 'true');
    const errors = serverStartupErrors(PG);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => KMS_ROW.test(e))).toBe(true);
    expect(errors.some((e) => /OPENWOP_TEST_AUTH_ENABLED/.test(e))).toBe(true);
  });

  it('a named hatch clears only its own row; the KMS row has no hatch', () => {
    strictEnv();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENWOP_BYOK_KMS_KEY', '');
    vi.stubEnv('OPENWOP_ALLOW_INSECURE_AUTH_POSTURE', 'true');
    vi.stubEnv('OPENWOP_ALLOW_EPHEMERAL_STORAGE', 'true');
    const errors = productionProfileStartupErrors('memory://');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(KMS_ROW);
  });

  it('an evaluation posture requires none of the rows and is labelled evaluation', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'cookie-per-visitor');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('OPENWOP_BYOK_KMS_KEY', '');
    expect(productionProfileStartupErrors('memory://')).toEqual([]);
    expect(deployProfile()).toBe('evaluation');
  });
});

describe('ADR 0981 P3 — the membership and superadmin-MFA rows (D2 rows 7–8)', () => {
  const MEMBERSHIP_ROW = /requires membership authorization/;
  const MFA_ROW = /requires a superadmin second factor/;

  it('membership enforcement off is refused, naming the census and the hatch', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', '');
    const errors = serverStartupErrors(PG);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(MEMBERSHIP_ROW);
    expect(errors[0]).toMatch(/profile-census/);
    expect(errors[0]).toMatch(/OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION=true/);
  });

  it('only the exact string "true" counts as enforced, matching the rule itself', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', 'TRUE');
    expect(strictProfileRuleErrors()).toEqual([expect.stringMatching(MEMBERSHIP_ROW)]);
  });

  it('the membership hatch clears only its own row', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', '');
    vi.stubEnv('OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION', 'true');
    expect(serverStartupErrors(PG)).toEqual([]);
  });

  it('listed superadmins without the MFA requirement are refused, naming enrollment and the hatch', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', 'user:op1,user:op2');
    const errors = serverStartupErrors(PG);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(MFA_ROW);
    expect(errors[0]).toMatch(/Settings → Security/);
    expect(errors[0]).toMatch(/OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA=true/);
  });

  it('the MFA row is met by the requirement or its hatch, and absent with no superadmins listed', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', 'user:op1');
    vi.stubEnv('OPENWOP_SUPERADMIN_REQUIRE_MFA', 'true');
    expect(strictProfileRuleErrors()).toEqual([]);
    vi.stubEnv('OPENWOP_SUPERADMIN_REQUIRE_MFA', '');
    vi.stubEnv('OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA', 'true');
    expect(strictProfileRuleErrors()).toEqual([]);
    vi.stubEnv('OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA', '');
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', ' , ');
    expect(strictProfileRuleErrors()).toEqual([]);
  });

  it('both new rows report together with the older rows in one list', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', '');
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', 'user:op1');
    vi.stubEnv('OPENWOP_BYOK_KMS_KEY', '');
    const errors = serverStartupErrors(PG);
    expect(errors).toHaveLength(3);
    expect(errors.some((e) => MEMBERSHIP_ROW.test(e))).toBe(true);
    expect(errors.some((e) => MFA_ROW.test(e))).toBe(true);
    expect(errors.some((e) => KMS_ROW.test(e))).toBe(true);
  });

  it('an evaluation profile requires neither row', () => {
    strictEnv();
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'cookie-per-visitor');
    vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', '');
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', 'user:op1');
    expect(strictProfileRuleErrors()).toEqual([]);
  });
});

describe('ADR 0981 D5 — readiness carries the profile label and no hatch names', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    vi.stubEnv('OPENWOP_STORAGE_DSN', 'memory://');
    vi.stubEnv('OPENWOP_AUTH_DISABLE_COOKIES', 'true');
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'production-profile-test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        res();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    vi.unstubAllEnvs();
  });

  it('reports evaluation, and a set hatch never reaches the public body', async () => {
    vi.stubEnv('OPENWOP_ALLOW_EPHEMERAL_STORAGE', 'true');
    const res = await fetch(`${base}/readiness`);
    const text = await res.text();
    const body = JSON.parse(text) as { profile?: string };
    expect(body.profile).toBe('evaluation');
    expect(text).not.toMatch(/OPENWOP_ALLOW_/);
  });
});
