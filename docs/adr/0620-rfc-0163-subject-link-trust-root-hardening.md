# ADR 0620 — RFC 0163 subject-linking hardening (declarable key class + same-IdP trust root)

Status: implemented

## Context

RFC 0159 / ADR 0613 shipped the SCIM ⟷ SAML combined-leaver contract: a
same-tenant subject LINK keyed on the opaque `externalId` (== persistent SAML
`NameID`), a cross-lane deny store, and a `capabilities.auth.subjectLinking`
advertisement. Two of its safety obligations survived only as **negative-existence
claims-checks** a suite cannot fully witness (§A.2 "MUST NOT key on a mutable/PII
attribute", §A.4 "MUST NOT silently fall back"), and it left the two lanes'
trust-root relationship open (UQ4: nothing forbade linking two principals that
merely collide on an identifier across two *different* IdPs).

**RFC 0163** (Active; amends RFC 0159; wire shape locked 2026-09-01, spec commit
`da881bec`) hardens both, additively, gated on the same `subjectLinking:true`
opt-in:

- **§A — a declarable, witnessable link-key CLASS.** A `subjectLinking:true` host
  MUST advertise `capabilities.auth.subjectLinkKey`, a value from the **closed**
  enum `{opaque-idp, configured-immutable}` (classes, not vendor attributes).
  Mutable/PII keys are inexpressible by construction — the enum's closedness is
  the witness. Required-when-`subjectLinking:true` as an `auth-profiles.md` MUST
  **and** a `capabilities.schema.json` `if`/`then`.
- **§B — a same-IdP trust-root MUST.** A link may form only when the SAML
  assertion's signed `<saml:Issuer>` entityID matches the IdP entityID the SCIM
  connection was bound to at configuration time. A cross-IdP identifier collision
  MUST NOT join two principals; absent a shared trust root, fail closed (§B.2).

The conformance suite `@openwop/openwop-conformance@1.148.0` carries the witness
scenarios (`auth-subject-link-key-class.test.ts` + the `src/lib/` self-tests). This
ADR is the reference-host implementation that gates RFC 0163 `Active → Accepted`.

## Decision

Extend ADR 0613 — do not rewrite it. Same LINK-not-MERGE posture; no `userIdFor`
change; RFC 0048 §C owner-echo and RFC 0006 `:fork` replay stay deterministic.

1. **Suite pin + vendored schema.** `@openwop/openwop-conformance` → `^1.148.0`;
   re-vendor `schemas/capabilities.schema.json` from the package (it now carries
   the `subjectLinkKey` enum + the conditional; `additionalProperties:true`
   preserved).

2. **Key class (§A).** `SUBJECT_LINK_KEY = 'opaque-idp'` — ONE exported const in
   `host/auth/subjectLinkService.ts` (openwop-app links on externalId↔persistent-
   NameID, which IS `opaque-idp`). `discovery.ts` `subjectLinkingCapability()`
   emits `{ subjectLinking: true, subjectLinkKey: SUBJECT_LINK_KEY }` — the
   literal DERIVED from that const, so advertise and behaviour cannot drift (§A.2).

3. **Trust-root binding (§B).** The SCIM connection's IdP entityID is BOUND at
   provision/config time and recorded on the User (`User.idpEntityId`, `source:
   'scim'` only), never inferred from a later request:
   - the conformance seam supplies `idpUrl`; the host resolves the entityID by
     fetching the synthetic IdP once and reading its signed `<saml:Issuer>`
     (SSRF-guarded to the configured allowlist);
   - the real `/scim/v2` lane (bearer-authed, no `idpUrl`) uses the config seat
     `OPENWOP_SCIM_IDP_ENTITY_ID`.
   The SAML validator (`samlValidationService`) reconstructs the `<saml:Issuer>`
   inside the signed canonical (suite ≥1.147.0) and surfaces `SamlPrincipal.issuer`.
   `evaluateSubjectLinkTrustRoot(tenant, externalId, samlIssuer, fallback)`
   (`scimProvisioningService`) returns `no-link | unbound | same-root | mismatch`.

4. **Enforcement, both lanes.** The `auth/saml/validate` seam (`authSaml.ts`) and
   the PRODUCTION ACS (`authSamlSso.ts`) both call the shared evaluator BEFORE the
   RFC 0159 deny check. A `mismatch` refuses:
   - seam → `401 { authenticated:false, reason:'subject_link_trust_root_mismatch',
     linkedDenied:false }`;
   - ACS → no session (`/?ssoError=1`), fail-closed on evaluator throw.
   `unbound`/`no-link` fall through to the RFC 0159 deny contract, so a SAML-only
   or pre-RFC-0163 deployment is unaffected (no regression).

5. **SSRF allowlist widened (R2).** `host/auth/samlSeamOrigins.ts` allows BOTH
   `OPENWOP_TEST_SAML_IDP_URL` (IdP-A) and `OPENWOP_TEST_SAML_IDP_URL_B` (IdP-B).
   Before, the seam 403'd IdP-B before any trust-root check, so the §B cross-root
   negative passed VACUOUSLY. Widening lets the assertion reach the trust-root
   refusal — proven load-bearing by a sabotage revert (the cross-root leg returns
   200 when the refusal is removed).

## The `unbound` carve-out (why not fail-closed on absent seat unconditionally)

RFC 0163 §B.2 says fail closed absent a shared trust root. Applied literally to
EVERY deployment, that would refuse every legitimate active user provisioned by
the pre-RFC-0163 (no-entityID) path — a false-negative regression. So the check
fires only when the SCIM side is BOUND (a recorded `idpEntityId` or the config
seat). A bound link whose SAML assertion carries no issuer DOES fail closed
(`mismatch`); an entirely unbound connection falls back to the RFC 0159 deny-only
contract (still SAFE — a deactivated leaver is still denied, just by the RFC 0159
externalId match rather than the §B trust-root scope). This narrows §B.2 to the
deployments that have opted into trust-root binding, exactly the population RFC
0163 binds.

## Implementation record

| Piece | File | Test |
|---|---|---|
| `subjectLinkKey` const | `host/auth/subjectLinkService.ts` | `test/auth-subject-link.test.ts` (advert) |
| Discovery advert | `routes/discovery.ts` | `test/auth-subject-link.test.ts` |
| Signed-Issuer canonical + `principal.issuer` | `host/auth/samlValidationService.ts` | `test/auth-saml.test.ts` |
| `User.idpEntityId` + create/update | `features/users/usersService.ts` | (covered via seam) |
| Trust-root evaluator + provision binding | `host/auth/scimProvisioningService.ts` | `test/auth-subject-link.test.ts` |
| SCIM seam `idpUrl` resolve/record | `routes/authScim.ts` | `test/auth-subject-link.test.ts` |
| SSRF allowlist (both roots) | `host/auth/samlSeamOrigins.ts` | `test/auth-subject-link.test.ts` |
| Validate-seam refusal (R1/R2) | `routes/authSaml.ts` | `test/auth-subject-link.test.ts` |
| Production ACS parity | `routes/authSamlSso.ts` + `host/auth/samlSso.ts` | `test/auth-saml-sso-trust-root.test.ts` |
| Vendored schema sync | `schemas/capabilities.schema.json` | `capabilities-auth-subject-link.test.ts` (suite `src/lib/`) |

Witnessed by the merged conformance scenarios (`auth-subject-link-key-class.test.ts`,
opt-in on the two-IdP + SCIM seam env) and the in-process host witness above,
which stands up two synthetic IdPs with distinct signed issuers.

## Alternatives weighed

- **Fail closed on absent seat unconditionally** — rejected: regresses every
  pre-RFC-0163 active user (see the carve-out above).
- **Use idpUrl origin as the trust-root discriminator** — rejected: RFC 0163 §B.1
  pins the representation to the signed `<saml:Issuer>` entityID; the origin is
  not the entityID and would not survive a real multi-URL IdP.
- **A second Stripe-style trust-root store** — unnecessary: the entityID rides
  the existing SCIM `User` record (the same rail `externalId` rides).
