/**
 * Production SAML 2.0 SSO routes — the real enterprise login (Okta / Azure AD…).
 * OFF until the `OPENWOP_SAML_*` env vars are set (see `host/auth/samlSso.ts`);
 * every route 404s when unconfigured.
 *
 *   GET  /v1/host/openwop-app/auth/saml/sso/login[?returnTo=/]  SP-initiated → redirect to IdP
 *   POST /v1/host/openwop-app/auth/saml/sso/acs                 IdP POSTs SAMLResponse → session
 *   GET  /v1/host/openwop-app/auth/saml/sso/metadata           SP metadata XML (upload to the IdP)
 *
 * These are PRE-AUTH (the user has no session yet), so the prefix is on the auth
 * middleware's PUBLIC_PATH_PREFIXES allowlist. On a validated assertion the ACS
 * provisions a durable `User` keyed `saml:<NameID>` and issues a session cookie —
 * SAML becomes a first-class login alongside OIDC + password (ADR 0002 / RFC 0050).
 */
import express, { type Express } from 'express';
import { OpenwopError } from '../types.js';
import { resolveActiveWorkspace } from '../host/activeWorkspacePref.js';
import { isWorkspaceMember } from '../host/accessControlService.js';
import { createLogger } from '../observability/logger.js';
import { issueUserSession } from '../middleware/auth.js';
import { upsertFromPrincipal, sessionEpochOf } from '../features/users/usersService.js';
import { isLinkedSubjectDenied, combinedSubjectLinkingActive } from '../host/auth/subjectLinkService.js';
import { evaluateSubjectLinkTrustRoot } from '../host/auth/scimProvisioningService.js';
import { samlSettings, samlAuthorizeUrl, samlValidate, samlMetadata } from '../host/auth/samlSso.js';
import type { Storage } from '../storage/storage.js';

const log = createLogger('routes.authSamlSso');

/** Only same-site relative paths — block open-redirect via RelayState. */
function safeReturnTo(v: unknown): string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

export function registerSamlSsoRoutes(app: Express, deps: { storage?: Storage } = {}): void {
  const storage = deps.storage;
  // SP-initiated: bounce the browser to the IdP with a relay-stated AuthnRequest.
  app.get('/v1/host/openwop-app/auth/saml/sso/login', async (req, res, next) => {
    try {
      const s = samlSettings();
      if (!s) throw new OpenwopError('not_found', 'SAML SSO is not configured on this host.', 404, {});
      const url = await samlAuthorizeUrl(s, safeReturnTo(req.query.returnTo), storage);
      res.redirect(url);
    } catch (err) { next(err); }
  });

  // Assertion Consumer Service — the IdP's browser-driven form POST lands here.
  app.post(
    '/v1/host/openwop-app/auth/saml/sso/acs',
    express.urlencoded({ extended: false, limit: '256kb' }),
    async (req, res, next) => {
      try {
        const s = samlSettings();
        if (!s) throw new OpenwopError('not_found', 'SAML SSO is not configured on this host.', 404, {});
        const body = (req.body ?? {}) as { SAMLResponse?: string; RelayState?: string };
        if (!body.SAMLResponse) throw new OpenwopError('validation_error', 'Missing SAMLResponse.', 400, {});

        let identity;
        try {
          identity = await samlValidate(s, body.SAMLResponse, body.RelayState, storage);
        } catch (e) {
          // Rejected assertion (bad signature / expired / wrong audience / forged).
          log.warn('saml_sso_rejected', { reason: e instanceof Error ? e.message : 'invalid' });
          res.redirect('/?ssoError=1');
          return;
        }

        // RFC 0159 §A.3 (ADR 0613) — the combined leaver contract, enforced in
        // PRODUCTION (not just the conformance seam), so the advertised
        // `capabilities.auth.subjectLinking` is behaviorally honest. A valid
        // assertion for a subject whose LINKED SCIM identity was deactivated MUST
        // NOT mint a session. The deny is keyed on the SCIM `externalId` ==
        // persistent SAML `NameID`; consult it under this SP's deployment tenant.
        // For the link to fire the operator MUST align OPENWOP_SAML_TENANT ==
        // OPENWOP_SCIM_TENANT (the RFC 0159 "same-tenant link" requirement).
        // Fail CLOSED (§A.4): a store read error refuses the login rather than
        // letting a leaver in during a storage outage.
        // RFC 0163 §B.1 (ADR 0620) — trust-root scoping, applied in PRODUCTION,
        // not only the test seam. Before honouring the cross-lane link, verify
        // the assertion's SIGNED issuer matches the IdP entityID the SCIM
        // connection was bound to (OPENWOP_SCIM_IDP_ENTITY_ID for the real
        // /scim/v2 lane, or the per-record entityID). A cross-IdP identifier
        // collision MUST NOT authenticate as the SCIM-linked principal, and a
        // BOUND link we cannot trust-root-verify fails closed (§B.2). `no-link`
        // falls through to the RFC 0159 deny contract; `unbound` fails closed in a
        // both-profiles deployment (RFC 0164 §A.2, below) but otherwise falls
        // through — a SAML-only or pre-RFC-0163 deployment is unaffected.
        let trustRoot;
        try {
          trustRoot = await evaluateSubjectLinkTrustRoot(
            s.tenantId,
            identity.nameId,
            identity.issuer,
            process.env.OPENWOP_SCIM_IDP_ENTITY_ID,
          );
        } catch (e) {
          log.warn('saml_sso_trust_root_check_failed_closed', { reason: e instanceof Error ? e.message : 'error' });
          trustRoot = 'mismatch' as const;
        }
        // RFC 0164 §A.2 (ADR 0623) — in a deployment that advertises BOTH
        // profiles, a subject the host cannot bind to a shared trust root
        // (`unbound`) MUST fail closed: 0163's `unbound` deny-only carve-out is
        // REMOVED for the combined contract. Gated on the SAME
        // `combinedSubjectLinkingActive()` predicate the advert uses, so a
        // single-profile / pre-0164 deployment keeps the carve-out unchanged.
        if (trustRoot === 'unbound' && combinedSubjectLinkingActive()) {
          log.warn('saml_sso_unbound_refused', { tenantId: s.tenantId });
          res.redirect('/?ssoError=1');
          return;
        }
        if (trustRoot === 'mismatch') {
          log.warn('saml_sso_trust_root_mismatch_refused', { tenantId: s.tenantId });
          res.redirect('/?ssoError=1');
          return;
        }

        let linkedDenied: boolean;
        try {
          linkedDenied = await isLinkedSubjectDenied(s.tenantId, identity.nameId);
        } catch (e) {
          log.warn('saml_sso_link_check_failed_closed', { reason: e instanceof Error ? e.message : 'error' });
          linkedDenied = true;
        }
        if (linkedDenied) {
          log.warn('saml_sso_linked_deactivated_refused', { tenantId: s.tenantId });
          res.redirect('/?ssoError=1');
          return;
        }

        // Provision-or-resolve the durable User for this IdP subject, then bind a
        // session — SAML is now a real login. `saml:<NameID>` is the stable,
        // opaque RBAC subject (ADR 0003); groups captured verbatim (RFC 0049/ADR 0006).
        const user = await upsertFromPrincipal({
          tenantId: s.tenantId,
          principalId: `saml:${identity.nameId}`,
          source: 'saml',
          ...(identity.email ? { email: identity.email } : {}),
          ...(identity.displayName ? { displayName: identity.displayName } : {}),
          groups: identity.groups,
        });
        // USERS-1 (fail-closed, finding H5): a valid IdP assertion is
        // authentication, not authorization to hold a session. The host's
        // disable lifecycle is the fail-closed lockout — `upsertFromPrincipal`
        // deliberately never re-activates a disabled record, so consult the
        // resolved status and refuse BEFORE minting the session cookie.
        if (user.status !== 'active') {
          log.warn('saml_sso_disabled_user_refused', { userId: user.userId });
          throw new OpenwopError('forbidden', 'This account is disabled.', 403, { userId: user.userId });
        }
        // ADR 0389 P4: an IdP-provisioned sign-in satisfies tenant MFA policy BY
        // DELEGATION — the org's IdP owns the factor requirement; double-gating
        // would dead-end SSO users with no Firebase factor to enroll. Grade-pass
        // SEC-G2 honesty valve: OPENWOP_SAML_ASSUME_MFA=false switches from
        // assume-by-delegation to judging the assertion's AuthnContextClassRef
        // (multifactor/timesync/smartcard classes count; absent/password ⇒ no
        // mark, and the user hits the requireMfa gate honestly).
        const assumeMfa = process.env.OPENWOP_SAML_ASSUME_MFA !== 'false';
        const acr = identity.authnContextClassRef ?? '';
        const mfaByContext = /multifactor|mfa|timesynctoken|smartcard/i.test(acr);
        // ADR 0434 P4 (grade fix IDN-2) — honor the subject's last active
        // workspace here too. Wiring only the OIDC-bind mint left the app
        // INCONSISTENT: the same human landed in their shared workspace after a
        // Google sign-in but in their personal tenant after SAML. Same
        // fail-closed resolution — a stale preference cannot resurrect access
        // that was revoked.
        const samlActive = await resolveActiveWorkspace(user.userId, s.tenantId, isWorkspaceMember);
        issueUserSession(res, { userId: user.userId, tenantId: samlActive, personalTenant: s.tenantId, mfa: assumeMfa || mfaByContext, epoch: sessionEpochOf(user) });
        log.info('saml_sso_login', { userId: user.userId, groups: identity.groups.length });
        res.redirect(safeReturnTo(body.RelayState));
      } catch (err) { next(err); }
    },
  );

  // SP metadata — the company uploads this (or its URL) when creating the IdP app.
  app.get('/v1/host/openwop-app/auth/saml/sso/metadata', (_req, res, next) => {
    try {
      const s = samlSettings();
      if (!s) throw new OpenwopError('not_found', 'SAML SSO is not configured on this host.', 404, {});
      res.type('application/xml').send(samlMetadata(s));
    } catch (err) { next(err); }
  });
}
