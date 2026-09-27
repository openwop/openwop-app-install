# ADR 0623 — RFC 0164: the SCIM⟷SAML leaver contract is MANDATORY when both profiles are advertised

Status: implemented

## Context

RFC 0159 / ADR 0613 shipped the SCIM ⟷ SAML combined-leaver contract, and RFC
0163 / ADR 0620 hardened it (a declarable link-key CLASS + a same-IdP trust-root
MUST). In both, `capabilities.auth.subjectLinking:true` was an **honesty-gated
opt-in**: a host advertising both `openwop-auth-saml` and `openwop-auth-scim`
was *encouraged* to also derive `subjectLinking:true`, but a host that advertised
both profiles and *omitted* `subjectLinking` was treated as **`inapplicable`** —
not a failure. That left a real hole: a leaver deactivated via SCIM
(`scim:<userName>`) could still SSO in via SAML (`saml:<NameID>`), and the wire
never had to admit it. RFC 0163 also left a runtime carve-out: an `unbound`
subject (a SCIM record with no recorded trust root) fell back to RFC 0159
deny-only — ADR 0620 flagged this §B.2 concern as unclosed.

**RFC 0164** (spec locked at openwop `b1203c439`; suite
`@openwop/openwop-conformance@1.151.0`) closes both:

- The contract is **MANDATORY**: any host advertising BOTH `openwop-auth-saml`
  AND `openwop-auth-scim` MUST derive `subjectLinking:true` + `subjectLinkKey`.
  **"Both profiles advertised + no `subjectLinking:true`" becomes a conformance
  FAILURE (was `inapplicable`).**
- **§A.2** removes the `unbound` carve-out *for a both-profiles deployment*: "For
  any subject the host cannot link (no persistent NameID / no externalId, no
  shared trust root per RFC 0163 §B.2, or lanes that serve different tenant
  realms), the host MUST fail closed on the SAML lane for that subject. A host
  that cannot honour the combined contract for its deployment as a whole MUST NOT
  advertise both profiles."

For openwop-app, the deployment can fail to honour the combined contract two ways:
realm misalignment (`subjectLinkRealmAlignment()` reports `aligned:false` when a
configured production SAML SP's `OPENWOP_SAML_TENANT` differs from
`scimLinkRealm()`), or no shared trust root configurable for the SCIM lane
(neither `OPENWOP_SCIM_IDP_ENTITY_ID` nor the conformance seam's
`OPENWOP_TEST_SCIM_URL`).

## Decision

**Enforce "both profiles ⇒ combined contract" STRUCTURALLY, from a single shared
predicate, by DROPPING `openwop-auth-scim` from discovery when the contract cannot
hold, and by failing the SAML lane closed on an unlinkable subject in a
both-profiles deployment.**

1. **The shared predicate — `combinedSubjectLinkingActive()`
   (`host/auth/subjectLinkService.ts`).** True iff the host advertises BOTH
   profiles AND can honour the contract as a whole:
   `samlProfileAdvertised() && scimProfileAdvertised() && scimTrustRootConfigured()
   && subjectLinkRealmAlignment().aligned`. Both consumers — the discovery advert
   and the SAML lanes — read this ONE predicate, so the advertised posture and the
   runtime enforcement can never disagree (advertise both ⟺ enforce fail-closed on
   an unlinkable subject).

2. **The advert drop — `advertisedAuthProfiles()` (`routes/discovery.ts`).** After
   building the profiles list, if it contains BOTH profiles but
   `!combinedSubjectLinkingActive()`, drop `openwop-auth-scim` (keep SAML). This is
   the single source: the only two consumers of `advertisedAuthProfiles()` are the
   profiles list itself and `subjectLinkingCapability()`, whose existing
   `&& subjectLinkRealmAlignment().aligned` clause is now implied (kept as
   defense-in-depth). The gate has **two independent arms** — misaligned realms,
   and no configurable trust root — each proven load-bearing by a separate witness.

3. **The runtime fail-closed — `routes/authSaml.ts` (validate seam) +
   `routes/authSamlSso.ts` (production ACS).** The RFC 0163 evaluator returns
   `no-link | unbound | same-root | mismatch`. When `trustRoot === 'unbound' &&
   combinedSubjectLinkingActive()`, both lanes now refuse (seam →
   `401 {authenticated:false, reason:'subject_link_unbound', linkedDenied:false}`;
   ACS → no session, `/?ssoError=1`). A **distinct** reason
   `subject_link_unbound` (not `subject_link_trust_root_mismatch`) so logs tell
   them apart. Gated on the shared predicate, so a **single-profile / pre-0164
   deployment keeps RFC 0163's `unbound` deny-only carve-out unchanged** — the
   `unbound` fail-closed applies ONLY to the combined-contract deployment.

4. **Why DROP SCIM, not SAML.** SAML is the operator's deliberate production SSO
   login path; dropping it would remove the daily sign-in advertisement for every
   employee. SCIM is the provisioning lane; its bearer endpoints still FUNCTION
   (the seam is not disabled) — we simply stop *advertising* a cross-lane link that
   cannot hold. Withholding the SCIM advert is the honest signal that cross-lane
   deprovisioning is not guaranteed on this deployment.

5. **Boot-log operator signal (`index.ts`).** The existing
   `subject_link_realms_misaligned` error log (key unchanged) now states that
   `openwop-auth-scim` is DROPPED from discovery (not merely that `subjectLinking`
   is withheld).

### Composition with RFC 0163 (ADR 0620)

- **RFC 0164 is an advertise-time CONFIG property.** It decides, from static env
  (`samlRealm` vs `scimRealm`, and whether a trust root is configurable), whether
  the host may advertise both profiles at all. Its enforcement is a
  discovery-document shape plus a runtime gate keyed on the same static condition.
- **RFC 0163's trust-root check is a runtime PER-CONNECTION property.** It decides,
  at link-formation time, whether a given SAML assertion's signed `<saml:Issuer>`
  matches the IdP the SCIM connection was bound to.

They compose cleanly because 0164 gates *upstream*: misaligned/untrustable ⇒ SCIM
dropped ⇒ no "both profiles" posture ⇒ no `subjectLinking` claim ⇒ 0163's runtime
link path is never reached for a configuration that could over-claim. **RFC 0164
tightens 0163 in one place: it REMOVES the `unbound` deny-only carve-out for a
combined deployment (fail-closed instead), which is the honest closure of the
§B.2 concern ADR 0620 flagged.** When both profiles DO survive (aligned +
trust-root configured), 0163's trust-root MUST still governs each individual link.

## Alternatives weighed

- **Drop `openwop-auth-saml` instead of SCIM — REJECTED.** SAML is the production
  login path; removing its advertisement breaks daily sign-in for a configuration
  problem unrelated to SAML's own soundness.
- **Fail boot when the contract cannot hold — REJECTED.** Both lanes work
  independently; only the cross-link is broken. A hard boot failure would take
  down SSO login and SCIM provisioning over a missing cross-lane guarantee. The
  boot-log signal + the honest advert is the proportionate response.
- **Withhold only `subjectLinking` (the pre-0164 posture) — REJECTED by RFC
  0164.** That is precisely the "both profiles + no subjectLinking" state RFC 0164
  reclassifies from `inapplicable` to FAILURE.
- **Keep 0163's `unbound` deny-only in a combined deployment — REJECTED by §A.2.**
  A subject with no shared trust root is a subject the host cannot link; the
  combined contract requires failing it closed on the SAML lane.

## Implementation record

| Item | Where |
| --- | --- |
| Shared predicate + arms (`combinedSubjectLinkingActive`, `samlProfileAdvertised`, `scimProfileAdvertised`, `scimTrustRootConfigured`) | `src/host/auth/subjectLinkService.ts` |
| RFC 0164 advert drop (two-arm gate) | `src/routes/discovery.ts` `advertisedAuthProfiles()` |
| Defense-in-depth note | `src/routes/discovery.ts` `subjectLinkingCapability()` |
| `unbound` fail-closed (validate seam) | `src/routes/authSaml.ts` (`subject_link_unbound`) |
| `unbound` fail-closed (production ACS) | `src/routes/authSamlSso.ts` (`saml_sso_unbound_refused`) |
| Boot-log wording (SCIM dropped) | `src/index.ts` `subject_link_realms_misaligned` |
| In-process witness (5 legs, 2 sabotages) | `test/auth-subject-link.test.ts` → "RFC 0164 … mandatory-both invariant" |
| Conformance pin `^1.151.0` + re-vendored `allOf` schema | `backend/typescript/package.json`, `schemas/capabilities.schema.json` |

The witness is **end-to-end** against the real `${BASE}/.well-known/openwop` and
the `sample` auth seams (env-per-request), the authoritative form:

- **(i)** misaligned realms + trust-root seat present ⇒ `openwop-auth-scim` ABSENT
  (born-red on origin/main);
- **(ii)** aligned realms + NO trust-root seat ⇒ `openwop-auth-scim` ABSENT (the
  second gate arm, proven independently);
- **(iii)** aligned + seat ⇒ both profiles + `subjectLinking:true` +
  `subjectLinkKey:'opaque-idp'` (born-green after the gate);
- **(iv)** unbound subject + both profiles ⇒ SAML `401 subject_link_unbound`;
- **(v)** single-profile deployment + unbound subject ⇒ RFC 0159 deny-only
  survives (authenticates).

Sabotage-verified: reverting the SCIM drop reds (i) AND (ii); reverting the
unbound refusal reds (iv) (while (v) stays green — the carve-out is intact). The
RFC 0159/0163 legs (cross-lane deactivation, link-key hygiene, same-IdP trust
root) remain green.

## Conformance schema + suite

Folded into THIS PR (the suite published while the host leg was in flight):
`@openwop/openwop-conformance` → `^1.151.0`, and `schemas/capabilities.schema.json`
re-vendored from that package. `auth` is now an `allOf` of two conditionals — the
EXISTING `subjectLinking:true ⇒ subjectLinkKey required`, PLUS the NEW
`profiles ⊇ {openwop-auth-saml, openwop-auth-scim} ⇒ subjectLinking const true +
subjectLinkKey required`; the `subjectLinking` description is marked
derived/deprecated-toward-v2. The schema now REJECTS a both-profiles-no-flag
document — which the structural drop guarantees this host never emits.

## References

- RFC 0164 — the mandatory-both SCIM⟷SAML leaver contract (amends RFC 0159/0163); spec `b1203c439`; suite `@openwop/openwop-conformance@1.151.0`.
- ADR 0620 — RFC 0163 subject-linking hardening (declarable key class + trust root).
- ADR 0613 — RFC 0159 SCIM⟷SAML subject linking (the original combined leaver contract).
- ADR reservation: `docs/adr/0623-rfc-0164-mandatory-subject-linking.md` (via `scripts/check-adr-refs.mjs --reserve`).
