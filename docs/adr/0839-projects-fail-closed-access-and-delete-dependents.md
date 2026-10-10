# ADR 0839 — Projects: an absent caller reads nothing, a delete takes its dependents, and project writes are checked

Status: implemented (feature loop 2026-10 row 25, `feat/fl2-25-projects`; `/architect` pass before code; grade-ux and grade-code passes after — see the correction notes and the implementation record)

Feature loop 2026-10 row 25 (Projects + collaborative projects). Extends ADR 0046 (the project
subject), ADR 0054 (collaborative projects: members, visibility, D5 access rule), ADR 0608 (the
`subjectAccess` seam's read gate) and ADR 0643 KBC-1 (`subjectReadAllowed`, the fail-closed
no-subject rule). No new feature package, no toggle (`projects` stays always-on), host extension
only — nothing touches the OpenWOP wire.

## Context

The row-25 workflow grade (`docs/steward/WORKFLOWS-ASSESSMENT.md`, § "Projects + collaborative
projects — feature loop round 2 (row 25)", ids `PRJ3WF-`) re-measured round 1's B (projects A−,
collab B) at `557f95faa` and opened at C+.

1. **An absent caller is the tenant owner (`PRJ3WF-1`, was `CPC-6`).**
   `resolveProjectAccess` passes `callerSubject` to `resolveEffectiveAccess`, which answers an
   absent subject with the tenant-owner arm (`host/accessControlService.ts:1995`). `levelFor`
   (`features/projects/projectsService.ts:409`) then sees `workspace:write` and returns
   `'write'` — on a `private` project too. The `'project'` resolver on the seam passes the caller
   through (`features/projects/feature.ts:47`), and `isVisibleToAsync` asks the seam before its
   own anonymous deny (`host/conversationVisibility.ts:68-72`). Round 1 recorded this as
   "suspected; reachability not proved". It is reachable:
   - `features/strategy/surface.ts:128` hard-codes `undefined`, so every workflow run's strategy
     context gets private projects' name, status, health and milestones;
   - `routes/interrupts.ts:274-284` resolves the caller via `resolveCallerUser(...).catch(() =>
     null)`, which is `undefined` for an `apikey:` principal, so a member's `owk_` key is
     allowed on a private project's conversation;
   - `voice/realtime/routes.ts`, `work-selection` (route + surface) and the collab WebSocket
     cookie lane pass identities that are `undefined` for `owk_` keys or unbound OIDC sessions.
   KBC-1 already wrote the right rule — `subjectReadAllowed` refuses `subject === undefined` and
   its docblock (`host/subjectAccess.ts:110-130`) describes this exact fall-through — but only
   the KB and canvas lanes go through it.

2. **A project delete strands what other features own under it (`PRJ3WF-2`).** `deleteProject`
   cascades the board, schedules, memory, vectors, KB stamps and binding; the route adds the
   group conversation. Four kinds of row OWNED by the project are left, and every door to them
   asks the project, which no longer exists, so they are refused to everyone, admins included:
   project-owned canvases (undeletable — `canvasEditorRoutes.ts:372-375`), priority-matrix
   lists scoped to the project and their own project-owned boards, the team intent ledger and its
   deltas, and project-owned documents.

3. **A schedule can outlive its project (`PRJ3WF-3`, was `PRJWF-5`).** A create landing between
   `deleteProject`'s job listing and its row delete survives, fires forever (`fireJob` never
   checks the owner), and every door 404s it.

4. **Project writes are blind puts of a stale read (`PRJ3WF-4`).** `updateProject`,
   `addProjectMember`, `removeProjectMember`, `setProjectVisibility` and
   `setNotebookCollectionId` read the row and `put` a modified copy. Two concurrent member adds
   lose one. An edit that read before a delete and writes after it brings the row back, with
   its board and memory already gone.

5. **Demo-clear deletes projects by name (`PRJ3WF-5`).** `host/demoOpsPlanningSeed.ts:262-266`
   deletes any project whose name is in the demo list, so a user's project that happens to
   share one is deleted with its whole cascade.

## Boundaries audit

- **One access rule, two exits.** `levelFor` is the only implementation of the D5 rule;
  `resolveProjectAccess` and `listVisibleProjects` both call it. The seam
  (`resolveSubjectAccess`) is the single entry for every other feature. Fixing those two
  points covers every caller found; no caller is edited for correctness, only the strategy
  surface for intent (it should pass the run's actor, as its own comment claims it does).
- **Cascade seams already exist, but all fire AFTER the row is gone and swallow errors**
  (`host/canvasLifecycle.ts`, `conversationLifecycle.ts`, `rosterLifecycle.ts`). That contract
  is wrong for this case: a dependent's own gate needs the project to exist, so a purge that
  runs after the row delete and fails leaves the row stranded for good. The new seam runs
  BEFORE the row delete and propagates failure. It is a sibling of those seams, not a fourth
  copy of their contract.
- **Each dependent already has a full single-owner delete**: `deleteCanvasForTenant`
  (`host/canvasSurface.ts:476`, versions + idem + lifecycle fan-out incl. share links),
  `deleteList` (`priority-matrix/priorityMatrixService.ts:374`, board + scores + votes +
  sessions + intake + comments), `deleteDocument` (`documents/documentsService.ts:499`, versions
  + rendered assets + share links + retention hold). The team ledger has none; one is added in
  its own store. The seam calls these; it re-implements none of them.
- **CAS exists:** `DurableCollection.compareAndSwap` (`host/hostExtPersistence.ts:770`), used by
  `casRepoint` in the same file.

## Decision

**D1 — An absent caller resolves to `'none'`, at both exits.**
- `levelFor(p, access, undefined)` returns `'none'` before consulting `access`. So
  `resolveProjectAccess`, `listVisibleProjects` and `buildProjectContextBlock` refuse an absent
  caller.
- `resolveSubjectAccess(tenantId, subject, undefined)` returns `'none'` when a resolver is
  registered for the kind (a membership-scoped subject), and still `null` when none is. This
  is the KBC-1 rule moved one level down, so it covers every kind (projects and advisory
  boards) and every caller of the seam, including the ones that never route through
  `subjectReadAllowed`.
- `features/strategy/surface.ts` passes `scope.actingUserId` instead of `undefined`, matching its
  comment.
- The tenant-owner arm of `resolveEffectiveAccess` is NOT changed: an internal org-scope call
  with no member context is still the tenant principal (KBC-1's docblock explains why it is
  right there). Only the membership-scoped resolver stops borrowing it.
- **Consequence, stated:** a run with no acting user (schedule- or webhook-fired) can no longer
  read a project's conversation context, board ranking or charter through these doors. That is
  KBC-1's rule ("a system run has no membership") applied uniformly; it was already the
  behaviour of the KB lane.
- **Witness:** born-red on `origin/main` (`'write'` for an absent caller on a private project,
  through `levelFor` and through the seam), plus a ratchet that every registered
  `SubjectAccessResolver` kind answers `'none'` for an absent caller through the seam.

**D2 — A project delete purges the rows the project owns, before the row goes, and the confirm
says how many.**
- New host seam `host/subjectDependents.ts`: `registerSubjectDependent(kind, key, { count,
  purge })`, `countSubjectDependents(tenantId, subject)`, `purgeSubjectDependents(tenantId,
  subject)`. Keyed registration (a repeat boot overwrites). Unlike the lifecycle seams, `purge`
  failures PROPAGATE.
- Registrants (each feature declares the rows it writes under a project):
  - `canvas` (registered by projects, host function): canvases with `ownerSubject = project:<id>`
    → `deleteCanvasForTenant`;
  - `priority-matrix`: lists with `projectId = <id>` → `deleteList`;
  - `team-intent-ledger`: the ledger and its deltas → new `deleteLedgerForProject`;
  - `documents`: documents with `ownerSubject = project:<id>` → `deleteDocument`.
- `deleteProject` order: retention hold → **dependents** → board → schedules → memory →
  vectors → KB → row. A dependent failure throws before anything else is touched and the
  project stays, retryable.
- Only rows OWNED by the project are purged. A canvas merely TAGGED with `projectId` (no
  `ownerSubject`) stays readable by the org and is not deleted (deferred: its retention
  exemption in `app-builder/canvasRetention.ts:72`).
- `GET /projects/:id/delete-preview` (project write) returns `{ dependents: { canvases,
  priorityLists, documents, teamLedger } }`; the delete confirm names the non-zero counts, and
  says it could not count them when the read fails (never "nothing"). The DELETE receipt adds
  `dependentsDeleted`.
- **Witness:** born-red — delete a project that owns one of each; on `origin/main` all four
  survive. Ratchet: the set of registered `'project'` dependents equals the expected four.

**D3 — A schedule cannot outlive its project.** The double-check: `createProjectSchedule`
re-reads the project after `registerJob` and deletes its own job (404) if the project is gone;
`deleteProject` re-lists owned jobs after the row delete and removes any that landed. Whichever
side runs second sees the other. Born-red witness drives the interleaving.

**D4 — Project writes are compare-and-swap.** One helper `mutateProject(tenantId, id, fn)`:
read, apply, `compareAndSwap(expected, next)`, retry a bounded number of times, 404 when the
row is gone (so a write after a delete cannot resurrect it), 409 `conflict` on exhausted
contention. All five writers use it.

**D5 — Projects record their creator; demo-clear clears only its own.** `createProject` stamps
`createdBy` when an actor is known (the route's acting user; the seeder's `ACTOR`). Demo-clear
deletes a project only when its name is a demo name AND (`createdBy` is the seed actor, OR it
has no `createdBy` and its charter goal is the seeder's exact sentence — the rows already seeded
before this change). A user project with a demo name is never deleted. Re-running the seeder
skips by name as before, so already-seeded tenants get no duplicates.

## Alternatives weighed

- **Fix each caller to pass the right identity.** Rejected as the primary fix: six lanes today,
  more tomorrow, and each new one fails open by default. Kept for strategy only, where the
  caller is simply wrong.
- **Change `resolveEffectiveAccess`'s owner arm.** Rejected: it is correct for org-scope calls
  with no member context, and dozens of internal callers rely on it.
- **Refuse the project delete while dependents exist.** Rejected: it makes deletion a chore
  across four features, and the delete already destroys the board and chat. Competitor norm
  (Asana, Notion, GitHub repositories) is that deleting a container deletes its contents after a
  confirm that names them, which is D2.
- **Re-home dependents to the org.** Rejected: for a private project that publishes private
  content to every org reader.
- **Reuse the after-the-fact lifecycle seam.** Rejected for the reason in the audit.

## Matrix

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature package | `features/projects/**` plus one host seam; registrants in the owning features. |
| 2 | Toggle | none (always-on). Dependents register in `registerRoutes`, which runs regardless of toggle. |
| 3 | Workflow surface | unchanged; strategy surface now passes the run's actor. |
| 4 | Node pack | none. |
| 5 | AI chat / envelopes | none new; `openwop:projects.list` unchanged (already fails empty without an actor). |
| 6 | Agent pack | none. |
| 7 | Public surface | none. |
| 8 | RBAC | D1; `delete-preview` gated like DELETE (project write). |
| 9 | Replay / fork | no run-shaping state changes. |
| 10 | Frontend | delete confirm in `ProjectDetailPage` reads the preview; no new route. |

**RFC verdict:** host extension only. No wire change.

## Phased plan

1. D1 + witnesses (seam ratchet, `levelFor`, strategy surface).
2. D4 `mutateProject` + resurrect witness.
3. D3 schedule double-check + witness.
4. D2 seam, four registrants, preview route, receipt, frontend confirm, witnesses.
5. D5 creator stamp + demo-clear filter + witness.

## Open questions / deferred

- `interrupts` / voice / collab still resolve some identities as `undefined` for `owk_` keys and
  unbound OIDC sessions; after D1 those callers are refused rather than allowed. Making them
  resolve the real principal is a per-lane identity change, deferred to their rows.
- A canvas only tagged with a deleted `projectId` stays retention-exempt (`canvasRetention.ts:72`).
- `PRJWF-6` (no "runs of this project" surface), `PRJWF-7` (binding writes unserialized).
- Entities scoped to a private project are not membership-gated (entities row).

## `/architect` adversarial pass (2026-10-06, before code) — findings folded into the decision

Track A (host code, no wire). Each finding re-read at `file:line`.

1. **BLOCKER [DATA/PRIVACY] — D5 adds a personal-data field with no eraser.** `createdBy` holds
   the acting user's id. `eraseSubjectProjects` (`projectsService.ts:670`) redacts only
   `members[].ref`, so a DSAR would leave the creator's id on every project they made.
   **Folded:** the eraser redacts `createdBy` to `ERASED_USER_REF` with the same
   `matchesSubject` rule (including the double-prefix arm), counted in `rowsTouched`; the
   witness covers it. Demo-clear's `createdBy === ACTOR` filter is unaffected (the seed actor is
   not a data subject).
2. **HIGH [DATA INTEGRITY] — D2 must key every dependent by tenant AND owner, never by project
   id alone.** Project ids are random, but a lister that matched `ownerSubject.id` across the
   whole store would still be a prefix-by-id delete. **Folded:** each registrant lists inside the
   caller's tenant (`listCanvasesForTenant`-style projections, `listLists(tenantId)`,
   `listDocumentsForTenant`, the ledger's tenant-qualified key) and then filters on
   `ownerSubject.kind === 'project' && id === projectId`. Purges call the feature's own
   tenant-checked delete with the row's own `orgId`.
3. **HIGH [FAILURE MODES] — D2's partial failure must leave the project retryable, and a retry
   must converge.** **Folded:** dependents run first (after the hold), each purge deletes what
   it lists and is idempotent, and a throw aborts before the board/row cascade, so the project
   and its delete button survive and the second attempt finishes the job. The DELETE receipt
   reports per-dependent counts of what THIS call deleted.
4. **MEDIUM [PERF] — `documents:doc` has no tenant index** (`listDocumentsForTenant` is
   `docs.list()` filtered, `documentsService.ts:328`). The preview and the purge each pay one
   full scan. Accepted: both run only on an explicit delete (preview on confirm open), not on a
   hot path, and the documents row owns the index. Recorded, not fixed here.
5. **MEDIUM [BEHAVIOUR] — D1 changes three lanes from "allowed" to "refused", not only the
   attacker's.** (a) An `owk_` key held by a genuine project member can no longer act on that
   project conversation's interrupts, because the interrupts lane resolves an `apikey:`
   principal to `undefined` rather than to its issuer. (b) A run with no acting user loses
   project links in the strategy surface and project-owned conversation context. (c) The same
   seam rule applies to advisory boards (`'board'` kind). All three are the fail-closed side of
   one rule; each was previously allowed for EVERYONE, so there is no narrower correct answer
   without a per-lane identity fix. Recorded as product decisions and as deferred work.
6. **LOW [CORRECTNESS] — D4 CAS compares serialized bytes.** `compareAndSwap` byte-matches
   `JSON.stringify(expected)` (`hostExtPersistence.ts:770-787`), so `mutateProject` must pass
   the exact object `store.get` returned (not a spread copy) and re-read on every retry. Folded.
7. **Checked and cleared:** no legitimate caller of `levelFor` / `resolveSubjectAccess` relies on
   `undefined → owner` — every HTTP door passes `userId ?? principalId` (always defined when
   authenticated), every agent tool early-returns without an actor, and the three actorless lanes
   (`runStamp.ts:56`, `documents/surface.ts:48`, `gatePreview.ts:34`) either skip the check or
   only test existence and already fall back gracefully. `deleteNotebook` and the notebook-create
   rollback both go through `deleteProject`, so they inherit D2/D3 with no second wiring. No
   feature→feature cycle: registrants import only the host seam.

Status after the pass: **Accepted** — no open Blocker in the decision text.

## Correction notes (after code)

1. **D1 — the conversation-resolve lane needed the principal, not only a refusal (grade-code
   `PRJ3CD-2`).** The interrupts route resolves `callerUserId` with `resolveCallerUser`, which
   throws for an anonymous session and for an `apikey:` principal. Before D1 that `undefined`
   reached the project resolver as the tenant OWNER; after it, as nobody. That would have locked
   an anonymous demo visitor out of their OWN project's chat — the opposite of the goal. Rather
   than restore the fail-open, `isVisibleToAsync` now takes the caller's principal
   (`req.userId ?? principalId`, the spelling every other HTTP door passes) and hands it to the
   SEAM only when there is no canonical user; the participant/owner rule is unchanged. An `owk_`
   key therefore resolves through its issuer on this lane (§5a's "refused" holds only on the
   voice lane, `PRJ3CD-9`).
2. **D2 — the dependents purge also runs AFTER the row delete, best-effort (`PRJ3CD-4`).** The
   decision text ran it once, before the row; a dependent created in between was stranded. The
   second sweep cannot keep the delete retryable (the row is gone), so it logs instead of
   throwing, and its counts are added to the receipt.
3. **D2 — `deleteNotebook` deleted the corpus before `deleteProject` (`PRJ3CD-3`).** Once
   `deleteProject` could throw from a dependent purge (and it already could from the legal hold),
   that order destroyed a notebook's sources while the notebook survived. The corpus is now
   deleted only after the project delete lands.
4. **D2 overturned a pinned contract (`PRJ3CD-1`).** `kbc4-documents-ingest-to-kb-idor.test.ts`
   recorded "documents are not cascaded on project delete" as the premise for keeping a stranded
   document's PATCH exit. New strandings can no longer happen through the project door; the exit
   stays for documents stranded by earlier deploys, and that test now reproduces that legacy
   state explicitly.
5. **UI (grade-ux).** The preview read put an await before the shell-mounted confirm, so a second
   click could ask again — once after the project was already gone. The Delete button now runs
   one delete at a time and says "Checking…" / "Deleting…" (`PRJ3UX-1`).

## Implementation record

| Phase | Commit (subject) | Witness |
|---|---|---|
| D1–D5 service + seam | `fix(projects): fail-closed absent caller, delete dependents seam, CAS writes, schedule double-check, creator stamp (ADR 0839 D1-D5)` | `test/adr0839-projects-access-and-writes.test.ts` — 10 legs born red on `557f95faa` |
| D2 route + registrations | `test(projects): ADR 0839 D2 delete-dependents route witness (born red on main)` | `test/adr0839-projects-delete-dependents.test.ts` — all four dependents survived on `557f95faa` |
| D3 delete side | `test(projects): ADR 0839 D3 delete-side re-list witness` | sabotage of the re-list reddens it |
| D2 frontend | `feat(projects): delete confirm + receipt name the dependents other features lose (ADR 0839 D2)` | `deleteReceipt.test.tsx` |
| grade-ux | `fix(projects-ui): grade-ux row 25 — …` | `deleteReceipt.test.tsx` B1, `projectLedgerTab.test.tsx` B3/B4 (born red), `agentBoardReadOnly.test.tsx`, `projectSourcesReadOnly.test.tsx` |
| grade-code | `fix(projects): grade-code row 25 — …` | principal leg (sabotage reddens), failing-dependent retry leg, DSAR bridging leg, `kbc4` rewritten |

Sabotage witnesses (each guard removed in turn, the named leg went red): `levelFor` absent-caller
guard, the seam guard, the dependents purge, the schedule create re-check, the schedule delete
re-list, the CAS (`put` instead of swap), the principal hand-off.

Pack bumps: none. New routes: `GET /v1/host/openwop-app/projects/:id/delete-preview`. No wire change.
