# ADR 0003 — Canonical user identity & session binding

**Status:** Accepted (Phases 1–3 implemented; 4 sequenced with ADR 0006/RBAC)
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
- **Phase 4 (with ADR 0006) — One subject everywhere.** OIDC bearer + all
  product surfaces resolve the RBAC subject as `User.userId`; auth-method strings
  become `User.linkedIds[]`. *Gate:* ADR 0006 opens with "subject = `User.userId`".

## Replay / fork + compatibility summary

- **Compatibility class:** Additive / forward-compatible. The RFC 0048 owner
  *shape* is unchanged; only the host's principal-id *minting policy* changes, for
  new runs. Historical runs keep their stamped owner (read verbatim on `:fork`).
- **No discovery / schema / conformance change.** No new RFC.
- **SECURITY:** closes the RFC 0048 PII-in-principal leak on the run-owner/audit
  surface; the stable owner is the correct `:fork` behavior (C3 / ADR 0002 C4).

## Open questions

- [ ] **Linked-id model:** does `User` grow an explicit `linkedIds[]`, or do we
  keep one principal per `User` and resolve by `userId` from the session? (Phase 4
  / ADR 0006 — pick when a single user legitimately has two auth methods.)
- [ ] **OIDC bearer remap timing:** Phase 4 vs. sooner if a non-SPA OIDC client
  starts creating runs before RBAC lands.
- [ ] **`/me` / `/users` response PII:** the `User` object still exposes its
  stored `principalId` (`password:<email>`). Acceptable for self/admin views;
  revisit if those responses cross a tenant boundary.
