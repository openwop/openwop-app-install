# ADR 0888 — Profiles: one directory resolver for route and run, a team-view projector, and the byte exits of retention

Status: implemented (2026-10-14, #4800 → `8c5234497`; Accepted after the adversarial /architect pass — see § Review dispositions)

Feature: `profiles` (ADR 0005), extension — no toggle (always-on since 2026-06-12).
Feature loop 2026-10 row 45. Findings `PR2WF-1..4` in
`docs/steward/WORKFLOWS-ASSESSMENT.md` (row 45 section), each proved RED on
`origin/main` @ `482da8a52` by `backend/typescript/test/profiles-fl2-45-probes.test.ts`.

## Context

Round 1 graded profiles A / A / A. Re-measured, two defects sit on the read side, and
both come from the same missing piece: **nothing decides, in one place, which people a
reader may see.**

1. **The directory is empty in a shared workspace.** `GET /profiles` lists
   `listProfiles(resolveCallerUser(req).tenantId)`. For an OIDC user that is the
   caller's HOME tenant (`user:<hash>`, `usersGuards.ts:87-101`), never the active
   `ws:` workspace. Profiles are stored in each member's home tenant
   (`getOrCreateProfile(user.tenantId, …)`), so no profile row has `tenantId = ws:T`.
   PROBE (production identity path: personal login → root member → `/switch`): Alice's
   directory in `ws:T` is `[]` and does not contain her co-member Bob. `/team`,
   endorsements, and `GET /profiles/:id` are all dead in every shared workspace, which
   is where a team directory is supposed to be useful.
2. **The run lane has no predicate.** `ctx.features.profiles` (`surface.ts`) serves
   `listProfiles(scope.tenantId)` to any run: no acting user, an actor who is not a
   member, an actor disabled before a suspended run resumed. The route refuses all
   three. PROBE: `buildProfilesSurface({ tenantId })` and
   `{ actingUserId: 'user:stranger' }` both resolve. It also reads a DIFFERENT tenant
   than the route (the run tenant, not the home tenant), so the two lanes disagree about
   whose directory they show.
3. **Peers see private preferences.** The team view (`viewProfile`) and the surface
   project `pinnedAgentIds`, `pinnedChatAgentIds` and `knowledge.collectionIds` (private
   KB pointers, ADR 0042) to every co-member and into every run's event log. PROBE RED.
4. **Retention leaves the face online.** The ADR 0081 retention purger deletes the row
   and the KB doc but never releases the avatar/portfolio byte refs, while the DSAR
   eraser does (review F1). PROBE: after `purgeRetained` and the scratch window, the
   avatar token still serves 200.
5. **An avatar can be a type the exit will not render.** `requireImageToken` accepts any
   `image/*`; `assetServeHeaders` (ADR 0818) serves only raster types inline, so a TIFF
   or HEIC avatar is stored and then renders as a broken image everywhere.

Sound on probe and NOT changed here: anon/apikey callers (401 via `resolveCallerUser`),
cross-tenant by-id reads (404), link XSS (`safeUrl` at write; links are never rendered
as an href), upload types (svg/html excluded, ADR 0818 exit headers), DSAR of the row,
bytes, peer endorsements and the Team Portfolio KB doc. There is no profiles chat tool.

## Prod exposure (read-only, user-approved, 2026-10-14)

- `PR2WF-1` (the ungated run lane) was **latent, never exercised**: 0 run events mention
  `feature.profiles.nodes` out of 193,574 events (2026-01-15 → now), and 0 stored
  workflow definitions reference it. A floor query with the same text match on
  `core.` returns hits, so the zero is a real zero, not a broken match.
- Prod holds 28 profile rows across 4 tenants. This also supports the "zero chain
  consumers" basis for the pack 1.2.0 bump (D3).

## Boundaries audit

- **Membership has one owner:** `accessControlService` — `isWorkspaceMember(subject,
  ws)` (the predicate the auth middleware already runs per request,
  `middleware/auth.ts:1304`) and `listWorkspaceRootMembers(ws)` (bounded per-tenant
  index, `accessControlService.ts:950`). This ADR composes both; it adds no member
  store.
- **Identity has one owner:** `usersService`. The join from a member to a profile is
  `getUser(member.subject)` — an EXACT `userId` point read. Never
  `getUserByPrincipal` across tenants: principal ids are not issuer-qualified, so
  `scim:jsmith` in `ws:T` may be a different human from another tenant's `scim:jsmith`
  (row 8 / ADR 0780 lesson). A member whose subject is not a `userId` (an unbound
  `oidc:<sub>` row, re-keyed to `user:` on bind) is skipped, not aliased.
- **Run-lane precedent:** `features/users/surface.ts` (actor required, live per ADR
  0621 `resolveSessionSubject`, named exit for system runs) and
  `features/comments/surface.ts` (`forbidden_scope` with a named exit). The
  single-principal shortcut follows `assertRunOrgScope` (`accessControlService.ts:661`):
  a `user:`/`anon:` tenant has one principal, so an actor there is its owner.
- **Exit guard:** `host/assetServeHeaders.ts` `INLINE_SAFE` is the one list of types a
  browser renders. The avatar check reuses it instead of keeping a second list.
- No route collision: every route stays under `/v1/host/openwop-app/profiles/*`.

## Decision

### D1 — One directory resolver, and a workspace sees only people who chose to be seen

> **Revised before code (architect pass, see § Review dispositions).** The first draft
> joined every workspace-root member to their home profile. That published every
> member's bio, location, links and asset tokens to every workspace they belong to —
> including the auto-join feature workspaces (`host-kicktodo`), where "co-member" means
> every signup — and it wrote cross-tenant endorsements that erasure could not reach.

A new module `features/profiles/directory.ts` owns the answer to "whose profiles may
this reader see". Both lanes call it.

```ts
type DirectoryScope =
  | { kind: 'home'; tenantId: string }        // the reader's own home tenant
  | { kind: 'workspace'; workspaceId: string }; // a shared workspace the reader is a member of
```

**Which branch.** Not the `ws:` id prefix — feature default workspaces such as
`host-kicktodo` are workspace roots without it. The rule is: the active tenant is the
reader's HOME tenant → `home`; otherwise the reader must hold the workspace-root
membership of the active tenant (`isWorkspaceMember`) → `workspace`; otherwise the
route falls back to the reader's `home` directory (exactly what it served before this
ADR — it names nobody outside that tenant), and the run lane refuses (`not_a_member`).

- **Route:** home tenant = `resolveCallerUser(req).tenantId` (this also keeps anon and
  apikey refused); the membership subject = `callerSubject(req)`, the subject the auth
  middleware itself admits with (`middleware/auth.ts:1304`).
- **Run:** the acting user is REQUIRED and must be a durable human: a `user:` id whose
  ADR 0621 session state is `active` (`resolveSessionSubject`). Its home tenant is
  `getUser(actor).tenantId`; the membership subject is the actor. Anything else — no
  actor (`no_acting_user`), an `apikey:`/`session:`/unbound principal
  (`not_a_durable_user`), a disabled or erased user (`acting_user_disabled`), a
  non-member (`not_a_member`) — is `forbidden_scope` with that reason and an exit
  ("start the run from a signed-in user's context").

Route and run therefore decide with the same two facts (home tenant, root
membership) for the same human.

**The workspace directory is opt-in per person, per workspace.** A profile gains
`sharedWorkspaceIds: string[]` (owner-only, never projected to peers), written through
`PUT/DELETE /profiles/me/workspace-share` on the `/me` lane for the ACTIVE workspace
(the caller must be its root member at the time). A share row
`profiles:ws-share` keyed `${workspaceId}|${userId}` (tenant index = the workspace id)
records `{ workspaceId, userId, memberSubject, sharedAt }`, where `memberSubject` is the
subject that proved membership at share time (it can differ from the canonical
`userId` — the M6 split; membership is re-checked with the subject it was proved
with). The profile row is the source of truth; the share rows are the bounded index.

A `workspace` read lists share rows via `listForTenantIndexed(workspaceId)` — bounded
by the number of people who opted in, never by the member count — re-checks each
`isWorkspaceMember(memberSubject, workspaceId)` and `getUser(userId).status === 'active'`,
and reads the profile with the existing tenant-guarded `getProfile(user.tenantId,
userId)`. Capped at 500 rows with `truncated: true`. A member who left, was disabled,
or un-shared disappears on the next read. Nobody is ever listed without having opted
in, so an auto-join workspace cannot become a directory of every signup.

`GET /profiles/:id` and `getProfile` in a workspace answer only for a person whose
share row exists and re-verifies; otherwise 404 / `found:false` — the same rule as the
list, so no existence oracle.

**Endorsements stay home-tenant only.** In a workspace scope the endorse routes refuse
with `409 endorse_unavailable_here`, and the projection carries `count` with an empty
`endorserUserIds` (the ids are home-tenant people). This removes the cross-tenant write
and its erasure-reach hole; a workspace endorsement store is a follow-up (OQ-5).

**Erasure.** The profile eraser deletes the subject's share rows (read
`sharedWorkspaceIds` before deleting the row), and an erasure run in a workspace tenant
deletes that workspace's share row for the subject (`${ws}|${subject}`). Leaving a
workspace needs no write: the read-time membership re-check hides the row. The row
is KEPT, so a person who leaves and is re-admitted is listed again without a new
share — their recorded choice for that workspace stands until they withdraw it (a
"Shared with" list on `/profile` to see and withdraw old shares is `PROF2UX-7`,
filed).

### D2 — One team-view projector

`viewProfile` (the route's peer view) and the surface's projection become one function,
`projectTeamProfile`, which emits an ALLOWLIST of descriptive fields: `userId`,
`preferredName`, `jobTitle`, `department`, `bio`, `contact`, `avatarAssetToken`,
`portfolioAssetTokens`, `skills`, `equipment`, `availability`, `interests`,
`growthInterests`, `workflows`, `completeness`, `createdAt`, `updatedAt`, and the
surfaced `displayName`/`emailVerified`. In a `workspace` scope `workflows` is dropped
(home-tenant workflow ids do not resolve there) and `endorserUserIds` is empty (D1).
An allowlist, not a denylist, so a field added
to `Profile` later is private until someone decides otherwise (the "validator
allowlists drop new fields" lesson, applied in the safe direction). The `/me` lane
(`viewOwnProfile`) keeps the full row: pins, knowledge and `completenessMissing` are the
owner's, and so is `sharedWorkspaceIds`.

**The run lane records less (architect M8).** A node's output is recorded into the run
log and replayed on `:fork`; a person's later erasure does not rewrite another run's
history. So the SURFACE projection is the team allowlist minus the declared-PII and
bearer fields: no `bio`, no `contact`, no `avatarAssetToken`/`portfolioAssetTokens`.
It keeps what the ADR 0005 surface exists for — capability (skills, title, department,
equipment, interests, availability). The surface keeps its viewer-independent
endorsement shape (`count` + `endorserUserIds`, no `endorsedByMe`) for replay.

### D3 — The run lane rides D1

`buildProfilesSurface` calls `resolveRunDirectory(scope)` on every method, so the route
and the run see the same people. The pack is unchanged (`role: action`, recorded; a
`:fork` is served the recorded output). The pack description gains the refusal.
Blast radius: zero chain packs consume `feature.profiles.nodes` (verified both ways).

### D4 — Retention releases what it un-references

The ADR 0081 purger's delete callback releases the purged row's avatar and portfolio
tokens after the row delete, through the same `releaseProfileByteRef` the eraser uses,
so a co-referenced token survives. The callback receives only an id, so it reads the
row first and releases only when `store.delete` returned true.

### D5 — Avatar and portfolio are inline-renderable rasters only

`assetServeHeaders.ts` exports `isInlineImageType(contentType)` (the `image/*` half of
`INLINE_SAFE`, normalised exactly as `assetServeHeaders` normalises: split on `;`,
trim, lowercase); `requireImageToken` uses it. Already-stored non-raster references are
left alone (they render broken, as today); a backfill is not worth a migration. A type the exit would download as an
attachment is refused at the reference write with a 400 that names the allowed types.

## Alternatives weighed

- **List every workspace member (the first draft).** Rejected in review: it publishes
  every member's profile to every workspace they belong to, including auto-join
  feature workspaces, with no consent, and costs O(members) reads per request.
- **Store a profile copy per workspace (Slack-style per-workspace profiles).** Honest
  per-workspace privacy, but forks the data, doubles DSAR reach, and breaks every
  existing consumer of `getProfile(userId)`. Rejected; the profile is the person's,
  shown to the people they work with.
- **Alias the member subject to a user by principal.** Rejected: confused deputy across
  issuers (row 8).
- **Keep the run lane open for system runs** (CRM's "no viewer ⇒ unfiltered"). A
  scheduled digest is a legitimate consumer, but the user schedule path already stamps
  `actingUserId` (ADR 0816 D8), so only webhook/event-started runs lose access, and
  those have no human whose membership could be checked. Comments and users made the
  same call.
- **Only fix the empty directory with copy** ("the directory shows your home tenant").
  Rejected: it documents a broken feature instead of fixing it.

## RFC verdict

Host-extension only. Routes stay under `/v1/host/openwop-app/profiles/*`; the surface is
a host feature surface (ADR 0014). No wire change, no new capability, no RFC.

## Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `features/profiles/directory.ts` (new), `routes.ts`, `surface.ts`, `profilesService.ts`; core gains one exported predicate in `host/assetServeHeaders.ts` |
| 2 | Toggle | none (always-on) |
| 3 | `ctx.profiles` | same two reads, now floored by D1; projection narrowed (D2) |
| 4 | Node pack | `feature.profiles.nodes` 1.1.1 → **1.2.0**, nodes 1.1.0 → 1.2.0 (outputs LOSE `bio`/`contact`/asset tokens, and both nodes gain a typed `forbidden_scope` failure; zero chain consumers) |
| 5–6 | Envelopes / agent pack | none |
| 7 | Public surface | none |
| 8 | RBAC | read = home tenant, or root member of the active workspace AND the target opted in; endorse = home tenant only; share = self, root member of the active workspace |
| 9 | Replay | surface `role: action` recorded; membership read at execution time only |
| 10 | Frontend | `profilesClient.ts` splits `TeamProfile` from `MyProfile`; `/team` in a workspace shows the opted-in members, a "Share my profile with this workspace" control for the viewer, and no endorse affordance |

## Phased plan

1. D2 projector + D4 + D5 (backend, tests).
2. D1 resolver + share index + route lanes (directory, by-id, endorse refusal, share/unshare, erasure).
3. D3 surface + pack description bump.
4. Frontend type split; `/grade-ux`, `/grade-code`.

Each phase's probe moves from the RED probe file into
`test/profiles-adr0888-directory.test.ts`, with a sabotage check per decision.

## Open questions

- [x] OQ-1 Cross-workspace exposure — DECIDED (D1): opt-in per person per workspace.
  The first draft's premise ("today's team view already shows them to co-members") was
  false: an OIDC user's home tenant holds one person. Per-FIELD visibility inside a
  share is a follow-up; the share is all-or-nothing for the team allowlist.
- [ ] OQ-2 Production's planner (`features/production/*`) still ranks
  `listProfiles(tenantId)` and is empty in a workspace (`PR2WF-4`). Routed to the
  production row; it should call `resolveRunDirectory`.
- [ ] OQ-3 Team Portfolio KB indexing stays per home tenant. A workspace-level index is
  the production row's call, with OQ-2.
- [ ] OQ-4 Unbound members (`oidc:<sub>` subjects) are skipped until they bind. The
  number of such rows in prod is not known (needs a prod read).
- [ ] OQ-5 Workspace endorsements (refused in a workspace scope by D1). A design that
  stores them in the workspace tenant, where that tenant's erasure reaches them.

## Review dispositions (adversarial `/architect`, before code, 2026-10-14)

| # | Finding | Disposition |
|---|---|---|
| C1 | Cross-tenant endorsement writes would escape erasure (`stripEndorsementsBy` scans one tenant) | ACCEPTED — endorsements refused in a workspace scope (D1, OQ-5) |
| H2 | `ws:` prefix misses feature default workspaces (`host-kicktodo`) | ACCEPTED — branch on home-vs-membership, not on the id shape (D1) |
| H3 | Premise "co-members already see it" is false; auto-join workspaces = every signup | ACCEPTED — opt-in share per workspace (D1, OQ-1) |
| H4 | O(members) reads per request | ACCEPTED — the list is bounded by opt-ins via the share index, capped at 500 with `truncated` |
| M5 | Run lane admitted `apikey:`/`session:`/unbound actors the route refuses | ACCEPTED — durable `user:` actor, active, required (D1) |
| M6 | Member subject vs canonical `userId` may differ | ACCEPTED — the share row stores the subject that proved membership and re-checks with it |
| M7 | Event and audit in different tenants | MOOT — no workspace endorsement write |
| M8 | Recorded node output copies PII into run logs erasure cannot reach | ACCEPTED — surface projection drops bio, contact and asset tokens (D2) |
| L9 | `workflows` ids foreign in a workspace | ACCEPTED (D2) |
| L10 | endorser-id filter coherence | MOOT — empty in a workspace |
| L11 | D5 normalisation; D4 capture-before-delete | ACCEPTED (D4, D5) |
| L12 | read-only "other tenant" run branch | MOOT — the branch is now home-or-member only |

### Grade-pass dispositions (`/grade-code` + `/grade-ux`, 2026-10-14, after implementation)

| # | Finding | Disposition |
|---|---|---|
| PROF2CD-1 (High) | Each departed sharer cost a deployment-wide member scan per read (the auth predicate's authoritative-"no" fallback) | FIXED — one bounded `listWorkspaceRootMembers` read per request; witness spies `access-members` `list()` = 0 calls; sabotage red |
| PROF2CD-2 | share/unshare race could leave an index row the profile does not list | FIXED — the share re-reads the profile after the row put and withdraws a row the profile no longer lists |
| PROF2CD-3 | stored `memberSubject` goes stale when a bind re-keys the member row | FIXED — a row is live under the stored subject OR the person's `userId`; witness + sabotage red |
| PROF2CD-4 | route skipped orphans, run lane did not | FIXED — one `listHomeDirectory`; by-id orphan is 404 on both lanes |
| PROF2CD-5 | misleading refusal text for unbound bearer actors | FIXED — message names that case; still refused (no principal aliasing) |
| PROF2CD-6 | `preferredName`/`displayName` recorded in run output | ACCEPTED RESIDUE — a name is the minimum a "who has skill X" chain needs; erasure of run history is the run-retention lane's, not this surface's |
| PROF2CD-7 | `sharedByMe` from the capped list; repeat share resets `sharedAt` | FIXED — read from the reader's own profile; repeat share keeps the first `sharedAt` |
| PROF2CD-8 | un-share materialises an empty profile row | FILED — harmless (the same lazy row `GET /me` creates) |
| PROF2CD-9 | ADR "re-proves membership" + `get` description text | FIXED (D1 erasure paragraph; pack `get` description) |
| PROF2CD-10 | removing output fields under a patch bump; 409 vs 400 for share outside a workspace | FIXED (1.2.0) / FILED (409 kept: the request is valid, the caller's STATE is wrong) |
| PROF2CD-11 | home list unbounded | FILED — pre-existing, not changed here |
| PROF2UX-1 (High) | share control did not say where or what it publishes | FIXED — workspace name + field list before the first share |
| PROF2UX-2 (High) | no success feedback, focus lost, stale label | FIXED — toast, awaited re-read, focus returns to the control |
| PROF2UX-3 (High) | read-only chips had pointer + hover | FIXED — hover scoped to `button.`; `--static` modifier |
| PROF2UX-4 (High) | endorsement copy pointed at an impossible action, wrong nouns | FIXED — "not available in shared workspaces yet", locale nouns, said once |
| PROF2UX-5/-8/-9/-11 | glued sentences; bare count to SR; loading prop; per-card repetition | FIXED |
| PROF2UX-6 | `sharedByMe` past the cap | FIXED (with PROF2CD-7) |
| PROF2UX-7 | no "Shared with" list on `/profile` | FILED — follow-up; the D1 text states the kept-row behaviour |
| PROF2UX-10 | thin FE tests | PARTIAL — empty-state share + disclosure + read-only chips + said-once covered |
| PROF2UX-12 | filters see only the first 500 | FILED |

### Re-check dispositions (second `/architect` pass + team-lead notes, 2026-10-14)

| # | Finding | Disposition |
|---|---|---|
| H5 | Per-row `isWorkspaceMember` ⇒ a deployment-wide scan per stale row; cap before filter | FIXED with `PROF2CD-1`: one `listWorkspaceRootMembers` read per request; the 500 cap applies AFTER the live filter |
| Join key (lead #1) | Which field joins a share to a person; two-IdP collision | The join is the share row's `userId` (the canonical user the SHARER resolved, written by them). A member row's `subject` is only ever compared, never mapped to a user. Membership matches only `user:` spellings (the stored bound id, or the canonical `userId`); a principal-shaped `memberSubject` is ignored, and the share route refuses an unbound caller (`409 account_not_bound`). Witness: X's row carrying `scim:jsmith` is NOT listed when a different IdP's `scim:jsmith` is a member; sabotage red |
| Agent-id spellings (lead #2) | Strip both ADR 0763 spellings of pinned ids | MOOT — the team view is an allowlist; `pinnedAgentIds`/`pinnedChatAgentIds` are dropped wholesale whatever they hold |
| System-run exit (lead #3) | Must fail closed; ratchet a new surface method | Fails CLOSED: typed `forbidden_scope` + `reason`, the node returns `status:'failure'` with NO outputs. `EXECUTOR_CTX_POLICY` already gates the `features` key as a whole (`surfaces.features`), so the per-method guarantee is a profiles ratchet: every key of `buildProfilesSurface(...)` must refuse a no-actor run (sabotage: an added ungated method reds it) |
| Byte release seam (lead #4) | One release path | D4 calls the eraser's own `releaseProfileByteRef` → `releaseByteRef`; no second path |
| M — erasure key | A workspace erasure keyed by the bound id missed the row | FIXED — `eraseWorkspaceShare` matches `userId` OR `memberSubject` over that workspace's own bounded index; witness + sabotage red |
| M — index repair | The profile list must never resurrect an erased share | STATED: the `profiles:ws-share` index is NEVER rebuilt or repaired from `sharedWorkspaceIds`. The profile list is the erasure source of truth for the HOME eraser only; nothing writes a share row except an explicit `PUT /me/workspace-share` |
| M — unbound share vanishes after bind | | FIXED by refusing an unbound share (above) |
| M — run-lane parity for unbound bearer clients | | STATED, deliberate narrowing: a run whose actor is an unbound `oidc:` principal is refused (`not_a_durable_user`) even in its home tenant, because resolving it to a user would alias a principal. The HTTP route still serves it (it canonicalises inside the caller's own personal tenant). |

## Implementation record

| Phase | Decision | Landed | Witness (each sabotage-checked red) |
|---|---|---|---|
| 1 | D2 allowlist projector, D4 retention byte release, D5 inline-raster avatar | #4800 | `profiles-adr0888-directory.test.ts` — peer view is an allowlist; retention reclaims the avatar bytes; `isInlineImageType` |
| 2 | D1 resolver, share index, route lanes, endorse refusal, erasure | #4800 | opt-in listing; un-share; departed member; `host-*` root; two-IdP; erasure (home + workspace, by either key); PROF2CD-1 scan spy |
| 3 | D3 run lane + pack 1.2.0 | #4800 | no-actor / API key / non-member / disabled refusals; route≡run people; per-method surface ratchet; `profiles-node-through-surface.test.ts` typed failures |
| 4 | Frontend `/team` workspace scope + grade fixes | #4800 | `teamDirectoryFailedRead.test.tsx` workspace cases |

Gate: `npm run ci` GREEN on `c06485c70` (backend 2557, frontend 1009); merged by `scripts/merge-train.sh 4800` (main's tree = the gated tree).

