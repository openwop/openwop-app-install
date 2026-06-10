# ADR 0004 — Organizations

**Status:** Superseded-in-part / reconciled (see Correction 2026-06-08)
**Date:** 2026-06-08
**Feature toggle:** `orgs` (now: org **invitations** only)
**Depends on:** ADR 0002 (Users), ADR 0003 (Canonical identity & session binding)
**Owns:** email-token invitations that delegate to `accessControl`.
**Org/member/role ownership:** `src/routes/accessControl.ts` + `accessControlService.ts`.

---

## Correction (2026-06-08) — reconciled with the pre-existing `accessControl` surface

> **What changed and why.** A `/code-review` route-test harness revealed that the
> app **already had** a complete Organizations / teams / members / **roles**
> surface — `src/host/accessControlService.ts` + `src/routes/accessControl.ts`,
> always-on at `/v1/host/sample/orgs`, with roles mapped to the **RFC 0049 scope
> vocabulary** and fail-closed authority. The v1 decision below was authored
> WITHOUT discovering it (the prior architect skill had no
> boundaries/duplication check — now added). As shipped, v1 **collided** with
> accessControl: every overlapping route (`POST /orgs`, `/orgs/:id`,
> `/orgs/:id/members`) was silently shadowed (first registrant wins), so the
> feature was non-functional in the real app, and it modeled a **conflicting**
> tenancy (v1: `org === tenant`; accessControl: tenant is the boundary, org is a
> grouping inside it) plus a **parallel authority tier** (owner/admin/member vs
> RFC 0049 roles).
>
> **Reconciliation (option B of the architect options review):** `accessControl`
> is the **single owner** of orgs/members/roles. The `orgs` feature is reduced to
> the ONE thing accessControl lacked — an **email-token invitation flow** to
> onboard a person as a member — which **delegates**: `createInvitation` checks
> the org via `accessControlService.getOrg` (IDOR-scoped to the tenant);
> `acceptInvitation` binds the accepting user's stable `User.userId` (ADR 0003)
> as an accessControl `OrgMember` via `createMember` with the invited RFC-0049
> role; management is gated by accessControl's own `host:members:manage` scope
> (`resolveEffectiveAccess`) — **no parallel tier**. Routes are additive and
> non-colliding (`/orgs/:orgId/invites`, `/orgs/invitations/accept`).
>
> **Removed from v1** (duplicative/conflicting with accessControl): the
> `org === tenant` model, the membership tier, the active-org **switch**
> (session rebind), and the personal-org. A multi-principal-tenant "workspace
> switch" is genuinely useful but belongs with **ADR 0006 (RBAC)** + ADR 0003
> Phase 4 — accessControl's own header notes it needs an explicit owner member
> once tenants are multi-principal, which is exactly what ADR 0003 + this
> invitation binding now provide.
>
> **Kept (independently valid):** the `isAnonymous` fix (a bound session is never
> anonymous — a real shipped bug the harness caught) and the route-test harness.
> **ADR 0006 (RBAC)** now = wire accessControl's RFC-0049 scopes onto the
> protocol surface + explicit multi-principal ownership keyed on `User.userId`.

> **No new OpenWOP RFC.** Invitations are a non-normative `/v1/host/sample/*`
> onboarding helper; orgs/roles ride accessControl's existing RFC-0049 model.

---

> **The v1 decision below is retained as the superseded reasoning trail** (per
> CLAUDE.md "correct, don't rewrite history"). It does not reflect the shipped
> code; read the Correction above for what actually exists.

---

## Context

`tenantId` is already the scoping boundary for everything in this host — data
(`workspaces/{tenant}/…` analog via `DurableCollection` filters), run ownership
(RFC 0048 owner `tenant`), BYOK secrets, and feature-toggle bucketing. But it is
an *unmanaged string*: there is no entity behind it, no membership, no way to
invite a second person into the same scope. ADR 0003 made `User.userId` the
canonical subject and bound it to a session carrying one active `tenantId`. This
ADR makes that `tenantId` a **first-class Organization** with CRUD, membership,
and invitations — the MyndHyve "Workspaces & Teams" analog — so RBAC (ADR 0006)
has an org to scope roles to and CRM/CMS have an org to scope data to.

## Decision

Ship a toggle-gated **`orgs`** feature package introducing three entities and an
org-switch on the ADR-0003 session.

1. **Organization** — `{ orgId, name, slug, kind: 'personal'|'team', createdAt }`.
   **`orgId` IS a `tenantId`** — the existing scoping boundary, now named. A
   team org gets a fresh `org:<uuid>` tenant; a user's home tenant is their
   personal org.
2. **Membership** — `{ orgId, userId, role: 'owner'|'admin'|'member', joinedAt }`.
   This `role` is the **coarse org tier** (can-I-administer-this-org), NOT RBAC
   permissions — that mapping is **ADR 0006**. The boundary is deliberate
   (mirrors the principal/role split of ADR 0002 §"boundary").
3. **Invitation** — `{ orgId, email, role, tokenHash, expiresAt }`. Email + a
   single-use token (hashed at rest, like password reset tokens — ADR 0002 C3);
   accept → membership.

### The active org is the session tenant (ADR 0003)

A request operates in exactly ONE active org = `req.tenantId` (the bound
session's `tenantId`). **Switching** orgs re-issues the session (`issueUserSession`
from ADR 0003) with the target `orgId` as the new `tenantId` — but ONLY after
verifying the caller is a member. `principal.tenants[]` stays **single** (the
active org); it is NOT broadened to all of a user's orgs.

> **RFC 0048 §D invariant (load-bearing).** Cross-workspace isolation keys on the
> owner `tenant`. A session is scoped to ONE active org, so a run is owned by the
> active org's tenant and a member of org A cannot read org B's runs by virtue of
> membership alone. Broadening `principal.tenants[]` to every org a user belongs
> to would **break** that isolation — explicitly rejected here.

### Personal org (lazy)

A user's first org-list with no memberships **lazily creates a personal org**
(`orgId = user.tenantId`, `kind: 'personal'`, the user as `owner`). This keeps
the `orgs` feature decoupled from the `users` feature (ADR 0001 — no edit to
signup) and aligns the org with the tenant the user's existing data already lives
under. Personal orgs cannot be deleted or have members added (they are the user's
private scope).

## Boundary with ADR 0006 (RBAC)

| Concern | Owner | Artifact |
|---|---|---|
| *Which orgs am I in, and am I an org admin?* | **ADR 0004 (this)** | Membership `role` (owner/admin/member) |
| *What may I do on a resource?* | **ADR 0006 (RBAC)** | Permissions keyed to `(User.userId, orgId)` |

Membership gates org administration (invite/remove members, rename/delete the
org). RBAC, when it lands, keys permissions to `(userId, orgId)` — this ADR
gives it the `orgId` and the membership edges to build on.

## Architectural constraints honored

- **C-isolation (RFC 0048 §D):** active org single; never broaden
  `principal.tenants[]`. Org-switch verifies membership before re-binding.
- **C-fail-closed (ADR 0002 H5):** a non-member's switch / admin action denies;
  an expired/invalid invite token denies. No fail-open path.
- **C-secrets (ADR 0002 C3):** invitation tokens returned once, stored as sha256
  hashes with expiry; never logged.
- **C-identity (ADR 0003):** membership + ownership key on `User.userId`, not on
  an auth-method principal string.

## Phased plan / scope

- **v1 (this ADR):** Org CRUD (name/slug/kind), membership (add/remove/list,
  get-my-orgs), lazy personal org, invitations (mint/accept/list/revoke),
  membership-verified org-switch. Toggle-gated `orgs` feature + frontend.
- **Deferred (noted, not cut):** teams-within-org, org activity log, org logo
  upload (needs ADR 0007 Media), per-org feature-toggle overrides surfaced in the
  org UI, transfer-ownership.

## Alternatives considered

1. **Org as a layer ABOVE tenants (one tenant, many orgs).** Rejected: every
   data store, run owner, and BYOK secret is already tenant-scoped; introducing a
   second scoping axis would touch the whole host. Org = tenant reuses the
   isolation that already exists and is proven.
2. **Multi-org `principal.tenants[]` (a session sees all your orgs at once).**
   Rejected: breaks RFC 0048 §D isolation (see invariant above). One active org
   per session; switch to change it.
3. **Eager personal-org creation in signup.** Rejected: couples `orgs` to the
   `users` feature (ADR 0001). Lazy creation keeps the package self-contained.

## Open questions

- [ ] **Transfer ownership / last-owner guard:** v1 forbids removing the last
  owner; full ownership-transfer is deferred.
- [ ] **Org-switch + run-in-flight:** switching the active org mid-session does
  not retro-scope existing runs (they keep their owner tenant — correct per
  `replay.md`); confirm the SPA surfaces the active org clearly.
- [ ] **Invite to a not-yet-registered email:** v1 stores the invite by email;
  acceptance binds it to whichever durable user claims that email. Revisit when
  ADR 0005 (Profiles) firms up email ownership.
