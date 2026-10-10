# ADR 0815 — Orgs residual: a sub-org is not a door, the owner tier is judged per person, and removal takes down what the member delegated

Status: Accepted (2026-10-05) — implemented on `feat/fl2-12-orgs-residual` (D1–D6 + /architect, /grade-code, /grade-ux rounds); see § Implementation record

Feature-loop 2026-10 row 12 (`docs/steward/FEATURE-LOOP-2026-10.md`), the
**residual** of the unmerged row-12 draft branch (`feat/fl2-12-orgs`, never on `main`).

- **Composes:** ADR 0797 (act-as narrows; `requireOwner` on the owner tier;
  `owner_required`), ADR 0795 (key authority; D6 `notifyIssuerRemoved` on a
  subject's LAST membership), ADR 0697 (membership natural key; legacy twins),
  ADR 0684 (the point-read membership index), ADR 0622 (invitation events),
  ADR 0015 (workspace-as-tenant), ADR 0731 (tenant-level authority),
  USERS-19 (the SAML `default` tenant).
- **Supersedes nothing.** The row-12 draft (number 0790, never merged) has no ADR file. Its number stays as a
  historical citation in the tracker. The parts of it that `main` already
  solved are listed below and are not reopened.
- **Toggle:** none. `accessControl` is always-on core. The `orgs` toggle gates
  invitations only.
- **Wire:** untouched. Everything here is `/host/openwop-app/*` or
  host-internal. No RFC.

## Context — what `main` already fixed, and what it did not

Row 12's first pass (2026-09-30) found an act-as escalation, admin→owner lanes,
key residue and a sub-org door. Before it merged, another session shipped ADR
0797 and ADR 0795 in a different shape. The old branch was therefore
re-measured against `origin/main 0b772c45e`, in a detached worktree, using its
real-HTTP witnesses plus five new probes:

| Item | On `main` |
|---|---|
| act-as escalates | **Fixed** — ADR 0797 D1 (`host/actingAccess.ts`) |
| admin adds, grants, demotes or deletes an owner ROW; owner groups; owner invite | **Fixed** — ADR 0797 D2 `requireOwner` |
| cdp `requireAdmin({})` | **Fixed** — ADR 0797 D3 |
| a removed member's `owk_` keys | **Fixed** — ADR 0795 D6 (revoke on last membership; `delegationIssuerIsLive`) |
| a key mints a key | **Fixed** — ADR 0800 |
| The draft's auth-boundary key check + `onSubjectRekeyed` | **Superseded** by ADR 0795 D6 |
| **B1 — the sub-org door** | **RED.** A Viewer in a `ws:` workspace gets `POST /environments` 403, then `POST /orgs` 201, then `POST /environments` **201**. A sub-org owner is also a workspace KEY ADMIN and lists everyone's keys |
| **B1 in a root-less shared tenant (SAML `default`)** | **RED.** Any member gets `POST /orgs` 201 |
| **Owner tier judged on one row's DIRECT roles** | **RED, three ways.** (a) An admin re-points a viewer row that sits in an owner GROUP at its OWN subject and gets 200: admin→owner. (b) An admin deletes a group-derived owner and gets 204. (c) An admin deletes an owner's legacy non-owner twin and gets 204; `deleteMember` sweeps every twin, so the OWNER row goes with it |
| **In-place identity rebind** | **RED.** An owner re-points a root member at another subject and gets 200. The OLD person still reads the workspace, because the ADR 0684 point-read index was never moved, and the root row's id is derived from the old subject |
| **A demotion vs a legacy twin** | **RED.** The twin keeps `host:members:manage` in the tenant-wide union |
| **`updateMember` ∥ `deleteMember`** | **RED.** A blind put resurrects a removed row (interleaving 0 of 20) |
| **A removed admin's PENDING invite** | **RED.** Still redeemable (201). ADR 0797 lists it as open |
| **Schedules acting as a removed member** | **RED.** Still enabled, and still firing as them |
| **Member lifecycle events / audit lines** | **Absent.** No `host.orgs.member.*` |
| **UX** | The page offers owner-tier controls the server now refuses an admin, and renders `owner_required` as a generic failure. The remove confirm says nothing about invites or schedules |

## Decision

> **Shaped by an adversarial /architect pass on the first draft (2026-10-05).**
> It found 2 Blockers and 5 Highs; § "/architect round" lists each one and its
> disposition. The decisions below are the corrected ones.

### D1 — a sub-org is not a door to workspace authority

There are two layers, and both are required.

**D1a — creating an org in a multi-member tenant is owner-tier.**
`POST /orgs` (`requireOrgCreate`, `routes/accessControl.ts`) admits:
- the caller's own personal workspace (the `isPersonalTenantId` shape, never
  `default`);
- the wildcard operator, or an operator env key;
- the bootstrap of a NON-`ws:` tenant that has no org at all, read strictly. A
  store error is a 500, never "no orgs".

Otherwise the acting access must hold the `owner` ROLE (ADR 0797's
`requireOwner`, refusal `owner_required`):
- act-as can only narrow it;
- a key holds roles `[]`, so it never qualifies.

Where the owner role comes from depends on the tenant:
- **shared workspace:** the ROOT membership (`callerTenantAccess`);
- **root-less shared tenant** (the SAML `default` shape): any org's owner role,
  direct or via a group (`holdsOwnerRoleInTenant`). It never uses the
  single-principal exit, which would make every SAML user an owner.

**D1b — in a shared workspace, tenant-wide authority IS the root membership.**
This is enforced at the resolvers, not at each reader. In a `ws:` tenant
(`isSharedWorkspaceTenant`, decided on the id shape, so no read is added on the
hot path):
- `resolveEffectiveAccess(tenant, { subject })` with no `orgId` resolves the
  ROOT row rather than the first match;
- `resolveSubjectScopesUnionDirect` counts root rows only. That function feeds
  `resolveSubjectScopesUnion`, `resolveTenantLevelScopes` and so
  `callerTenantAccess`;
- `hasDistinctScopeHolder` does the same.

A sub-org row stays authority inside that sub-org, through `orgId`. Two things
follow:
- Every first-match reader is fixed at once: the developer-key admin, the
  approvals SLA, prod-promotion approval, interrupts, strategy and
  `/access/effective`.
- Sub-org owner rows minted through the door before D1a lose their tenant-wide
  PROTOCOL scopes (`workspace:write`, `webhooks:manage`, `packs:publish`, …)
  as well as `host:` management, with no data migration.

Someone who is not a root member is not in the workspace (`isWorkspaceMember`),
so the root row is the only coherent tenant-wide reading.

### D2 — the owner tier is judged per PERSON, not per row

`relationshipRoles(memberId)` returns direct ∪ group roles over every row of
(tenant, org, subject): the addressed row plus its ADR 0697 twins. Member PATCH
and DELETE treat the target as an owner when that set contains `owner`, and then
require ADR 0797's `requireOwner`. That closes (a), (b) and (c). The ≥1-owner
invariant is unchanged.

### D3 — an identity is not edited in place, and an update cannot resurrect

- **The route refuses every `subject` change on a row that already has one**,
  and on any workspace-ROOT row: 409 `identity_locked` ("remove them and add or
  invite the new person"). Re-pointing a row moves a membership to someone else
  without removing it from the first person. None of the D4 cascade runs for
  them, and a root row's id and index stay keyed on the old subject.
  - Only a subject-LESS sub-org placeholder may be bound, and only to an
    identity not already in that org (409 `identity_taken`).
  - `POST …/members` applies `identity_taken` in a sub-org too, where ids are
    random and a second row is the twin ADR 0697 D1 forbids.
  - The refusals live in the ROUTE. `rekeyMemberSubject` calls `updateMember`,
    and a service-level refusal would wedge the bind.
- **`updateMember` writes by CAS** against the row as read (`casMember`). A row
  that vanished mid-flight is never written again.
  - A ROLES patch is applied to every twin of the relationship, so a demotion
    holds. Each twin is its own CAS with a fresh re-read, and the patch is
    absolute, so a lost swap retries rather than half-applying. Bounded
    contention is a typed 409.
  - The owner-invariant restore is a CAS from what this call wrote. If a restore
    loses and the org is STILL ownerless, the addressed row gets its prior roles
    back. A lost race may cost an edit, never the workspace.
- **Transfer-ownership to one of the caller's own rows with `stepDown`** is a
  409 (`transfer_to_self`). Role edits apply to the whole relationship, so the
  step-down would strip the grant.

### D4 — removal takes down what the member delegated

- **Presence.** In a shared workspace, being present IS holding the root row, as
  `isWorkspaceMember` reads it. `subjectHasMembershipStrict` (behind ADR 0795's
  `notifyIfLastMembershipGone` and `delegationIssuerIsLive`) now counts root rows
  only there. Losing the root row while a sub-org row survives therefore revokes
  the person's keys and pauses their schedules, where before it did neither.
- **Seam (per org).** `onMemberAuthorityLost(id, hook)` in
  `accessControlService` carries `{ tenantId, orgId, subject, memberIds, roles,
  reason, actor? }`. It is fired:
  - by `deleteMember` after the removal is durable (`reason: 'removed'`). That
    covers the admin route and account deletion;
  - by the member PATCH route when an update leaves the person without
    `host:members:manage` in that org (`reason: 'demoted'`). This resolves an open question of the unmerged draft.

  Each hook's failure is logged, never thrown. Core imports no subscriber.
- **Invites.** `features/orgs` subscribes and deletes that relationship's
  PENDING invites in the org. It does this even while the `orgs` toggle is off.
  It matches on:
  - the inviter's member row, now stamped at mint as `createdByMemberId`, which
    finds an `oidc:` row whose invites were recorded as a canonical `user:`;
  - or the exact `createdBy` string.

  It never aliases one spelling to another.
- **Schedules (tenant-wide).** `schedulingService` subscribes to ADR 0795's
  `registerIssuerRemovedHandler` ("this person has LEFT the tenant", which
  `deleteOrg` also fires). It uses that rather than the per-org seam because
  leaving a sub-org is not leaving the workspace. It acts only where
  `membershipDefinesPresence`.
  - It DISABLES, never erases, every enabled job that acts as the person. A job
    acts as someone through `ownerSubject` (user), `ownerUserId`,
    `metadata.actingUserId` or `inputs.ownerSubject`, matched in every
    `subjectKeyForms` spelling, as erasure matches them.
  - It stamps `metadata.disabledReason: 'acting_member_removed'`. That marker is
    server-owned: it is a reserved client metadata key, and it is judged on the
    job as read.
  - Re-enabling RE-OWNS the job: the enabler becomes every actor field. A key
    cannot re-own. A FEATURE-owned job (`featureId`) keeps its actor in the
    feature's own rows too, so it gets a typed 409 asking to recreate it from
    the feature.
  - "Run now" on a paused job is a typed 409.
  - `registerJob` (a full replace that seven feature lanes re-run) carries the
    pause forward, unless the new row acts as someone else.
- **Deactivated accounts.** SCIM deprovision and an admin's deactivate change the
  account, not a membership, so no cascade sees them. `fireJob` asks the session
  authority whether a `user:` actor is still `active`, which is the reading ADR
  0795 gives a key's issuer, and skips with `actor-inactive` when it is not. This
  is non-destructive: reactivating them resumes the job.

### D5 — member lifecycle events and audit lines

`host/memberLifecycleEvents.ts` adds three events, catalogued in
`hostEventCatalog.ts`:
- `host.orgs.member.added`: a NEW row only;
- `host.orgs.member.roles-changed`: only when the role SET changed, including
  both halves of transfer-ownership;
- `host.orgs.member.removed`: from the D4 seam, so account deletion emits it too,
  and only when a row was actually removed.

Each event has a matching `org_member_*` audit line. Payloads carry ids and role
ids. A `saml:` / `scim:` / free-text subject is reduced to its kind
(`saml:(redacted)`). The audience is the tenant's own subscribers, who can already
list members. A root `memberId` is a hash of tenant and subject, and is therefore
not pseudonymous against them (/architect L2, accepted).

### D6 — UX: never offer what the server refuses

- The org page ANDs the act-as lens with the caller's own access. Without the
  `owner` role it hides `owner` in the role picker, disables owner rows and owner
  groups with a visible reason, and gates org create on the ROOT access
  (`/access/effective?orgId=<tenant>`).
- `owner_required`, `identity_locked`, `identity_taken` and
  `acting_member_removed` render as localized messages in four locales, using the
  envelope `accessClient` carries on `ApiError`.
- The remove confirm states what removal takes down (keys, pending invites,
  schedules), and a success toast confirms it.
- A paused-because-removed schedule shows a chip, Run now is disabled, and Resume
  asks before re-owning.

## Alternatives weighed

- **D1: a membership check on sub-org creation alone, with no D1b.** Rejected.
  Sub-org owner rows minted through the door already exist, and only D1b
  neutralises their management authority.
- **D1: forbid sub-orgs in a workspace.** Rejected. Teams-as-orgs is a real
  product shape. Owners can still create sub-orgs.
- **D2: delete twins on every update.** Rejected as silent data loss on a hot
  path. Applying the patch keeps the rows and makes them agree.
- **D4 invites: check the inviter's authority at ACCEPT instead.** Rejected. The
  inviter is recorded canonically (`user:`), while their member row may be
  `oidc:`. An accept-time check would refuse valid invites (the row-4 identity
  lesson). The cascade keys on the row's own subject.
- **D4 schedules: subscribe to the per-org seam.** Rejected. Removing someone from
  a sub-org would pause their workspace-wide jobs.
- **D4 schedules: a membership check at fire time.** It is the stronger
  invariant on paper, but rejected:
  - A job created before an OIDC bind carries `oidc:<sub>`, while the rekeyed
    root row says `user:<id>`. A fire-time membership miss would pause a member's
    legitimate job, which is the two-spellings lockout.
  - The membership miss path is a full scan.

  The lanes that bypass `deleteMember` and `deleteOrg` change the ACCOUNT (SCIM,
  deactivate), so the fire-time check is the account's status instead, as a
  point read.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core `accessControl` owns the seam and imports no subscriber. `features/orgs` and `host/schedulingService` subscribe. |
| 2 | Toggle | None new. |
| 3 | Workflow surface | Unchanged. The D5 events give a chain a binding point (`ORGWF-8`, people-hr offboarding, is a product call). |
| 4 | Node pack | Unchanged. |
| 5 | AI chat / envelopes | None. No agent tool reads or writes membership. |
| 6 | Agent pack | None. |
| 7 | Public surface | None new. |
| 8 | RBAC | This ADR. Every new branch fails closed. |
| 9 | Replay / fork | Not run-affecting. A disabled schedule stops future fires only. |
| 10 | Frontend | D6. Four-locale parity. |

## RFC verdict

**Host-extension, no RFC.** The RFC 0049 §C `authorization/decide` seam keeps
its shape. Which memberships count toward a decision is this host's own policy:
RFC 0049 lets a host define what its roles and orgs grant, and D1b narrows it in
a `ws:` workspace to the root membership. A decide call there is answered from
the root row, protocol scopes included. Nothing is advertised differently.
`host.*` events are this host's own side channel.

## Risks

| Risk | Mitigation |
|---|---|
| A SAML `default` tenant that already has orgs: a member who used to create orgs is now refused | The refusal names the rule. An owner of any existing org (or the operator, with a tenant env key) creates it. Prod sizing is asked of the orchestrator (read-only) before deploy |
| D1b removes management a sub-org ADMIN used to hold workspace-wide | Intended. That was the B1 hole. Authority inside the sub-org is unchanged (`resolveEffectiveAccess` with its `orgId`) |
| A schedule whose actor is spelled `oidc:` while the member row is `user:` (or the reverse) is not matched | Residual `ORGWF-12`, carried from the unmerged draft. Principals are not issuer-qualified, so we never alias by string |
| D1b changes what a sub-org role means in a `ws:` workspace: protocol scopes no longer union across sub-orgs | Intended. A sub-org member who is not a root member was never in the workspace. Measured by the full gate (see § Implementation record) |
| A SAML `default` tenant whose members already self-minted orgs keeps their tenant-wide union (D1b does not apply there) | D1a stops new ones. Existing rows need an owner to demote them. Prod sizing is asked of the orchestrator (read-only); an operator step is written up if non-zero |

## Phased plan

- **P1 (this PR):** D1–D6 with real-HTTP witnesses that are RED on `0b772c45e`.
- **Residuals found in this round (filed, not fixed here):**
  - A DEACTIVATED (SCIM or admin) admin's pending invites stay redeemable. D4
    handles deactivation for schedules only. The invite accept path would need
    the inviter's status, and that has the same spelling question as `ORGWF-12`.
  - Org DELETE is gated in the UI at the root, but the server checks the TARGET
    org. A sub-org owner who is not a root owner is not offered deleting their
    own sub-org (the server would allow it), and a root owner with no row in a
    sub-org is offered it (the server refuses it). This needs a per-org
    `canDelete` on the list.
  - The `identity_taken` check is check-then-create, so two concurrent POSTs can
    still mint a sub-org twin (ADR 0697 D2's removal sweep covers them).
  - Removing a subject-less placeholder row emits no `member.removed` event and
    runs no cascade, since it delegated nothing.
  - Assistant loops (`RecurringTasksPanel`) do not show the paused chip. A loop
    re-registers, so it stays paused, and its enable door answers the typed 409.
- **Residuals (from the unmerged draft, still open, owned elsewhere):**
  - `ORGWF-9`: the kanban assignee carve-out survives removal;
  - `ORGWF-10`: webhooks carry no creator;
  - `ORGWF-11`: approver refs;
  - `ORGWF-12`: the other-spelling twin;
  - `ORGWF-13`: the reconcile sweep for a failed unindex;
  - `ORGWF-14`: open collab sockets;
  - `ORGWF-8`: offboarding on `member.removed`.

## Open questions

1. ~~Should the invite cascade also fire on a DEMOTION?~~ **Yes** (D4,
   `reason: 'demoted'`).
2. Prod sizing, read-only: how many sub-org owner rows in `ws:` tenants were
   created by a subject who is not a root owner, and does the SAML `default`
   tenant hold orgs or members?

## /architect round (2026-10-05, adversarial, independent agent)

| Finding | Disposition |
|---|---|
| **B1** D1b missed the first-match `resolveEffectiveAccess({subject})` readers (key admin, approvals SLA, promotion approval, interrupts, strategy, `/access/effective`) and `hasDistinctScopeHolder` | Fixed at the resolver: in `ws:` a subject with no `orgId` resolves the root row (D1b) |
| **B2** ADR 0795's "last membership" never fired when the ROOT row went but a sub-org row stayed; account deletion removes root rows only; SCIM / deactivate touch no membership | Presence = root row in `ws:` (D4); `fireJob` reads account status (D4) |
| **H1** D1a via the tenant-level path is void in `default` (single-principal exit) | Root-less branch uses `holdsOwnerRoleInTenant`; existing `default` self-minted owners → Risks + prod sizing |
| **H2** D1b left self-minted sub-org owners every PROTOCOL scope tenant-wide | D1b now counts root rows only for ALL scopes in `ws:` |
| **H3** `registerJob` is a full replace and re-armed paused jobs | Carry-forward (D4) |
| **H4** Run now ignores `enabled`; actor match too loose (raw vs `user:`; `inputs.ownerSubject`) | Typed 409 in the trigger route; `jobActors` + `subjectKeyForms` (D4) |
| **H5** a sub-org subject rebind is a silent identity transfer; `POST` mints sub-org twins | Every rebind of a subject-bearing row refused; `identity_taken` on POST (D3) |
| **M1** feature enable doors cannot supply an actor | Feature-owned jobs: typed 409 "recreate from the feature" (D4) |
| **M2** invite spelling gap; demotion not cascaded | `createdByMemberId` stamped at mint; `reason: 'demoted'` (D4) |
| **M3** multi-row CAS half-apply / 0-owner restore | Per-row CAS with absolute patch; forced restore if still ownerless (D3) |
| **M4** bootstrap exit must not apply to `ws:`; strict read; scope gate would admit keys | Bootstrap non-`ws:` only, strict; role-based `requireOwner` (D1a) |
| **M5** D1b must not add a read to the hot path | Decided on the `ws:` id shape (D1b) |
| L1 `deleteOrg`, personal-workspace seeding and rekey bypass the D5 events | Accepted gap: org deletion is a teardown, not a member transition; documented here |
| L2 a root `memberId` is a reversible hash | Accepted (D5) |
| L3 index move on rebind was dead code | Dropped (D3 refuses the rebind) |
| L4 step-down to your own twin | 409 `transfer_to_self` (D3) |
| L5 D6 must pass `orgId` to `/access/effective` | D6 |
| L6 "four cases" listed three | Fixed |

## Closing grades and deploy note

- **grade-code: D+ → A−.** No Blockers, Highs or Mediums are open. Two Lows are
  accepted: `managersAmong` resolves per group member on a cold admin path, and
  the before-snapshot is not atomic with the write.
- **grade-ux: C− → A−.** The es "en su nombre" ambiguity and the deep-link lens
  were fixed in the closing commit. Remaining Lows: the org-delete reason (it
  goes with the per-org residual) and the brief controls flash before the access
  read lands.

**Prod sizing** (orchestrator, read-only, 2026-10-04 ~22:20 EDT):
- 1 `ws:` tenant, holding 2 member rows (root plus one owner-made sub-org). Every
  row is `owner`.
- SAML `default`: 0 orgs and 0 members.
- 0 owner-carrying groups.

So B1 and D2 were latent, and nothing needs repair. D1b changes nothing for
existing users. The regression leg pins the owner-made sub-org shape.

**Protocol scopes.** Outside a `ws:` workspace, the RFC 0049 union is exactly
as before, and that is witnessed. Inside one, a sub-org row no longer adds
protocol scopes tenant-wide. The conformance lane does not use `ws:` tenants.

**Operator path, SAML `default` (or any root-less shared tenant):**
- Creating an org there now needs the `owner` role in an existing org of that
  tenant.
- An owner grants it from Organizations → Members ("Transfer ownership", or the
  `owner` role on the member), or adds the person to a group that carries
  `owner`.
- If the tenant has no org yet, the first `POST /orgs` is the bootstrap, and
  its creator becomes the owner. The operator can make it first with a tenant
  env key.
- Today's prod tenant has 0 orgs, so no step is owed.

**Which sign-in modes are affected by D1a** (read from `middleware/auth.ts`,
`features/users/authRoutes.ts` and `routes/authSamlSso.ts`):

| Mode | Where `POST /orgs` lands | Affected |
|---|---|---|
| OIDC | the user's own `user:<hash>` tenant (implicit owner) | No |
| Anonymous demo | `anon:<sid>` | No |
| Personal workspace (any mode) | `user:` | No |
| Shared `ws:` workspace | that workspace | Yes, by design: workspace owners only |
| **SAML SSO** | `OPENWOP_SAML_TENANT` (default `default`), ONE tenant for every SAML user | **Yes**: after the first org, only an owner of an existing org there may create more |
| Operator env key / wildcard | any | No (exit) |

The refusal is a localized message saying to ask an owner, not a bare 403
(`errorCreateOrgOwnerRequired`, with a controller test). The SAML operator step
is in `CHANGELOG.md` [Unreleased] § Security.

**Deploy:** backend first, then frontend. There is no migration and no new env
var.

## Grading rounds (2026-10-05, independent agents)

- **`/grade-code`: D+ (main) → B+ (first cut).** No Blockers. Fixed in the
  follow-up commit:
  - an act-as invite stamped the VIEWED member as inviter (now the caller's own
    row);
  - the demotion cascade now also runs from group edits and group deletes
    (custom roles cannot carry `host:` scopes);
  - `registerJob` carry-forward matches actors in every spelling;
  - a twin-loop 409 rolls back what it wrote instead of half-applying;
  - the demotion hook passes every row of the relationship;
  - a NON-member of a shared-workspace org is offered nothing in the UI;
  - doc claims corrected: the RFC verdict, the 409-door list, Status;
  - new witnesses: `/access/effective` and `hasDistinctScopeHolder` are
    root-only; an owner through a GROUP may create orgs in a root-less tenant; a
    roles-only PATCH on a group-derived owner; `transfer_to_self`; the
    placeholder bind and `identity_taken`; the group-edit demotion cascade; the
    act-as inviter; `actor-inactive`; a CONTROLLER-level frontend test.

  The grader's "project schedule door cannot resume" finding does not apply: a
  project job acts as no person (`ownerSubject` is the project, with no
  `actingUserId`), so the cascade never pauses one.
- **`/grade-ux`: C− (main) → B− (first cut).** Fixed:
  - owner rows are judged per PERSON in the UI (`effectiveOwnerIds`: twins and
    groups);
  - the pause refusal is localized (re-own vs recreate);
  - the profile schedules tab maps the pause;
  - disabled controls point at visible reasons (`aria-describedby`), both for
    owner groups and for org create;
  - removal copy is neutral in root-less tenants, and the re-own clause is
    softened;
  - the chip no longer overloads "owner";
  - `errorOwnerTier` is shortened.

  Residuals are listed under Phased plan.

## Implementation record

| Decision | Commit | Witness (RED on `0b772c45e`, green here) |
|---|---|---|
| D1–D5 | `2bed17a69` | `backend/typescript/test/adr0815-orgs-residual.test.ts`: 14 legs, all 14 RED on `0b772c45e` in a detached worktree, each for the intended reason |
| D6 | `452cb04d1` | `frontend/react/src/orgs/__tests__/adr0815-owner-tier*.test.tsx`, `SubjectSchedulesPanel.states.test.tsx` |
| Grading rounds | `c209eec7a` | +8 backend legs (22 total), + the controller test |
| Closing | (this commit) | +2 regression legs (24): an owner-made sub-org keeps its owners; the RFC 0049 protocol union outside `ws:` is unchanged |

**Suites changed by design (not regressions):**
- `adr0795-key-authority.test.ts` minted its "shared workspace" as a `ws:`
  tenant with only a SUB-org and no root, a shape `createWorkspace` never makes.
  Under D1b nobody is in such a tenant. The orgs are now the workspace roots.
- `entities-rbac-session-scope.test.ts` asserted that a sub-org ADMIN held
  `host:members:manage` workspace-wide. That WAS the door. It now asserts the
  root reading, and that the type door refuses that user and admits a root admin.
- `scheduled-channel-posts-adr0202-d3.test.ts` minted a sub-org over HTTP as a
  non-owner (now D1a-refused). It mints the org directly, because that suite is
  about the schedule door.
- Full-gate round two found seven more, all encoding one of the same two shapes:
  - Five had several users of ONE shared tenant each `POST /orgs`. Only the
    first creator is the bootstrap now, and later members are refused (D1a, the
    SAML `default` door). They now mint the org directly, owned by the caller:
    `ambient-work-graph-route`, `campaign-brief-hooks-routes`,
    `campaign-brief-voc-routes` (their "`orgId` is required" 400 was the refused
    org's missing id reaching the brief POST, not a route deriving an org from
    the union), `capability-firewall-route`, and `webinars-bind-form-route`
    (tenant `default` itself).
  - `csm-authz-http` had a workspace EDITOR create a sub-org over HTTP. That is
    the door itself, so the sub-org is now minted directly with that editor as
    its owner.
  - `src/features/__tests__/requireTenantScope.test.ts` seated its members in a
    sub-org of a root-less `ws:` tenant. They are now root members, and the gate
    assertions are unchanged.
