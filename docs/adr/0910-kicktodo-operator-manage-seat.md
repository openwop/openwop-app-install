# ADR 0910 — KickTodo operator access: just-in-time, time-boxed `kicktodo-operator` activation for eligible superadmins on a system-owned default workspace

**Status:** Accepted (2026-10-18 — the owner answered OQ1–OQ6 and asked for the recommendations to proceed) — P0 implemented (#4944); P1–P4 to follow
**Date:** 2026-10-17
**Feature:** `kicktodo-core` (the `host-kicktodo` default workspace, ADR 0684) + host access control
(`host/accessControlService.ts`, ADR 0006 / 0015 / 0697 / 0815)
**Origin:** KickTodo launch tracker **A-08 D2** (nobody can hold `host:kicktodo:manage` inside
`host-kicktodo` on kicktodo.com) and **D-23** (the hand-written AI binding in `host-kicktodo` cannot be
removed, because `DELETE /byok/active-config` acts on the caller's ACTIVE workspace and needs
`host:byok:manage` there).
**RFC verdict:** **host-extension — no RFC.** Every route here sits under `/v1/host/openwop-app/*`
(non-normative). `host:kicktodo:manage` and `host:byok:manage` are `host:` MANAGEMENT scopes, deliberately
outside RFC 0049 `PROTOCOL_SCOPES` (`accessControlService.ts:117`, "adding to that set would be a WIRE
change"). No event type, capability flag, run-event field or endpoint contract changes.

> **AMENDED 2026-10-18.** The owner answered all six open questions (see "Open questions — decided").
> The decision changed from a standing `admin` seat to **just-in-time access**: the superadmin allowlist
> is eligibility only. Authority is a time-boxed (≤ 8 h), MFA-stepped-up, justified activation of a
> NEW narrow `kicktodo-operator` role, checked at use time. Publication self-approval is allowed
> explicitly for a live activation, and the Factory key has a dedicated vault ref. Context and the
> options analysis are kept as first written, with inline amendment notes, for the reasoning trail.

**Evidence basis.** Everything below was read from source at `991a62253` (`origin/main`). Nothing was
measured against production in this ADR; claims about kicktodo.com are the tracker's, and the two
production facts cited from other ADRs (ADR 0697 OQ2, ADR 0711 operational note) are marked as such.

## Context

### The seat that does not exist

Every KickTodo privileged act funnels through ONE gate, `requireKicktodoManage`
(`features/featureRoute.ts:147`), and its subject-based twin `hasKicktodoManageAuthority`
(`featureRoute.ts:108`) used by the Challenge Author's agent tools and by the approval-eligibility
checks. Callers include all Factory authoring/publishing routes (`kicktodo-creator/routes.ts:83,454,506`),
commerce, community, engagement, accountability, metrics, the org admin lens
(`kicktodo-organizations/routes.ts:166`), the `challenge-publish` decider check
(`kicktodo-creator/routes.ts:424-433`) and the four sign-off approval kinds
(`kicktodo-core/signoffApprovals.ts:35-41`).

The gate admits exactly three callers:

1. a wildcard principal (`req.principal.tenants` includes `*`);
2. the implicit owner of their OWN personal workspace (`isOwnPersonalWorkspace`);
3. a subject whose tenant-wide scope union (`resolveSubjectScopesUnion`, `accessControlService.ts:2158`)
   contains `host:kicktodo:manage`. Only the built-in `admin` and `owner` roles carry it
   (`ADMIN_SCOPES`, `accessControlService.ts:278`). Custom roles cannot (`isProtocolScope`, `:224`).

None of the three can be satisfied in `host-kicktodo` today:

| Door | Why it is shut for `host-kicktodo` |
|---|---|
| wildcard `*` key | A `*` key deliberately leaves `req.tenantId` unset, so it acts as `default`, never as `host-kicktodo` (`middleware/auth.ts:1160-1170`). It is also tooling, not a person: it has no subject that `hasKicktodoManageAuthority` (the eligibility lane) would accept. |
| personal-owner short-circuit | `host-kicktodo` is not a `user:`/`anon:` tenant. |
| member with `admin`/`owner` | **The workspace has no human owner, and nobody can make one.** `ensureFeatureDefaultOrgs` provisions it with `createdBy: 'system'` and no `ownerSubject` (`host/featureDefaultOrgs.ts:119-121`, `ensureWorkspaceRootOrg` → `createOrg` without an owner, `accessControlService.ts:739`). Auto-join adds every participant as `['viewer']` (`host/workspaceJoinLedger.ts:179`, `createMember` default role at `accessControlService.ts:914`). Promoting anyone needs `host:members:manage` IN `host-kicktodo` (`routes/accessControl.ts:556,596`), which only an admin/owner there holds. ADR 0697 OQ2 records the production consequence: on kicktodo.com every row in that workspace is an auto-join `viewer`, with zero member POST/PATCH/DELETE. |

**ADR 0684 §5 decided this shape on purpose** ("the org is system-owned … administration is the
operator's superadmin surface, not an org-owner seat; membership of this org means 'is a participant',
NOT 'may administer'"). **The superadmin surface it names was never built for KickTodo.** Superadmin
(`host/superadmin.ts`) is an allowlist exemption tested route by route (`requireSuperadmin`,
`isListedSuperadmin`). It is not a membership and not a scope. `requireKicktodoManage` never consults it,
and the access-control member routes key on `tenantOf(req)`, the caller's active workspace, so a
superadmin cannot even address `host-kicktodo`'s roster. They cannot switch into it either:
`POST /workspaces/:id/switch` requires `isWorkspaceMember` (`routes/workspaces.ts:150-156`).

ADR 0684 itself hit the same wall. Its "What is NOT evidenced" section says the ban path has no
production evidence because it "requires the operator's own identity (`host:members:manage`)".

### Why the owner needs it now

The owner has decided to (a) author the first challenge catalog in PRODUCTION through the Factory, with
the Factory BYOK-only, and (b) remove the hand-written `minimax / managed:openwop-free` binding in
`host-kicktodo` (ADR 0711 operational note, D-23). Both need a human holding admin-class scopes IN
`host-kicktodo`: (a) needs `host:kicktodo:manage`, (b) needs `host:byok:manage` with `host-kicktodo` as
the active workspace.

### Boundaries audit (what already exists — compose, don't fork)

| Concern | Owner today | Finding |
|---|---|---|
| Role → scope | `BUILT_IN_ROLES` (`accessControlService.ts:296`) | `admin` carries `host:kicktodo:manage` + `host:byok:manage` + `host:members:manage`, never `host:org:manage`. *(Amended 2026-10-18, OQ1: still too wide. D1 adds a narrow activation-only `kicktodo-operator` role.)* |
| Workspace-root membership | `createMember` (derived id `workspaceRootMemberId`, ADR 0697 D1), `memberIndex` point-read (ADR 0684 §6a) | Converges on the existing row. A seat must upgrade an auto-joined `viewer` row instead of adding a twin. |
| Join-once ledger | `workspaceJoinLedger.ts` | Auto-join never grants more than `viewer`. A revoked operator re-joined by auto-join comes back as a participant only. |
| Superadmin predicate | `isListedSuperadmin` (allowlist only; no wildcard, no dev-open; narrowed keys refused, ADR 0795 D1) | This is the right creation authority. `isSuperadmin` is too wide because it admits the dev-open switch and the wildcard bearer. |
| Member lifecycle events | `memberAdded` / `memberRolesChanged` (`host/memberLifecycleEvents.ts:62,68`), `runMemberAuthorityLostHooks` | Reuse them, so the seat shows up wherever role changes already do. |
| Tamper-evident audit | `appendAudit(tenantId, kind, payload)` (`host/auditChainService.ts:188`), already used for `security.breakglass-*` | Reuse the chain. No second audit store. |
| Break-glass | `routes/authBreakGlass.ts` (ADR 0389 P3): single-use token, 10-min non-refreshing session, bound to a superadmin-listed tenant | Solves a different problem (all auth down). It mints a session in the operator's own tenant and grants no membership anywhere. |
| Readiness | `GET /kicktodo/readiness` (ADR 0690, `requireSuperadmin`) | The natural place to report "no manage holder" and "orphaned operator seat". |
| Separation of duties | `challenge-publish`: decider ≠ submitter (`kicktodo-creator/routes.ts:430`, `publishService.ts:362`). Sign-offs: decider ∉ `separateFrom(approval)` (`signoffApprovals.ts:39`) | **One seat cannot publish anything.** Publication needs two distinct manage-holding subjects. *(Amended 2026-10-18, OQ2: waived for a live operator activation only, D5.)* |
| Erasure | `eraseSubjectAccessControl` anonymizes, never deletes, a membership (`accessControlService.ts:2278`, ADR 0464) | A seat ledger is subject-keyed, so it needs its own eraser (`subject-erasure-coverage.test.ts`). |
| Step-up signals | `req.mfaVerified` (ADR 0389 P1, `middleware/auth.ts:1256`), `req.oidcAuthTime` (ID-token `auth_time`, bearer path only, `auth.ts:1264`), cookie `authAt` (server re-stamp, daily, ADR 0833 D3) | Use MFA and `oidcAuthTime` for activation. `authAt` cannot prove a recent sign-in (D3 G4). |
| Naming | `kicktodo-seats` (ADR 0431 P4) is the COHORT seat purchase surface | "Seat" is taken in the KickTodo UI. In SPA copy this is an **operator membership**. The ADR keeps "operator seat" as the internal name. |

### A latent laundering path this ADR must close first

`host-kicktodo` is a multi-principal workspace (every participant is in it), but the host decides
"shared workspace" by **prefix**: `isSharedWorkspaceTenant(t) = t.startsWith('ws:')`
(`accessControlService.ts:1281`). Every ADR 0815 hardening keys on that predicate, including the
D1b rule that **in a shared workspace only the ROOT membership is tenant-wide**
(`resolveSubjectScopesUnionDirect`, `:2186`). For `host-kicktodo` the predicate is false, so **any
sub-org membership row a subject holds in `host-kicktodo` contributes its roles to the tenant-wide
union.** A sub-org `owner` row therefore yields `OWNER_SCOPES` in `host-kicktodo`, including
`host:kicktodo:manage` and `host:byok:manage`.

Today that row can only be minted through `POST /orgs` in `host-kicktodo` (`requireOrgCreate`,
`routes/accessControl.ts:216`), and the exits are: a superadmin (via `requireOwner`'s `isSuperadmin`
bypass, `:158`), a wildcard key, or an **env key** (`auth.kind === 'env-key'`, `:218`). So:

- **An existing, undocumented path to the seat already exists.** An operator who configures
  `OPENWOP_API_KEYS=<key>:host-kicktodo` can `POST /orgs` as that key. The created sub-org seeds
  `ownerSubject = 'bearer:<first 8>'` as owner (`routes/accessControl.ts:429-435`), and from then on that
  key passes `requireKicktodoManage` in `host-kicktodo`. The comment at `middleware/auth.ts:1153`
  ("`bearer:<…>` … can never match a member row") is false on this path. Read from code, not exercised.
  The seat is unaudited as a grant, invisible in any members UI (nobody can read that roster), not
  revocable from a UI, and keyed to a credential prefix rather than a person. It is also useless for
  publication: `hasKicktodoManageAuthority` will accept `bearer:…` as a decider, which makes a shared
  environment credential count as a "different person" under separation of duties. **It must not be the
  answer, and P0 closes it.**
- **Once an operator seat exists (any option below), the same hole widens.** An operator who is also a
  superadmin, active in `host-kicktodo`, could create a sub-org and add any participant as its owner.
  That participant would silently become a tenant-wide KickTodo and BYOK admin, with no root role
  change to see. That is the "moving a definition between registries moves authz" lesson: the authority
  arrives through the sub-org registry, not the root roster everyone audits.

## Decision drivers

1. **Least privilege.** Only `host:kicktodo:manage` + `host:byok:manage`, and only on system-owned
   declared default workspaces, never a customer workspace. *(Amended 2026-10-18, OQ1: a narrow role,
   not `admin`.)*
2. **Just-in-time, not standing.** Eligibility and activation are separate, activation is short, and
   expiry holds at USE time (the Microsoft Entra PIM / NIST SP 800-53 AC-6 model, the owner's
   decision on OQ4–OQ6).
3. **The gate is on the USE lane.** Authority at use time comes from the resolver every KickTodo route
   and tool already calls (`resolveSubjectScopesUnion`). No new bypass branch in `requireKicktodoManage`
   or `hasKicktodoManageAuthority`.
4. **Auditable and visible.** Activation, expiry and revocation each append a tamper-evident row, and
   activations are listed without scanning the participant roster (ADR 0684 §6: it is unbounded).
5. **Separation of duties is waived only explicitly and visibly** (OQ2), and nowhere else.
6. **No cross-tenant grant.** The host-global allowlist decides eligibility. It never grants authority
   in a tenant by itself.
7. **White-label safe.** Any distribution's declared default org gets the same mechanism, with no
   KickTodo literal in core.

## Options

### A — Operator seat: a superadmin makes THEMSELVES a real `admin` member of a system-owned declared default workspace

> **AMENDED 2026-10-18 (owner decisions OQ1, OQ4–OQ6).** The decision below keeps A's shape (the
> caller activates for themselves, on a system-owned declared default workspace only, audited, with
> authority read by the existing resolver). It changes three things: the role is a narrow
> `kicktodo-operator`, not `admin`. The seat is a time-boxed ACTIVATION, not a standing membership role,
> which is option C made exact at use time. And the allowlist is eligibility only. The analysis of A as
> first written is kept below for the reasoning trail.

A superadmin-only, idempotent `POST /v1/host/openwop-app/workspaces/:id/operator-seat` turns the
caller's own workspace-root membership in `:id` into `admin`. It creates the row, or upgrades the
auto-joined `viewer` row, and records the seat in a small point-keyed ledger. After that the operator
is an ordinary member. They can switch in, and every existing gate resolves them through the existing
resolver.

- **Least privilege:** `admin` only, scoped to one workspace. Wider than needed (members, billing,
  connections, MCP management). *Superseded by OQ1.*
- **Use lane:** unchanged, so revocation takes effect on the next request in both lanes.
- **Audit / revocation / DSAR / multi-tenant / white-label:** carried into the decision below.

### B — Superadmin scope grant: `requireKicktodoManage` admits `isListedSuperadmin` without membership

Add an `isListedSuperadmin(req)` exit to the gate (and `hasKicktodoManageAuthority` would need a
subject form).

- **Fails D-23 outright.** `DELETE /byok/active-config` acts on `tenantOf(req)`, and a non-member
  cannot make `host-kicktodo` active. B would need a second bypass in the switch route, or an explicit
  tenant parameter on BYOK writes. Either one is a cross-tenant administration lane on a credential
  surface.
- **Tool lane drift.** `hasKicktodoManageAuthority(tenantId, subject)` has no `req`, so the tool lane
  and the route lane would hold two implementations of "who is a superadmin". ADR 0458 CRITICAL-3
  removed exactly that drift.
- **Standing, invisible authority.** No row, no listing, no expiry. Every superadmin would be a
  KickTodo publisher in every tenant where the feature is on, unless the bypass is also tenant-scoped.
  ADR 0684 §5 says not to write a default-org check that way.
- Rejected. Its one advantage (de-listing works instantly) is kept in the decision: the use-time check
  re-reads the allowlist.

### C — Time-boxed break-glass seat

> **AMENDED 2026-10-18 — ADOPTED in its just-in-time form (OQ4–OQ6).** The use-lane cost objection
> below is answered by the decision: the expiry check is a POINT read, done only for a declared default
> workspace, and never a roster scan. The "wrong fit for multi-day work" objection is answered by
> making activation re-activatable: authoring spans days, but each authority-bearing act needs a live
> activation at the moment it happens. The break-glass naming objection stands, so the SPA calls this
> "operator access", never "break-glass".

A, with mandatory expiry (e.g. 8 h). The grant mints a membership with `expiresAt`, and a use-lane
check or a sweeper revokes it.

- **Use-lane cost.** An expiry that holds at use time must be read inside
  `resolveSubjectScopesUnionDirect`, the hottest authority resolver in the host, or by a sweeper whose
  lag is the window. An expiry enforced only by a sweeper is a creation-lane gate in disguise.
- **Wrong fit for the work.** First-catalog authoring is days of Factory runs, gate reviews and
  approvals. A seat that lapses mid-review strands pending `challenge-publish` approvals: eligibility
  is re-checked at decide time (`registerApprovalEligibility`), so a lapsed decider gets 403 and the
  approval sits.
- **Break-glass already means something here** (ADR 0389: all auth is down). Reusing the word for a
  routine operator role blurs an incident control.

### D (considered, rejected) — author in the operator's own workspace and publish across

The owner is implicit manage-holder in their personal workspace today, so the Factory already works
there. But enrollment reads the challenge from the ENROLLING tenant (`kicktodo-core/feature.ts:41-44`,
ADR 0684 §2: "co-location — rather than a cross-tenant bridge — is the shape"). Getting the catalog into
`host-kicktodo` would need a cross-tenant publish bridge: a new write lane across the hard isolation
boundary, with its own authz question about who may write into `host-kicktodo`. That is this ADR's
question again, plus a bridge. D-23 is also left unsolved.

### E (considered, rejected) — seed a human owner at provisioning (`OPENWOP_KICKTODO_OWNER=<subject>`)

This reverses ADR 0684 §5 (system-owned), puts a person's identity in deploy config, and makes the
owner undeletable by the ≥1-owner invariant. `owner` is also more than the work needs.

## Decision

**Just-in-time operator access (amended 2026-10-18).** A listed superadmin is ELIGIBLE. To act, they
ACTIVATE a time-boxed, MFA-stepped-up, justified `kicktodo-operator` role for themselves on a
system-owned declared default workspace. Authority holds only while that activation is live, and that
is checked on every authority resolution. The P0 laundering fix ships first.

**D0 — default workspaces are membership-rooted for AUTHORITY.** Add
`isMembershipRootedWorkspace(tenantId)` in `accessControlService.ts`: true for `ws:` tenants AND for
every declared default workspace (registered at boot from the same declarations
`setDefaultWorkspaceTargets` receives). Adopt it at the **authority** sites only:
`resolveSubjectScopesUnionDirect` (`:2186`, the D1b union), `resolveEffectiveAccess`'s org default
(`:1971`), `subjectHasMembershipStrict` (`:1930`), the `hasDistinctScopeHolder` D1b decider filter
(`:2128`) and `requireOrgCreate` (`routes/accessControl.ts:221,224`). **Do NOT change
`isSharedWorkspaceTenant` globally.** Its notification callers (`notifications/audience.ts:86`,
`materialiseRecipients`) would then materialise every broadcast per participant in `host-kicktodo`,
a full-roster fan-out ADR 0684 §6 forbids. Under D0 a sub-org row in `host-kicktodo` grants nothing
tenant-wide, and `POST /orgs` there needs the `owner` role on the root membership, which nobody holds.

**D1 — the `kicktodo-operator` built-in role (OQ1).** `BuiltInRoleId` gains `'kicktodo-operator'`
with scopes **exactly** `['host:kicktodo:manage', 'host:byok:manage']`: no viewer/editor base, no
member management, never owner. It is **activation-only**. It never appears in a member row's
`roles[]`, and `parseRoleIds`/`validRoleIds` (`routes/accessControl.ts`) refuse it on every member
and group route in every tenant, so a standing, non-expiring grant cannot be minted through the roster.
It is added to the roles listing (`GET /roles`) marked `activationOnly: true`, so the UI never offers
it as an assignable role.

**D2 — eligibility.** `isListedSuperadmin(req)` (allowlist only: no wildcard bearer, no
`OPENWOP_FEATURE_TOGGLES_DEV_OPEN`, a narrowed key never qualifies) is ELIGIBILITY. It grants nothing by
itself, anywhere. Eligibility is reviewed by the boot pass (D7), which runs on every revision, and every
allowlist change is a revision.

**D3 — activation.**

```
POST   /v1/host/openwop-app/workspaces/:id/operator-access   { justification: string, durationMinutes?: number }  → 201 { activation }
DELETE /v1/host/openwop-app/workspaces/:id/operator-access[/:subject]                                         → 204
GET    /v1/host/openwop-app/workspaces/:id/operator-access                                                    → 200 { activations[] }
```

The POST guards, in order, each fail-closed:

- **G1 eligible:** `isListedSuperadmin(req)`.
- **G2 a person, activating for THEMSELVES:** `req.userId` is set (bound session) with the `user:`
  shape. `req.principal.auth.kind` is not `api-key`/`env-key`, and the subject is not delegated. There
  is no `subject` field in the body.
- **G3 MFA step-up:** `req.mfaVerified === true` (ADR 0389 P1, `middleware/auth.ts:1256-1257` on
  the bearer path, carried on the cookie as `mfa`). Otherwise the response is 403 `mfa_required`.
- **G4 recent authentication (≤ 15 min).** **Available today on the bearer path only:**
  `req.oidcAuthTime` is set from the ID token's `auth_time` claim (`middleware/auth.ts:1264`). The
  cookie's `authAt` (ADR 0833 D3, `cookieSession.ts:85`) is **not** usable: it is the SERVER time of
  the last IdP verification, re-stamped at most daily (`REAUTH_RESTAMP_SECONDS = 86_400`, `auth.ts:900`),
  so it cannot prove a recent sign-in. The activation therefore REQUIRES a fresh ID token on the request
  with `nowS − req.oidcAuthTime ≤ 900`, else 403 `reauth_required`. The SPA re-authenticates first
  (Firebase `reauthenticateWithPopup`) and sends the new token. A cookie-only request cannot activate.
- **G5 justification:** `justification` is a non-empty string of at least 10 characters and at most
  500, stored verbatim.
- **G6 target:** `:id ∈ declaredDefaultWorkspaceTargets()`, `getWorkspace(:id)` is a workspace root,
  AND `org.createdBy === 'system'`, otherwise a uniform **404**. A superadmin can never activate in a
  customer's `ws:` workspace. The target's feature must be enabled (`resolveOne`), otherwise 409.
- **G7 duration:** default **480 minutes** (8 h), maximum 480, minimum 15. A larger value is a 400,
  never clamped silently.
- **G8 audit first:** `appendAudit(:id, 'security.operator-access-activated', { activationId, subject,
  justification, expiresAt, ip, mfa: true, authTime })` is awaited **before** the activation row is
  written. A failed append means no activation (500).

Effects: if the caller has no root membership in `:id`, one is created as `['viewer']` (the participant
floor, so they can switch in). An existing root row is **not touched**: no role edit, no twin. The
activation is written to the ledger, and the other superadmins are notified (D6).

**Re-activatable:** a POST while an activation is live returns 409 `already_active` (with its
`expiresAt`). After expiry or revocation a new POST mints a NEW `activationId`, with fresh MFA, fresh
re-auth and a fresh justification.

**D4 — the ledger and the USE-TIME check.** New `host/operatorAccess.ts`:
`DurableCollection<OperatorActivation>('workspace-operator-activation')`, keyed
`${workspaceId}::${subject}` (the current activation), tenant-indexed on `workspaceId`. Fields:
`activationId, workspaceId, subject, justification, activatedAt, expiresAt, revokedAt?, revokedBy?`.

In `resolveSubjectScopesUnionDirect`, after the membership union, **iff
`isDeclaredDefaultWorkspace(tenantId)`** (a set lookup, so every other tenant pays nothing):

```
const a = await operatorActivations.get(`${tenantId}::${subject}`);   // one point read
if (a && !a.revokedAt && Date.parse(a.expiresAt) > Date.now()
      && isListedSuperadminTenant(subject)                              // eligibility, re-read at use
      && mine.some(isWorkspaceRootMembership)) {                        // still a member
  add BUILT_IN_ROLES['kicktodo-operator'].scopes;
}
```

- Expiry is compared **on every resolution**. The sweep (D7) only cleans up rows and writes the expiry
  audit. **No authority decision depends on the sweep having run.**
- De-listing takes effect at use time too (`isListedSuperadminTenant` is an env read), so the allowlist
  is honoured live and not only at activation.
- Read error on the point read ⇒ the activation is treated as absent (fail-closed, RFC 0049 §C).
- **The delegated lane gets nothing.** `resolveSubjectScopesUnion`'s `viaDelegation` path (an `owk_`
  key the operator issued) calls the direct resolver with `{ activations: false }`. A key minted during
  an activation never inherits operator scopes. This applies the ADR 0795 D1 "a key asked for less"
  reasoning, and it also stops the activation from outliving its 8 h inside a key.
- Because both the route lane (`requireKicktodoManage`) and the tool lane (`hasKicktodoManageAuthority`)
  already call this resolver, both see the same activation and expire at the same instant. Neither is
  edited.

**D5 — explicit, audited self-approval of publication (OQ2).** The owner waives the two-person rule
for `challenge-publish` **only for a live operator activation**. One predicate,
`operatorSelfApprovalActivation(tenantId, subject): Promise<string | null>` in `host/operatorAccess.ts`
(the activation id when live per D4's exact test, else null), is consulted at BOTH separation sites:

- the eligibility check (`kicktodo-creator/routes.ts:430`): `decidedBy === submitter` is allowed iff
  the predicate returns an id;
- `completePublication` (`publishService.ts:362`): `approver === record.submittedBy` is allowed iff
  the same predicate returns an id. The act re-asks; it does not trust the eligibility pass.

When it applies, the approval record (`resolveApproval`, host-local, never on the wire) and the
publication record carry `selfApproved: true, operatorActivationId`, and
`appendAudit(tenant, 'kicktodo.publication.self-approved', { approvalId, candidateId, subject,
operatorActivationId })` is awaited before the publish. **Unchanged:** a submitter without a live
activation still needs a different decider. The four sign-off kinds (`signoffApprovals.ts`) keep
`separateFrom` with no waiver. Every decider still needs manage authority at decide time.
*Trade-off, in one sentence: a single compromised eligible account with a live MFA-stepped activation
can now publish content alone, which the audit row records but does not prevent.*

**D6 — notification.** Activation, revocation and the sweep-observed expiry notify the **other** listed
superadmins only. That is `listedSuperadminTenants()` minus the actor, addressed to each personal tenant
(the `funnelWeeklySummary` precedent). **Never** the participant roster and never a role-addressed
notice in `host-kicktodo`.

**D7 — revocation, expiry sweep, eligibility review.**

1. `DELETE …/operator-access` (self), or `…/:subject` by any other eligible superadmin (MFA required,
   no re-auth window). It sets `revokedAt`. Authority ends on the next resolution. Audit
   `security.operator-access-revoked { activationId, by }`.
2. Removing the operator's root membership through any lane also ends authority (D4's membership
   leg). The ledger row is cleaned by the sweep.
3. **Boot pass** (beside `ensureFeatureDefaultOrgs` in `index.ts`) plus an **hourly sweep**: for each
   ledger row that is expired, revoked, de-listed or member-less, write the matching audit row once
   (`security.operator-access-expired` / `…-revoked { by: 'eligibility-review' }`), notify per D6,
   and delete the row. This is the PIM access review: the boot pass is the eligibility review, because
   every allowlist change ships as a revision and every revision boots. It is bounded: it lists the
   ledger, never the roster.

**D8 — the Factory credential (OQ3).** The Factory's provider key lives in `host-kicktodo`'s vault
under ONE dedicated ref, `kicktodo-factory:<provider>` (e.g. `kicktodo-factory:anthropic`), and the
Factory chains reference it **by name**. They do not resolve it through `pickCredentialRef`'s "any key
for this provider" selection, and the chat `active-config` binding never points at it. P1 adds a
ratchet: the only `credentialRef` literals or defaults equal to `kicktodo-factory:*` live in the Factory
chain pack and `kicktodo-creator`, and `resolveFactoryImage`/the Factory LLM pre-flight pick that ref
rather than the first matching provider key. Storing it needs `host:byok:manage`, so it needs a live
activation.

**D9 — a Factory run that outlives the activation (verified against the code).** Authority is checked
when each GATED act happens, not for the life of a run:

- **Starting a run** (`runFactoryRunTool`, `agentTools.ts:104`) and every Challenge Author chat tool
  (`runCandidatesTool`, `:80`, and siblings) call `hasKicktodoManageAuthority` **per call**. After
  expiry, a chat turn's read tools fail EMPTY and its action tools return a typed `forbidden`.
- **A run already running is unaffected.** The in-run Factory surface (`kicktodo-creator/surface.ts`,
  including the terminal `submitPublication` op at `:234`) does **not** re-check manage authority. It
  acts as the run's `actingUserId`. So a run started under a live activation completes after expiry and
  may still RAISE its `challenge-publish` approval.
- **Deciding that approval needs a live activation at decision time.** `registerApprovalEligibility`
  runs at decide (`kicktodo-creator/routes.ts:424-433`), and under D5 the self-approval predicate is
  asked again inside `completePublication`. An expired operator gets 403 and must re-activate.
- So the expected behaviour holds. One nuance is recorded: the run's *terminal submit* is not gated at
  submit time. That is acceptable, because it only raises an approval and publishes nothing.

**D10 — readiness (ADR 0690).** `buildKicktodoReadiness` gains `operatorAccess`: eligible count
(listed superadmins), live activations, and a **warning** `no_live_operator_activation` (not a
blocker: JIT means zero live activations is the normal resting state). It also reports `factory_credential_missing`
when `kicktodo-factory:*` is absent.

**D11 — SPA.** The KickTodo admin People & access page gets an "Operator access" panel, shown to a
listed superadmin only (`/access/effective` `superadmin`). It offers *Activate* (justification required,
duration picker defaulting to 8 h, Firebase re-auth then the call), a live countdown to `expiresAt`,
*End now*, the activation list, and the switch hand-off. Copy states exactly what is granted: KickTodo
authoring and publishing, including approving your own submission, and the workspace's AI keys.

## Trade-offs accepted

- **Re-activation friction.** Multi-day authoring means re-activating, with MFA and re-auth, at least
  every 8 h. That is the PIM trade the owner chose.
- **One point read per authority resolution in declared default workspaces.** Bounded and keyed. Every
  other tenant pays only a set lookup.
- **Recent-auth needs a bearer.** A cookie-only client cannot activate until the SPA sends a fresh ID
  token (G4).
- **Self-approval** (D5): one sentence, stated there.

## Implementation plan

Each phase is one PR, gated by `npm run ci`. Every guard has a **sabotage witness**: the test is run
red against the guard removed, and the result is recorded in the PR.

### P0 — D0, close the sub-org laundering path (before any activation exists)

| File | Change |
|---|---|
| `backend/typescript/src/host/accessControlService.ts` | `isMembershipRootedWorkspace`, `registerMembershipRootedWorkspaces(ids)`. Adopt at `:1930`, `:1971`, `:2128`, `:2186`. |
| `backend/typescript/src/index.ts` (beside `setDefaultWorkspaceTargets`, `:513`) | Register the declared default ids. |
| `backend/typescript/src/routes/accessControl.ts` | `requireOrgCreate` (`:221`, `:224`) uses the new predicate. |
| `backend/typescript/test/adr0910-default-workspace-root-only-union.test.ts` | (a) a sub-org `owner` row in a declared default workspace yields **zero** tenant-wide scopes and `requireKicktodoManage` → 403. Witness: revert `:2186` → red. (b) an env key scoped to the default workspace that `POST /orgs` does not then pass `requireKicktodoManage`. Witness: revert (a) → red. (c) `POST /orgs` there by a viewer participant → 403. Witness: revert `:221/:224` → red. (d) control: `ws:` and `default` tenants behave exactly as before. |
| `backend/typescript/test/adr0910-shared-predicate-not-widened.test.ts` | `isSharedWorkspaceTenant('host-kicktodo') === false` and `materialiseRecipients('host-kicktodo')` stays `null`. Witness: widen the predicate → red. |
| `middleware/auth.ts:1153` | Correct the "`bearer:` can never match a member row" comment, citing D0. |

> **P0 record (2026-10-18, #4944).** Implemented as planned, with two deviations stated here.
> `isMembershipRootedWorkspace` / `registerMembershipRootedWorkspaces` landed in
> `accessControlService.ts` and drive the four authority sites (the D1b union, the
> org-less effective-access default, `subjectHasMembershipStrict`, the distinct-holder
> decider filter) and `requireOrgCreate`; `index.ts` registers the declared default ids
> beside `setDefaultWorkspaceTargets`; the `middleware/auth.ts` comment is corrected.
> `isSharedWorkspaceTenant` is unchanged (`ws:` only).
>
> Test: `test/adr0910-default-workspace-root-only-union.test.ts` (5) — a sub-org owner row
> grants no tenant-wide scope and fails `hasKicktodoManageAuthority`; the `bearer:` seat an
> env key seeds is not a manage holder; controls (an undeclared tenant keeps today's union,
> `ws:` unchanged); the notification predicate is not widened. Sabotage, each witnessed red:
> no registration (3 red), the union site reverted alone (2 red), `isSharedWorkspaceTenant`
> widened (1 red). Related suites green at the change: 19 files / 347 tests (ADR 0815, 0684,
> KickTodo authz, shared-workspace, org-scope).
>
> **Deviations:** (1) the planned second file (`adr0910-shared-predicate-not-widened`) is a
> leg of the first; (2) leg (c) — `POST /orgs` by a viewer participant in the default
> workspace → 403 over HTTP — is NOT yet written. `requireOrgCreate` uses the same
> predicate the service legs witness, but the route itself has no test of its own here; it
> lands with P1's HTTP suite, which needs the same signed-in harness.

### P1 — D1–D5, D8, D9: role, activation, use-time check, self-approval, Factory ref

| File | Change |
|---|---|
| `backend/typescript/src/host/accessControlService.ts` | `kicktodo-operator` in `BuiltInRoleId`/`BUILT_IN_ROLES` (`activationOnly`). The D4 block in `resolveSubjectScopesUnionDirect` and the `{ activations: false }` flag on the `viaDelegation` path. |
| `backend/typescript/src/routes/accessControl.ts` | `parseRoleIds`/`validRoleIds` refuse `kicktodo-operator`. `GET /roles` marks it `activationOnly`. |
| `backend/typescript/src/host/operatorAccess.ts` (new) | Ledger, `activateOperatorAccess`, `revokeOperatorAccess`, `listOperatorActivations`, `operatorSelfApprovalActivation`, the D6 notifier, `registerSubjectEraser` (point-delete `${tenantId}::${subjectKey}`; the audit chain keeps the history under ADR 0464's audit rules). |
| `backend/typescript/src/host/subjectEraserManifest.ts` | Classify `workspace-operator-activation`. |
| `backend/typescript/src/routes/operatorAccess.ts` (new) + `routes/registerAllRoutes.ts` | The three routes. |
| `backend/typescript/src/features/kicktodo-creator/routes.ts:430`, `publishService.ts:362` | The D5 predicate at both separation sites. `selfApproved` + `operatorActivationId` on the approval and publication records. The self-approval audit row. |
| `backend/typescript/src/features/kicktodo-creator/agentTools.ts`, the Factory chain pack | D8: the Factory picks `kicktodo-factory:<provider>` by name. |
| `test/adr0910-kicktodo-operator-role.test.ts` | `BUILT_IN_ROLES['kicktodo-operator'].scopes` equals **exactly** `['host:kicktodo:manage','host:byok:manage']` (set equality, so a third scope is red). It is not `owner`, has no `host:members:manage`, and the member/group routes refuse it (POST and PATCH both → 400). Witness: add `host:members:manage` to the role → red. Drop the route refusal → red. |
| `test/adr0910-operator-activation.test.ts` | One leg per guard, each with its witness. **G1** not listed → 403; dev-open on and not listed → 403 (witness: swap to `isSuperadmin`); narrowed key → 403. **G2** env/`owk_`/anon/delegated → 403 (witness: drop the auth-kind check). **G3** `mfaVerified` false → 403 `mfa_required` (witness: drop it). **G4** `oidcAuthTime` 16 min old → 403 `reauth_required`, cookie-only → 403 (witness: drop it, or read `cookieSession.authAt` instead → red because a day-old re-stamp passes). **G5** empty or 9-char justification → 400. **G6** a `ws:` workspace the caller owns → 404 (witness: drop `createdBy === 'system'`). **G7** 481 min → 400, default = 480. **G8** `appendAudit` rejecting → 500 and no ledger row (witness: audit after write). Re-activation: live → 409; after expiry → new `activationId`. Root row untouched (same `memberId`, same `roles`). |
| `test/adr0910-operator-use-time-expiry.test.ts` | With a fake clock and **the sweep never run**: before `expiresAt`, a Factory route → 2xx, `hasKicktodoManageAuthority` → true, `DELETE /byok/active-config` → 204. One second after, all three are refused, through both lanes. Witness: compare expiry only in the sweep → red. De-list (env) mid-activation → refused at once (witness: drop `isListedSuperadminTenant` from D4). Revoke → refused next request. Remove the root membership → refused. An `owk_` key issued by the operator during the activation → refused (witness: drop `{ activations: false }`). A read error on the ledger → refused. |
| `test/adr0910-self-approval.test.ts` | An operator with a live activation approves their own submission. The challenge publishes, and the approval and publication records carry `selfApproved: true` + the `activationId`, with the audit row present. The same operator after expiry → 403 at decide AND inside `completePublication` (call it directly; witness: check only at eligibility → red). A non-operator manage holder (e.g. a personal-workspace owner, or an `admin` member) self-deciding → 403 (witness: waive for any manage holder → red). A sign-off kind with the operator in `separateFrom` → still 403. |
| `test/adr0910-factory-run-outlives-activation.test.ts` | Start a Factory run under a live activation, expire it, and let the run reach `submitPublication`. The approval is raised. A chat tool call after expiry fails empty or with a typed error. Deciding needs a re-activation. Pins D9 as documented behaviour. |
| `test/adr0910-factory-credential-ref.test.ts` | The ratchet in D8, and that the Factory chooses `kicktodo-factory:anthropic` over another anthropic key in the same vault. Witness: revert to `pickCredentialRef` first-match → red. |
| `test/adr0910-operator-notify.test.ts` | Activation notifies other listed superadmins only: zero notices to participants and to the actor. Witness: address the tenant → red. |
| `test/subject-erasure-coverage.test.ts` | Passes with the new store classified. |

> **P1 record (2026-10-18) — implemented, with corrections the code forced.**
>
> - **CORRECTION to D4 — eligibility must be re-read on the PERSONAL tenant, not the
>   subject.** D4 calls `isListedSuperadminTenant(subject)`. A member subject is
>   `User.userId` = `user:<sha256(tenant:principal)>` (`usersService.userIdFor`); the
>   allowlist holds the PERSONAL tenant `user:<sha256(iss:sub)>`. They are different
>   hashes, so as written the use-time check could never pass. The activation now records
>   `eligibilityTenant` (the caller's `req.personalTenant`, verified listed at G1) and D4
>   re-reads THAT, which keeps live de-listing.
> - **D1, stricter than written.** `kicktodo-operator` is NOT added to `BuiltInRoleId`: it
>   is `KICKTODO_OPERATOR_ROLE` in `host/operatorActivationLedger.ts`. The role validators
>   only admit built-in and custom ids, and `scopesForRoles` ignores it, so a member or
>   group row can never carry it — the refusal is structural, not a list of route checks.
>   Listing it in `GET /roles` (marked `activationOnly`) moves to **P3**, with the SPA
>   filter that keeps it out of role pickers; listing it before that filter exists would
>   offer an unassignable role in the UI.
> - **G1 tightened.** Eligibility is the caller's own PERSONAL tenant on the allowlist;
>   `isListedSuperadmin(req)` alone also passes any member of a listed ACTIVE workspace.
> - **D5.** `selfApproved` + `operatorActivationId` ride the publication record and the
>   `kicktodo.publication.self-approved` audit row (awaited before the publish). The host
>   approval record is NOT widened in P1 (`resolveApproval`'s outcome type is closed);
>   its `decidedBy === submittedBy` already shows the self-decision.
> - **D8.** `pickFactoryCredentialRef` prefers `kicktodo-factory:<provider>` by name and
>   falls back to the ordinary ladder when the ref is absent, so a creator's personal
>   workspace without the dedicated ref keeps working.
> - **Not yet witnessed:** the G8 audit-failure leg (needs an audit fault seam) and the
>   delegated-lane leg (`{ activations: false }` is in the code; an `owk_` key test needs
>   the key-issuing harness). The D4 root-membership condition is defence in depth: under
>   D0 a removed root row already empties the union before the activation is read.
>
> Test: `test/adr0910-operator-access.test.ts` (13, HTTP through a synthetic OIDC issuer
> and a bound session) — D1 role shape; G1, G3, G4, G5, G6, G7; activation (8 h default,
> viewer floor, manage granted, 409 on a second); revocation; use-time expiry with no
> sweep; de-listing; root-membership loss; the D5 predicate; D8 preference + ratchet.

### P2 — D7 sweep + D10 readiness

| File | Change |
|---|---|
| `backend/typescript/src/host/operatorAccess.ts`, `index.ts`, the hourly scheduler seam | `sweepOperatorActivations()` at boot and hourly. |
| `backend/typescript/src/features/kicktodo-core/readinessService.ts` | `operatorAccess`, `no_live_operator_activation`, `factory_credential_missing`. |
| `test/adr0910-operator-sweep.test.ts` | An expired row → exactly one `security.operator-access-expired` audit and one notice per other superadmin, and the row is deleted; a second sweep writes nothing. A de-listed holder at boot → `revoked { by: 'eligibility-review' }`. The witness for "authority does not depend on the sweep" is the P1 use-time test. |
| `test/adr0690-kicktodo-readiness*.test.ts` | The new fields and warnings. |

### P3 — D11, SPA

| File | Change |
|---|---|
| `frontend/react/src/features/kicktodo-admin/PeopleAccessPage.tsx` + `OperatorAccessPanel.tsx` | Panel: re-auth via Firebase, then activate; countdown; end now; list; switch. `ui/` primitives, `<Notice>` for what is granted. |
| `frontend/react/src/features/kicktodo-admin/i18n/*.ts` | Keys in every shipped locale (the owner can review pt-BR). |
| `frontend/react/src/features/kicktodo-admin/__tests__/OperatorAccessPanel.test.tsx` | Hidden for a non-superadmin. Justification required. `mfa_required`/`reauth_required` render their own states. The countdown reaches "expired" and offers re-activation. The copy names self-approval. Witness: render without the superadmin check → red. |

### P4 — production enactment (runbook, recorded in this ADR)

1. Deploy P0–P2 (backend first, ADR 0530 `deploy.sh`), then P3.
2. Owner, a listed superadmin with MFA: re-authenticate, then *Activate* on `host-kicktodo` with
   justification "A-08 first catalog / D-23", and switch in.
3. **D-23:** confirm ADR 0711 option B is live (a member with no stored binding reads the managed
   default as `valid`), then `DELETE /byok/active-config` from `host-kicktodo`. Verify participants
   still reach the managed default.
4. Store the Factory key as `kicktodo-factory:<provider>` (D8). Run the Factory, then submit and
   self-approve (D5) while the activation is live, re-activating as needed.
5. Record the ADR 0684 ban-path witness that the operator identity finally makes possible.
6. Readiness shows the activation and the Factory credential. Let the activation expire and confirm
   the sweep's audit row and the other superadmins' notice.

## Open questions — decided 2026-10-18 by the owner

- [x] **OQ1 — role.** *Decided 2026-10-18 by the owner:* a NEW narrow built-in role,
  `kicktodo-operator`, carrying `host:kicktodo:manage` + `host:byok:manage` only. No member management
  and never owner. → D1, P1 role test.
- [x] **OQ2 — second decider.** *Decided 2026-10-18 by the owner:* the two-person rule for publication
  is WAIVED. An operator may approve their own submission, as explicit, audited self-approval: only with
  a live operator activation, recorded `selfApproved: true` + the activation id in the audit row and
  the approval record. Every other decider rule is unchanged. → D5.
- [x] **OQ3 — Factory BYOK key.** *Decided 2026-10-18 by the owner:* in `host-kicktodo`'s workspace
  vault, under a dedicated Factory-named ref that only the Factory chains reference. → D8.
- [x] **OQ4 — expiry.** *Decided 2026-10-18 by the owner ("industry best practices": Microsoft Entra
  PIM / NIST SP 800-53 AC-6):* time-boxed activation, default and maximum 8 h, re-activatable, expiry
  enforced at USE time on every authority resolution. A sweep only cleans up. → D3 G7, D4, D7.
- [x] **OQ5 — MFA.** *Decided 2026-10-18 by the owner:* activation requires MFA step-up
  (`req.mfaVerified`) and, where auth time is available, recent authentication (≤ 15 min). Auth time is
  available today on the bearer path only (`req.oidcAuthTime`). The cookie `authAt` cannot serve. → D3
  G3/G4.
- [x] **OQ6 — notification.** *Decided 2026-10-18 by the owner:* activation and revocation (and
  expiry) notify the OTHER superadmins only, never the participant roster. Every activation, expiry and
  revocation is audited, and eligibility is reviewed through the boot-time pass. → D6, D7.

## How this unblocks the tracker

- **A-08 D2:** after P1 + P4.2 the owner holds `host:kicktodo:manage` in `host-kicktodo` while an
  activation is live, through the existing gate on both lanes. First-catalog authoring proceeds, and
  publication no longer waits on a second person (D5).
- **D-23:** the same activation carries `host:byok:manage`, and the participant-floor membership makes
  `host-kicktodo` switchable, so `DELETE /byok/active-config` runs from the right active workspace
  (P4.3, after the ADR 0711 B check).

## Surprising findings recorded here

1. **An undocumented seat path exists today**: an env key scoped to `host-kicktodo` → `POST /orgs` →
   sub-org owner row → tenant-wide `OWNER_SCOPES`, because `host-kicktodo` falls outside every
   `ws:`-keyed ADR 0815 hardening (12 `isSharedWorkspaceTenant` call sites). Closed by P0. Read from
   code, not exercised.
2. **ADR 0684 §5 delegated administration to "the operator's superadmin surface", and none exists for
   KickTodo**, which is why the ban path (ADR 0684) and D-23 (ADR 0711) were both stuck on the same
   missing identity.
3. **One manage holder could not publish anything**, by design (separation of duties). D5 now waives
   this for a live operator activation only.
4. **`notifications/audience.ts` treats `host-kicktodo` as non-shared**: `isCurrentNotificationAudience`
   answers `true` for anyone, and role-addressed notices are not materialised. Out of scope here and
   deliberately not widened by D0 (fan-out). Worth its own row.
5. **The in-run Factory `submitPublication` op does not re-check manage authority** (D9). It only
   raises an approval, so this is acceptable. It is the one Factory act not gated at the moment it
   happens.
6. **A "recent authentication" signal exists only on the bearer path.** The cookie's `authAt` is
   re-stamped up to a day late by design (ADR 0833 D3), so it must not be used for step-up.

## Status checklist

- [x] Owner answers OQ1–OQ6 (2026-10-18). Accepted 2026-10-18.
- [ ] P0 merged (laundering path closed) — implemented in #4944 (`isMembershipRootedWorkspace`); see the P0 record below
- [ ] P1 merged
- [ ] P2 merged
- [ ] P3 merged
- [ ] P4 enacted on kicktodo.com and recorded here → `implemented`
