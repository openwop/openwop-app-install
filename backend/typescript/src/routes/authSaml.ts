/**
 * SAML assertion-validation seam (RFC 0050 §A — `openwop-auth-saml`).
 *
 *   POST /v1/host/openwop-app/auth/saml/validate   { idpUrl, variant }
 *
 * Drives the host's real SAML ACS (`samlValidationService`) over the live wire,
 * per `spec/v1/host-sample-test-seams.md`: resolve `{ certificatePem, assertion }`
 * of the named `variant` from the operator-supplied synthetic IdP
 * (`GET {idpUrl}?variant=<v>`), validate the assertion, and answer
 *   - 2xx `{ authenticated: true, principal }`  for `valid`
 *   - 401 `{ authenticated: false, reason }`     (`unauthenticated`) for every
 *     negative — the full RFC 0050 §A MUST list (alg:none, unsigned,
 *     bad-signature, expired, not-yet-valid, signature-wrapping).
 *
 * The seam is HOST-LEVEL, not behind the `users` toggle: advertising
 * `openwop-auth-saml` (discovery.ts) is a host-wide claim, so the seam that
 * honors it MUST be reachable whenever the profile is advertised — gating it on
 * a per-tenant toggle would make the advertised capability 404 (dishonest,
 * ADR 0002 finding C1). It returns 404 only when no synthetic IdP is configured
 * (`OPENWOP_TEST_SAML_IDP_URL` unset), which is how the conformance behavioral
 * leg soft-skips.
 *
 * SSRF guard (finding C3): the seam fetches ONLY the operator-configured IdP
 * origin — an arbitrary body `idpUrl` pointing elsewhere is refused (403), so
 * the seam can't be turned into a server-side request forgery vector.
 */

import type { Express } from 'express';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { createHash } from 'node:crypto';
import { validateSamlAssertion } from '../host/auth/samlValidationService.js';
import { isLinkedSubjectDenied, scimLinkRealm, combinedSubjectLinkingActive } from '../host/auth/subjectLinkService.js';
import { evaluateSubjectLinkTrustRoot } from '../host/auth/scimProvisioningService.js';
import { isAllowedIdpUrl } from '../host/auth/samlSeamOrigins.js';

const log = createLogger('auth.saml');

/** The deterministic realm the SCIM subject-link deny is keyed on — mirrors
 *  `authScim.ts` `scimTenant()`. This seam is pre-auth (no session), so it
 *  resolves the link tenant from config, per RFC 0159 §A.1. */
function scimTenant(): string {
  return scimLinkRealm();
}

/** USERS-15 — a persistent NameID SHOULD be opaque but is an email at many IdPs;
 *  logs carry a short digest for correlation, never the value. */
function subjectDigest(nameId: string): string {
  return createHash('sha256').update(nameId).digest('hex').slice(0, 16);
}

export function registerSamlAuthRoutes(app: Express): void {
  // BOTH spellings (see the authScim registration note) — the pinned suite drives
  // the `sample` alias, reachable independent of the testSeam rewrite.
  app.post(['/v1/host/openwop-app/auth/saml/validate', '/v1/host/sample/auth/saml/validate'], async (req, res, next) => {
    try {
      const configured = process.env.OPENWOP_TEST_SAML_IDP_URL;
      if (!configured) {
        throw new OpenwopError('not_found', 'SAML test seam not configured (set OPENWOP_TEST_SAML_IDP_URL).', 404, {});
      }
      const body = (req.body ?? {}) as { idpUrl?: unknown; variant?: unknown; nameId?: unknown };
      const idpUrl = typeof body.idpUrl === 'string' ? body.idpUrl : '';
      const variant = typeof body.variant === 'string' ? body.variant : '';
      // RFC 0159 (ADR 0613) — the OPAQUE subject to link-check (SCIM externalId ==
      // persistent SAML NameID). Optional: when absent the seam is the plain
      // RFC 0050 §A validator.
      const nameId = typeof body.nameId === 'string' ? body.nameId : '';
      if (!idpUrl || !variant) {
        throw new OpenwopError('validation_error', 'Fields `idpUrl` and `variant` are required.', 400, {});
      }
      // SSRF guard — only an operator-configured synthetic-IdP origin may be
      // fetched. RFC 0163 §B WIDENED this to BOTH trust roots
      // (OPENWOP_TEST_SAML_IDP_URL + _B): before, the guard 403'd IdP-B before
      // any trust-root check, so the §B cross-root negative passed VACUOUSLY
      // (403, no `authenticated` field). Widening lets the assertion reach the
      // trust-root refusal below, which is now the load-bearing assertion.
      if (!isAllowedIdpUrl(idpUrl)) {
        throw new OpenwopError('forbidden', 'idpUrl does not match a configured synthetic IdP.', 403, {});
      }

      const idpRes = await fetch(`${idpUrl}?variant=${encodeURIComponent(variant)}`);
      if (!idpRes.ok) {
        throw new OpenwopError('internal_error', `Synthetic IdP returned ${idpRes.status}.`, 502, { variant });
      }
      const { certificatePem, assertion } = (await idpRes.json()) as { certificatePem?: string; assertion?: string };
      if (typeof certificatePem !== 'string' || typeof assertion !== 'string') {
        throw new OpenwopError('internal_error', 'Synthetic IdP response missing certificatePem/assertion.', 502, { variant });
      }

      const result = validateSamlAssertion(assertion, certificatePem);
      if (!result.valid) {
        // Canonical envelope: `unauthenticated` for every §A rejection.
        log.info('saml_assertion_rejected', { variant, reason: result.reason });
        res.status(401).json({ authenticated: false, reason: result.reason });
        return;
      }

      // RFC 0159 §A.3 — the combined leaver contract. Even a cryptographically
      // VALID assertion MUST NOT authenticate a subject whose linked SCIM identity
      // has been deactivated. Fail CLOSED (§A.4): a store read error denies rather
      // than letting a leaver SSO in during a storage outage.
      if (nameId) {
        // RFC 0163 §B.1 — trust-root scoping. A link forms only when the SAML
        // assertion's SIGNED issuer matches the IdP entityID the SCIM connection
        // was bound to. A cross-IdP identifier collision (a valid assertion from
        // a DIFFERENT trust root than the one that provisioned this externalId)
        // MUST NOT authenticate as the SCIM-linked principal. `no-link` falls
        // through to the RFC 0159 deny contract (no regression).
        const trustRoot = await evaluateSubjectLinkTrustRoot(
          scimTenant(),
          nameId,
          result.principal?.issuer,
          process.env.OPENWOP_SCIM_IDP_ENTITY_ID,
        );
        // RFC 0164 §A.2 (ADR 0623) — in a deployment that advertises BOTH
        // profiles (the combined-contract deployment), a subject the host cannot
        // bind to a shared trust root (`unbound`) MUST fail closed: RFC 0163's
        // `unbound` deny-only carve-out is REMOVED here. A DISTINCT reason
        // (`subject_link_unbound`, not `..._trust_root_mismatch`) so logs tell
        // them apart. Gated on `combinedSubjectLinkingActive()` — the SAME
        // predicate the advert uses to keep both profiles — so a single-profile
        // deployment keeps 0163's carve-out unchanged.
        if (trustRoot === 'unbound' && combinedSubjectLinkingActive()) {
          log.info('saml_assertion_unbound_refused', { subjectDigest: subjectDigest(nameId), issuer: result.principal?.issuer });
          res.status(401).json({ authenticated: false, reason: 'subject_link_unbound', linkedDenied: false });
          return;
        }
        if (trustRoot === 'mismatch') {
          // USERS-15 — the NameID rides as a digest (it is an email at many
          // IdPs); the issuer is a non-PII entityID and is the diagnostic.
          log.info('saml_assertion_trust_root_mismatch', { subjectDigest: subjectDigest(nameId), issuer: result.principal?.issuer });
          res.status(401).json({ authenticated: false, reason: 'subject_link_trust_root_mismatch', linkedDenied: false });
          return;
        }
        let denied: boolean;
        try {
          denied = await isLinkedSubjectDenied(scimTenant(), nameId);
        } catch (e) {
          log.warn('saml_link_check_failed_closed', { reason: e instanceof Error ? e.message : 'error' });
          denied = true;
        }
        if (denied) {
          log.info('saml_assertion_linked_deactivated', { subjectDigest: subjectDigest(nameId) });
          res.status(401).json({ authenticated: false, reason: 'subject_linked_deactivated', linkedDenied: true });
          return;
        }
        log.info('saml_assertion_accepted', { variant, linkedDenied: false });
        res.status(200).json({ authenticated: true, principal: result.principal, linkedDenied: false });
        return;
      }

      log.info('saml_assertion_accepted', { variant });
      res.status(200).json({ authenticated: true, principal: result.principal });
    } catch (err) {
      next(err);
    }
  });
}
