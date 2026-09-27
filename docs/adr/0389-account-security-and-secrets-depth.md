# ADR 0389 — Account security & secrets depth (MFA enroll · break-glass · secrets-vault UI)

**Status:** implemented (all 4 phases, 2026-07-17 — PRs #2000/#2007/#2012 + P4)
**Date:** 2026-07-17
**Feature toggle:** none new — three surfaces land on existing always-on admin/settings pages (§4)
**Depends on:** ADR 0002 (Users & Authentication — this ADR picks up its recorded Phase-5 deferrals), ADR 0026 (Firebase email/password supersedes the host credential store — **reshapes item (a), see § Context correction**), ADR 0024 (Connections credential broker — the vault UI sits *over* this), ADR 0028 (`requireSuperadmin` shared gate), ADR 0010 (Notifications — break-glass alert seam).
**Unblocks:** MYNDHYVE-GAP-ANALYSIS §1.4 "Security cluster" (MFA TOTP enroll UI · break-glass · secrets-vault UI).
**Authored with:** `/architect` posture (auth-affecting + secret-handling + capability-gating decision per CLAUDE.md).

> **Port note.** This closes three enterprise table-stakes gaps MyndHyve ships that
> openwop-app does not yet surface (gap rows 365–367). Items (a) MFA enroll UI and
> (b) break-glass login are **ADR 0002's own recorded Phase-5 deferrals** (`docs/adr/0002-users-authentication.md:171`, `:204`). Item (c) is a management UI over
> credential storage this app *already has three of* — it builds no new secret
> store. The wire authority is unchanged: SSO rides the already-Accepted **RFC 0050**;
> nothing here touches the OpenWOP wire (§8).

---

## Context

Enterprise buyers treat three things as table-stakes and openwop-app is missing the
*surfaces* for all three even though the *primitives* mostly exist:

1. **Self-service MFA enrollment** — a user can't turn on a second factor from the
   SPA. (QR + manual secret + verify.)
2. **Break-glass operator login** — if the IdP/SSO is down, there is no sanctioned
   recovery path to an operator session; the only lever is a redeploy touching
   `OPENWOP_SUPERADMIN_TENANTS`.
3. **A secrets-vault management UI** — the app stores tenant secrets, connection
   credentials, OAuth client secrets, and API keys across three subsystems, but has
   no single operator surface to list / add / reveal-once / rotate / delete them.

This is the MYNDHYVE-GAP-ANALYSIS §1.4 "Security cluster" (M+S+M). It is packaged as
**one extension ADR** because the three items share the same authority (the BYOK
envelope), the same admin RBAC posture, and the same new audit seam (§2).

### § Context correction — item (a)'s premise is stale (load-bearing)

The task framing ("backend TOTP support exists, the enroll UI doesn't") **describes a
world that ADR 0026 removed.** ADR 0002 Phase 5 shipped a *host-owned* TOTP MFA over a
host-owned password store. **ADR 0026 (Accepted, 2026-06-11) explicitly SUPERSEDED
ADR 0002 § Phase 2 (host email/password) *and* § Phase 5 (host TOTP MFA)** — the host
now holds **no** credential store; email/password and social login are **Firebase
Authentication**, and the backend only verifies Firebase OIDC ID tokens
(`features/users/authRoutes.ts:8` — "the host owns NO credential store";
`docs/adr/0026-…:6-8`). A repo grep confirms there is **no live TOTP code** anywhere in
the backend.

So item (a) is **not** "wire an enroll UI to existing backend TOTP." Re-introducing a
host TOTP secret store would resurrect exactly the parallel-credential surface ADR 0026
deleted on purpose. The correct, architecture-consistent design **delegates the second
factor to the identity provider that already owns the first factor** — Firebase
Authentication's native MFA for local/social accounts, and the enterprise IdP for SSO
accounts — and the *host's* job is (i) the enrollment UI that drives the Firebase client
SDK and (ii) a fail-closed enforcement gate that reads the second-factor state off the
verified ID token. This is developed in §3(a) and is the reason the MFA item is
recommended **passkeys-first with TOTP fallback** (§6).

---

## Boundaries audit (file:line)

| Concern | Single owner | Evidence |
|---|---|---|
| **Sessions / durable identity / the login+MFA gate** | **`users`** feature | `middleware/cookieSession.ts:149` ("the canonical subject for `/me`, MFA, run ownership, and RBAC"); `features/users/usersGuards.ts` (`requireSignedIn`, `resolveCallerUser`, `isAnonymous`); `features/users/authRoutes.ts` (Firebase OIDC bind) |
| **First + second factor for local/social accounts** | **Firebase Authentication** (client), host **verifies** the ID-token claim | `authRoutes.ts:8`; ADR 0026 decision — host holds no credential |
| **Per-user / per-org provider credentials + OAuth client secrets** | **`connections`** | `features/connections/connectionsService.ts` (`resolveConnectionCredential:346`, `upsertOAuthConnection`, `liveSecretFor`); `oauthClientStore.ts` (`DurableCollection('connections:oauth-client')`, write-only secret, ADR 0024 §7) |
| **Scoped API bearer tokens (reveal-once precedent)** | **`developer-keys`** | `features/developer-keys/apiKeyService.ts:4` ("plaintext token is shown ONCE at issuance; only its SHA-256 hash is stored"), `:53-75` |
| **THE ONE secret authority (encrypt-at-rest + the credential-ref store)** | **`byok/secretResolver.ts`** | `resolveSecret:224` / `setSecret:291` / `removeSecret:327` / `listSecretRefs:348` (tenant-scoped, `credentialRef`-keyed) **+** `sealHostSecret:183` / `openHostSecret:190` (host-global envelope). ADR 0024 §7: "the envelope stays the single owner of encrypt-at-rest; this feature composes it rather than re-deriving the master key." |
| **Superadmin privilege** | **`host/superadmin.ts`** | `isSuperadmin` / `requireSuperadmin` — wildcard bearer OR `OPENWOP_SUPERADMIN_TENANTS` OR the explicit `OPENWOP_FEATURE_TOGGLES_DEV_OPEN` dev knob; **fails closed** |
| **Break-glass operator credential (where it lives)** | **env-provisioned** (`OPENWOP_BREAKGLASS_*`), **never DB-only** — §3(b) | new; justified below |
| **Security-audit emission** | **NEW — a minimal append-only `host/securityAudit.ts` seam** (§2, "Audit seam"), no dedicated audit store exists today | grep: no `securityAudit`/`AuditLog` store in `host/`,`features/`,`middleware/` |

**The ONE secret authority — named explicitly.** `byok/secretResolver.ts` is the single
encrypt-at-rest owner. The vault UI (item c) is a **read/manage projection over it plus
the two credential subsystems that already compose it** (`connections`, `developer-keys`).
It **MUST NOT** introduce a second secret store — the same discipline ADR 0024 §7 states
for the OAuth client store. `listSecretRefs()` already returns refs (never values), which
is exactly the vault's list model.

**Where break-glass credentials live, and why env (fail-safe direction).** The
break-glass credential is provisioned as an **environment secret** (`OPENWOP_BREAKGLASS_TOKEN_HASH` — an argon2/scrypt hash of a high-entropy token, plus
`OPENWOP_BREAKGLASS_ENABLED`, default unset). It is **never DB-only**. Justification is
the fail-safe direction: break-glass exists precisely for the outage in which the
IdP and/or the durable identity store is *unreachable*. A credential that lives only in
the database is unavailable in exactly that failure, so a DB-backed break-glass is
self-defeating. Environment secrets are present at process boot independent of DB/IdP
health, which is the availability property the feature requires. The safety that keeps
this env lever from being a backdoor is layered on top: default-OFF, a **hash** (never
the plaintext) at rest, single-use + short-TTL sessions, and a loud audit + notification
on every use (§3(b)). It **composes** the existing privilege system — a break-glass
session is stamped onto a tenant already listed in `OPENWOP_SUPERADMIN_TENANTS`, so it
grants nothing the superadmin gate doesn't already recognize (it invents no parallel
privilege), per the project-memory rule that superadmin is env-based.

**Audit seam.** There is **no** dedicated security-audit store in the app today (grep
clean). The three security-sensitive actions here — a break-glass mint, a secret
reveal, a rotate/delete, an MFA disable, an enforcement-policy change — need a durable,
append-only, tamper-evident record that is *not* run-scoped (so RFC 0079 run provenance
and `run.metadata.connectionUse[]` don't fit). This ADR introduces a **minimal**
`host/securityAudit.ts` — one `DurableCollection('security:audit')`, append-only, records
`{eventId, at, actorSubject, tenantId, kind, targetRef, outcome, detail}`, never a secret
value. It **complements** (does not replace) the structured logger (`observability/logger.ts`) and, for break-glass, fires a Notifications (ADR 0010) alert to
superadmins. This is the one genuinely new persistence surface; it is justified by the
absence of any existing owner.

---

## Decision

Ship the three surfaces as an **extension of existing features** (no new feature
package, no new toggle), plus the one new `host/securityAudit.ts` seam.

### (a) Self-service MFA enroll / verify / disable — delegated to the identity provider

- **Local / social (Firebase) accounts.** Build the enroll UI in the SPA's Settings →
  **Security** section. It drives **Firebase Authentication's native MFA** via the
  Firebase client SDK: `multiFactor(user).getSession()` →
  `TotpMultiFactorGenerator.generateSecret()` yields the QR (`generateQrCodeUrl`) + the
  manual base32 secret; the user scans/enters, the UI collects the 6-digit code and
  calls `TotpMultiFactorGenerator.assertionForEnrollment()` → `multiFactor(user).enroll()`.
  **The host stores no TOTP secret** — Firebase (Identity Platform) holds it. Disable =
  `multiFactor(user).unenroll(factor)`. Recovery codes are Firebase's (or, if
  unavailable on the plan, a second enrolled factor is the recovery path — surfaced in
  copy). This is the only shape consistent with ADR 0026.
- **Enterprise SSO accounts (SAML/SCIM/non-Firebase OIDC).** The **IdP owns the second
  factor** (SAML `AuthnContext`); the app does **not** offer TOTP enrollment for these —
  double-enrolling MFA the IdP already enforces is wrong. The Security section detects
  the account source (via the durable `User.source`, `usersGuards.ts` `UserSource`) and
  shows "MFA is managed by your identity provider" instead of an enroll card.
- **Host-side gate (reads, never stores).** `middleware/cookieSession.ts` / the users
  login gate reads the verified ID token's `firebase.sign_in_second_factor` /
  `second_factor_identifier` claim to know whether a session cleared MFA. This is the
  hook §3(d)'s tenant enforcement uses. **Fail-closed:** a required-MFA tenant whose
  token shows no second factor is denied the durable-identity routes (401), never
  fail-open.

### (b) Break-glass operator login

- **Pre-provisioned, env, default-OFF.** `OPENWOP_BREAKGLASS_ENABLED` (unset ⇒ the whole
  path 404s — no route, no timing oracle), `OPENWOP_BREAKGLASS_TOKEN_HASH` (argon2/scrypt
  of a high-entropy token generated out-of-band), `OPENWOP_BREAKGLASS_TENANT` (which
  superadmin tenant the minted session assumes — MUST be in `OPENWOP_SUPERADMIN_TENANTS`
  or the mint refuses).
- **The flow.** `POST /v1/host/openwop-app/auth/break-glass` (public-allowlisted, like the
  SAML ACS) accepts the plaintext token, constant-time-compares against the hash, and on
  match mints a **single-use, short-TTL (≤10 min) host cookie session** (`cookieSession.ts`) whose tenant is `OPENWOP_BREAKGLASS_TENANT`. It composes
  `host/superadmin.ts` — no new privilege type; the session simply *is* a superadmin
  tenant session. The token is single-use within its window (a `claimIdempotency`-guarded
  one-shot) and the session is marked so it can't be refreshed/extended.
- **Loud.** Every attempt (success **and** failure) writes a `security:audit` record
  (`kind:'break-glass'`) **and** fires an ADR 0010 Notification to all superadmins. A
  break-glass session carries a banner + is rate-limited (a handful of attempts/hour) to
  blunt online guessing against the env hash.
- **Fail-closed everywhere:** disabled by default; a missing/misconfigured tenant refuses
  to mint; a decrypt/compare error denies (never a 500-to-open).

### (c) Secrets-vault management UI — over the ONE authority, no new store

A superadmin admin panel (`requireSuperadmin`) that is a **projection + management layer**
over the three existing credential owners; it stores nothing of its own except audit
rows.

- **List (masked).** Aggregate a read-only inventory from `listSecretRefs()`
  (`byok/secretResolver.ts` — raw tenant secrets, by `credentialRef`), the `connections`
  list (`connectionsService`, status/scopes only — ADR 0024 already returns "status only,
  never secrets"), the OAuth client store (`clientId` + `configured` only), and
  `developer-keys` (`ApiKeyPublic`, never the hash). Values are **masked** (`••••` + last-4
  where a suffix is safe); nothing secret crosses the read boundary by default — the exact
  posture `apiKeyService.ts` and `oauthClientStore.ts` already enforce.
- **Add.** For a raw tenant secret: `setSecret(ref, value, scope)`. Shown once at
  creation (the developer-keys reveal-once precedent), then only masked.
- **Reveal-once (re-auth + audit).** Reveal is **only** offered for kinds where a
  cleartext exists and revealing is meaningful — operator-entered raw secrets/API-key
  material. It is **never** offered for OAuth refresh tokens (delegated tokens; surfacing
  them is a downgrade, and ADR 0024 keeps them off every read boundary), for the OAuth
  client *secret* (write-only by ADR 0024 §7), or for hashed material (nothing to reveal).
  A reveal requires a **step-up re-auth** (a fresh Firebase reauth / a re-entered break-
  glass factor) and writes a `security:audit` `kind:'secret-reveal'` record with the
  `targetRef` before returning the value once.
- **Rotate.** **Compose the existing rotation seams, don't fork one.** For a `connections`
  OAuth credential, rotate = the ADR 0024 write-scope **re-consent** / warm-refresh path
  (`refreshDaemon.ts`, `oauthFlow.ts`) — not an overwrite. For a raw tenant secret or an
  API key, rotate = `setSecret` with a new value / issue-new-then-revoke-old
  (`apiKeyService.issue` + `revoke`). Every rotate audits.
- **Delete (dependency check).** Before `removeSecret` / connection-revoke, run a
  **reference check**: which features reference this `credentialRef` / `connectionId`.
  `connections` already knows its consumers (the resolver's `connectionUse` provenance and
  the provider→node manifest); raw `credentialRef`s are matched against the known
  consumers (`aiProviders`, integration adapters, node configs referencing the ref). A
  delete with live references warns (with the referencing surfaces named) and requires
  explicit confirmation; the delete audits either way. **Fail-closed:** if the dependency
  index can't be computed, warn rather than silently delete.

### (d) Tenant MFA enforcement (admin, phased last)

A per-tenant admin policy (`requireMfa: boolean`, stored via the existing feature-config /
governance store, superadmin-gated). When set, the users login gate (§3(a) hook) denies
durable-identity routes to a session whose verified token shows no second factor — **fail-
closed**, with a clear "your organization requires MFA; enroll a second factor" response
that deep-links Settings → Security. Enterprise-SSO accounts satisfy it via the IdP claim;
Firebase accounts via a Firebase-enrolled factor. Changing the policy audits.

---

## Feature Evaluation Matrix

| # | Dimension | Verdict for this ADR |
|---|---|---|
| 1 | **Feature-package architecture** | **No new package.** (a) extends `users` (+ SPA Settings → Security); (b) extends `users`/`cookieSession` + `host/superadmin`; (c) a new admin panel composing `byok`, `connections`, `developer-keys`. One new host module: `host/securityAudit.ts`. |
| 2 | **Feature toggle / admin UI** | **No new toggle.** MFA enroll = self-service in the always-on Settings → Security section. Vault + break-glass config + MFA enforcement = superadmin admin panels (like ADR 0024 §7's `OAuthClientAdminPanel`, self-hiding on 403). A toggle would be wrong: security surfaces are platform plumbing, not A/B'd product (the ADR 0002/0010/0024 graduation rationale). |
| 3 | **Workflow node pack** | **None — honest.** Enrolling MFA, minting a break-glass session, and revealing/rotating operator secrets are human-in-the-UI admin acts, not workflow steps. Exposing "reveal a secret" or "mint an operator session" as a runnable node would be a credential-exfil / privilege-escalation primitive inside replayable/forkable/shareable run definitions — the exact leak ADR 0024 D1/C3 forecloses. Secrets reach nodes only through the existing broker injection, never a new node. |
| 4 | **Artifact-type pack** | **None.** No new durable model-authored artifact type; the only new persistence is the append-only `security:audit` log, which is host state, not an artifact. |
| 5 | **AI-chat agent pack** | **None — honest.** No agent persona should be able to enroll a human's second factor, break the glass, or reveal a secret; these are human-authenticated admin actions gated by step-up re-auth. No agent pack, by security design (composes the single chat; adds nothing to it). |
| 6 | **Chat-time tools (`ctx` / `registerFeatureAgentTool`)** | **None — honest.** A read tool exposing secret inventory or MFA state to a model is a disclosure risk with no product need; deliberately not added to the ADR 0315 baseline or any pack allowlist. |
| 7 | **RFC 0021 envelopes** | **None.** No in-run structured model→app intent. MFA/vault/break-glass are out-of-band admin surfaces, not in-run exchanges. |
| 8 | **RBAC** | MFA enroll/disable = **self-service** (the acting user, `resolveCallerUser`, on their own account). Vault + break-glass-config + MFA-enforcement = **superadmin** (`requireSuperadmin`, `host/superadmin.ts`). Break-glass *use* mints a superadmin-tenant session. **All fail-closed**: no fail-open resolver, denials on missing second factor, disabled-by-default break-glass, dependency-warn-not-silent-delete. |
| 9 | **Replay / fork safety** | **n/a — deliberately.** None of these three write to `run.metadata` or participate in run replay/`:fork`. A break-glass session is an auth event, not a run; a secret reveal/rotate is admin state. The one replay-relevant invariant already holds upstream: a run's creating principal is stamped at creation and read verbatim on `:fork` (ADR 0002 C4), so a later MFA-enforcement change or a break-glass event never alters a historical run's identity. The `security:audit` log is append-only and never replayed. |
| 10 | **Frontend / public surface / MCP** | **Public surface: none** beyond the single public-allowlisted `POST …/auth/break-glass` (default-404 unless enabled), same posture as the SAML ACS. **MCP: none** (no external-process channel). **Frontend:** Settings → **Security** section (MFA enroll/verify/disable, SSO-managed notice) + a superadmin **Secrets Vault** admin panel + a **Break-glass & MFA policy** admin panel; all built on the `ui/` design system + 4-locale i18n parity (fatal otherwise). |

---

## Phased plan

Each phase is independently shippable and testable.

- **Phase 1 — MFA enroll/verify/disable UI (Firebase-delegated).** Settings → Security
  section; Firebase `TotpMultiFactorGenerator` enroll flow (QR + manual secret + verify),
  disable, and the SSO-managed notice. Host reads the second-factor claim (no store).
  Tests: enroll → claim present; disable → claim gone; SSO account shows the notice.
- **Phase 2 — Secrets-vault UI.** Superadmin panel: masked list over `listSecretRefs` +
  `connections` + `oauthClientStore` + `developer-keys`; add (reveal-once at creation);
  reveal-once with step-up re-auth + audit (raw secrets only); rotate (compose the
  connections re-consent / api-key reissue seams); delete with dependency check. Introduce
  `host/securityAudit.ts`. Tests: no secret on the list boundary; reveal audits; delete
  with live refs warns.
- **Phase 3 — Break-glass login.** `OPENWOP_BREAKGLASS_*` env, `POST …/auth/break-glass`,
  single-use short-TTL superadmin-tenant session, loud audit + ADR 0010 notification, rate
  limit, default-OFF/404. Tests: disabled ⇒ 404; wrong token ⇒ denied + audited; success ⇒
  short-TTL session + audit + notification; tenant-not-superadmin ⇒ refuse.
- **Phase 4 — Tenant MFA enforcement.** Per-tenant `requireMfa` admin policy + the fail-
  closed gate reading the second-factor claim; enforcement-change audits. Tests: required
  tenant + no-factor token ⇒ 401 deep-link; SSO claim satisfies; Firebase factor satisfies.

---

## Alternatives weighed

1. **Re-add host-owned TOTP (resurrect ADR 0002 Phase 5).** Rejected. It re-introduces the
   exact parallel-credential surface ADR 0026 deleted (two identity systems for one human;
   host-side secret surface; stranding-class bugs). The host storing a TOTP seed while
   Firebase owns the password is the anti-pattern that ADR is about.
2. **WebAuthn / passkeys instead of TOTP — the better 2026 answer (recommended, phased).**
   Passkeys (platform authenticators / security keys) are phishing-resistant, beat TOTP on
   both security and UX, and Firebase Authentication is adding passkey support.
   **Recommendation: passkeys-first with TOTP as the fallback second factor, both delegated
   to Firebase** — the same "host builds the enroll UI, IdP holds the credential" shape, so
   it costs no extra host secret surface. Phase 1 should build the Security section so
   passkey enrollment is a sibling card to TOTP, not a rewrite. Gated as an assumption on
   Firebase passkey GA (open question below); TOTP is the guaranteed-available fallback,
   which is why the ADR is titled around MFA generally, not TOTP specifically.
3. **Delegate MFA entirely to the SSO IdP (no host MFA at all).** Correct *for enterprise
   SSO tenants* (item a already does this) but insufficient as the whole answer: the app
   also serves local/social Firebase accounts (individual users, demos) that have no IdP
   to enforce a factor. So: IdP owns MFA for SSO accounts, Firebase owns it for the rest —
   a split, not a single delegate.
4. **Break-glass as a durable DB-backed operator record.** Rejected on the fail-safe
   direction (Boundaries audit): a DB-only credential is unreachable in the IdP/DB outage
   the feature exists for. Env-provisioned + hashed + default-off + loud is the correct
   availability/safety balance.
5. **A brand-new secrets store for the vault.** Rejected — it would fork a second secret
   authority against the ADR 0024 §7 discipline. The vault is a projection over
   `byok/secretResolver.ts` + `connections` + `developer-keys`.

---

## Open questions / assumptions

- **[assumption] Firebase MFA plan tier.** Firebase TOTP MFA requires the Identity
  Platform (GCIP) upgrade on the project. Confirm `openwop-dev` is (or can be) upgraded;
  if not, Phase 1's local-account MFA is blocked on that operator step (SSO-tenant MFA via
  the IdP is unaffected). Recovery-code availability depends on the same tier.
- **[assumption] Firebase passkey GA.** ~~Alternative 2's passkeys-first recommendation
  assumes Firebase passkey support reaches GA on the plan; until then TOTP is the shipped
  factor and passkeys are the fast-follow.~~ **FALSIFIED 2026-07-19 (evidence-checked —
  see § Correction below).**
- **[open] Break-glass tenant provenance.** Should a break-glass session be visually and
  audit-distinguishable from a normal superadmin session for the *entire* session lifetime
  (banner + every action tagged), or only at mint? (Leaning: entire lifetime.)
- **[open] Reveal-once step-up mechanism for break-glass operators.** A break-glass
  operator has no Firebase reauth to step up against; define the step-up (re-enter the
  break-glass factor?) before Phase 2 lets a break-glass session reveal secrets — or
  forbid reveal from a break-glass session entirely (safer default; leaning forbid).
- **[open] Dependency-check completeness for raw `credentialRef`s.** The connection
  consumer graph is known; raw `credentialRef` references (aiProviders, adapters, node
  configs) need an enumerable index. Confirm the set is closed enough to warn accurately,
  else the delete warning must say "references could not be fully verified."
- **[coordinate] MFA-enforcement policy store.** Confirm the per-tenant `requireMfa` policy
  rides the existing governance/feature-config store rather than a new one (it should).

---

## RFC gate

**Host work — no new OpenWOP RFC.** Verified against each surface:

- **MFA (a/d):** Firebase native MFA is a **client-side** enrollment plus the host reading
  a claim off an already-verified Firebase ID token — no new run-event field, capability
  flag, event type, or endpoint contract on the wire. Enterprise SSO's MFA rides the
  **already-Accepted RFC 0050** (SAML `AuthnContext`); this ADR adds nothing to it.
- **Break-glass (b):** mints a **host cookie session** via a host-extension route
  (`/v1/host/openwop-app/auth/break-glass`, non-normative). No wire surface, no advertised
  capability.
- **Vault (c):** a UI over host-extension credential subsystems; every route is
  `/v1/host/openwop-app/*` (non-normative) and rides Accepted RFCs 0050/0076/0079 exactly
  as ADR 0024 does.

No `capabilities.*` field, no run-event field, no new event type is added — so per the
CLAUDE.md "a spec change needs an RFC" test, **none is triggered.** SSO's identity
profiles are already Accepted (RFC 0050); MFA and the vault are host-internal.
`OPENWOP_REQUIRE_BEHAVIOR=true` advertises nothing new here.

---

## Implementation record

### Phase 1 — MFA enroll/verify/disable (Firebase-delegated) — 2026-07-17

**Surface correction (load-bearing):** the plan predates ADR 0396's settings shell
landing. The Security surface shipped as a **settings-shell panel**
(`/settings#security`, `SETTINGS_PANELS` id `security`, own `security` group), NOT a
standalone `/security` route — a second personal-settings page beside the shell would
be exactly the parallel-surface smell 0396 exists to end.

- **Client (Firebase-delegated):** `auth/firebase.ts` grew the TOTP surface —
  `startTotpEnrollment` (secret held module-scoped only; never storage),
  `completeTotpEnrollment`, `cancelTotpEnrollment`, `listMfaFactors`,
  `unenrollMfaFactor`, and the **sign-in challenge** (`MfaRequiredError`,
  `completeMfaSignIn`, resolver stashed from both `signInWithEmail` and the OAuth
  `processRedirectResult` path — without this an enrolled user is locked out).
  `AuthCard` gained the `mfa` code-entry view, rendered independent of
  `passwordEnabled` (OAuth-only deployments hit the challenge via redirect-back).
- **Host claim (reads, never stores):** `middleware/auth.ts` reads
  `firebase.sign_in_second_factor` after `oidc.verify` (bearer authoritative,
  `req.mfaVerified`); `SessionPayload.mfa` persists the mark at bind/promotion and
  the bearer path re-syncs the cookie on drift (promote AND demote — the claim is a
  property of the sign-in session). Workspace switch carries it
  (`routes/workspaces.ts`); `GET /users/me/security` returns
  `{ source, mfaSessionVerified }` for the panel.
- **QR correction:** v1 ships manual base32 secret + copy + `otpauth://` deep link —
  **no QR-image encoder dependency**. Recorded as an honest trim; a QR image is a
  pure-frontend follow-up if wanted.
- Tests: `test/mfa-session-claim.test.ts` (bearer claim → mark; bind persists;
  cookie-only keeps it; switch keeps it; no-claim ⇒ false; anon refused) +
  `SecurityPanel.test.tsx` (SSO notice / sign-in hint / enroll empty-state).
  Entry bundle ratchet 192 → 193 kB (eager auth + settings-shell catalogs).

### Phase 2 — Secrets-vault UI — 2026-07-17

**Corrections (load-bearing):**
- **No `host/securityAudit.ts`.** The planned new `security:audit` collection
  would have duplicated `host/auditChainService` — the existing tamper-evident,
  CAS-serialized, per-tenant hash chain whose kinds are already free strings.
  `security.*` events now ride THAT chain (scope note widened at its header);
  tamper evidence matters more for security events than consent rows.
- **Route namespace:** `/v1/host/openwop-app/vault/*`, NOT `/admin/vault` — the
  `/admin` prefix is in `PUBLIC_PATH_PREFIXES` (its routes do their own
  `OPENWOP_ADMIN_TOKEN` check), so the global auth middleware never stamps a
  principal there and `requireSuperadmin` would always 403. Caught by the route
  test; the boundary lesson is recorded here so the next `/admin/*` addition
  checks first.
- **Cross-tenant enumeration deliberately OUT (v1).** The vault inventories the
  superadmin's ACTIVE tenant + the host-global bucket. Enumerating every
  tenant's ref names needs a new Storage method AND reverses the 2026-07
  vuln-scan M3 visibility posture — deferred as its own decision.
- **Step-up = the `auth_time` claim** (`req.oidcAuthTime`, stamped post-verify):
  reveal demands a bearer minted by a sign-in fresher than
  `OPENWOP_VAULT_REVEAL_MAX_AUTH_AGE_S` (300s default) — the client re-runs
  Firebase re-auth and retries. No new credential machinery. The wildcard admin
  bearer is exempt (possession of the operator key IS the step-up). Cookie-only
  callers fail closed.

Shipped: `routes/adminVault.ts` (inventory/add/reveal/rotate/delete; reveal
audits BEFORE returning; `connection:*` refs refused for reveal/rotate/delete —
the connections lifecycle owns them; delete fail-closes on live references
[headless-AI default binding v1] with `?force=true` override, still audited);
FE `connections/VaultAdminPanel.tsx` composed into ConnectionsPage beside
`OAuthClientAdminPanel` (same 403-self-hide), masked rows, one-time reveal
display, step-up guidance, referenced-delete confirm; i18n ×4. Tests:
`test/admin-vault.test.ts` (7) + `VaultAdminPanel.test.tsx` (2).

### Phase 3 — Break-glass login — 2026-07-17

Shipped: `routes/authBreakGlass.ts` (`POST /v1/host/openwop-app/auth/break-glass`,
PUBLIC-prefixed — the SAML-ACS precedent; a hardened cookie-less posture must not
401 the locked-out operator). Default-OFF ⇒ 404-invisible. Credential =
`scrypt$salt$hash` env (`OPENWOP_BREAKGLASS_TOKEN_HASH`, minted by
`scripts/breakglass-hash.mjs`; node:crypto scrypt + timingSafeEqual — no new
dep). Success mints a 10-min non-refreshing user-tier cookie for
`OPENWOP_BREAKGLASS_TENANT` (which MUST be in `OPENWOP_SUPERADMIN_TENANTS` —
refused otherwise, fail-closed). **Single-use across instances** via a durable
CAS-claimed burn marker keyed by the token hash (rotate the env hash to re-arm).
Every attempt chains `security.breakglass-*` on the P2 audit chain; success
notifies every durable member of the tenant (ADR 0010). 5 attempts/15 min/IP.
Tests: `test/break-glass.test.ts` (5 — 404-invisible, audited denials,
non-superadmin-tenant refusal, success + burn + re-arm, 429).

### Phase 4 — Tenant MFA enforcement — 2026-07-17

Shipped: `GovernancePolicy.requireMfa?: boolean` (governance store — NOT a
feature toggle; `tenantRequiresMfa()` accessor with a 30s cache for the auth
hot path); superadmin `PUT /governance/policy` parses it (`null` clears,
omission preserves — and the media-budget PUT now preserves it too);
enforcement lives in `middleware/auth.ts` `refuseIfMfaRequired` on BOTH the
bearer and cookie paths: a SHARED workspace with `requireMfa` refuses
non-`mfaVerified` sessions 401 `mfa_required` + the `/settings#security`
deep-link, FAIL-CLOSED. The PERSONAL tenant is exempt (the enrollment path must
stay reachable) and **escape routes stay open** (logout / switch-back /
workspace list / own security read) — without them a cookie pinned to a
requireMfa workspace is a full lockout (found during test design, not in
production). SAML sign-ins stamp `mfa: true` at session issue — the IdP owns
the factor requirement (AuthnContext); double-gating would dead-end SSO users.
FE: a `requireMfa` checkbox section on the superadmin GovernancePanel, i18n ×4.
Tests: `test/tenant-require-mfa.test.ts` (2 — the full refuse/pass/exempt/
escape flow + PUT round-trip w/ preserve-and-clear semantics).

### Grade pass — 2026-07-17

Same-day 3-lens grade (code/ux/data) over all four phases; two blockers found
and fixed forward: the byok-chat-budget PUT's preserve list wiped `requireMfa`
(SEC-C1 — the full-replace-store drift class struck a second time), and the
break-glass 10-minute session was sliding-refreshed to 24h (SEC-C2 — fixed via
`SessionPayload.noRefresh`). Plus the audit-chain orphan-adoption self-heal,
step-up pass-path test, exempt-prefix boundary matching, async scrypt, and the
vault reveal UX overhaul. Full findings + open items live in
`docs/{CODEBASE,UX,DATA}-ASSESSMENT-adr0388-0389-batch.md`.

---

## § Correction 2026-07-19 — the passkeys-first assumption is FALSIFIED; recovery is the real gap

A deep evidence pass (standards + vendor docs + platform capability) overturned the §6
recommendation's enabling assumption and re-ordered the roadmap. Recorded here rather
than rewritten above — the reasoning trail is the point.

**1. Firebase/GCIP does not support passkeys, and no date is announced.** Identity
Platform supports exactly two second factors — **SMS and TOTP** (the Identity Platform
product-comparison + `web/mfa` docs enumerate every sign-in method with no WebAuthn
entry). `firebase-js-sdk#2123` ("WebAuthn support") has been **open since 2019-08-29**
with no Google commitment; companion issues sit on the iOS (#11548) and Android (#6981)
SDKs. The one forward signal is a **mock** passkey implementation added to the Auth
*emulator* in Firebase CLI v15.21.0 (June 2026) — there is no production API.

⇒ **TOTP is not an interim state on this stack; it is the ceiling until Google ships.**
The §6 "passkeys-first with TOTP fallback" recommendation remains correct *in principle*
and is **unachievable in practice** here. The obvious workaround — a self-hosted WebAuthn
relying party minting Firebase custom tokens — is **foreclosed by ADR 0026**, since it
re-creates precisely the host credential surface that ADR deleted. Passkeys therefore
require a Google product change or an ADR 0026 reversal; there is no third path, and
neither should be undertaken speculatively.

**2. TOTP is standards-compliant — the urgency was misplaced.** NIST SP 800-63B **Rev 4
(final 2025-07-31**; Rev 3 and the syncable-authenticator Supplement 1 are Withdrawn)
does **not** deprecate TOTP: single-factor OTP remains valid at AAL2 as one leg of a
two-factor combination. Rev 4's new phishing-resistance clause is a **SHALL-OFFER** for
verifiers plus a SHALL-USE for *federal* staff/contractors — SHOULD-level for a
non-federal B2B SaaS. (Also Rev 4: synced passkeys are capped at AAL2 and SHALL NOT be
used at AAL3; SMS is now formally a "Restricted Authenticator".) PCI DSS 8.4.2 accepts
TOTP as one leg. So the shipped factor is fine; nothing forces a migration.

**3. The actual gap is RECOVERY, and it is documented lockout-by-design.** GCIP states
plainly: *"Identity Platform does not provide a built-in mechanism for recovering second
factors"* and *"If a user loses access to their second factor, they will be locked
out."* Password reset does **not** bypass MFA. Meanwhile NIST 800-63B-4 **§4.2.2** is the
first revision to table acceptable recovery compositions per AAL (at AAL2: two recovery
codes obtained by different methods, **or** one recovery code plus a single-factor
authenticator), and **§4.1.2.1/§4.2.3** require independent-channel notification on every
authenticator bind and every recovery event. This ADR shipped a factor with **no recovery
path and no bind notification** — a larger real-world exposure than the passkey gap.

**4. Recovery decision (options-evaluated 2026-07-19).** Four options were scored; the
dominant force is ADR 0026 single-owner integrity plus the `routes/account.ts:17`
precedent (a DELIBERATE decision not to run `firebase-admin` server-side — heavyweight
native dep, service-account credentials, and keeping server-side deletion independent of
Firebase availability):

| Option | Verdict |
|---|---|
| Host-generated recovery codes | **REJECTED — boundary violation.** NIST classifies recovery codes as **look-up secrets**, i.e. a first-class *authenticator type*. Hosting them is not a neutral "recovery artifact"; it re-creates the credential store ADR 0026 deleted. |
| Admin-mediated reset via `firebase-admin` | **DEFERRED** — reverses the `account.ts` decision for one feature, adds a native dep + service-account credentials, and couples recovery to Firebase availability. Escalation path only (see trigger). |
| Operator runbook (out-of-band) | **ADOPTED as the fallback** — zero code, zero deps; the honest answer for true lockout. See `docs/RUNBOOK-mfa.md`. |
| **Second factor as recovery, made real** | **ADOPTED as the primary** — what §3(a) already promised ("a second enrolled factor is the recovery path — surfaced in copy") but never shipped: the copy did not exist and nothing prompted a backup enrollment. Satisfies §4.2.2's "one code + a single-factor authenticator" shape, is self-service (GitHub's mandate data credits self-service recovery with a **one-third drop** in 2FA tickets and 54% fewer human-intervention recoveries), and costs no new credential surface. |

**Escalation trigger for admin-mediated reset:** if lockout tickets persist despite the
backup-factor prompt, that work lands as **its own ADR** explicitly reversing
`account.ts:17`, with the four B2B guardrails the evidence names — step-up re-auth on the
reset action itself (Okta built *Protected Actions* for exactly this after the 2023
help-desk social-engineering attacks), audit of the acting admin, independent-channel
notification to the affected user, and last-admin/break-glass protection.

**5. Rejected: a Stytch-style `allowedMethods` policy knob "for later".** Separating
`mfaPolicy` from `allowedMethods` is the right shape *when there is more than one method*.
Today TOTP is the only one the platform can honor, so the knob would be dead config
implying a choice that does not exist — a violation of this repo's "advertise only
honored behavior" rule. Recorded instead as the **extension point**: when Firebase ships
passkeys, `requireMfa` gains `allowedMethods` and the phishing-resistant-only posture
becomes a config flip rather than a rewrite.

**6. Independent-channel notification — honestly partial.** Bind/unbind events now emit
through the Notifications seam (in-app + Web Push to the user's other devices). That is
an *approximation* of NIST §4.1.2.1's independent-channel requirement, not full
satisfaction: true independence wants a channel outside the authenticated app (email/SMS).
Recorded as a known limitation; closing it is transactional-email work that belongs with
the email feature, not here.


**7. The enforcement layer was never evaluated — GCIP can enforce MFA itself.** §3(d)
and Phase 4 assume without argument that the *host* must own MFA enforcement, so the
design went straight to `refuseIfMfaRequired` in `middleware/auth.ts`. A follow-on
capability pass (2026-07-19, first-party GCIP docs) found that assumption untested:

- **`MultiFactorAuthConfig.State` has three values**, not two — `DISABLED`, `ENABLED`,
  and **`MANDATORY`** ("Multi-factor authentication is required for this project"),
  per the Identity Toolkit **REST v2** reference. Note the docs disagree with
  themselves: the guide-level `web/mfa` prose still frames enforcement as purely the
  app's job, which is the `ENABLED`-era framing.
- **`mfaConfig` is a field on the GCIP *Tenant* resource**, so per-tenant MFA policy is
  first-class at the IdP — reachable only by adopting GCIP tenants, which this app does
  not use (its tenancy is its own, `user:<hash>`). That is an identity-architecture
  change, not a config flip.
- **The Admin SDK lags REST**: it exposes only `DISABLED | ENABLED` and only
  `factorIds: ['phone']`. Setting `MANDATORY` or TOTP per tenant means driving Identity
  Toolkit v2 REST directly.
- **Blocking Functions (`beforeSignIn`) are GA and fire *after* second-factor
  verification** — they can deny by throwing `HttpsError` and set `sessionClaims`.
  Budget: **7s hard**, **2000 req/min** project-wide. This is strictly more expressive
  than the enum (recovery carve-outs, staged rollout, break-glass) and is where
  reCAPTCHA Enterprise surfaces `additionalUserInfo.recaptchaScore` for risk-based
  step-up (email/password protection GA; **phone/SMS protection still Preview**).

⇒ **The Phase 4 gate is NOT retired by this finding, and must not be** on the strength
of an enum. `MANDATORY`'s *runtime* behavior is **[unverified]** — no doc retrieved
states what it does to an unenrolled user's sign-in (hard refusal? enrollment-required
error? which code?) or how it behaves for federated sign-in where a second factor is
meaningless. The cheap experiment that settles it: set `MANDATORY` on a throwaway
tenant via REST, attempt a password sign-in with an unenrolled user, record the error.
Until that runs, the host gate remains the control, not defense-in-depth.

**8. Federated assurance is opaque through GCIP — but that does not bind this app.**
No `amr`/`acr` claim is documented on the Firebase ID token, and the GCIP SAML docs
never mention `AuthnContextClassRef`; a Google-provider sign-in tells a relying app
nothing about whether the user's own account used a passkey. **This app is unaffected
on the SSO path**: `routes/authSamlSso.ts` parses assertions host-side rather than
brokering through GCIP, so `AuthnContextClassRef` is directly readable — which is why
`OPENWOP_SAML_ASSUME_MFA=false` remains a coherent eventual default (`ENG-3`). Any
*future* design that assumes federated assurance is visible through Firebase should be
abandoned at design time, not discovered at integration time.
