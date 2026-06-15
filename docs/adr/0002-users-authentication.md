# ADR 0002 — Users & Authentication (with enterprise SSO)

**Status:** implemented (Phases 1–5 shipped) — **§ Phase 2 (host email/password) + § Phase 5 (host TOTP MFA) SUPERSEDED by ADR 0026 (2026-06-11):** the host's own credential store + TOTP were removed; email/password is now Firebase Authentication and the backend holds no password. The durable-User model, OIDC bind, and enterprise SSO (SAML/SCIM) parts of this ADR are unchanged. See "Implementation record" below.

> **§ Correction (2026-06-11) — graduated off the feature toggle.** Users &
> Authentication shipped behind the `users` toggle (default OFF, per-tenant).
> That was wrong for an identity foundation: the `SignInButton`'s `/me`
> signed-in check, ADR 0003's OIDC bind, and every feature keying on durable
> `User.userId` need it unconditionally — in a toggle-OFF deploy every sign-in
> hit a 404 on `/v1/host/openwop-app/users/me`. Graduated to a permanent, always-on
> **admin** surface (nav under "Access & data", alongside Connections),
> mirroring the Connections (ADR 0024 § Correction) and Notifications
> (ADR 0010 § Correction) graduations: no `toggleDefault`, no `requireEnabled`
> gates, the page renders unconditionally.
**Date:** 2026-06-08
**Feature toggle:** `users`
**Pack(s):** `feature.users.*` → `packs.openwop.dev`
**Depends on:** ADR 0001 (feature-first package architecture)
**Unblocks:** ADR 0003 (Canonical identity & session binding — closes this ADR's
identity seam), 0004 (Organizations), 0005 (Profiles), 0006 (RBAC), and through
them every product surface in [`ROADMAP.md`](../../ROADMAP.md).
**Authored with:** `/architect` (auth-affecting decision per CLAUDE.md).

> **Port note.** This ports MyndHyve's *enterprise-SSO security logic*
> (`myndhyve/src/core/sso/` — `SAMLValidationService`, `SSOAuthService`,
> `samlAcs.ts`) as the proven reference implementation. It does **not** clone
> MyndHyve's Firebase-coupled internals. The wire authority is the OpenWOP spec:
> `spec/v1/auth-profiles.md`, **RFC 0050** (SAML/SCIM enterprise identity
> profiles), **RFC 0048** (principal), **RFC 0049** (roles), **RFC 0010** (OIDC
> auth-profile conformance family). MyndHyve is the non-steward host that drove
> RFC 0050 to **Accepted**, so its defenses are battle-tested — but openwop-app
> conforms to the spec, not to MyndHyve.

---

## Context

openwop-app today has **no first-class user identity**. The backend
(`backend/typescript/src/middleware/auth.ts`) resolves a principal from one of
three existing paths:

1. **Endpoint/platform API keys** (`verifyEndpointApiKey`) — machine callers.
2. **OIDC user-bearer** (`oidcVerifier.ts`) — already implements
   `openwop-auth-oidc-user-bearer` per RFC 0010; a verified JWT yields
   `principalId: oidc:<sub>`.
3. **Cookie/session** for the demo SPA.

There are **no durable user records**, no account lifecycle, and no org/tenant
identity beyond a `tenantId` string used as a feature-toggle bucket unit and a
superadmin gate (`OPENWOP_SUPERADMIN_TENANTS`). Every downstream roadmap feature
(Orgs, Profiles, RBAC, CRM, CMS) needs a real subject to scope and authorize
against. Identity is therefore the foundation, and it must be **enterprise-grade**:
the explicit requirement is **SSO — SAML 2.0 + SCIM provisioning**, not just
email/password.

## Decision

Ship a toggle-gated **`users`** feature package (per ADR 0001) that introduces:

1. **Durable, org-scoped user accounts + lifecycle** — create / disable / enable /
   delete; a user resolves to an **RFC 0048 `principal`** that the existing
   `auth.ts` paths already produce, now backed by a persisted record rather than a
   bare token claim.
2. **Authentication methods**, layered by phase:
   - **OIDC user-bearer** — *already implemented*; reconcile it to mint/lookup a
     durable user record instead of a transient `oidc:<sub>` principal.
   - **Email/password** + reset + verification — the baseline non-SSO path.
   - **Enterprise SSO (the headline requirement):**
     - **SAML 2.0 ACS** advertising `openwop-auth-saml`, wiring the host-sample
       seam `POST /v1/host/openwop-app/auth/saml/validate`, passing
       `auth-saml-profile.test.ts` non-vacuously.
     - **SCIM 2.0 provisioning** advertising `openwop-auth-scim`, wiring
       `POST /v1/host/openwop-app/auth/scim/provision`, passing
       `auth-scim-profile.test.ts` non-vacuously.
3. **Group capture, not role resolution.** SAML assertion groups and SCIM
   `assign-group` ops are captured **onto the principal** here; the mapping from
   groups → roles is **RFC 0049** and belongs to **ADR 0006 (RBAC)**. This ADR
   draws that boundary deliberately (Finding #6).

### The principal / role boundary (load-bearing)

| Concern | Owner | Wire artifact |
|---|---|---|
| *Who are you?* — authenticate, resolve a durable subject | **ADR 0002 (this)** | RFC 0048 `principal` (OIDC `sub` / SAML `NameID` / SCIM `userName`) + raw `groups[]` |
| *What may you do?* — map groups→roles, gate decisions | **ADR 0006 (RBAC)** | RFC 0049 `roles` |

The `users` feature **must not** contain authorization logic. It captures identity
+ raw group membership; RBAC consumes it.

## Architect findings folded into this decision

Severity-ordered; each is a binding constraint on the implementation.

### CRITICAL

- **C1 — Capability-advertisement honesty.** `capabilities.auth.profiles[]` lists
  `openwop-auth-saml` / `openwop-auth-scim` **only after** the gated conformance
  legs pass non-vacuously under `OPENWOP_REQUIRE_BEHAVIOR=true` (per
  `auth-profiles.md` honesty principle; RFC 0050 records the 13→19 count rise once
  the IdP URL engages the behavioral legs). OIDC stays advertised (already
  honored). **Never advertise ahead of behavior.**
- **C2 — SAML attack surface is load-bearing.** The ACS MUST reject all six
  negatives + accept the one positive: `valid` → authenticated; `alg:none`,
  `unsigned`, `bad-signature`, `expired` (`NotOnOrAfter`), `not-yet-valid`
  (`NotBefore`), **`signature-wrapping` (XSW)** → `401 {reason}`. The XSW defense
  (consumed-assertion `<ds:Reference URI>` identity check) is ported verbatim from
  MyndHyve's `SAMLValidationService`. Each negative lands with a SECURITY invariant
  + conformance assertion **in the same PR** as the code.
- **C3 — BYOK / secret handling.** IdP X.509 signing certs, SCIM bearer tokens, and
  OIDC client secrets live in the **host secret store only** — never in run
  definitions, event payloads, the persisted run-doc, debug bundles, or error
  bodies. Redaction recipes added; assert no secret crosses the result boundary
  (mirror the existing `aiProviders` secret-stripping in this app). Per
  `threat-model-secret-leakage.md`.
- **C4 — Replay / fork safety.** A run's creating principal is stamped at creation
  (`run.metadata`, per ADR 0001) and read **verbatim** on replay / `:fork` — never
  re-resolved against live identity. A user deactivated *after* a run was created
  MUST NOT break that run's historical replay. (This is ADR 0001's
  annotations-don't-survive-`:fork` lesson applied to identity.)

### HIGH

- **H5 — Fail-closed.** A deactivated SCIM principal's subsequent decisions deny
  (RFC 0049 fail-closed); an unverifiable assertion denies with `unauthenticated`.
  No fail-open path anywhere in the resolver.
- **H6 — Principal/role boundary** (see table above) — no RBAC logic in `users`.
- **H7 — Interop honesty.** `INTEROP-MATRIX.md` / `/.well-known/openwop` updated to
  claim saml/scim **only** when C1's gate is met.

### MEDIUM

- **M8 — MFA / break-glass (TOTP) is a deferred phase**, not a cut. MyndHyve has
  PBKDF2 + TOTP break-glass; we sequence it behind SSO, noted in the plan so the
  phasing is honest.

## Alternatives considered

1. **Keep the transient `oidc:<sub>` principal, skip durable users.** Rejected:
   Orgs/Profiles/RBAC all need a stable subject to attach membership and roles to;
   a token claim isn't a record you can disable or assign a role to.
2. **Email/password first, SSO later.** Rejected as the *primary* shape: the user
   requirement is explicitly enterprise SSO, and OIDC is already done — so SAML +
   SCIM are the real new surface, not password auth. Password auth is the baseline,
   not the headline.
3. **Build bespoke SAML validation.** Rejected: home-grown SAML is a footgun
   (XSW, `alg:none`). Port MyndHyve's proven `SAMLValidationService` + bind to the
   spec's 7-variant conformance suite — proven defenses, spec-pinned contract.
4. **Advertise saml/scim immediately for "completeness."** Rejected — violates C1 /
   the RFC 0050 honesty principle; dishonest advertisement is a CRITICAL interop
   break, not a convenience.

## Phased implementation plan

> Each phase is independently shippable and gated. The ADR moves to `implemented`
> with a phase→commit/test table as phases land.

- **Phase 1 — Durable users on the existing OIDC path.** User record store
  (org-scoped), account lifecycle, reconcile `oidcVerifier` → durable record.
  Stamp creating principal into `run.metadata` (C4). No new advertised capability.
- **Phase 2 — Email/password baseline.** Signup / login / reset / verify. Backend
  routes gated by `resolveOne('users', subject).enabled`.
- **Phase 3 — SAML 2.0 ACS (`openwop-auth-saml`).** Port `SAMLValidationService` +
  `samlAcs.ts` logic (C2 negative suite, XSW defense). Wire
  `POST /v1/host/openwop-app/auth/saml/validate`. IdP certs in secret store (C3). Flip
  the advertised profile **only** when `auth-saml-profile.test.ts` passes
  non-vacuously (C1). SAML groups captured onto the principal (H6).
- **Phase 4 — SCIM 2.0 (`openwop-auth-scim`).** `create-user` / `assign-group` /
  `deactivate-user` → upsert principal + raw groups; deactivate ⇒ fail-closed deny
  (H5). Wire `POST /v1/host/openwop-app/auth/scim/provision`. SCIM bearer in secret
  store (C3). Flip advertisement only on `auth-scim-profile.test.ts` green (C1).
- **Phase 5 (deferred) — MFA / break-glass TOTP** (M8).

## Implementation record

All five phases shipped. Each is verified (typecheck 0 errors; the cited tests
green; the full backend suite's only failures are the pre-existing
pack-dependent infra tests on `origin/main`).

| Phase | What shipped | Commit | Tests |
|---|---|---|---|
| 1 | Durable users on the existing OIDC path | `5f44aad` (PR #45) | `users-feature.test.ts` (6) |
| 2 | Email/password baseline (scrypt, reset/verify tokens) | `c008b4f` | `users-credentials.test.ts` (8) |
| 3 | SAML 2.0 ACS — `openwop-auth-saml` (XSW + §A 7-variant suite) | `514cecc` | `auth-saml.test.ts` (8) |
| 4 | SCIM 2.0 provisioning — `openwop-auth-scim` (fail-closed deactivate) | `8221626` | `auth-scim.test.ts` (4) |
| 5 | TOTP MFA (RFC 6238) + login second-factor gate | _this commit_ | `users-mfa.test.ts` (4) |

**Findings honored, with evidence:** C1 (advertise `openwop-auth-{saml,scim}`
only with a real validator proven by the per-profile tests) · C2 (the SAML XSW /
`alg:none` / window negatives each have a passing assertion) · C3 (passwords →
scrypt; reset/verify/recovery → sha256-hashed; IdP certs / SCIM tokens / TOTP
secrets kept host-side, never logged or returned past enrollment; SSRF guard on
the SAML seam) · C4 (`userId` stable across logins / SCIM joiner-mover-leaver) ·
H5 (disabled / deactivated / pending-MFA all fail closed) · H6 (raw IdP groups
captured; group→role mapping left to ADR 0006).

**Per the FEATURES/CLAUDE governance note,** no new OpenWOP RFC was needed: SSO
rides on the already-Accepted RFC 0050 profiles, and MFA is a host-internal
feature that never touches the wire.

**Deferred follow-ons** (tracked, not silently dropped): OIDC `oidc:<sub>`
principal migration into durable records on in-flight runs; the full
`/scim/v2/{Users,Groups}` REST surface (filtering, full PATCH-op semantics,
ETags); the SCIM bearer-token auth wiring; moving TOTP secrets into the host
secret vault; LDAP (`openwop-auth-ldap`, optional per RFC 0050).

## Open questions / decisions checklist

- [ ] **Superadmin reconciliation** — does a `users` record with a superadmin role
  supersede or complement `OPENWOP_SUPERADMIN_TENANTS`? (Coordinate with ADR 0006.)
- [ ] **Personal org** — does every user get an auto-created personal org on first
  login? (Coordinate with ADR 0004.)
- [ ] **OIDC principal migration** — how do existing `oidc:<sub>` principals on
  in-flight runs reconcile to durable records without breaking replay (C4)?
- [ ] **SCIM↔SAML identity linking** — same enterprise user arriving via both: key
  on what (NameID? email? SCIM `externalId`)? Define the join key before Phase 4.
- [ ] **Group→role mapping config surface** — owned by ADR 0006, but this ADR must
  fix the shape of the raw `groups[]` it hands over.
- [ ] **Conformance suite version** — confirm `@openwop/openwop-conformance` version
  exposes the full 7-variant SAML behavioral leg (RFC 0050 notes 1.18.1+).

## Replay / fork + capability summary

- **Compatibility class:** Additive. New optional auth profiles + a toggle-gated
  feature; hosts not advertising saml/scim stay v1-compliant.
- **Capability gating:** all new conformance scenarios gated on
  `auth.profiles` membership (C1) + operator-supplied IdP/SCIM env; soft-skip
  otherwise.
- **Replay:** creating principal stamped + read verbatim on `:fork` (C4).
- **SECURITY:** SAML negative-suite invariants land with the code (C2); secret
  redaction asserted (C3); fail-closed (H5).
