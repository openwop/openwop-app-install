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
import { createLogger } from '../observability/logger.js';
import { issueUserSession } from '../middleware/auth.js';
import { upsertFromPrincipal } from '../features/users/usersService.js';
import { samlSettings, samlAuthorizeUrl, samlValidate, samlMetadata } from '../host/auth/samlSso.js';

const log = createLogger('routes.authSamlSso');

/** Only same-site relative paths — block open-redirect via RelayState. */
function safeReturnTo(v: unknown): string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

export function registerSamlSsoRoutes(app: Express): void {
  // SP-initiated: bounce the browser to the IdP with a relay-stated AuthnRequest.
  app.get('/v1/host/openwop-app/auth/saml/sso/login', async (req, res, next) => {
    try {
      const s = samlSettings();
      if (!s) throw new OpenwopError('not_found', 'SAML SSO is not configured on this host.', 404, {});
      const url = await samlAuthorizeUrl(s, safeReturnTo(req.query.returnTo));
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
          identity = await samlValidate(s, body.SAMLResponse, body.RelayState);
        } catch (e) {
          // Rejected assertion (bad signature / expired / wrong audience / forged).
          log.warn('saml_sso_rejected', { reason: e instanceof Error ? e.message : 'invalid' });
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
        issueUserSession(res, { userId: user.userId, tenantId: s.tenantId, personalTenant: s.tenantId });
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
