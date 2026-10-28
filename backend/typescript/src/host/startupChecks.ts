/**
 * ADR 0981 D3 — every fatal server-start misconfiguration, reported together.
 *
 * Each check stays in its owner; this module only calls them, so `main()` can
 * log the whole list and exit once instead of failing on the first. Server-only:
 * `createApp()` never calls it, because in-process test apps run test env by
 * design (ADR 0195).
 */
import { sessionSecretConfigError } from '../middleware/auth.js';
import { enterprisePosture, productionProfileStartupErrors } from './deployPosture.js';
import { isAuthorizationEnforced } from './protocolAuthorization.js';
import { listedSuperadminTenants, superadminMfaRequired } from './superadmin.js';
import { oidcTrustRootStartupError } from './oidcTrustGuard.js';
import { testAuthSeamStartupError } from '../routes/authTestSeam.js';
import { workspaceReadinessStartupError } from './workspaceReadiness.js';

/**
 * ADR 0981 D2 rows 7–8 (P3) — the two controls the strict profile added on
 * acceptance. They read each rule's own predicate, so "on" means exactly what
 * the rule's owner means by it. Each has a named hatch (ADR 0195's rule: accept
 * a named risk, never drift into it). Before turning either rule on, read the
 * census (`GET /host/openwop-app/operations/profile-census`).
 */
export function strictProfileRuleErrors(): string[] {
  if (!enterprisePosture()) return [];
  const errors: string[] = [];
  if (!isAuthorizationEnforced() && process.env.OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION !== 'true') {
    errors.push(
      'OPENWOP_DEPLOY_POSTURE=auth requires membership authorization: set OPENWOP_AUTHORIZATION_ENFORCEMENT=true ' +
        '(read GET /host/openwop-app/operations/profile-census first — it lists who enforcement would deny), or accept ' +
        'the risk explicitly with OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION=true (ADR 0981).',
    );
  }
  if (listedSuperadminTenants().length > 0 && !superadminMfaRequired() && process.env.OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA !== 'true') {
    errors.push(
      'OPENWOP_DEPLOY_POSTURE=auth with OPENWOP_SUPERADMIN_TENANTS set requires a superadmin second factor: enroll TOTP ' +
        'for every listed superadmin (Settings → Security), then set OPENWOP_SUPERADMIN_REQUIRE_MFA=true; break-glass stays ' +
        'exempt. Or accept the risk explicitly with OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA=true (ADR 0981).',
    );
  }
  return errors;
}

export function serverStartupErrors(storageDsn: string): string[] {
  return [
    sessionSecretConfigError(),
    ...productionProfileStartupErrors(storageDsn),
    ...strictProfileRuleErrors(),
    // ADR 0745 D4 — a deployed service never trusts the conformance harness's OIDC issuer.
    oidcTrustRootStartupError(),
    // ADR 0833 D8 — nor serves the any-subject test-login seam.
    testAuthSeamStartupError(),
    // ADR 0551 P2 — a required durable workspace store on a non-durable DSN.
    workspaceReadinessStartupError(storageDsn),
  ].filter((e): e is string => e !== null);
}
