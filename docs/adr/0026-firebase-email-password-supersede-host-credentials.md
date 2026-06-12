# ADR 0026 — Firebase email/password auth supersedes the host-owned credential store

**Status:** Accepted (Phase 1 — frontend — implemented 2026-06-11; **Phase 2 — backend removal + test migration — implemented 2026-06-11**; Phase 3 docs — this ADR + the supersede notes)

Supersedes **ADR 0002 § Phase 2** (host email/password baseline) and **§ Phase 5**
(host TOTP MFA). Renders **ADR 0003 § Phase 4c**'s `personalTenantForPassword`
dead (the OIDC tenant derivation now covers every auth method) and makes **Phase
4b** (account linking) Firebase's job rather than the host's.

## Context

ADR 0002 Phase 2 shipped a **server-side** email/password system in
`credentialsService.ts` (scrypt hashes, reset/verify tokens) behind
`/v1/host/sample/users/auth/{signup,login,password/*,email/*}`, plus a host TOTP
MFA (Phase 5). The SPA's social logins (Google/GitHub) already run through
**Firebase Authentication**, whose ID tokens the host verifies on the OIDC bearer
path (`middleware/auth.ts`) — minting `oidc:<sub>` → a durable `User`.

Running a host password system **in parallel** to Firebase is the root of real
cost and risk:

- **Two identity systems for one human.** A user who signs up with the host
  password *and* later "Continue with Google" gets two siloed `User`s in two
  `user:<hash>` tenants — the entire motivation for the (complex) ADR 0003 Phase
  4b account-linking design (alias index, cross-tenant merge, anti-takeover guard).
  Firebase **already** links a password credential to a Google account under one
  UID, making that complexity unnecessary.
- **Host-side secret surface.** The host stores password hashes + reset/verify
  tokens it otherwise wouldn't — extra attack surface and operational burden
  (email delivery for reset/verify is stubbed; the demo surfaces dev tokens).
- **Stranding-class bugs.** ADR 0003 Phase 4c existed only because the host
  password account's home tenant was anon-derived; Firebase owns the durable
  identity, so the class doesn't arise.

The reference app **MyndHyve** (`/dev/myndhyve`) already does it the clean way:
Firebase email/password on the client (`createUserWithEmailAndPassword`,
`signInWithEmailAndPassword`, `sendPasswordResetEmail`, `updateProfile`,
`sendEmailVerification`); the backend **only** verifies Firebase ID tokens and
holds **no** credential store.

## Decision

**Remove the host-owned password system; use Firebase Authentication's
email/password provider on the client**, exactly like MyndHyve. After this, the
backend sees **only** Firebase OIDC ID tokens (`oidc:<firebase-uid>`) for *every*
sign-in method — social and email/password alike — and they all flow through the
existing, single path: `middleware/auth.ts` verify → `/migrate-tenant` (anon
sandbox adoption, ADR 0003 Phase 4c) → `/oidc/bind` (durable `User`, Phase 4a).

Consequences:
- **Account linking** (password ↔ Google) becomes a Firebase concern
  (`linkWithCredential` / provider linking) — host ADR 0003 Phase 4b is **not
  built** (the architect design is retained in ADR 0003 for the record).
- **MFA** moves to Firebase (`multiFactor`) if/when wanted; the host TOTP MFA
  (ADR 0002 Phase 5), which was only enforced at host `login`, is removed.
- **`personalTenantForPassword`** (ADR 0003 Phase 4c) becomes dead code — the
  OIDC derivation `tenantIdFromOidc` is the one canonical personal-tenant rule for
  all Firebase-issued identities (email/password included).

## Why this is host-only (no RFC, no wire change)

Identity minting + the SPA's auth UI are host concerns. No `/.well-known/openwop`
capability advertises host password auth (it was never on the wire). SAML/SCIM
(RFC 0050) are independent and unaffected. Same governance basis as ADR 0002/0003.

## Phased implementation

| Phase | Scope | Status |
|---|---|---|
| **1 — Frontend** | `AuthCard` calls Firebase email/password (signup/login/reset/verify) instead of the host routes; a shared `finalizeFirebaseSession()` runs migrate+bind for the in-page (non-redirect) email/password flow; drop the host-route client calls. **Backend untouched** — email/password users ride the existing OIDC path. | **implemented 2026-06-11** |
| **2 — Backend removal** | **DONE.** Deleted `credentialsService.ts`, `mfaService.ts`, `mfaRoutes.ts`; slimmed `authRoutes.ts` to `logout` + `oidc/bind`; un-registered MFA in `feature.ts`; `profiles` `resolveEmailVerified` now derives from `source` only (federated ⇒ verified) — no credentialsService. Frontend: removed `MfaPanel.tsx` + the dead `usersClient` password/MFA fns + the UsersPage password-signup form. `personalTenantForPassword` went with `credentialsService`. **Test migration:** the 11 route suites that minted users via `POST /users/auth/signup` now use a new **env-gated auth test seam** (`POST /v1/host/sample/test/login`, `OPENWOP_TEST_AUTH_ENABLED=true`, `src/routes/authTestSeam.ts`) — it mints a session for a synthetic durable User and takes an explicit `tenantId` so the org-RBAC suites get co-tenant users (the old "second-signup-inherits-tenant" quirk is gone; Firebase users are each their own tenant). Deleted `users-credentials`/`users-mfa`/`auth-anon-adopt` tests. | implemented 2026-06-11 |
| **3 — Docs** | Supersede notes on ADR 0002 §2/§5; ADR 0003 §4c dead-code note. | this ADR + the notes below |

**Why Phase 1 ships alone:** it *is* the product goal ("use the Firebase
username/password solution") and is backend-clean (no test churn). Phase 2's
dozen-suite test migration is large, pure-infrastructure work that earns its own
reviewable change rather than riding the frontend swap.

## Alternatives weighed

- **Keep the host password system + build ADR 0003 Phase 4b (host-level linking).**
  Rejected: 4b's alias index + cross-tenant merge + anti-takeover guard exist
  *only* to paper over running two identity systems; Firebase already solves it.
  The host password system is not a differentiator worth that complexity.
- **Firebase MFA now.** Deferred: MyndHyve doesn't use Firebase MFA in the normal
  flow; out of scope for the swap. Revisit if MFA is a product requirement.

## Open questions

- [ ] **Existing host password accounts on the demo.** Near-zero per ADR 0015
  Context (the demo has ~no durable Users); those few would re-register via
  Firebase. Confirm before Phase 2 deletes the routes.
- [ ] **Email verification UX.** Firebase `sendEmailVerification` needs an action
  URL / template configured in the Firebase console for a real (non-dev) deploy.
