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
import { validateSamlAssertion } from '../host/auth/samlValidationService.js';

const log = createLogger('auth.saml');

/** True when `candidate` has the same origin (proto+host+port) as `configured`. */
function sameOrigin(candidate: string, configured: string): boolean {
  try {
    return new URL(candidate).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

export function registerSamlAuthRoutes(app: Express): void {
  app.post('/v1/host/openwop-app/auth/saml/validate', async (req, res, next) => {
    try {
      const configured = process.env.OPENWOP_TEST_SAML_IDP_URL;
      if (!configured) {
        throw new OpenwopError('not_found', 'SAML test seam not configured (set OPENWOP_TEST_SAML_IDP_URL).', 404, {});
      }
      const body = (req.body ?? {}) as { idpUrl?: unknown; variant?: unknown };
      const idpUrl = typeof body.idpUrl === 'string' ? body.idpUrl : '';
      const variant = typeof body.variant === 'string' ? body.variant : '';
      if (!idpUrl || !variant) {
        throw new OpenwopError('validation_error', 'Fields `idpUrl` and `variant` are required.', 400, {});
      }
      // SSRF guard — only the operator-configured IdP origin may be fetched.
      if (!sameOrigin(idpUrl, configured)) {
        throw new OpenwopError('forbidden', 'idpUrl does not match the configured synthetic IdP.', 403, {});
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
      log.info('saml_assertion_accepted', { variant });
      res.status(200).json({ authenticated: true, principal: result.principal });
    } catch (err) {
      next(err);
    }
  });
}
