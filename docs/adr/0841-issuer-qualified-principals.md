# ADR 0841 — Issuer-qualified principals: unnecessary while each protocol has one IdP per host; ratcheted so they cannot become necessary silently

Status: Accepted (P0 implemented with this ADR; P1 deferred to its trigger)

## Context

Auth mints principals as unqualified strings: `oidc:<sub>`
(`middleware/auth.ts`), `saml:<NameID>` (`routes/authSamlSso.ts`) and
`scim:<userName>` (`host/auth/scimProvisioningService.ts`). None of them carries
the issuer. `docs/steward/TODO.md` CE-15 (and CONNCD-15 / CONNWF-5e) records the
consequence: "the same string can be two humans across IdPs". The rule that
follows is that any cross-tenant alias, merge or erasure must prove same-human
through a link, never through string equality.

A read-only audit on 2026-10-05 listed every place a principal string is compared
or joined. Two of its findings were fixed on their own merits:
- #4427 scoped the superadmin re-key migration to its tenant.
- #4491 stopped a `scim:<userName>` DSAR key matching a deny row's `externalId`.

Both PRs, and the CE-15 entry, described a live "two different humans share one
string" hazard. **That premise is false on this host today**, and that fact is
what this ADR records.

### MEASURED 2026-10-06: every protocol has exactly one IdP per host

| Protocol | Configuration | Cardinality |
|---|---|---|
| OIDC | `readOidcConfigFromEnv()` — `OPENWOP_OIDC_ISSUER` (+ `_AUDIENCE`, `_JWKS_URL`) | one issuer per host |
| SAML | `samlSettings()` — `OPENWOP_SAML_IDP_SSO_URL` / `_IDP_CERT` / `_SP_ENTITY_ID` / `_ACS_URL`, bound to `OPENWOP_SAML_TENANT` | one IdP per host, one tenant |
| SCIM | `OPENWOP_SCIM_BEARER`, bound to `OPENWOP_SCIM_TENANT`, entity `OPENWOP_SCIM_IDP_ENTITY_ID` | one client per host, one tenant |

No IdP configuration is stored anywhere else. There is no per-tenant SSO,
connection or IdP collection. So within one protocol, a principal string can only
come from that protocol's single IdP: it names one human host-wide. The protocol
prefixes keep `saml:x`, `scim:x` and `oidc:x` apart. The CONNCD-15 collision
(two IdPs presenting the same string in one workspace) **cannot arise** in this
configuration.

## Decision

**D1 — Keep principals unqualified while D2's invariant holds.** Issuer
qualification would mean rewriting every stored principal: User rows,
memberships, key `createdBy`, run owners, deny rows and erasure keys. That buys
nothing while each protocol has one IdP.

**D2 — Pin the invariant with a ratchet.**
`backend/typescript/test/adr0841-single-idp-ratchet.test.ts` asserts that:
- the IdP configuration surface is EXACTLY the env names in the table above;
- no `DurableCollection` stores SSO, IdP, SAML or OIDC connection settings.

Adding a second issuer, a per-tenant IdP, or a stored SSO connection therefore
fails the ratchet, and its message points here. Whoever adds multi-IdP support
implements D3 in the same change, or consciously re-pins with a stated reason.

**D3 — When the invariant breaks (P1, deferred): key identity on `(tenant, issuer, principal)`, not on a rewritten string.**
- Store the issuer on the User row. For SCIM, `User.idpEntityId` already exists, written only for SCIM today. Give SAML/OIDC rows the same.
- Derive `userIdFor(tenant, issuer, principal)` for NEW users. Existing rows keep their id and default to the host's single configured issuer, so no id moves and no replay/fork reference breaks (RFC 0048 §D).
- Make every join that crosses a tenant or an IdP require a link (`linkedIds`, or `idpEntityId` + principal), never string equality. That is the shape ADR 0780 D2's correction already accepted.

  The sites to convert are the audit's list:

  | Site | Today | Needs |
  |---|---|---|
  | `getUserByPrincipal` / `userIdFor` | string | issuer |
  | `usersGuards.ts` `upsertFromPrincipal` | string | issuer |
  | `connectionsService.ts` `actingUserIds` (non-`user:` branch) | string | link |
  | `subjectLinkService` deny key | `tenant:externalId` | `tenant:idpEntityId:externalId` |
  | OIDC-bind `rekeyMemberSubject` (global) | string | issuer-scoped |

**Alternatives weighed.**
1. *Rewrite principal strings now* (`saml:<entityHash>:<NameID>` …). Rejected. It is a wide, replay-sensitive migration for a hazard that cannot occur today.
2. *Do nothing and rely on review.* Rejected. The invariant lives in env-reading code, and nothing would notice a second IdP being added. The original CE-15 entry shows how easily this is misjudged in both directions.
3. *D1 + D2 (chosen).* Zero migration, plus a tripwire on the exact change that makes D3 necessary.

## Consequences

- CE-15 stops being an open "design (L)" item. It becomes a deferred P1 with a mechanical trigger.
- #4427 and #4491 stand as defence-in-depth and as a semantic fix. Their PRs carry correction comments saying the two-humans scenario is not reachable today.
- `docs/steward/TODO.md` CE-15 is reframed to point here.

## Phases

| Phase | What | Status |
|---|---|---|
| P0 | This ADR + the D2 ratchet (sabotage: adding an env read or an SSO collection reds it) | implemented |
| P1 | D3, in the same change that adds a second IdP surface | deferred — triggered by the ratchet |

## Open questions

- [ ] Does a white-label adopter need per-tenant SSO? If so, P1 is that feature's first ADR dependency, not an afterthought.
