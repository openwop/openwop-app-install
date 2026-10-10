# ADR 0842 — Priority Matrix: the run lane asks who started the run, the score trail keeps ballots secret, and a project's agenda stays the project's

Status: **implemented** (2026-10-06, feature loop round 2 row 26 — this PR)

Extends **ADR 0058** (Priority Matrix), **ADR 0059** (multi-voter), **ADR 0610** (project-bound
lists, `projectReadable`), **ADR 0667** (scoring honesty, kanban co-ownership) and **ADR 0839**
(projects: absent caller, delete dependents). Follows the run-lane precedent of **ADR 0597
§Correction 1** (strategy) and **ADR 0838 D3** (documents). Feature loop round 2, row 26. Gap ids
`PMX4WF-1..9` in `docs/steward/WORKFLOWS-ASSESSMENT.md` § "Priority Matrix — feature loop round 2
(row 26)".

## Context

Priority Matrix rows are reached through four lanes: the HTTP routes, the Prioritization
Analyst's agent tools, the workflow surface (`ctx.features['priority-matrix']`, which the
`feature.priority-matrix.nodes` pack calls) and the managed KB. The it.22 pass graded the routes
("all 40 handlers gated … PASS") and that is still true. **It is a property of one door, not of
the rows.** Measured on `c790b4127` (`test/adr0842-priority-matrix-access.test.ts`, six legs born
red, one control green):

1. **The run lane is tenant-trusted for a human-started run (`PMX4WF-1`).**
   `buildPriorityMatrixSurface` (`surface.ts`) resolves every verb by `tenantId` alone. An
   org-A-only editor who runs a workflow reads org-B list names, idea titles, portfolio rows and
   intake, and scores, files, annotates and plans on the org-B list. The route and the agent tool
   both refuse the same person. The surface's own justification — "a run is tenant-trusted" — is
   the premise ADR 0597 §Correction 1 falsified for strategy: `BundleScope.actingUserId` is the run
   owner's durable principal for every human-started run, absent only for system runs
   (`host/inMemorySurfaces.ts:253-264`). Viewers cannot start runs, so the reach is cross-org (and
   any future rule that narrows a project below org-write).
2. **Vote secrecy is bypassed through the score trail (`PMX4WF-2`).** ADR 0059 keeps per-voter
   ballots behind config authority (`GET …/votes`: list creator or `host:org:manage`; "members see
   only aggregate + their own vote"). `GET …/score-history` needs only `workspace:read` and returns
   every `IdeaScoreChange` verbatim — `voterId`, `actor`, and the voter's per-criterion `scores`.
3. **A private project's planning agenda is org-readable and outlives the project
   (`PMX4WF-3`).** `createPlanningSession` composes the `board-agenda` Document with no
   `ownerSubject`; `canReadDocument` answers `true` for an unowned document, and ADR 0839's
   project-delete cascade takes documents by exact `ownerSubject`, so it never reaches it.
4. **The agent write tools skip the project gate the route applies (`PMX4WF-4`).** Equivalent
   today only because `createList` pins `project.orgId === list.orgId` and org-write implies
   project-write; when the seam answers `'none'` (a dangling project, a future rule) the route
   404s and the tool writes.
5. **An idea delete strands its intake, evidence and score trail (`PMX4WF-5`)** — names, emails,
   voter ids — until the whole list goes. ADR 0667 D5 named intake + evidence for the card hook;
   neither the hook nor `deleteIdea` does it.
6. **The kanban card-delete hook and board claim scan every tenant's lists** on every kanban
   delete (`PMX4WF-8`, part).

## Boundaries audit

- **One predicate already exists, split across two files.** `orgScopeGranted` (`routes.ts:50`,
  imported by `agentTools.ts`) and two copies of the project-membership check (`routes.ts:84`
  `projectReadable`, `agentTools.ts:91` `listProjectReadable`). No new seam is needed; the two
  copies are folded into one module and the surface becomes its third caller.
- **The run-person rule is settled in-tree.** Strategy (`strategy/surface.ts:81`) keys on
  `scope.actingUserId` and keeps `true` for a subjectless run; documents (`documents/surface.ts:47`)
  does the same with `actingUserId ?? orgScopeSubject`. This ADR follows strategy (actor only):
  `orgScopeSubject` is "membership only, never a grant" (ADR 0832 D3) and a write gate is a grant.
- **Documents already model project ownership** (`ownerSubject: {kind:'project'}` validated
  against the derived org, `documentsService.ts:271-290`); the cascade is ADR 0839's.
- **Config authority** is `requireListConfigAuthority` (`routes.ts:99-104`); D2 needs its boolean
  form, not a new rule.
- **No route, toggle, pack, envelope or capability changes.** Host-extension only.

## Decision

**D1 — one list-access module; the run lane is its third caller.** New
`features/priority-matrix/listAccess.ts` owns `orgScopeGranted`, `listProjectReadable(tenantId,
list, subject)`, `canReadList` (org `workspace:read` + project read) and `canWriteList` (that +
org `workspace:write`). Routes, agent tools and the surface all import it; the local copies are
deleted. In the surface, a run WITH `scope.actingUserId` is gated exactly like the route:

- an unreadable list behaves exactly like a missing one (no existence leak): `listRankedIdeas` and
  `getScheduleStatus` throw the same `not_found` a bogus id throws; `getIntake` returns the same
  `{intake:null, evidence:[]}`; `listLists`/`listPortfolio` omit the list;
- a write verb (`submitIdea`, `scoreIdea`, `updateIntake`, `addEvidence`, `generateAgenda`,
  `proposeScenario`) on a list the actor cannot write throws `not_found` when it cannot read it and
  `forbidden_scope` when it can read but not write — the route's 404/403 split.

A run WITHOUT an actor (schedule-less system job, inbound webhook — the `forms-intake` chain) stays
tenant-trusted, unchanged; the `expectedOrgId` write-boundary guard on `submitIdea` is unchanged.
**Ratchet:** the test enumerates `Object.keys(buildPriorityMatrixSurface(...))` and requires every
verb to be classified (gated-read / gated-write / list-free); a new verb fails until it is.

**D2 — the score trail redacts other voters below config authority.** `GET …/score-history`
returns, for a caller WITHOUT config authority, every row's priority movement and timestamp, and
for multi-voter rows (`voterId` present) whose voter is not the caller: no `voterId`, no `actor`,
no `scores`. The caller's own rows and single-mode rows are unchanged (the single-mode score is the
shared row the list already shows). Config authority sees the trail verbatim. The redaction is a
pure function in `scoreHistory.ts` (`redactTrailFor`), applied at the route — the one exit; no
other lane exposes the trail.

**D3 — a project-bound list's agenda Document is owned by the project.** `createPlanningSession`
passes `ownerSubject: {kind:'project', id: list.projectId}` when the list is project-bound, so
`canReadDocument` applies the membership gate and ADR 0839's cascade takes it with the project.
Org-scoped lists are unchanged. **Legacy rows:** sized from prod before deciding (see Open
questions); no migration ships if the count is zero.

**D4 — agent write tools apply the project gate** via `canWriteList` (D1), returning `not_found`.

**D5 — an idea delete takes its per-card overlays.** `deleteIdea` and the kanban card-delete hook
both call new per-card sweeps: `deleteIntakeRowsForCard(listId, cardId)` (intake + evidence) and
`deleteScoreChangesForCard(tenantId, listId, cardId)`. Idempotent (the hook also runs on PM's own
deletes).

**D6 — the kanban hooks resolve the tenant first.** The card hook and board claim resolve the
board's `tenantId` (`getBoard`) and list only that tenant's lists (`listLists(tenantId)`, a prefix
read), instead of `lists.list()` over every tenant.

**D8 — the comments lane asks the project too (added by the pre-code review, finding A1).** The
`priority_idea` comment-target validator (`features/comments/commentsService.ts:119-131`) checks
the list's tenant + org and ignores the `caller` it is handed, so an org viewer who is not a member
of a private project can open a thread on that project's idea and receives the idea's title as the
thread target. It now applies `subjectReadAllowed(tenantId, {kind:'project', id: list.projectId},
caller)` for a project-bound list — the KBC-1 rule (`preAuthorized` passes, an absent subject is
refused, `null` falls through) — and is unchanged for an org-scoped list.

**D9 — list reads project what the caller may do (added by the `/grade-ux` pass, `PM4UX-1`).**
`GET …/lists` and `GET …/lists/:id` carry `viewer: { canWrite, canConfigure }`, computed by the
same predicates the doors enforce (`workspace:write` in the list's org; list creator or
`host:org:manage`). The page hides every control whose only outcome would be a 403 (DESIGN.md
"403 ⇒ hidden"). A projection, never authority — every door still re-checks, and a test proves a
viewer's write is refused at the door regardless. Chosen over a fourth client-side
`use*OrgAccess` hook because config authority depends on `createdBy`, which only the server
compares honestly, and a project-bound list's answer depends on the project seam.

**D10 — strategy links ask the project too (added by the `/grade-code` adversarial review).**
`strategyService.resolvePriorityLinkTarget` — the ONE resolver strategy's context, health and
timeline projections share — checked `canReadOrg(list.orgId)` only, and the link route's
`requireLinkTargetScope` did the same. So a private project's idea title, priority and rank
reached an org viewer who is not a member through `/strategy/:id/context`, `/health`, the
timeline, the strategy surface and its agent tools, while PM's own five lanes refused that person.
The resolver now also asks `listAccess.listProjectReadable` for a REAL caller; an actorless lane
keeps the org answer (the strategy surface's documented tenant-trusted fallback), mirroring D1.
The ADR's first draft counted "five lanes" and the workflow grade read only PM's directory — the
sixth lane lived in strategy, which reads PM rows through PM's service, and only a reviewer
grepping for `getList(` outside the feature found it.

**D7 — contract hygiene (`PMX4WF-9`).** The score tool's description states the merge semantics;
the stale `weightedScoring.ts` docblock lines are corrected; the 200-session cap gets a test.

## Alternatives weighed

- **Keep the surface tenant-trusted and document it.** Rejected: the route, the agent tool, the
  KB and the strategy surface one feature over all refuse the same person. Two lanes of one
  feature disagreeing about the same rows is the exact shape ADR 0597 §Correction 1 closed.
- **Gate the run lane on `actingUserId ?? orgScopeSubject` (documents' choice).** Rejected for
  writes: the causing member did not start the run, and the ADR 0832 ratchet forbids a grant on
  `orgScopeSubject`. Using it only to narrow READS of actorless runs would change the
  `forms-intake` bridge for no measured reach; recorded as a residual.
- **Drop multi-voter rows from the trail entirely for non-authority readers.** Rejected: the
  priority movement ("why did this rank change", ADR 0234 §C7) is aggregate data members are
  entitled to; only identity + ballot are secret.
- **Delete agenda Documents with their list.** Rejected for this ADR: an agenda is a meeting
  record owned by Documents, and an org-scoped list's agenda is legitimately org-readable. For a
  project-bound list D3 makes the project cascade take it. Stated as a product decision.
- **Re-key the score trail to `${listId}::${cardId}::…` to make reads prefix-scans (`PMX4WF-8`).**
  Deferred: an id-scheme change over 129 prod rows for a non-measured cost.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | All inside `features/priority-matrix/`; one new module (`listAccess.ts`). No core edits. |
| 2 | Toggle | Unchanged (`priority-matrix`, ON). |
| 3 | Workflow surface | D1 — gated by the run's actor; system runs unchanged. |
| 4 | Node pack | No change (behaviour of the surface it calls changes; no version bump — no manifest change). |
| 5 | AI-chat envelopes | None. |
| 6 | Agent pack | No manifest change; D4 + D7 change tool behaviour/description only (description is host code, `agentTools.ts`). |
| 7 | Public surface | None. |
| 8 | RBAC | D1/D2/D4 — the point of the ADR. |
| 9 | Replay / fork | Node outputs are recorded; replay reads them verbatim. A `:fork` re-executes post-fork nodes under the run's re-stamped `actingUserId` — the person who FORKED, who may differ from the original starter — so the gate answers for whoever is causing the new writes. That is the intended rule, not drift: a fork is a new act. |
| 10 | Frontend | D9 gates every write control on the server projection; the score-history view only counts rows (verified: never reads `scores`/`actor`/`voterId`), and the client type now marks those optional. Lazy route chunk; entry headroom unchanged (223 B). |

**RFC verdict:** host-extension only. No wire change.

## Pre-code adversarial review (`/architect`, 2026-10-06)

Track A. Findings against the first draft, each folded above:

- **A1 (CRITICAL, boundaries — a fifth lane the draft missed).** The draft enumerated four lanes
  (routes, tools, surface, KB). Comments are a fifth: `priority_idea` threads validate by list
  tenant + org only (`commentsService.ts:119-131`), so a private project's idea is reachable
  through the comments door. Shipping D1–D5 would have closed three doors and left this one —
  the "gate on one door is not a gate on the rows" lesson this ADR opens with. → **D8**.
- **A2 (HIGH, replay wording).** The draft said a fork re-executes "under the same actor". False:
  the fork route re-stamps `actingUserId` from the forking principal. The behaviour is right; the
  claim was not. → matrix row 9 corrected.
- **A3 (MEDIUM, D6 ordering).** Resolving the tenant via `getBoard(card.boardId)` must hold on
  the `deleteList → deleteBoard` path. Verified: `deleteBoard` deletes every card BEFORE the board
  row (`host/kanbanService.ts:808-814`), so the board is still readable inside each hook. A card
  whose board is already gone is a no-op (the list-wide sweeps in `deleteList` and the teardown
  hook own that case) — stated here so nobody "fixes" it into a global scan again.
- **A4 (MEDIUM, D3 failure mode).** `createDocument` validates a project `ownerSubject` (exists,
  same org). A dangling `projectId` therefore makes the compose throw — which the existing
  `catch` turns into the inline-markdown floor. Correct (an orphaned list must not mint an
  unowned doc), and now stated.
- **A5 (LOW, residual — not fixed).** ADR 0059 exposes the per-criterion AGGREGATE plus the
  caller's own vote to every member. With two voters and `mean`, a member can solve the other
  ballot exactly from those two numbers. D2 removes the direct disclosure; the arithmetic one is a
  property of ADR 0059's read shape and is recorded, not closed here.
- **Checked and cleared:** the surface's `actor` argument on `updateIntake`/`addEvidence`/
  `proposeScenario` is set by the pack (`run:<runId>`, `feature.priority-matrix.nodes/index.mjs:104,
  134,147`), not by node input — no attribution spoofing. Viewers cannot start runs (the `viewer`
  role has no run-create scope), so D1's reach is cross-org; the cure is still the route's rule.

## Product decisions (for the user)

1. A human-started workflow that touches Priority Matrix can now only read/write the lists its
   starter can; a cross-org run that used to succeed now fails `not_found`/`forbidden_scope`.
2. Members without config authority no longer see other voters' identities or ballots in the
   score history (they still see every rank movement and their own vote).
3. New planning agendas for project-bound lists are visible only to the project's readers and are
   deleted with the project.
4. Deleting an idea now also deletes its intake, evidence links and score history.
5. Comments on a private project's idea, and strategy links to it (context, health, timeline),
   are limited to people who can read the project.
6. Read-only members no longer see score inputs, status selects, row menus, the idea form, agenda
   building, intake editing or scenario actions — they see a "View only" note. Members who are not
   the list's creator or an org admin no longer see Criteria / Delete list. Non-superadmins no
   longer see peer add/remove or the workspace-shared credential option.
7. The Matrix marks partially-scored ideas "n of m scored", and its tray now reads "not yet
   placeable" rather than "unscored".

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 + D4 (`listAccess.ts`, surface gate, tool parity) | `adr0842` D1/D4 legs + verb ratchet |
| P2 | D2 | `adr0842` D2 leg |
| P3 | D3 | `adr0842` D3 leg |
| P4 | D5 + D6 | `adr0842` D5 leg + `priority-matrix-kanban-coownership` |
| P5 | D7 | session-cap leg |
| P6 | D8 | `adr0842` D8 leg |
| P7 | D9 + UX Blockers `PM4UX-1..6` | `adr0842` D9 leg, `readOnlyList.test.tsx`, `createListForm.test.tsx` |
| P8 | D10 + `PM4CD-1` intake CAS + `PM4CD-B6` editor rename | `adr0842` D10 + PM4CD-1 legs, `readOnlyList` editor leg |

Each guard is sabotage-witnessed (guard removed → its leg red) before merge.

## Open questions

- [ ] **Legacy agenda Documents for project-bound lists** — prod count requested; zero ⇒ no
  migration. Non-zero ⇒ a re-own is a prod data change needing approval (out of this PR).
- [ ] **`PMX4WF-6`** (one partial idea can outrank one complete idea below the 2-and-majority
  threshold) and **`PMX4WF-7`** (Matrix vs List completeness) are ranking-semantics changes;
  carried to their own decision, not folded here.
- [ ] Actorless-run read narrowing by `orgScopeSubject` — residual, no measured reach.

## Implementation record

Commits on `feat/fl2-26-priority-matrix` (cited by subject — shas move on rebase, the ADR 0826
lesson):

| Phase | Commit subject | Witness |
|---|---|---|
| P1–P6 | `fix(priority-matrix): run lane gated by its starter, ballot secrecy on the score trail, project-owned agendas (ADR 0842 D1-D8)` | `test/adr0842-priority-matrix-access.test.ts` D1/D2/D3/D4/D5/D7/D8 — six legs born red on `c790b4127` |
| P7 | `fix(priority-matrix): offer readers no write that 403s, matrix discloses partial scores, failures said in place (ADR 0842 D9, PM4UX-1..6)` | D9 leg; `readOnlyList.test.tsx`; `createListForm.test.tsx` PM4UX-1 |
| P8 | `fix(priority-matrix): grade-code row 26 — strategy links ask the project, editor rename no longer 403s, null-shape parity, quiet list-delete hook, logged best-effort failures (ADR 0842 D5/D9/D10)` and the closing docs commit | D10 leg; PM4CD-1 leg (red on the pre-CAS `intake.ts`); editor-rename leg |

Sabotage witnesses (guard removed → the named leg red, then restored): surface read gate,
surface write gate, trail redaction, agenda `ownerSubject`, tool project gate, per-card cascade,
comments project gate, strategy project gate, null-shape parity, `viewer.canWrite`, FE `canWrite`,
FE Matrix partial chip, intake CAS (by reverting to the pre-CAS module).

**Prod data:** no migration ships. Legacy agenda Documents of project-bound lists keep no
`ownerSubject` (sized against prod before any re-own; a re-own is a prod data change needing
approval).
