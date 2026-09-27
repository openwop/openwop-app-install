# ADR 0613 — RFC 0159 SCIM ⟷ SAML subject linking (the combined leaver contract)

Status: implemented

## Context

The durable User key is `userIdFor(tenant, principalId) = user:<sha256(tenant:principalId)>`.
A SAML login is principal `saml:<NameID>`; a SCIM user is `scim:<userName>` —
**structurally different Users**. So a leaver deactivated via SCIM
(`scim:<userName>` disabled) can still SSO in via SAML (`saml:<NameID>` still
active). RFC 0159 (Active; amends RFC 0050) closes this: a host advertising BOTH
`openwop-auth-saml` and `openwop-auth-scim` MUST maintain a same-tenant subject
LINK keyed on an OPAQUE, IdP-stable id (SCIM `externalId` == persistent SAML
`NameID`), and a SCIM deactivation MUST fail-close the linked SAML identity.

This is host work riding an already-Accepted RFC — no new wire RFC needed. The
merged conformance witness is `../openwop/conformance/src/scenarios/auth-subject-link.test.ts`.

## Decision

**LINK, not MERGE.** Do NOT rewrite `userIdFor` or coalesce the two durable
Users — merging breaks `:fork` replay + RFC 0048 §D owner-echo. Instead maintain
a cross-lane deny that the SAML decision path consults.

1. **Deny store** — `host/auth/subjectLinkService.ts`, a `DurableCollection<LinkDenyRow>`
   in its own `hostext:auth:subjectLinkDeny:` namespace, rows keyed
   deterministically `${tenantId}:${externalId}` (no randomUUID ⇒ idempotent +
   replay-safe), `tenantOf` index so teardown reclaims it. API:
   `denyLinkedSubject`, `isLinkedSubjectDenied`, `clearLinkedSubjectDeny`.
   `isLinkedSubjectDenied` is a point read and THROWS on a storage error so the
   security callers fail CLOSED (§A.4).
2. **Persist `externalId` on the User** (`features/users/usersService.ts`) for
   `source:'scim'` records + `getScimUserByExternalId(tenantId, externalId)` —
   IDOR-guarded (tenant match AND `source==='scim'`), mirroring `resolveScimUser`.
3. **SCIM deactivate writes the deny** at the ONE composition owner
   (`scimProvisioningService.deactivateUser` + `setScimActive`), keyed on the
   user's own tenant + externalId — covering the conformance seam AND the real
   `/scim/v2` PATCH/DELETE lane. Reactivation (`setScimActive(user, true)`)
   CLEARS the deny (re-hire).
4. **SAML validate seam** (`routes/authSaml.ts`) accepts an optional body
   `nameId`; after a VALID assertion it consults `isLinkedSubjectDenied` and
   returns `401 {authenticated:false, reason:'subject_linked_deactivated', linkedDenied:true}`
   when denied, else `{authenticated:true, ..., linkedDenied:false}`.
5. **Production ACS** (`routes/authSamlSso.ts` `/auth/saml/sso/acs`) consults the
   deny after validation and REFUSES to mint the session when denied — so the
   advertised capability is behaviorally honest in production, not only under the
   test seam.
6. **§A.2 link-key hygiene** — `op:'link'` with a mutable/PII `linkKey`
   (email/userName/…) is rejected `400 validation_error`; no cross-lane link is
   formed from a mutable key. The legitimate link is IMPLICIT (externalId ==
   NameID), established at provision time.
7. **Discovery** — `subjectLinkingCapability()` emits `{subjectLinking:true}`
   IFF both profiles are advertised, DERIVED from the same `advertisedAuthProfiles()`.

### Tenant-resolution seam

The deny store is a generic `(tenantId, externalId)` map; the caller picks the
tenant:

- The conformance SCIM seam routes subject-link (externalId-addressed) ops
  through the deterministic `OPENWOP_SCIM_TENANT` (default `scim`) realm, and the
  pre-auth `auth/saml/validate` seam consults that same realm — deterministic
  same-tenant resolution with no session (§A.1).
- The real `/scim/v2` lane provisions/deactivates under `OPENWOP_SCIM_TENANT`
  (via `requireScimBearer`), so the deny lands there.
- The production ACS consults its SAML deployment tenant (`OPENWOP_SAML_TENANT`).

**Production caveat:** for the contract to fire in a real deployment the operator
MUST align `OPENWOP_SAML_TENANT == OPENWOP_SCIM_TENANT`. That alignment IS the
RFC 0159 "same-tenant link" requirement made concrete; it is documented in the
ACS code comment. When they differ, each lane remains internally consistent and
fail-closed — the link simply does not span the two tenants.

## Alternatives weighed

- **Rewrite `userIdFor` to a shared opaque subject / merge the two Users** —
  rejected: breaks `:fork` replay determinism and RFC 0048 §D owner-echo (a run
  stamped `saml:<NameID>` must resolve verbatim on replay).
- **Deny store owned by `usersService` or `scimProvisioningService`** — rejected:
  the cross-lane leaver deny is a distinct concept owned by neither; a new module
  is the single source of truth both lanes import.

## Implementation record

| Piece | File | Test |
|---|---|---|
| Deny store | `host/auth/subjectLinkService.ts` | `test/subject-link-service.test.ts` |
| User.externalId + resolver | `features/users/usersService.ts` | `test/auth-subject-link.test.ts` |
| SCIM deactivate → deny/clear | `host/auth/scimProvisioningService.ts` | `test/auth-scim.test.ts` |
| Seam: top-level fields, link tenant, `link` reject, sample alias | `routes/authScim.ts` | `test/auth-subject-link.test.ts` |
| SAML validate: nameId consult, sample alias | `routes/authSaml.ts` | `test/auth-subject-link.test.ts` |
| Production ACS consult | `routes/authSamlSso.ts` | (covered by service + seam) |
| Discovery flag | `routes/discovery.ts` | `test/auth-subject-link.test.ts` |

Witnessed by the merged conformance scenario `auth-subject-link.test.ts` (opt-in
on `OPENWOP_TEST_SAML_IDP_URL` + `OPENWOP_TEST_SCIM_URL`).
