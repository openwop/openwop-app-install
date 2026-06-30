# ADR 0003 — Canonical user identity & session binding

**Status:** Phases 1–4 implemented. (Phases 1–3 + **Phase 4a** OIDC-bind + **Phase 4c** canonical personal tenant + anon-sandbox adopt-migration implemented 2026-06-11 — fixes the password-stranding bug, closes ADR 0015's "anon→personal migration" open question. **Phase 4b** account-linking is **moot** — superseded by ADR 0026 (Firebase links providers natively). **Phase 4d** one-shot subject re-key **implemented 2026-06-22**. See "Phase 4 design" + the 4c implementation correction + the 4d ledger below.)
**Date:** 2026-06-08
**Refines:** ADR 0002 (Users & Authentication) — closes its deferred identity seam.
**Unblocks / prerequisite of:** ADR 0006 (Roles & Permissions / RBAC) — RBAC keys
roles to a subject; that subject is fixed here.
**Authored with:** `/architect` (identity / replay-safety / RFC 0048 decision).

> **No new OpenWOP RFC.** RFC 0048 already defines the `principal` / run-owner
> concept; this only changes the host's *id-minting policy* for new runs
> (forward-compatible, opaque). Per the `FEATURES.md` / `CLAUDE.md` governance
> note, that is host work, not a spec change.

---

## Context

ADR 0002 shipped durable users + password/SAML/SCIM/OIDC auth, but left one seam
open, surfaced by the `/code-review` of the auth work and confirmed by an
`/architect` pass:

**A human resolves to *different* durable `User` records depending on auth
path, and runs are owned by whichever transient principal was on the request.**

Concretely, on the pre-ADR-0003 `main`:

- The session payload carries **no user identity** — `{ sid, tenantId, tier }`
  (`middleware/auth.ts`). There is no `userId`.
- `req.principal.principalId` is auth-method-dependent: `session:<sid>` for
  cookies (regenerated per session AND on every OIDC→user upgrade), `oidc:<sub>`
  for OIDC, `bearer:<…>` for keys.
- **Password `login` establishes no session** — it returns `{user}` only, so the
  browser keeps its `session:<sid>` / anon principal, never the `password:<email>`
  account.
- The principal is the **run-owner / audit / annotation key** (`runs.ts`:
  `auditSink.record({ principalId })`, annotation `principalRef`). Per RFC 0048
  this is the run **owner**.

Three consequences:

1. **Identity fragmentation.** `usersService.upsertFromPrincipal` keys the `User`
   on whatever string arrives, so signup (`password:<email>`), `/me`
   (`session:<sid>`), and OIDC (`oidc:<sub>`) mint *different* records for one
   person. The "MFA keyed two ways" defect (ADR 0002 review finding #10) is the
   first symptom; ADR 0006 (RBAC), audit, and `/me` would each hit it again.
2. **PII in the principal (RFC 0048 / `auth.md` §"Identity claims").** The
   principal MUST be opaque + non-PII, but `password:<email>` / `scim:<userName>`
   / `saml:<NameID>` embed PII, which then lands in the audit sink and annotation
   refs — the wire-visible owner surface.
3. **Replay/fork-unsafe ownership (RFC 0048 §D, `replay.md`).** A password user's
   runs are owned by an unstable `session:<sid>`; on `:fork` the owner is read
   verbatim but no longer resolves to a live identity. ADR 0002 finding C4
   ("creating principal survives `:fork`") was satisfied in letter, not spirit.

## Decision

**The durable `User.userId` is the canonical subject identity.** Authentication
methods resolve-or-create a `User`; the session binds to that `userId`; the
principal stamped on the wire is an opaque `user:<userId>`. Auth-method strings
(`password:<email>`, `oidc:<sub>`, `saml:<NameID>`, `scim:<userName>`) are
*linked identifiers* on the `User`, never the key the rest of the system sees.

### The keying, before → after

| Concern | Before | After (ADR 0003) |
|---|---|---|
| Session payload | `{ sid, tenantId, tier }` | `+ userId?` |
| Caller's user | `upsertFromPrincipal(<auth-method string>)` | `getUser(req.userId)` when signed in |
| Run owner / audit principal | `session:<sid>` / `password:<email>` (unstable / PII) | `user:<userId>` (stable, opaque) |
| MFA enrollment key | session principal (≠ password user) | `req.userId` (one key) |
| RBAC subject (ADR 0006) | ambiguous | `User.userId` |

### Boundary with ADR 0006 (RBAC)

This ADR fixes **who you are** (one stable subject). ADR 0006 fixes **what you
may do** (roles keyed to `User.userId`). Settling the subject here is a
*prerequisite* of RBAC: if RBAC shipped on the fragmented scheme, every role
binding would inherit the fragmentation and need a later data rewrite.

## Architect findings folded in

- **C1 (identity):** no canonical subject — fragmentation is architectural, not a
  local MFA bug. → durable `User` is canonical.
- **C2 (RFC 0048 PII):** principal ids embed PII that leaks to owner/audit. →
  opaque `user:<userId>`; an invariant test asserts no PII-prefixed principal
  reaches the audit sink.
- **C3 (replay/fork, RFC 0048 §D):** run owner is the unstable session sid. →
  stamp the stable `user:<userId>`; historical owners read **verbatim** on
  `:fork`, never rewritten (`replay.md` / ADR 0001).
- **Sequencing:** blocking for ADR 0006 (RBAC), not for MFA polish.
- **Governance:** host work; no new RFC; forward-compatible value-scheme change.

## Alternatives considered

1. **Keep the parallel MFA handlers, patch case-by-case.** Rejected: the
   fragmentation re-appears in RBAC, audit, and `/me`; each gets its own special
   case. The review already showed this treadmill (three fix rounds).
2. **Lookup-and-rewrite the principal at run-create time** (resolve the durable
   user on the hot path). Rejected: a per-request store scan on the run-create
   path, and it doesn't fix `/me` / MFA keying.
3. **Map OIDC bearer to `user:<userId>` too, immediately.** Deferred to Phase 4:
   the bearer path's `oidc:<sub>` is already stable + opaque; remapping it churns
   OIDC tests for no acute gain. Do it when RBAC needs one subject everywhere.

## Phased implementation plan

Each phase is additive and gated. The **bound-session path is new** (nothing set
`session.userId` before), so existing anon/OIDC tests are unaffected by 1–3.

- **Phase 1 — Session carries `userId`.** `SessionPayload.userId?`, `req.userId`
  set by `authMiddleware` from it. *Gate:* typecheck + suite green; inert.
- **Phase 2 — Login binds the session.** Password `login` (after the MFA gate)
  mints a user-tier session carrying the durable `userId` and sets the cookie;
  signup likewise. *Gate:* the bound session round-trips (`req.userId` populated
  on the next request).
- **Phase 3 — Identity + ownership key on `userId`.** `/me` and the MFA routes
  resolve the caller via `getUser(req.userId)`; `principalOf` returns
  `user:<userId>` when signed in; the parallel password-authed `/auth/mfa/*`
  routes are removed (the session-based `/mfa/*` now work for password users).
  *Gate:* MFA enrolled via `/mfa/*` is honored by the `/login` gate; no
  PII-prefixed principal in the audit sink (invariant test).
- **Phase 4 — One subject AND one personal tenant everywhere (designed 2026-06-10;
  detailed in "Phase 4 design" below).** OIDC bearer + every surface resolve the RBAC
  subject as `User.userId`; auth-method strings become `User.linkedIds[]`; and each
  `User` gets ONE canonical personal tenant `user:<userId>`. This closes the
  password-stranding gap Phases 1–3 left (a password account is created in the ephemeral
  `anon:<sid>` tenant and has no durable home — see the correction note) and subsumes
  ADR 0015's "anon→personal migration" + "account linking" open questions and TODO
  item 3's last two sub-items. *Gate:* the canonical subject + tenant round-trip for
  password AND OIDC; the subject re-key leaves run ownership intact (verified: runs are
  tenant-owned, no subject stamp).

## Phase 4 design (2026-06-10) — canonical subject + personal tenant + account linking

> **Correction note (not a rewrite of Phases 1–3).** Phases 1–3 canonicalized the
> **subject** (`user:<userId>`) but said nothing about the **personal tenant**. A
> `/plan` + `/architect` pass (2026-06-10) verifying the two ADR 0015 deferred items
> found the gap: the personal tenant is **3-way fragmented** — `anon:<sid>` (anon),
> `user:<sha256(iss:sub)>` (OIDC, `auth.ts:498`), and **the ephemeral anon tenant the
> password user happened to sign up in** (`credentialsService.ts:132` — `User.tenantId =
> input.tenantId = tenantOf(req)`). Verified consequence: a **password account has no
> durable home** — `login` resolves it via `getUserByPrincipal(tenantId, …)` keyed on
> the *current* tenant (`authRoutes.ts:111`), with no global email→user lookup, so once
> the `anon:<sid>` session resets (24h / new device) the account is unreachable. In the
> `enforceBearer` posture a no-session signup is `401`'d outright (`auth.ts:609`). So
> Phase 4 must canonicalize the **tenant**, not just the subject.

### Decision

1. **Canonical subject = `user:<userId>` everywhere** (the original Phase 4). The OIDC
   bearer path upserts a durable `User` and sets `req.userId`, so its subject stops being
   the transient `oidc:<sub>`. Auth-method strings (`password:<email>`, `oidc:<sub>`,
   `saml:<NameID>`, `scim:<userName>`) move to **`User.linkedIds[]`**.
2. **Canonical personal tenant = `user:<userId>`** for BOTH auth methods (Option (ii)
   from the architect review — *adopt*, don't *fork-into*). A password signup **adopts its
   anon sandbox** by re-keying `anon:<sid> → user:<userId>`; an OIDC first-login re-keys
   its `user:<sha256>` data to `user:<userId>` once. One human → one durable sandbox.
3. **Account linking is explicit + verified-email-gated.** `POST …/users/me/link` binds a
   second authenticated principal to the current `User` (adds to `linkedIds[]`) **only**
   when the email is verified on both sides — auto-linking on an unverified email is an
   account-takeover vector (rejected).

### Sub-phases

- **4a — Durable User on OIDC.** In `auth.ts`'s OIDC branch, upsert a `User` keyed by
  `oidc:<sub>` (deterministic — no per-request store scan, mirroring the Phase 0 cost
  rule) and set `req.userId` → subject becomes `user:<userId>`. *Gate:* an OIDC bearer
  resolves a stable `user:<userId>` across requests; existing OIDC tests unaffected.
- **4b — `linkedIds[]` + explicit linking.** ~~Add `User.linkedIds: string[]`; resolve any
  `linkedId → userId`; `POST …/users/me/link` (verified-email guard).~~ **MOOT — superseded by
  ADR 0026 (2026-06-11).** The host password system was removed in favor of Firebase
  email/password, and **Firebase links providers natively** (one Firebase user with multiple
  linked providers resolves to one OIDC `sub`, hence one `tenantIdFromOidc` and one durable
  `User`). The host has no second principal to link, so an in-host `linkedIds[]` + a
  `/users/me/link` route are not needed and were never built. The account-takeover concern the
  design guarded against (auto-linking on an unverified email) is Firebase's responsibility now.
- **4c — Canonical personal tenant + adopt-migration.** Re-key the personal tenant to
  `user:<userId>` and migrate the source sandbox. **Completes `reassignTenant`** to cover
  *every* tenant-scoped store the source can hold — not just `runs`+`workflows`
  (`sqlite/index.ts:910`): `events`/`interrupts` (cascade), `byok_tenant_secrets`,
  `notifications`, `push_subscriptions`, and the host-ext KV rows (accessControl
  orgs/members, feature-toggle overrides, chat, messaging, `user_agents`). **Two adapters
  (`sqlite` + `postgres`) must stay in lockstep** — there is no separate memory adapter.
  **Deterministic-key hazard (architect Finding 3):** the personal-workspace owner member
  uses `mbr-<hash(tenantId, subject)>` (`accessControlService.ts` `personalOwnerMemberId`),
  so a naïve `UPDATE … SET tenant_id` collides with the destination's seeded owner — the
  migration MUST recompute that id (delete-then-reinsert), not bulk-UPDATE. *Gate:* a
  seeded source tenant moves **all** stores and leaves the source empty; the
  personal-owner member is single (no duplicate).

  > **Implementation correction (2026-06-11, PR #124 + Phase B).** The shipped 4c refined
  > three points of the design above:
  > 1. **Coverage is by schema INTROSPECTION, not a hand-kept list.** `reassignTenant`
  >    discovers every `tenant_id` table from the live schema (sqlite `pragma_table_info` /
  >    postgres `information_schema`), so a future tenant table is covered automatically and
  >    the sqlite/postgres secrets-table divergence (`byok_tenant_secrets` vs `byok_secrets`)
  >    resolves itself. See `src/storage/tenantMigration.ts`.
  > 2. **The deterministic-key hazard is AVOIDED, not patched.** Rather than delete-then-
  >    reinsert the personal-owner member, the migration does **not** move the access-control
  >    scaffolding at all (the personal-workspace org `orgId == tenant` + owner member, whose
  >    row keys encode the tenant); the destination re-seeds canonical scaffolding via
  >    `ensurePersonalWorkspace`. Only *content* (runs, workflows, host-ext CRM/kanban/KB…,
  >    re-keyed by JSON `tenantId`/`orgId`) migrates — in **one transaction** (atomic +
  >    idempotent), not the two-phase the design implied.
  > 3. **The password home tenant is EMAIL-derived, not `user:<userId>`.** `userId` is
  >    `hash(tenantId:principalId)`, anon-derived for password and thus unstable; the stable
  >    home is `personalTenantForPassword(email) = user:<hash(password:email)>` (mirrors
  >    `tenantIdFromOidc`). `signup`/`login` both resolve it from the email, fixing the
  >    stranding bug. Signup adopts the anon sandbox into it; a signup made while already in a
  >    durable tenant (the SSO/SCIM in-tenant teammate-provisioning shape) lands in that
  >    tenant so org collaborators stay co-tenant.
  >
  > **Superseded note (ADR 0026, 2026-06-11).** Point 3 is now moot: the host password
  > system was removed in favor of Firebase email/password, so `personalTenantForPassword`
  > and the password `signup`/`login` are gone. Email/password users are Firebase OIDC and
  > land in the OIDC home (`tenantIdFromOidc`) like any social login — the stranding class
  > no longer exists. The anon-sandbox adopt-migration (the rest of 4c) is unchanged and now
  > runs for ALL Firebase logins via `/migrate-tenant`. Phase 4b (account linking) is
  > likewise moot — Firebase links providers natively (ADR 0026).
- **4d — One-shot subject re-key.** A transactional, maintenance-gated migration rewrites
  every `OrgMember.subject` from a legacy `oidc:<sub>`/`password:<email>` to the canonical
  `user:<userId>`. It re-keys **only the RBAC subject, never the run's owning tenant** —
  runs are tenant-owned with no subject stamp, so this is replay/fork-safe (RFC 0048 §D).
  The `user:<sha256>`→`user:<userId>` **tenant** re-key (4c) *is* run-bearing, but prod has
  **zero durable `User` records today** (ADR 0015 Context), so the existing-data migration
  is near-empty and the replay risk is theoretical — still, do 4c transactionally and
  before any traffic depends on the new keying. *Gate:* `isWorkspaceMember(user:<id>)`
  resolves post-rekey; a pre-existing run's stamped owner is unchanged.

  > **Implementation ledger (2026-06-22).** Phase 4d shipped as a maintenance-gated,
  > idempotent, transactional batch migration that re-keys ONLY `OrgMember.subject` —
  > runs / run ownership / the event log are untouched (runs are tenant-owned with no
  > subject stamp), so it is replay/fork-safe per the design.
  >
  > | Piece | Where |
  > |---|---|
  > | Service fn `rekeyLegacyMemberSubjects(tenantId) → { scanned, rekeyed, skipped }` | `src/host/subjectRekeyMigration.ts` |
  > | Tenant-wide member lister `listTenantMembers(tenantId)` | `src/host/accessControlService.ts` |
  > | Maintenance route `POST /v1/host/openwop-app/maintenance/rekey-member-subjects` | `src/routes/subjectRekey.ts` |
  > | Re-key primitive reused (deterministic owner-member re-derivation + ≥1-owner safety) | `accessControlService.ts` `rekeyMemberSubject` |
  > | User resolver reused (legacy subject → durable `User`) | `features/users/usersService.ts` `getUserByPrincipal` |
  > | Superadmin gate reused (SAME posture as governance/feature-toggles, ADR 0028) | `host/superadmin.ts` `requireSuperadmin` |
  > | Focused test (a re-key / b canonical-untouched / c unresolvable-skip / d idempotent) | `test/subject-rekey-migration.test.ts` |
  >
  > Resolution is **never-mint**: a legacy subject (`oidc:`/`saml:`/`scim:`/`session:`/
  > `anon:`/`password:` …) is re-keyed to `user:<userId>` ONLY when
  > `getUserByPrincipal(tenantId, legacySubject)` resolves a durable user; an unresolvable
  > legacy subject is SKIPPED (counted, never invented). A member already `user:<…>` is left
  > untouched, so re-running re-keys nothing (idempotent).

### Sequencing & risk

4a → 4b → 4c → 4d. Independent of, but unblocks the premise of, ADR 0006 ("subject =
`User.userId`"). No wire change, no RFC (host id-minting policy only — same governance
basis as Phases 1–3). The one expensive mistake is 4c's tenant re-key on a populated host;
gated by the near-empty-prod fact + the transactional/maintenance-window constraint.



- **Compatibility class:** Additive / forward-compatible. The RFC 0048 owner
  *shape* is unchanged; only the host's principal-id *minting policy* changes, for
  new runs. Historical runs keep their stamped owner (read verbatim on `:fork`).
- **No discovery / schema / conformance change.** No new RFC.
- **SECURITY:** closes the RFC 0048 PII-in-principal leak on the run-owner/audit
  surface; the stable owner is the correct `:fork` behavior (C3 / ADR 0002 C4).

### Correction (2026-06-16) — canonicalize at the PROVISIONING choke points, not just reads

Phase 4a/4c canonicalized *read* resolution (`resolveCallerUser` →
`resolveCanonicalUserForTenant`), but two *write* choke points that auto-provision
per-human records still keyed on the raw `callerSubject`: the personal-workspace
owner member + the personal kanban board (`routes/workspaces.ts` `GET /me/workspaces`
and `routes/kanban.ts` `GET /kanban/boards/personal`). `callerSubject` falls back to
the volatile channel principal (`oidc:<sub>` bearer / `session:<sid>`) whenever the
session isn't bound, and `ensurePersonalWorkspace` keys the owner member on
`personalOwnerMemberId(tenant, ownerSubject)` while `personalBoardId` hashes the
owner — so an unbound touch minted a SEPARATE owner member + "My Board" per channel.
Observed in prod: two "My Board"s + a stray `session:<sid>` (`manual`) principal on
`/users` for one human. **Fix:** both choke points now resolve the caller's ONE
canonical durable user (`resolveCallerUser(req).userId`) and key the owner member +
board on that. The Phase 4a bind re-key (`rekeyMemberSubject`) is retained as a
safety net for legacy memberships seeded under `oidc:<sub>` before this fix. No wire
change.

## Open questions

- [x] **Linked-id model:** RESOLVED (Phase 4 design), then **MOOT** (ADR 0026) — the
  designed in-host `linkedIds[]` + verified-email-gated `/users/me/link` were never built;
  Firebase links providers natively, so one human resolves to one OIDC `sub` → one `User`.
- [x] **OIDC bearer remap timing:** RESOLVED — Phase 4 sub-phase 4a (durable User on the
  OIDC bearer path). No longer waits on RBAC; it is the prerequisite ADR 0006 assumes.
- [x] **Canonical personal tenant** (NEW, raised by the 2026-06-10 review): RESOLVED —
  one `user:<userId>` personal tenant per `User`, adopting the source sandbox via the
  completed `reassignTenant` (Phase 4 sub-phase 4c). Closes the password-stranding gap +
  ADR 0015's "anon→personal migration" open question.
- [ ] **`/me` / `/users` response PII:** the `User` object still exposes its
  stored `principalId` (`password:<email>`). Acceptable for self/admin views;
  revisit if those responses cross a tenant boundary. *(Phase 4 moves these to
  `linkedIds[]` — keep the same self/admin-only exposure rule.)*
