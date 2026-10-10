# ADR 0797 — `x-openwop-act-as` may only narrow, and only an owner grants ownership

Status: Accepted (2026-10-01; implemented in the PR that adds this file — see § Implementation record)

- **Closes:** `CE-8` (`docs/steward/TODO.md`) — "org act-as privilege
  escalation", and the CDP half of the same row, recorded separately as `KEY-19`.
- **Composes:** ADR 0006 (membership-derived authority), 0015 (workspace-as-tenant;
  the implicit owner of a personal workspace), 0622 (one org-scoped predicate),
  0731 (never resolve `{}`), RFC 0049.
- **Toggle:** none. An authorization fix on always-on routes.
- **Wire:** untouched. `/v1/host/openwop-app/*` only. No RFC.

## Context

`x-openwop-act-as: <memberId>` was written as a demo seam: the workspace owner
names one of its members and sees the app with that member's scopes, so
role-based enforcement can be shown ("a viewer is actually denied"). Five route
modules read it — `routes/accessControl.ts`, `features/orgs`, `environments`,
`entities`, `cdp` — and every one resolved authority for the NAMED member and
nothing else.

So the header was not a lens. It was a way to be that member:

- **Any member could become owner.** A Viewer sending the Owner's member id held
  the Owner's scopes. Reproduced over HTTP when the row was filed: a Viewer
  PATCHed itself to owner (200) and DELETEd the owner (204). Member ids are
  readable by every member.
- **An admin could become owner without the header.** `host:members:manage` and
  `host:groups:manage` are an admin's scopes too, and they were all it took to
  add an owner, add `owner` to oneself, demote or delete the owner, re-point the
  owner's member row at another subject, create a group that grants `owner`, or
  invite an owner.
- **The CDP audit-chain check passed for anyone.** With no header it called
  `resolveEffectiveAccess(tenant, {})`, which answers OWNER — the shape ADR 0731
  removed from entities and environments.

Production exposure, measured when the row was filed (2026-09-30): one shared
workspace, every member already an owner, no owner-row changes in 30 days. The
standing instruction was to invite no non-owner into a shared workspace until
this shipped.

## Decision

### D1 — acting as a member intersects with the caller

The access a request acts with is the named member's access INTERSECTED with the
caller's own (`host/actingAccess.ts`, `narrowToCaller`):

- scopes: the member's scopes the caller also holds;
- roles: the member's roles the caller also holds — or all of them when the
  caller is an owner, who may wear any member's roles.

Naming someone with less narrows, which is what the lens is for. Naming someone
with more yields nothing the caller did not already hold. The five readers share
three functions — `callerOrgAccess`, `callerTenantAccess`, `actingAccess` —
instead of each deriving "who is the caller" its own way.

Alternatives weighed:

- *Allow act-as only for owners and admins.* Simpler to state, but it keeps the
  "named member's access alone" semantics for them, so an admin naming the owner
  still becomes owner. Intersection needs no list of who may use the header.
- *Remove the header.* It is a real product feature (view as a member) and the
  SPA sends it. Narrowing keeps the feature and removes the escalation.
- *Derive the lens from a server-side "viewing as" session state.* Better
  long-term (a header a client sets is a strange place for it); a larger change
  than closing the hole needs.

### D2 — ownership is granted, changed and removed only by an owner

On the member, group and invite routes, a request that would add `owner` to
anyone, change or delete a member who is an owner, transfer ownership, create or
change or delete a group whose roles include `owner`, or invite an owner,
requires the acting access to hold the `owner` ROLE (or a superadmin, the
break-glass). `host:members:manage` alone is no longer enough.

"Change a member who is an owner" is any field, not only roles: re-pointing the
owner row's `subject` hands the role to someone else.

### D3 — the CDP admin check resolves the caller (`KEY-19`)

`requireAdmin` reads `callerTenantAccess` (the caller's memberships, plus the
single-principal exit) narrowed by act-as. It never passes `{}`.

## Not changed

- `GET /access/effective?memberId=` (and the same route under act-as) still
  reports a named member's scopes. It is a read of what a member can do, used by
  the admin screens; it grants nothing.
- An `owk_` API key presenting the header is refused outright by the API-key
  authority work in flight beside this (branch `feat/key-authority`). This ADR
  is about signed-in sessions.
- A custom role cannot carry the reserved management scopes (existing rule), so
  D2 is not reachable through a role definition.

## Risks

| Risk | Mitigation |
|---|---|
| The lens stops working for an admin viewing as someone | Pinned: an Owner viewing as a Viewer is denied what a Viewer is denied, with `actingAs` in the refusal |
| An admin who legitimately managed owners is now refused | Intended; the message names the rule (`owner_required`). A workspace with no reachable owner has the superadmin break-glass |
| A sixth reader of the header appears and resolves the member alone | The three functions are the only exports a route needs; `ACT_AS_HEADER` has no reader left outside `actingAccess.ts` and the CORS allow-list |

## Implementation record

| Decision | What | Witness |
|---|---|---|
| D1 | `host/actingAccess.ts`; `requireScope` (`routes/accessControl.ts`), `requireMemberManage` (`features/orgs`), `requireEnvScope`, `requireEntitiesScope` | `test/adr0797-act-as-narrows.test.ts` § "act-as narrows" (4), § `narrowToCaller` (2) |
| D2 | `requireOwner` on member create/patch/delete, transfer-ownership, group create/patch/delete; the invite route | § "only an owner…" (9) |
| D3 | `features/cdp/routes.ts` `requireAdmin` | § "KEY-19" (2) |

With narrowing and the owner rule removed, 8 of the 13 route tests that existed
at that point fail. The 482 existing test files that touch access control, orgs,
invites, CDP, environments or entities pass unchanged.

## Open questions

- [ ] CE-8's second finding has two halves. A removed member's API keys are
      handled by the API-key authority work in flight (`feat/key-authority`). A
      removed admin's PENDING INVITE staying redeemable is not handled anywhere yet.
- [ ] Move "viewing as" from a client header to server-side session state.
- [ ] Should removing the last admin, or an admin removing another admin, carry
      a rule of its own?
