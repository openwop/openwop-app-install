# ADR 0608 — Collaborative projects: visibility across foreign doors, the multi-party invariant, and the browser cadence

Status: ~~implemented (Tiers 1-6; the residuals each decision leaves are named in-section and filed as tracker rows — see § Implementation record)~~ **CORRECTED 2026-08-27 (R2 fold-in):** implemented; **one named Blocker open — `CPC-16` (the broad `/export` authz gap on the non-schedule kinds)**. The bare "implemented" above was dishonest: commit `7d4be150c` stamped it while `CPC-13` — a MEASURED co-tenant leak of the exact schedule rows Tier 1 hides — was open and unfixed. The R2 fold-in (see § R2) closes the SCHEDULE slice of `CPC-13`; the wider leak on roster/prompts/connection-ref/org-chart is carried forward as `CPC-16`, OPEN. Status is not "implemented" without that qualifier.

Supersedes nothing. Corrects **ADR 0054** (D5, D6) inline; see § Corrections to ADR 0054.

## Context

`FEATURES.md` ordinal 21 — **Collaborative projects** (ADR 0054 Phases 1–4) — was
skipped by the 71-feature grade loop (`LOOP-SKIP-1`: the merges jump feature 20 →
22, and the string appeared **zero** times in all three steward trackers). Its
first three-lane pass merged as PR #3456 (`7a9274c00`) and graded it
**C− / C+ / C+** with **11 Blockers** across the lanes.

The findings are not evenly weighted. One is a **measured privilege bypass** that
lets a caller with zero org scopes re-point, fire and delete another team's
automation. Two more are private-read leaks through doors owned by *other*
features. One is an advertised wire property (`multiPartyConversation
{maxParticipants: 8}`) that is enforced nowhere on the server. The rest are
honesty defects — copy, comments and records that state rules the code does not
implement.

This ADR records the decisions taken in the fix batch, **ordered by
irreversibility**, and the residuals each one leaves.

The organising observation, and the one worth carrying forward:

> **Every Blocker in this feature is the same shape — a gate that is correct on
> the lane it was written for, over a population that is larger than that lane.**
> `requireProject` is a good gate; it fronts the project's own doors. The rows it
> protects are reachable through the scheduler's door, the KB's door, the
> portability export's door. `participantRosterOf` is a correct roster
> derivation; it is keyed on `meta.boardId`, which is a *provenance spelling*, not
> the multi-party invariant. The `canWrite` projection is a correct authority
> projection; the client applies it to six of nine controls. In every case a test
> exists, passes, and enumerates the lane rather than the population — so the
> green reads as the invariant.

---

## D1 — A `ScheduledJob` is gated by its owning SUBJECT, not by tenant co-residency (`CPC-1`)

### The defect, as measured

A project schedule is an ordinary `ScheduledJob` stamped
`ownerSubject = {kind:'project', id}` (`features/projects/projectScheduleService.ts:92-99`).
`ownerSubject` appeared **zero** times in `routes/scheduler.ts`, and
`jobAccessible` (`:72-76`) short-circuited `if (job.tenantId === tenantOf(req)) return true`.

Measured live against a booted `createApp`, by the grader and re-witnessed here: a
co-tenant with **zero org scopes** got 404 on `GET /projects/:id` and
`GET /projects/:id/schedules`, then listed the private project's job, `PATCH` →
200 (re-pointing `workflowId` at their own workflow), `POST …/trigger` → 200
`runsFired:1` (a real run started, in the *project's* tenant), `DELETE` → 200 —
after which the owner's `/projects/:id/schedules` read `[]`.

That is two defects on one door: a **private-read leak** (list) and a
**`requireProject('workspace:write')` bypass** (patch / trigger / delete).

### Decision

Resolve the job's owner through the ADR 0054 D5 `subjectAccess` seam and honour
the level it returns — the **same rule** `routes/kanban.ts:107-141` already
applies to a board. READ is required to list a job; WRITE to patch, trigger or
delete it. Only when the seam returns `null` (no resolver for the owner's kind —
an agent- or user-owned job) does the legacy ADR 0025 tenant/personal rule run,
unchanged. Everything unreachable is a uniform 404, never a 403 — no existence
oracle.

### Alternatives weighed

1. **Special-case `kind:'project'` inside `routes/scheduler.ts`.** Rejected: it
   would put a second copy of the projects rule in a host route, which is the
   `CPC-8` defect ("the ONE seam is in practice three") committed by the cure that
   closes `CPC-1`. The seam already exists and kanban already uses it.
2. **Fail closed whenever a job carries `ownerSubject` and no resolver applies.**
   Rejected, and this one is worth writing down because it is superficially the
   safer choice. `ownerSubject` is legitimately stamped `{kind:'agent'}`
   (`features/kicktodo-core/kickbotService.ts:340`) and `{kind:'user'}`
   (`features/scheduled-agent-chats/agentTools.ts:127,265`) by features that
   depend on the legacy gate. Fail-closing would 404 those jobs for their own
   owners — a gate with no exit, which is worse than the leak it closes.
3. **Filter only the list, and leave the mutating verbs.** Rejected: the write
   bypass is the sharper half. `trigger` starts a real run.

### The cure's own failure mode, and what was done about it

Resolving a subject per job costs a `getProject` plus a full
`resolveEffectiveAccess` scan. Applied naively to `listJobs(tenantId)` that is N ×
2 host-collection scans per request — the **`host_ext_kv` prefix-scan incident's
exact class**, i.e. the cure committing a different family than the one it closes.
The gate is therefore constructed **once per request** and memoizes per owning
subject, so a tenant whose jobs all belong to one project costs one resolution,
not N. (`PRJC-3` extracted `listVisibleProjects` for exactly this reason; this is
the same lesson applied to a different list.)

### Witness

`backend/typescript/test/scheduler-subject-gating.test.ts` — **born red, 6 of 8
failing** against the pre-fix tree. It covers **each verb separately** (list /
patch / trigger / delete) rather than only list, because the read leak and the
write bypass are independent arms and a single list assertion would have let
either half regress silently.

It carries three positive controls, because the dominant failure mode of a
security witness is an assertion of a **non-effect** ("the row still exists", "a
second call changes nothing") which a *dead cure* satisfies perfectly:

- the org WRITER still lists, patches, triggers and deletes (the cure is not a brick);
- a job with **no** `ownerSubject` stays reachable by any tenant member (the cure
  is not a blanket deny — ADR 0025 is untouched);
- a project MEMBER with read-only authority **can list** but is refused all three
  mutations, and the project's own door agrees — so "membership never grants
  write" is asserted on both doors at once.

Sabotage-proved in four independent runs (list filter reverted → the two list
cases go red and only those; patch / trigger / delete each reverted to
`job.tenantId !== tenantOf(req)` → that verb's case plus the member-write case go
red). Each restore was verified by **diffing the file against a backup**, not by
re-reading it.

### Residuals, stated

- **The legacy fallback is still reached when the seam has no resolver.** If the
  projects feature ever failed to register its resolver, a project-owned job would
  fall back to the tenant rule. Projects is always-on (no toggle) and
  `routes/kanban.ts` carries the identical shape, so this is not a regression —
  but it is the reason `CPC-8` (make the seam structurally authoritative, with a
  ratchet) matters, and it is recorded in the code at the fallback itself.
- **`GET /v1/host/openwop-app/export` leaks the same rows and is NOT fixed here.**
  See D2.

---

## D2 — The portability export leaks the same rows; filed, not fixed (`CPC-13`, NEW)

The Tier-1 population was enumerated **by call graph over the row type**, not over
the route file — because "a filed count is a floor". Every backend caller of
`listJobs` / `getJob` / `updateJob` / `deleteJob` / `singleTick` /
`listJobsByRoster` / `listJobsByUser` was classified. That enumeration found a
**second HTTP door on the same rows** that the assessment did not file:

`GET /v1/host/openwop-app/export` (`features/portability/routes.ts:59-65`) calls
`buildExportBundle(tenantOf(req))` with **no scope check at all**, and the bundle's
`schedule` slice is `listJobs(tenantId)` verbatim
(`portabilityService.ts:339-341`).

**Measured in this batch**, same harness as D1: the co-tenant with zero org scopes
who gets 404 at `/projects/:id` receives `200` from
`/export?kinds=schedule` carrying
`{"kind":"schedule","ref":"sched:job-project-…","payload":{"jobId":…,"cronExpr":"0 9 * * *","workflowId":"wf.demo","enabled":true}}`
— byte-identical to the owner's own export of the same row.

**It is filed as a Blocker and deliberately NOT fixed in this batch.** The two
candidate cures are in genuine conflict and neither is safe to guess at inside a
security commit:

1. **Gate the route** (e.g. on `packs:publish`, mirroring `assertCanImport` at
   `routes.ts:28-37`). Changes the auth contract of a surface this host
   **advertises** as the RFC 0098 `portability` capability
   (`routes/discovery.ts:1126-1136`) and for which it is the
   `portability.import` non-vacuous graduation witness. An auth change there is a
   conformance question, not a host question.
2. **Filter the bundle rows** by caller readability. Preserves the contract, but
   makes a *portability export* silently incomplete — the "a failed/partial read
   presenting as success" family this repo has been bitten by repeatedly. A backup
   that quietly omits rows is its own defect.

The leak is also **wider than this feature**: the same route dumps every other
tenant entity kind by the same tenant-only rule, so the projects slice is a
symptom. Deciding the export's scope contract belongs with portability, with the
RFC 0098 conformance harness in hand.

> **CORRECTED 2026-08-27 (R2) — the SCHEDULE slice IS now fixed; the wider leak is
> re-filed.** The "deliberately NOT fixed" framing was right about the broad
> contract question but wrong to leave the *headline schedule rows* — the exact
> rows Tier 1 (D1) hides — re-exposed through this second door. The two candidate
> cures are NOT actually in conflict for the schedule slice: gating the whole
> route is the RFC-0098 contract question, but *filtering the schedule rows by
> caller readability* is the SAME mechanism the `GET /scheduler/jobs` door already
> uses, and applying it there re-closes D1's leak without touching the auth
> contract of the other kinds. So the R2 fold-in filters ONLY the `schedule`
> slice, drop-unreadable, through `scheduleSubject → resolveSubjectAccess`
> (`portabilityService.ts` schedule handler; `buildExportBundle` now takes the
> acting `caller`; `features/portability/routes.ts` passes `callerSubject(req)`).
> `CPC-13` is CLOSED for the schedule slice. The broad leak on the OTHER kinds
> (`roster` / `prompt-template` / `connection-ref` / `org-chart` still dumped on
> tenant co-residency alone) is a real, separate hole that plausibly needs an
> `../openwop` RFC (export/import is a conformance surface) and is carried forward
> as **`CPC-16`, OPEN**. See § R2.

---

## D3 — Enumerated population: the rows that carry a project owner and the doors that do not ask (`CPC-9` promoted from SUSPECTED)

`CPC-9` was filed **unproven** because the grader's probe returned `documents: []`
— no project-owned document existed in the scenario. Absence of a leaking row in
one probe is not absence of the leak; the population must be enumerated
**writer-side**. That was done (by call graph, over every writer that can stamp a
`kind:'project'` `ownerSubject`):

| Row type | Declaration | Project-owned writers | Door(s) | Verdict |
|---|---|---|---|---|
| `ScheduledJob` | `host/schedulingService.ts:72` | `projectScheduleService.ts:94` | `routes/scheduler.ts`; `features/portability/routes.ts:59` | **FIXED (D1)** / **FILED (D2)** |
| `KanbanBoard` | `host/kanbanService.ts:147` | `projectsService.ts:216`; `priorityMatrixService.ts:246`; `demoOpsPlanningSeed.ts:115,198` | `routes/kanban.ts` **GATED**; `features/priority-matrix/routes.ts:78-85` org-only; `features/work-selection/agentTools.ts:54-60` tenant-only | **FILED** (`CPC-14`) |
| `ConversationMeta` | `host/conversationStore.ts:126` | `projects/routes.ts:439`; `notebooks/routes.ts:554` | `chatSessions.ts:115-120`, `conversationVisibility.ts:69-73`, `chatContext.ts:220-224` | **GATED** |
| `CanvasRecord` | `host/canvasSurface.ts:69` | `canvasEditorRoutes.ts:229,268` (**client-supplied** kind, validated by org derivation only, `:137,175`) | every canvas-editor route is `authorizeOrgScope` + tenant-scoped load (`:68-72,90-98`); `sharing/sharingService.ts:713-720` mints a share link because its guard only matches `kind:'user'` | **FILED** (`CPC-15`) |
| `DocumentRecord` | `features/documents/documentsService.ts:83` | `documentsService.ts:817`; `documents/routes.ts:172,212`; `notebooks/transformWorkflow.ts:79` | `documents/routes.ts:84-96` org-only, and `?ownerKind=project&ownerId=` (`:39-47,92`) is a **first-class enumeration primitive**; `notebooks` lane is **GATED** (`routes.ts:108-121`) | **FILED** (`CPC-15`) |
| `ArtifactProjection` | `host/artifactProjection.ts:47` | inherited from `DocumentRecord` | `documents/artifactRoutes.ts:54-109` → `artifactProjection.ts:341-350`, org-scope only | **FILED** (`CPC-15`) |
| app-builder canvas args | `features/app-builder/renderCore.ts:31` | typed `{kind:'user'}` | — | **N/A** |

So `CPC-9` is **confirmed as a class and widened**: it named documents and canvas;
the enumeration adds the artifact Library projection, the priority-matrix door
over a project-owned board, the work-selection agent tool, and the sharing
share-link mint. None of these is fixed here — they belong to their owning
features and each needs its own born-red witness with a real project-owned row.
**The point of recording the table is that the next reader does not re-derive it
from a probe that finds nothing.**

---

## D4 — A KB collection BORN inside a project is gated by that project (`CPC-2`)

### The defect, as measured

`POST /projects/:id/knowledge/collections` creates an ordinary org KB collection
and binds it (`projectKnowledgeService.ts:113-129`). The projects door gates reads
at project READ (`projects/routes.ts:275,282`); the KB feature's own doors gate the
**same rows** on `requireOrgScope('workspace:read')` (`kb/routes.ts:54,107,207`).

Measured: an org **viewer** who is not a project member gets 404 at
`/projects/:id/knowledge`, then `GET /kb/orgs/:orgId/collections` → 200
(`Secret notes`), `.../documents` → 200 (`Merger plan`), and
`POST .../search` → 200 returning the verbatim chunk
`"ACQUIRE ACME FOR 40M. Board only."`.

**Two doors, same rows, opposite answers** is the defect whichever door is
"right".

### Decision — CONSTRAIN the KB door, do not widen the project door

Widening the project door to match the KB door would "fix" a leak by making it
official; that was never an option. So the KB door is constrained, but **only for
the collections the narrow claim actually covers.**

`KnowledgeCollection.boundSubject` is a **server-set** field (added to
`InternalCollectionFields`, so a network caller can neither claim nor clear it),
stamped by `createBoundCollection` — i.e. only where the corpus is **born inside**
the project. When present, the KB doors additionally resolve it through the
ADR 0054 D5 `subjectAccess` seam and fail closed as a uniform **404** — the same
answer the project door gives, so the two doors cannot disagree about existence
either. Absent ⇒ behaviour is byte-identical to before.

The guard is a **mounted middleware** on `${BASE}/collections/:collectionId`, not
a call in each of the 15 handlers, so a route added later inherits it rather than
having to remember it. It checks READ even on write routes, deliberately: the
write routes already require `workspace:write` in the collection's org, and
`levelFor` makes org-write in the project's org imply project-write, so the only
dimension this guard must add is membership READ.

### What I got wrong first, and how it was caught

The first implementation **also stamped at bind time** (`bindCollection`) and
**backfilled** unstamped collections on the project's knowledge read. Both were
wrong, and both were caught by tests rather than by reasoning:

1. **Stamping on bind bricked shared collections.** `boundSubject` names ONE
   subject. A collection bound to projects A and B took A's stamp; deleting A left
   a stamp that `resolveSubjectAccess` resolves to `'none'` **for everyone**,
   because the seam cannot distinguish "this project denies you" from "this
   project no longer exists". The collection became unreachable dead data — a gate
   with no exit, **strictly worse than the leak it closed**. The witness was not
   mine: `notebooks-delete-honesty.test.ts`'s shared-collection CONTROL
   ("a SHARED collection NAMED LIKE A PROVISIONED ONE is not destroyed") went red.
   Binding an org collection to a project must not retroactively narrow it either
   — it was already an org resource.
2. **The backfill could not tell "born here" from "bound here".** It looked
   obviously safe: an ADDITIVE stamp, never a deletion, so the guarded-prune
   hazard the same function documents does not apply. Narrowing it to collections
   bound **exclusively** to one project did not save it — `POST
   /knowledge/bindings` returns that very view, so binding a shared org collection
   to one project immediately stamped it. Dropped. Provenance is not derivable
   from the binding set.

Both are recorded as inline comments at the sites, so the next reader does not
re-derive them.

### Residual, stated plainly

**Collections created through a project's knowledge door BEFORE this change carry
no stamp and keep the old org-visible behaviour.** There is no backfill and there
cannot be a sound heuristic one; closing it needs a creation-provenance marker on
the row that does not exist yet. New corpora are covered from this commit on.

### Witness

`test/project-knowledge-visibility.test.ts` — born red. Covers the list, get,
documents and search lanes; asserts the verbatim chunk appears **nowhere** in the
refused response (not just that the status is 404 — a refusal that changed shape
must still not leak); asserts the STAMP on the row directly, because the guard and
the stamp are two mechanisms and a door-only test cannot say which is working; and
carries three exits/controls — the owner still reads it, a project member regains
it, flipping back to `org` restores it for a non-member, an unbound org collection
is untouched, a merely-bound shared collection is NOT narrowed, and deleting the
owning project RELEASES the stamp instead of bricking the corpus.

Sabotage-proved: removing the create stamp → 4 red; removing the delete release →
the EXIT case red (and only it). Each restore verified by diff.

---

## D5 — A visibility flip re-runs the shareable-KB carve-out (`CPC-3`)

### The defect, as measured

The provider's carve-out ("a private project's KB is not shared") is applied at
**share time only** (`projectKnowledgeService.ts:196-214`), and
`setProjectVisibility` had no reconcile hook. Measured: share a project KB to a
board, then flip the project to `private` — `GET /agents/host:ada-lovelace/knowledge`
**still** returns the collection with `knowledgeEnabled:true`, while
`GET .../shared-knowledge` reports `{shared:true, exists:false, count:0}`. The
advisor keeps retrieving the now-private corpus on **every turn**, for any user who
can chat with that agent, and the operator reading the panel concludes nothing is
shared.

### Decision

A new core seam — `registerShareableKbReconciler` /
`notifyShareableKbSourceChanged` in `host/shareableKb.ts`. The SOURCE feature
(projects) announces "my shareable set changed for this (org, kind)"; the CONSUMER
(advisory-board) registers the reconciliation. The dependency keeps pointing the
right way: projects still never imports advisory-board.

The reconcile is **symmetric**, and that is the decision worth recording. The
obvious fix is "unbind on going private". But `shared` reports STORED INTENT
(ADR 0277 P2), so if the board keeps its intent while its only project is private,
the honest behaviour on the way BACK to `org` is to **re-bind** — otherwise the
panel would claim "shared" forever over an advisor that holds nothing, which is
the same lie pointing the other way.

`stale` is computed as `forUnshare \ shareable` rather than "this project's
collections", so a collection also reachable through a still-`org`-visible project
is correctly retained. Boards are selected by EFFECTIVE shared kinds (stored intent
∪ the legacy derived state) — the same union `updateBoard`/`deleteBoard` use,
because a board that shared before `sharedKbKinds` existed has bindings and no
stored kind and would otherwise keep the leak for exactly the oldest tenants.

### Prescription I falsified

The finding also asked to *"make `shared` report `false` when the resolver yields
zero ids so the panel cannot claim a share that no longer exists."* **Not done, and
it should not be.** Once the reconcile lands, `{shared:true, exists:false,
count:0}` is a *true* statement — "you asked for project KBs; none are currently
shareable" — and the advisor genuinely holds nothing. Flipping `shared` to `false`
would DISCARD the stored intent, so restoring the project to `org` would silently
re-bind nothing. The panel's honesty problem was the binding, not the flag.

### Witness

`test/project-knowledge-visibility.test.ts` — share-THEN-private (the arm the
existing `advisory-board-knowledge.test.ts:112-122` near-miss cannot see, since it
tests private-THEN-share) **and** the way back. Sabotage-proved by removing the
`notifyShareableKbSourceChanged` call: that case, and only it, goes red.

### Residual

Best-effort by design: a reconcile failure never fails the visibility write (both
primitives are idempotent and the next trigger re-converges). A tenant whose board
is unreachable at flip time therefore keeps the stale binding until the next
trigger — an availability/consistency trade recorded here rather than hidden.

---

## D6 — The multi-party speaker roster keys on the invariant, not on `boardId` (`CPWF-1`, speaker arm ONLY)

### The defect

`participantRosterOf` returned `null` unless `meta.boardId` was set
(`host/multiPartyConversation.ts:51`). A project group chat is `type:'group'` with
`ownerSubject: project:<id>` and **no `boardId`** (`projects/routes.ts:436-441`),
seating every `agent:` member. So the roster was `null`, the fail-closed speaker
rule at `conversationExchange.ts:333-341` never fired, and the
`multiPartyConversation {supported:true, maxParticipants:8}` capability the host
**advertises** (`routes/discovery.ts:841`) was unenforced for that producer.

`boardId` is a **provenance spelling**, not the multi-party invariant — the
`ratchets-police-a-SPELLING-not-the-invariant` family, on a security guard.

**The comment is the reason it survived.** The line above the predicate asserted
that everything without a `boardId` "is single-agent / ungrouped", which is exactly
wrong for a project room. A reader checking the guard read the sentence and moved
on. Both halves are fixed in this change; a corrected predicate under an uncorrected
comment would just reset the trap.

### Decision — and where I did NOT follow the prescription

The finding prescribed "drop the `!meta.boardId` clause". Taken literally that
**creates a wedge**, and this is the one prescription in the batch I deliberately
narrowed:

- a group meta with **zero** `agent:` participants would then return `[]`, and the
  docblock's own rule says a declared-but-empty roster means *"no agent may
  speak"* — fail-closed. A kicktodo accountability circle
  (`kicktodo-accountability/circleService.ts:106`) creates exactly that shape and
  **seats no agents at create**, so every agent turn in those rooms would 422.
  Turning a missing guard into an outage is not closing it.

So the rule derives from the SHAPE with the empty case split by provenance —
which is the one place provenance legitimately carries information:

| meta | roster | rationale |
|---|---|---|
| not `type:'group'` | `null` | 1:1 / ungrouped — untouched |
| board group | derived, **even if empty** | a board declares a cohort explicitly; empty ⇒ nobody speaks (unchanged) |
| other group, ≥1 `agent:` seat | derived | **the arm that was missing** — projects, and the generic `POST /chat/sessions/:id/participants` |
| other group, 0 `agent:` seats | `null` | no roster was declared; legacy behaviour retained |

### The cap arm is deliberately NOT here

`MAX_MULTI_PARTY_PARTICIPANTS` is still enforced nowhere on the server for
projects (`CPWF-3` stays open). That ordering is the finding's own replay note and
it is right: **it is unknown whether any deployed tenant already seats >8 agents in
a project room**, and a cap landed first would start 4xx-ing live conversations.
The speaker arm cannot break a room that was already well-formed; the cap arm can.
The cap belongs at the seat-writing choke (`ensureConversationMeta` /
`addParticipant`) so a new producer inherits it, and behind a one-time audit — not
in this commit, and not per-producer.

### Witness (`CPWF-10`)

`grep -ci project` over `test/multi-party-conversation.test.ts` and
`test/multi-party-conversation-seam.test.ts` returned **0 / 0**: the RFC 0101 lane
was tested exclusively against board metas, and its negative case used a
`type:'agent'` meta — true, and it left `type:'group'`-without-`boardId` untested
in **both** directions. The test did not pin the defect; it could not see it.

Added, all born red or explicitly controlled:

1. **unit, project shape** — `type:'group'` + `ownerSubject: project:<id>`, no
   `boardId` ⇒ roster derived; `isParticipant` asserted in **both** directions.
2. **unit, the wedge control** — a non-board group with zero agent seats still
   returns `null`, and a board group with zero agent seats still returns `[]`.
3. **route-level enforcement** — a real exchange on a non-board group meta: the
   seated agent speaks (**positive control first** — without it, a 422 proves
   nothing distinguishable from a room where nobody can speak), then a
   non-participant is refused 422 and appended nowhere.

Sabotage-proved: restoring `|| !meta.boardId` turns (1) and (3) red, and only
those. Restore diff-verified.

### What the route-level witness does NOT cover — stated, not glossed

Case (3) drives the **generic** non-board group producer, not a project room with
`ownerSubject` stamped. That is not laziness: an owned conversation is gated by
`isVisibleToAsync`, which resolves a non-existent project subject to `'none'` and
masks the whole exchange as 404, so the speaker rule is never reached. Building a
real project needs cookie auth + org membership, which the RFC 0101 harness
(bearer, `_anon` tenant) has no path to. `participantRosterOf` never consults
`ownerSubject`, so the project-shaped meta is covered by (1) — but **no test
anywhere exercises a full multi-turn project convene end-to-end**, and the repo's
own e2e concedes the same limit (`e2e/collaborative-project.spec.ts:29-31`).

### Residual

The class was enumerated over `ensureConversationMeta(..., {type:'group'})`
producers: advisory-board (stamps `boardId`), projects, notebooks (seats one
agent), kicktodo-accountability circles (seats none), the generic chat-sessions
participants route, and the conformance seam (mints a synthetic `boardId`
*precisely so the real derivation fires*). Notebooks now derives a
single-participant roster, so a turn addressed to a different agent in a notebook
room would 422 — correct per RFC 0101, and called out here because it is the one
behaviour change outside projects.

---

## D7 — `orchestrated` is a SPA-history label, and the claim now says so (`CPWF-2`, honesty arm)

### The decision, stated as the finding asked

**Stop claiming durable attribution; keep the label that exists; route the real fix to an RFC.**

`orchestrated: true` (`useBoardroomCadence.ts:137`) has **zero** hits in
`backend/typescript/src`. Making the durable record honest needs a field on the
RFC 0005 `ConversationTurn` — `../openwop` RFC surface, not a host change
(CLAUDE.md § "A spec change needs an RFC"). So the host-side deliverable is
honesty, and that is what landed.

**My first correction was itself false, in the other direction**, and that is the
part worth recording. It claimed the flag "never leaves the browser". It does: it
rides the whole message object into the `chat_session` row's **opaque `content`
JSON** (`useSessionPersistence.persistMessage` stringifies it), so the SPA's own
history rehydrates it. What it never reaches is the `ConversationTurn` that
`:fork` replays and a server-side auditor or peer host reads. Both comments now
state that split precisely rather than either overclaiming or underclaiming it.

A related find: `chat/types.ts` already carried an accurate correction on the
`ChatMessage.orchestrated` FIELD (~20 lines above), while the `SendOptions`
docblock still said the marker makes "the durable transcript stop attributing it
to them". **The correction had been made at one site and not at its twin**, so a
reader of the OPTION met the false sentence. Both are corrected now.

## D8 — The client stops re-deriving authority, and the narrowing control tells the truth (`CPC-4`, `CPU-1`, `CPU-3`, `CPU-4`)

- **`CPC-4` — the chat room is gated on READ.** `ProjectChatTab` rendered "Open
  project chat" only `if (canWrite)`, with copy asserting the open "needs edit
  access (`workspace:write`)". The server gates `POST /:id/chat` on project READ
  and says so in-line. So the client both **locked out the exact population
  `private` + membership exists to serve** and **stated a rule the server does not
  enforce**, ×4 locales — the defect ADR 0054's own D3 correction closed
  server-side, reintroduced on the client. The button is unconditional now; the
  false key is DELETED from all four catalogs. The CADENCE EDITOR stays
  write-gated — that one really is a `PATCH`.
- **`CPU-3` — `Run now` is pre-gated.** It was never gated on `canWrite`, on a
  control `FEATURES.md:189` names in the pre-gated set, and it is not even the
  shown-then-403 case: `createRun` is authorized by the generic `runs:create`
  scope, outside the project ACL, so the run would actually **start**.
  **RESIDUAL:** Board / Sources / Podcast still receive no `canWrite` — their
  panels have no `readOnly` prop to take, and adding one to three foreign features
  is not this batch. `FEATURES.md` is corrected to say so rather than keep the
  claim.
- **`CPU-1` — the narrowing confirms and acknowledges.** One click used to fire the
  write with no confirm, no success feedback and no announce. Only the NARROWING
  direction confirms; widening back to `org` is the recovery path and a confirm on
  the exit is a tax on undoing the scary thing.
- **`CPU-1`/`CPU-2` — the disclosure names what it governs AND what it does not.**
  The copy named FOUR of ten tabs. Naming all ten would have made it *more
  confidently wrong*, because for podcast episodes the narrowing genuinely does not
  hold (`podcasts/routes.ts:228-281` is `hasOrgScope` only after creation). The
  copy now enumerates the surfaces it governs and states the podcast exception. The
  underlying `CPU-2` fix belongs to `podcasts`.
- **`CPU-4` — a completed milestone is announced.** The only state glyph was
  `aria-hidden` and the only other carrier was `text-decoration: line-through`, so
  a screen-reader user heard every title and "N of M done" and could map done-ness
  onto none of them. A per-row `sr-only` text state now carries it. (History worth
  keeping: `PROJ-UX-11` moved this from an inline style to a class — fixing the
  §10 violation and making the a11y defect harder to see.)

### Witnesses (`CPU-11` — the gate that could not fail)

The pre-gate's only execution witness covered **2 of 9** controls, all inside one
component, so **no test could fail** on the other seven — which is why `CPU-3`
shipped green. New `features/projects/__tests__/writeGateEnumeration.test.tsx`
covers the two controls the enumeration found wrong, in **both polarities and
opposite directions**: workflows asserts a control is HIDDEN for a reader, chat
asserts one is SHOWN. A gate test that only ever asserts absence cannot tell a
correct gate from a broken screen. The cadence-editor case renders the WRITER
first as a positive control — the fixture also had to seat an agent member, or the
absence assertion would have passed because there was nothing to gate.
`ProjectMembersTab.access.test.tsx` gains the confirm/decline/acknowledge trio.
All sabotage-proved with diff-verified restores.

Also locked in: the `check-notice-announce` cohort row for `ProjectMembersTab` is
**DELETED** and the gate baseline lowered 189 → 188 — the half that is easy to
skip, and without it the gate would carry a unit of slack for a new silent notice.

## D9 — A missing moderator REFUSES instead of substituting (`CPWF-4`)

`chairAgentId ??= routed` made whichever agent resolved first the chair, and the
chair both frames AND synthesizes. So an ordinary async-load race in the mention
lineup silently promoted advisor #2 into the seat the server 422s a non-member
for — the invariant defeated by substitution rather than by bypass.
`orderConveneCohort` already DROPS a non-member moderator, and dropping it is
exactly what triggered the promotion.

The convene now refuses with a typed, localized system line (×4 locales). A
transcript framed and synthesized by an agent the user did not choose is worse
than one that never started, because it looks correct.

`projectsService.ts:299` asserted the consumer "falls back to no chair". It did
not. **The false sentence sat in the file that owns the invariant**, which is why
nobody checked the consumer; it is corrected in the same change.

Witness: three cases — the refusal, a POSITIVE CONTROL that a resolving moderator
still chairs (without it the refusal is indistinguishable from a convene that
never runs), and a project with no moderator configured still convening (the
refusal is scoped). Sabotage-proved.

---

## Corrections to ADR 0054

Recorded as inline correction notes in `docs/adr/0054-collaborative-project.md`
per the CLAUDE.md rule (append `~~strikethrough~~` + a dated note at the affected
section; never silently rewrite the original rationale).

- **D5 — "cannot leak through any surface by construction".** Falsified three
  times, each by a door outside `features/projects/`: schedules (`CPC-1`,
  executed), the KB corpus (`CPC-2`, executed — verbatim chunk text to a
  non-member org viewer), and the shared-KB binding surviving an `org → private`
  flip (`CPC-3`, executed). "By construction" was a claim about a population that
  grows every time a feature stamps `ownerSubject:{kind:'project'}` on a row —
  and nothing structurally enforced it. The precise surviving claim is *"every
  door that resolves a project subject through the `subjectAccess` seam is
  gated"*, which is a statement about four call sites, not about the feature.
- **D5 — "ONE seam".** `resolveSubjectAccess` has four callers repo-wide; every
  other project consumer calls `resolveProjectAccess` **directly** (notebooks,
  podcasts, strategy, advisory-board) or the projects-local `requireProject`.
  Three entry points that agree **by registration**, not by construction
  (`CPC-8`).
- **D6 — "cohort cap 8".** A client-side literal
  (`frontend/react/src/chat/conversations/convene.ts:31`) with **zero** backend
  hits, against a server member cap of 100 (`projectsService.ts:91`) — while the
  host **advertises** `multiPartyConversation {maxParticipants: 8}`
  (`routes/discovery.ts:841`).

  > **CORRECTION 2026-08-31 (`CPWF-3` cap arm LANDED).** The closeout deferred
  > this arm "pending a one-time audit of rooms already seating >8", on the
  > premise that any server cap would 4xx or silently trim live conversations.
  > **That premise only holds for a THROWING cap** (the `assertCohortSeats` shape
  > one file over, `advisory-board/service.ts:303`). The arm that landed is
  > **skip-with-count + grandfather**, at the ONE seat-writing choke — the
  > `POST /:id/chat` reconcile in `projects/routes.ts`: a NEW room's meta is
  > seeded with the moderator-first cohort **capped** at
  > `MAX_MULTI_PARTY_PARTICIPANTS` (the const behind the advertised number,
  > `host/multiPartyConversation.ts:36`, not the FE `CONVENE_COHORT_CAP`), and the
  > add loop seats new agents **only while `seated < cap`**. The prune arm is
  > **unchanged** and targets non-members only, so a grandfathered >cap room hits
  > **zero** new adds and **zero** removals — no 4xx, no silent unseat. Because
  > nothing can break a well-formed historical room, **the audit precondition
  > dissolves**: the reason the arm was held is the exact property skip-with-count
  > guarantees. `CPWF-8`'s dispatch-time round budget is a SEPARATE choke and is
  > NOT closed by this (it stays open). Witness: `test/projects-route.test.ts`
  > (4 cases, born red on the NEW-room seat count and on the membership-churn
  > seat count; grandfather + prune regression guards). An adversarial review
  > caught a MEDIUM under-seat: the add loop runs before the prune loop, so
  > counting a soon-pruned non-member toward the cap would block a legitimately
  > swapped-in member for the session — fixed by counting only RETAINED members
  > (`want.has(ref)`) toward the cap, with the churn case added as its guard.
- **The Phase-2 gate (`0054:242`) under-specifies in the same direction the UI
  copy does.** The gate enumerates "board / memory / knowledge / schedules";
  `FEATURES.md:189` claims "every project-owned surface". The ADR's own
  acceptance criterion was therefore satisfiable without the claim being true —
  **the doc and the code were wrong together, which is why neither caught the
  other.** This is the transferable item: an ADR phase-gate that lists surfaces
  is a gate on a lane; a claim that says "every" needs a gate over the
  *population*, i.e. a ratchet on the writers (`CPC-8`), not a checklist.
- **"Descriptive membership … authority stays org-scoped" overstates**
  (`CPWF-6`). `projectsService.ts:321` makes membership the READ grant on a
  `private` project, propagating through the seam to five consumers. The precise,
  defensible claim is **"membership never grants WRITE; on a `private` project it
  is additionally the READ ACL."**

## Implementation record

| Tier | Decision | Commit | Witness |
|---|---|---|---|
| 1 | D1 — scheduler subject gate (`CPC-1`) | see git log | `test/scheduler-subject-gating.test.ts` (born red 6/8; four sabotages) |
| 2 | D4 — KB door gated by the born-in Subject (`CPC-2`) | see git log | `test/project-knowledge-visibility.test.ts` (born red; 2 sabotages) |
| 2 | D5 — visibility flip reconciles shared KB (`CPC-3`) | see git log | same file, share-THEN-private + the way back (1 sabotage) |
| 3 | D6 — multi-party speaker roster keys on the shape (`CPWF-1` speaker arm, `CPWF-10`) | see git log | `test/multi-party-conversation.test.ts` (3 cases, born red; 1 sabotage) |
| 3 | D6 — seated-roster cap at the advertised ceiling, skip-with-count + grandfather (`CPWF-3` cap arm; correction note above) | see git log | `test/projects-route.test.ts` (4 cases, born red on the NEW-room + churn seat counts; grandfather + prune guards) |
| — | D2 / D3 — filed, not fixed (`CPC-13`, `CPC-14`, `CPC-15`) | — | measured reproduction recorded in the tracker rows |
| 4 | D7 — `orchestrated` honesty + unmount halt disclosure (`CPWF-2` host half) | see git log | `cadenceHaltDisclosure.test.tsx` (+2, born red; 1 sabotage) |
| 5 | D8 — chat READ gate, `Run now` pre-gate, confirm + feedback, milestone a11y | see git log | `writeGateEnumeration.test.tsx` (5), `ProjectMembersTab.access.test.tsx` (+3); 4 sabotages |
| 5 | D9 — moderator refusal, not substitution (`CPWF-4`) | see git log | `convene.test.ts` (+3, born red; 1 sabotage) |
| 6 | Corrections to ADR 0054 (D5 ×2, D6, the Phase-2 gate) + `FEATURES.md:189` | see git log | re-read against the diff; each claimed edit grep-verified present |
| — | `CPWF-3` cap arm — deliberately NOT landed (needs the >8 audit first) | — | — |
| — | `CPU-3` residual — Board / Sources / Podcast still take no `canWrite` | — | recorded in `FEATURES.md` rather than claimed |

---

## R2 — adversarial-review fold-in (2026-08-27)

A proved-by-execution adversarial review of the R1 batch returned 1 HIGH / 2
MEDIUM / 2 LOW. Three were folded in; the population it named is recorded here so
the next reader does not re-derive it.

### R2-A — `CPC-13` schedule slice CLOSED (H1 / L5)

The R1 batch FILED `CPC-13` but did not fix it, and stamped the ADR "implemented"
anyway — so the headline schedule rows D1 hides stayed reachable through
`GET /v1/host/openwop-app/export`. Re-measured on R1 code: a zero-scope co-tenant
got `200` from `/export?kinds=schedule` carrying a `private` project's full
schedule row, byte-identical to the owner's export. The fix filters ONLY the
`schedule` slice, **drop-unreadable, through the SAME `scheduleSubject →
resolveSubjectAccess` gate the `GET /scheduler/jobs` list door uses** — a schedule
row the caller could not READ through the scheduler door no longer appears in the
bundle either. The auth contract of the other export kinds is untouched.

- **Witness:** `test/portability-export-subject-gating.test.ts` — born red. Sabotage
  (neutralize the drop-unreadable filter) → the two leak cases (zero-scope co-tenant;
  org-visible project) go red **and only those**; the three positive controls stay
  green (the OWNER still exports it — not bricked; a read-only MEMBER still exports it
  — READ suffices, matching the list door; a job with NO `ownerSubject` still exports
  — ADR 0025 untouched, not a blanket deny). Restore diff-verified byte-identical.
- **Status line corrected** (top of this ADR): the honest status is "implemented;
  one named Blocker open (`CPC-16`)", not bare "implemented".

### R2-B — `CPC-16` FILED (the broad `/export` authz gap)

The schedule fix does NOT close the wider hole: the same route still dumps
`roster` / `prompt-template` / `connection-ref` / `org-chart` for any co-tenant on
tenant co-residency alone (no subject/scope check — `portabilityService.ts` other
handlers; `features/portability/routes.ts` has no gate). This plausibly needs an
`../openwop` RFC because export/import is an RFC 0098 conformance surface and a
route-level gate would change an advertised capability's auth contract. Filed as
**`CPC-16`, OPEN**, with the measured evidence — NOT silently scoped into the
now-closed `CPC-13`.

### R2-C — the `writeGateEnumeration` witness was VACUOUS + binary (M2 / L4)

The cadence-editor case asserted `queryByText(en.cadenceHeading ?? '\x00')`. There
is **no `cadenceHeading` key** (the real one is `conveneCadenceHeading` = "Convene
cadence"), so `??` fell to a literal **NUL byte** the query could never match — and
the NUL made git classify the whole 5,294-byte file **binary** (`Bin 0 -> 5294`),
evading diff review. Proved: flipping that render to `canWrite={true}` (which DOES
mount the CadenceEditor) still passed 5/5. Fixed: query the real
`conveneCadenceHeading` key, sentinel dropped, NUL stripped (the file is text again
— a `101 insertions` diff). **The witness is now live** (the non-effect →
positive-control conversion): with `canWrite={false}` it passes; flipping to
`canWrite={true}` turns it RED because the heading mounts. Verified by sabotage.

### R2-D — the T3 roster predicate's blast radius NAMES notebooks (M3)

The D6 predicate widening (roster derived for any `type:'group'` with an `agent:`
seat, not only `boardId` metas) also catches **notebook chat rooms**, which the R1
enumeration under-named. Verdict, by call graph:

| Notebook path | Routes through `conversationExchange` speaker rule? | Verdict |
|---|---|---|
| **interactive chat room** — `${BASE}/:id/chat` seats exactly one `agent:` seat = the researcher (`notebooks/routes.ts:551-555`), turns go through the standard chat exchange | **YES** — `participantRosterOf` now returns `[researcher]`; the rule fires at `conversationExchange.ts:333` | the SEATED researcher IS in the roster ⇒ a normal researcher-addressed turn does **not** 422; only a turn addressed to a DIFFERENT agent would 422 (correct per RFC 0101 — the D6 Residual). A turn with no `to` has `answeringId=undefined`, so the rule does not fire either. **No latent break.** |
| **transform/tool persist** — `notebooks/agentTools.ts:122` `persistExchangedPair`, `:313` `appendWorkflowRunTurn` | **NO** — writes the turn through the persistence primitives DIRECTLY, bypassing `conversationExchange` | the widening is **INERT** on this path; no roster check runs. Speaker `scope.agentProfileId ?? RESEARCHER_AGENT_ID` is stamped without an `isParticipant` check. |

- **Witness:** `test/multi-party-conversation.test.ts` gains a notebook-shape case —
  `type:'group'` + `ownerSubject: projectSubject`, ONE researcher seat, no `boardId`
  ⇒ roster `[{agentId: researcher}]`, `isParticipant(roster, RESEARCHER)` true, a
  stranger false. Sabotage-proved (restore the `!meta.boardId ⇒ null` clause → the
  notebook case goes red, restore diff-verified). No fix needed — the interactive
  path is correct and the tool path is inert; the deliverable was the enumeration.
