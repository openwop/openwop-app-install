/**
 * SSRF allowlist for the SAML/SCIM conformance test seams (RFC 0050 finding C3,
 * widened for RFC 0163 §B).
 *
 * The `auth/saml/validate` and `auth/scim/provision` seams fetch a synthetic IdP
 * over HTTP (`GET {idpUrl}?variant=…`). An arbitrary body `idpUrl` MUST NOT be
 * fetchable, or the seam becomes a server-side request-forgery vector — so a
 * fetch target is refused unless its origin matches an operator-configured
 * synthetic-IdP endpoint.
 *
 * RFC 0163 §B needs a TWO-trust-root seam: IdP-A (also the SCIM lane's IdP) and
 * IdP-B (the cross-root collider). BOTH are legitimate targets, so the allowlist
 * carries both `OPENWOP_TEST_SAML_IDP_URL` and `OPENWOP_TEST_SAML_IDP_URL_B`.
 * BEFORE this widening the guard 403'd IdP-B unconditionally, which made the §B
 * cross-root negative pass VACUOUSLY (403, no `authenticated` field) — the seam
 * never reached the trust-root check. Widening the allowlist is what lets the
 * trust-root refusal become the load-bearing assertion.
 */

/** The operator-configured synthetic-IdP endpoints (both trust roots). */
export function allowedIdpUrls(): string[] {
  return [process.env.OPENWOP_TEST_SAML_IDP_URL, process.env.OPENWOP_TEST_SAML_IDP_URL_B].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
}

/** True when `candidate` shares an origin (proto+host+port) with a configured
 *  synthetic-IdP endpoint — the only URLs a seam may fetch. */
export function isAllowedIdpUrl(candidate: string): boolean {
  let origin: string;
  try {
    origin = new URL(candidate).origin;
  } catch {
    return false;
  }
  return allowedIdpUrls().some((u) => {
    try {
      return new URL(u).origin === origin;
    } catch {
      return false;
    }
  });
}
