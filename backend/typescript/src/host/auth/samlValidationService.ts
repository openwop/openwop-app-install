/**
 * SAML 2.0 assertion validator — `openwop-auth-saml` ACS (ADR 0002, Phase 3).
 *
 * Implements the RFC 0050 §A MUST list, porting the defense structure of
 * MyndHyve's `SAMLValidationService` (signature validation, clock-skew-adjusted
 * validity window, and the signature-wrapping / XSW defense) with `node:crypto`
 * only — no `xml-crypto`/`xmldom` dependency, matching this app's zero-runtime-dep
 * posture. It validates the assertion shape minted by the conformance suite's
 * synthetic IdP (`@openwop/openwop-conformance` `createSyntheticSamlIdp`), which
 * is the deterministic reference the host's ACS is driven against over the
 * `auth/saml/validate` seam.
 *
 * The RFC 0050 §A MUST list, in order:
 *   1. signature present            — unsigned  -> reject (`unsigned`)
 *   2. algorithm not `none`         — alg:none   -> reject (`alg-none`)
 *   3. signature binds the consumed assertion — the signed element MUST be the
 *      same element whose contents are consumed; otherwise the classic XML
 *      signature-wrapping (XSW) attack reads an attacker-injected assertion
 *      while a benign one carries the valid signature -> reject
 *      (`signature-wrapping`). THIS is the load-bearing security property.
 *   4. signature cryptographically valid against the IdP cert — else
 *      `bad-signature`
 *   5. validity window — now in [NotBefore, NotOnOrAfter) (± clock skew) — else
 *      `not-yet-valid` / `expired`
 * A pass maps the assertion's NameID onto an RFC 0048 principal (opaque,
 * non-PII) and any group attributes onto raw `groups[]` (group->role mapping is
 * RFC 0049 / ADR 0006 — NOT done here). Every failure maps to the canonical
 * `unauthenticated` envelope at the seam.
 *
 * @see ../../routes/../host/auth/samlAuthRoutes.ts (the seam)
 * @see RFCS/0050 §A · spec/v1/auth-profiles.md §openwop-auth-saml
 */

import { createVerify } from 'node:crypto';

const SIG_ALG_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SIG_ALG_NONE = 'http://www.w3.org/2000/09/xmldsig#none';

/** Tolerated clock skew on the validity window, mirroring MyndHyve's
 *  `clockSkewMs`. Small — the synthetic windows are ±1h, real IdPs ~minutes. */
const CLOCK_SKEW_MS = 60_000;

export type SamlRejectReason =
  | 'unsigned'
  | 'alg-none'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'signature-wrapping'
  | 'malformed';

export interface SamlPrincipal {
  /** Opaque, non-PII principal id derived from the SAML NameID. */
  principalId: string;
  nameId: string;
  /** Raw IdP group attributes, verbatim. Group->role mapping is ADR 0006. */
  groups: string[];
}

export interface SamlValidationResult {
  valid: boolean;
  reason: SamlRejectReason | null;
  principal?: SamlPrincipal;
}

/** The exact canonical byte string the synthetic IdP signs — reconstructed from
 *  the parsed consumed assertion so the RSA-SHA256 verify agrees without a full
 *  C14N stack (the deterministic-template approach the harness documents). */
function canonicalAssertion(id: string, subject: string, notBefore: string, notOnOrAfter: string): string {
  return (
    `<saml:Assertion ID="${id}" Version="2.0">` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"/>` +
    `<saml:Subject><saml:NameID>${subject}</saml:NameID></saml:Subject>` +
    `</saml:Assertion>`
  );
}

/**
 * Validate a SAML assertion against the IdP's signing certificate (PEM public
 * key). Returns `{ valid, reason, principal? }`. Pure + synchronous — no I/O.
 */
export function validateSamlAssertion(assertionXml: string, certificatePem: string): SamlValidationResult {
  const sigAlg = /<ds:SignatureMethod Algorithm="([^"]+)"/.exec(assertionXml)?.[1];
  const sigValue = /<ds:SignatureValue>([^<]*)<\/ds:SignatureValue>/.exec(assertionXml)?.[1];
  const refId = /<ds:Reference URI="#([^"]+)"/.exec(assertionXml)?.[1];

  // The CONSUMED assertion is the FIRST <saml:Assertion> in the response — the
  // one a downstream reader would use. The XSW defense (below) binds the
  // signature to THIS element, not to whichever element the signature covers.
  const consumed =
    /<saml:Assertion ID="([^"]+)"[^>]*>[\s\S]*?<saml:Conditions NotBefore="([^"]+)" NotOnOrAfter="([^"]+)"\/>[\s\S]*?<saml:NameID>([^<]*)<\/saml:NameID>/.exec(
      assertionXml,
    );
  if (consumed === null) return { valid: false, reason: 'malformed' };
  const [, consumedId, notBefore, notOnOrAfter, subject] = consumed;

  // 1. signature present — `unsigned` means no <ds:Signature> element at all
  //    (no SignatureValue / no SignatureMethod). An `alg:none` assertion DOES
  //    carry the element (with an empty value), so it falls through to step 2.
  if (sigValue === undefined || sigAlg === undefined) {
    return { valid: false, reason: 'unsigned' };
  }
  // 2. reject alg:none / absent-algorithm
  if (sigAlg === SIG_ALG_NONE || sigAlg !== SIG_ALG_RSA_SHA256) {
    return { valid: false, reason: 'alg-none' };
  }
  // 3. XSW defense: the signed element MUST be the consumed element.
  if (refId !== consumedId) {
    return { valid: false, reason: 'signature-wrapping' };
  }
  // 4. signature cryptographically valid against the IdP cert.
  const canonical = canonicalAssertion(consumedId, subject, notBefore, notOnOrAfter);
  let ok = false;
  try {
    ok = createVerify('RSA-SHA256').update(canonical, 'utf8').verify(certificatePem, sigValue, 'base64');
  } catch {
    ok = false; // malformed key / signature bytes -> treat as bad signature
  }
  if (!ok) return { valid: false, reason: 'bad-signature' };

  // 5. validity window (± clock skew).
  const now = Date.now();
  const nb = Date.parse(notBefore);
  const noa = Date.parse(notOnOrAfter);
  if (Number.isNaN(nb) || Number.isNaN(noa)) return { valid: false, reason: 'malformed' };
  if (now < nb - CLOCK_SKEW_MS) return { valid: false, reason: 'not-yet-valid' };
  if (now >= noa + CLOCK_SKEW_MS) return { valid: false, reason: 'expired' };

  // SECURITY (review finding #1): `groups` is intentionally always empty. The
  // signature only covers the reconstructed `canonicalAssertion` (ID +
  // Conditions + Subject/NameID) — it does NOT cover an <AttributeStatement>.
  // Parsing group attributes from the surrounding XML would surface UNSIGNED,
  // attacker-injectable data (append a `groups=admin` Attribute to a validly
  // signed assertion and the verify still passes). Honoring signed group
  // attributes requires real XML-DSig coverage of the whole assertion, which
  // this node:crypto validator does not implement — so we surface NO groups
  // rather than forgeable ones. Group->role provisioning flows through SCIM
  // (`scimProvisioningService`), whose membership IS authenticated.
  return {
    valid: true,
    reason: null,
    principal: { principalId: `saml:${subject}`, nameId: subject, groups: [] },
  };
}
