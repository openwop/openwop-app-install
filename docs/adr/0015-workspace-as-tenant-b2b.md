# ADR 0015 — Workspace-as-tenant & multi-member B2B tenancy

> **Numbering note:** authored as 0012, then 0014; renumbered to **0015** because
> parallel work claimed each slot first (0012 Publishing & SEO, 0013 Sharing, 0014
> Feature↔Workflow surfaces). The implementation merged in #83 under the title
> "ADR 0014"; this file + its references are the corrected number.

**Status:** implemented (Phases 0–5, incl. the role-preview lens + the wildcard-bearer enforcement escape hatch — see "Deployment postures" below)
**Date:** 2026-06-09
**Depends on:** ADR 0002 (Users), ADR 0003 (Canonical identity — esp. its deferred
Phase 4), ADR 0004 (Org invitations), ADR 0006 (RBAC).
**Revives / supersedes-in-part:** ADR 0004 v1's `org === tenant` + membership-verified
workspace-switch, which was reconciled away *before its prerequisites existed*.
**Owner of orgs/members/roles/scopes:** `src/host/accessControlService.ts` +
`src/routes/accessControl.ts` (the single owner — NOT a new feature; the ADR-0004 lesson).
**Authored with:** `/architect` (dual-track: app-architecture + capability honesty).

> **No new OpenWOP RFC.** Everything here is host-side: tenancy is a host concern,
> orgs/members/roles ride accessControl's existing **RFC 0049** scope model, and
> the only wire-visible change is the *honest* `capabilities.authorization` flip
> (already speced; gated on real enforcement — ADR 0006 Phase 3). Per
> `CLAUDE.md` governance, host work, not a spec change.

---

## Context — what the app is for, and the tenancy gap

openwop-app is **(a)** the live reference host for the OpenWOP protocol
(`app.openwop.dev` — anonymous, browser-session-scoped, 24h reset) **and (b)** a
white-label template adopters fork and self-host (`WHITE-LABEL.md`). That yields
three deployment personas the tenancy model must serve at once:

| Persona | Who | Need |
|---|---|---|
| A. Public anonymous demo | drive-by visitor | ephemeral isolated sandbox; resets 24h |
| B. Signed-in showcase | a logged-in person | durable personal workspace |
| **C. White-label self-host** | an **adopter company** | **a shared workspace many employees join, with differentiated roles** |

**Decision input (product owner, 2026-06-09): the white-label adopter onboards a
*team into one shared workspace* → build the B2B org-as-tenant model.** Persona C
is now first-class; A/B become its degenerate "org of one" case (à la a GitHub
personal account) — **one model, not two**.

### The gap this closes

The org/member/role layer (`accessControlService.ts`) is built *for* multi-member
tenants — RFC 0049 scopes, fail-closed, membership-derived. But the identity/tenant
layer contradicts it:

- **`tenant == one person`.** Tenant id is derived per-principal: `anon:<sid>`
  (`middleware/auth.ts`) or `user:<sha256(iss:sub)>` (`auth.ts:292`). There is **no
  mechanism to route a second person's requests into another tenant** — so an org's
  "members" can only ever be that one user.
- **No `User ⟷ Org` many-to-many.** Invitations bind a member record, but a member
  of tenant A whose own requests carry tenant B can't *operate in* A.
- **Identity fragments across auth paths.** ADR 0003 **Phase 4** (OIDC bearer +
  cookie both present one stable `User`-scoped subject) was explicitly deferred;
  cookie-only requests fell back to a per-session `session:<sid>`, so an `OrgMember`
  seeded against the bearer-path `oidc:<sub>` stopped matching the caller — a latent,
  non-deterministic "lost access to my own org" bug. (Confirmed: prod had **zero**
  durable `User` records and a stray anon-tenant "Smoke Org".)

History already pointed here: the **ADR 0004 Correction** cut the `org === tenant`
workspace-switch as premature, noting it *"belongs with ADR 0006 (RBAC) + ADR 0003
Phase 4"*; ADR 0006's context says *"when multi-principal tenants are real, replace
[the implicit owner] with an explicit owner member seeded at org creation."* Those
prerequisites now exist (or are Phase 0). This ADR finishes the arc.

## Decision

**The tenant becomes the Workspace, not the user.** A **User** is a global identity;
a **Workspace** is the isolation boundary (`= tenantId`); **Membership** binds a
user's stable subject → workspace with RFC 0049 roles. The session carries exactly
**one active workspace** as `req.tenantId`; switching re-issues the session after a
membership check, so `principal.tenants[]` stays single — **RFC 0048 §D
cross-workspace isolation is preserved** (the invariant that killed ADR 0004 v1's
broadening; honored here by switch-don't-broaden).

Industry alignment (GitHub/Slack/Linear/Auth0-Organizations/WorkOS): one human →
many workspaces, a distinct role in each; solo = a workspace of one; **platform
super-admin is a separate, out-of-band plane**, never tenant-reachable.

### Three sub-decisions

1. **Collapse org+tenant into "Workspace"** (Workspace = tenant = accessControl
   `Organization`, with **Teams** as the inside grouping → Workspace ⊃ Teams ⊃
   Members). Rejected the alternative of stacking a workspace layer *above* orgs
   (three grouping levels, no payoff). Cost: today's "many orgs per tenant" (a
   solo-demo artifact) becomes "one workspace per tenant, many teams".
2. **No data rekey.** An existing `user:<hash>` tenant is reinterpreted **as that
   user's personal workspace**; new shared workspaces get `ws:<uuid>`. All
   tenant-scoped data/runs/secrets stay valid — scoping code just sees another
   tenant-string flavor. Minimal blast radius vs. a migration.
3. **Platform super-admin stays env-based** (`OPENWOP_SUPERADMIN_TENANTS`) — the
   out-of-band root of trust, distinct from workspace owner/admin, never
   self-service, never demo-flippable. DB-backed grants (`env ∪ db`, writable only
   by an existing superadmin) are deferred to a real staff console (not now).

### What we explicitly do NOT do

- **No "flip a DB bit to grant myself owner/admin."** That conflates tenant-local
  authority with the platform plane and is a self-escalation hole in any
  multi-member workspace. "View as owner/admin/role" is a **read-only preview**
  (resolve `BUILT_IN_ROLES[role].scopes` for the UI lens), never a grant. Once
  identity is stable you genuinely *are* your workspace's owner — nothing to grant;
  the only legitimate need is previewing *lesser* roles (a downgrade, always safe).

## Phased plan

- **Phase 0 — Identity coherence across auth paths.  ✅ (this ADR)**
  The OIDC-promoted session cookie now carries the stable, opaque `oidc:<sub>`
  subject (`SessionPayload.subject`), so a cookie-only request (Authorization
  dropped — SPA token-cache race, EventSource) resolves the **same** RBAC subject as
  the bearer path instead of a fresh `session:<sid>`. Closes the "lost access to my
  own org" bug; zero store dependency in middleware, no per-request scan, bearer
  principal unchanged (no OIDC-test churn). *Gate: `auth-oidc-cookie-promotion.test.ts`
  adds a cookie-only-follow-up assertion; full auth/identity/access-control suite green.*
  → **Durable-`User` upsert + `user:<userId>` subject (full ADR 0003 Phase 4) folds
  into Phase 2**, where account-linking + member-listing metadata are actually needed.

- **Phase 1 — Workspace = tenant.** Promote accessControl `Organization` → Workspace
  (`orgId IS tenantId`; Teams inside). New shared workspaces mint `ws:<uuid>`; anon
  stays `anon:<sid>`; existing `user:<hash>` = personal workspace (no rekey). Extend
  the **BYOK/KMS** path (today keyed on signed-in `user:*` tenants) to `ws:*`, or
  shared-workspace secrets break. *Gate: KMS round-trip test for a `ws:*` tenant.*

- **Phase 2 — Membership routes a user INTO a workspace.** `GET /me/workspaces`
  (a user's memberships); workspace-switch re-issues the session to the target
  workspace **after a membership check** (ADR 0004 v1's switch, done right).
  Invitations (the surviving ADR 0004 piece) onboard people → bind their stable
  subject as an `OrgMember`. New user, zero memberships → **auto-provision a personal
  workspace**, seed owner, bind session (idempotent — deterministic guard, not
  `randomUUID()` per request; **signed-in only** so anon visitors don't flood the
  store). Durable `User` upsert lands here. *Gate: concurrency test — N parallel
  first requests create exactly one workspace.*

- **Phase 3 — Honest enforcement.** Flip `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`
  once protocol-surface enforcement is validated against real multi-member
  workspaces; `capabilities.authorization` advertised iff honored (ADR 0006 gate).

- **Phase 4 — Role-preview "view as" + frontend.** Role-level lens (preview, not
  grant) in the orgs UI; a workspace switcher in app chrome; the active workspace
  shown prominently (a run created in workspace A stays owned by A on switch —
  replay-safe, must not confuse the user). *Gate: `frontend/react npm run build`.*

- **Phase 5 — Demo + white-label config.  ✅ (this ADR, partial)**
  `OPENWOP_DEMO_MODE=false` now documented in `backend/typescript/.env.example`
  (default false; shipped unchanged in the white-label zip — the build script
  archives `HEAD` and only strips real `.env*`, so it must NOT rewrite the example).
  Remaining: WHITE-LABEL.md "onboard your team" walkthrough.

## Architectural constraints honored

- **Boundaries / single source of truth:** accessControl remains the sole owner of
  workspaces/teams/members/roles; invitations stay a thin delegator (ADR 0004 lesson).
- **RFC 0048 §D isolation:** one active workspace per session; switch-don't-broaden.
- **Fail-closed (RFC 0049):** non-member ⇒ zero scopes; the decision seam denies an
  unknown principal.
- **Identity (ADR 0003):** stable, opaque, PII-free subject (`oidc:<sub>` is a
  Firebase UID, not an email); `user:<userId>` once durable Users land (Phase 2).
- **Privilege boundary:** tenant-local owner/admin ≠ platform super-admin; the
  latter stays out-of-band.

## Alternatives considered

1. **Keep `tenant == user`, polish only.** Correct for personas A/B alone; rejected
   because it forecloses persona C (no team onboarding) — the chosen product intent.
2. **Migrate all data to `ws:<id>` tenants.** Rejected: a high-risk rekey of every
   tenant-scoped store for no functional gain over reinterpreting `user:<hash>` as
   the personal workspace.
3. **DB-backed, UI-flippable super-admin.** Rejected: self-escalation hole; conflates
   the two admin planes. Env stays the root of trust until a real staff console exists.
4. **Upsert a durable `User` in auth middleware on every OIDC request (full Phase 4
   now).** Rejected for Phase 0: couples middleware → user store + per-request scan,
   and breaks bare-app unit tests. The cookie-carried stable subject fixes the
   *coherence* bug with none of that cost; durable Users land in Phase 2 where needed.

## Open questions

- [ ] **Account linking:** when durable Users land (Phase 2), does one human with
  both password + OIDC resolve to one `User` (linkedIds[]) — and is the RBAC subject
  then `user:<userId>` (re-keying existing `oidc:<sub>`-bound members)?
- [ ] **Workspace deletion / last-owner guard** and ownership transfer (deferred).
- [ ] **Anon → personal-workspace promotion:** when an anon visitor signs in, do we
  migrate their `anon:<sid>` sandbox data into the new personal workspace, or start
  clean? (Affects the demo→signup UX.)

## Deployment postures — one build, demo vs. white-label

The demo (`app.openwop.dev`) and a white-label self-host are the **same build**,
differing only by configuration. The implicit-personal-owner short-circuit makes
**enforcement orthogonal to the anonymous demo** — an anon/personal caller is
always the implicit owner of their own sandbox, so they are never gated
regardless of `OPENWOP_AUTHORIZATION_ENFORCEMENT`. The membership/isolation
boundary holds in every posture (switch is membership-gated + the middleware
re-validates a non-personal active workspace each request). So the only thing the
enforcement flag changes is **intra-workspace role-scoping on the protocol
surface** — a feature dial, not a demo-vs-white-label fork.

| Posture | `OPENWOP_DEMO_MODE` | sign-in | `OPENWOP_AUTHORIZATION_ENFORCEMENT` | Experience |
|---|---|---|---|---|
| **Demo** (`app.openwop.dev`) | `true` | anon allowed (cookie-per-visitor) | off (today) | Anon: frictionless sandbox. Signed-in: real workspaces + the **role-preview lens** to *see* every role solo. |
| **White-label — team** | `false` | required (`OPENWOP_DEPLOY_POSTURE=auth`) | `true` | Full enforced B2B: shared workspaces, invites, role-gated runs. |
| **White-label — solo/simple** | `false` | optional | off | Personal workspaces only; no enforcement. |

**Wildcard-bearer escape hatch.** `requireProtocolScope` treats a wildcard-tenant
principal (`principal.tenants` includes `*` — the `OPENWOP_API_KEYS` operator key /
conformance harness) as full-access, mirroring the feature-toggle superadmin.
Without it, turning enforcement ON would `403` every API-key / conformance / curl
caller (they hold no accessControl membership), so enforcement could never be
enabled on a host that also serves bearer integrations. This makes
`OPENWOP_AUTHORIZATION_ENFORCEMENT=true` safe to enable **everywhere**, including
the demo, as a fast-follow.

## Phase → commit/test ledger

| Phase | Status | Evidence |
|---|---|---|
| 0 — Identity coherence | ✅ implemented | `middleware/auth.ts` (`SessionPayload.subject`); `auth-oidc-cookie-promotion.test.ts` +cookie-only assertion. |
| 1 — Workspace = tenant | ✅ implemented | `accessControlService.ts` (`createWorkspace`/`ensurePersonalWorkspace`/`isWorkspaceMember`/`listWorkspacesForSubject`); `secretResolver.ts` (`ws:` KMS); `auth.ts` (active-workspace routing + `personalTenant`). |
| 2 — Membership / switch / create / list | ✅ implemented | `routes/workspaces.ts` (`GET /me/workspaces`, `POST /workspaces`, `POST /workspaces/:id/switch`); `workspace-tenancy.test.ts` (4 — create/list/switch/invite/isolation). |
| 3 — Authority (implicit personal-owner; shared fail-closed) | ✅ implemented | `requireScope` + `requireProtocolScope` personal-owner short-circuit (`requestSubject.isOwnPersonalWorkspace`); `authorization-fail-closed.test.ts` rewritten to the shared-workspace + switch-boundary model. |
| 4 — Frontend (switcher + client) | ✅ implemented | `client/workspaceClient.ts`, `chrome/WorkspaceSwitcher.tsx`, Sidebar wiring; `npm run build` green. Includes the **role-preview lens** — `useOrgsController.changeView` accepts `role:<id>` (client-side preview of a built-in role's scopes, no act-as / no grant) so a solo operator can experience every role in their own workspace without a second account. |
| 5 — Demo / white-label config | ✅ implemented | `backend/typescript/.env.example` (`OPENWOP_DEMO_MODE=false` + `OPENWOP_AUTHORIZATION_ENFORCEMENT`); `WHITE-LABEL.md` "Onboard your team" walkthrough. |

**Verification:** backend `tsc --noEmit` clean; targeted auth/RBAC/workspace suites green; full backend suite = 1099 passed, only the 6 pre-existing pack-runtime failures (confirmed identical on base `8808121`). Frontend `npm run build` green.
