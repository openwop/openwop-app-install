# ADR 0046 — The `project` subject (ADR 0045 Phase 3)

**Status:** implemented
**Date:** 2026-06-15
**Toggle:** none — **always-on** (§ Correction 2026-06-15: graduated off the `projects` toggle;
access stays org-scoped, so the toggle only ever gated visibility).
**Depends on / composes:** ADR 0045 (the Subject model — this is its Phase 3), ADR 0041
(subject memory — a project's memory is free), ADR 0025 (kanban owner), ADR 0006 (RBAC).
**Surface:** host-internal under `/v1/host/openwop-app/projects/*`. **Host-only — no RFC.**

## Why this exists

ADR 0045 said a new subject *kind* over the unified work surfaces should be nearly free. This
ADR proves it: a **`project`** — an org-scoped work container that owns a board, memory, and
assigned workflows — with **almost no new infrastructure**.

## Decision

A `Project { id, tenantId, orgId, name, workflows[] }` is a `kind:'project'` Subject. It owns:
- **board** — `ensureSubjectBoard(tenantId, {kind:'project', id})` via the generic `ownerSubject`
  field added to kanban (additive; no migration of existing boards). A project board's cards fire
  **workflows**, not agent turns (a project has no cognition — ADR 0045).
- **memory** — the `project:<id>` scope, served by the existing `subjectMemory` with **zero new
  code** (`subjectScope` already handles the kind). Add/list/delete under `/projects/:id/memory`.
- **workflows** — an entity-local array (mirrors `RosterEntry.workflows`).

**No authority of its own (ADR 0045 boundary).** A project is org-scoped; every route gates on the
*caller's* RBAC scope **in the project's org** (`workspace:read` to view, `workspace:write` to
mutate). The project is never an authenticated principal. Delete cascades its board + memory.

## What this validated

`kind:'project'` reached production behavior through the subject model with only: a thin
`Project` entity/service, an additive `ownerSubject` board field, and routes. Memory was free;
the board rode the generic owner. That is the ADR 0045 thesis, demonstrated.

## Read-privacy model (code-review clarification → CLOSED)

Project **metadata** (name/orgId/boardId) is **org-scoped**: list + `GET /:id` require the caller's
`workspace:read` in the project's org, and a caller without it gets a uniform 404 (no existence leak).

**Board content is now org-scoped too (the gap is closed).** Previously a project's board (cards) was
*tenant-visible* — kanban `/boards/:id` gated only on tenant membership, so any tenant member with the
board id could read the cards. Now `routes/kanban.ts` `authorizeBoard` DERIVES the board's owning org
from its `ownerSubject` (a `kind:'project'` board → the project's current `orgId`) and gates on the
caller's scope IN that org: `workspace:read` to view (else uniform 404, no existence leak),
`workspace:write` to mutate (rename/delete/cards). The board LIST + `?include=cards` likewise drop
org-scoped boards the caller can't read.

The org is DERIVED, not stored — a host seam `host/subjectOrgScope.ts` (`setSubjectOrgResolver` /
`resolveSubjectOrg`) that the projects feature FILLS at boot (the same way `kb` fills
`setKnowledgeBackend`). So `core` (kanban) never imports a `feature` (projects), there is no per-board
`orgId` to migrate/backfill (existing project boards are protected immediately), and the board's org can
never drift from the project's. A subject with no resolver (`agent`/`user`) returns `null` ⇒ NOT
org-scoped ⇒ the legacy tenant/personal board visibility (ADR 0025) is preserved unchanged. The ADR 0049
D4 assignee carve-out also survives: `authorizeBoard` returns `null` (not 403) on insufficient scope, so
`authorizeCard` still falls through to per-card assignee access.

The per-card surfaces are org-gated too (code-review follow-up): **claim** (`POST /cards/:id/claim`) is a
write — on an org board it requires `workspace:write` in the org (was tenant-membership, a leak); the
**inbox** (`GET /assigned`) drops *role-addressed* cards on org boards the caller can't read, while a
*direct* assignee always keeps theirs (the D4 carve-out). So org-scoping covers board reads, board/card
writes, claim, and the assignment inbox — the only cross-org reach left is an explicit direct assignment.

*Deferred:* the 403-vs-404 nuance (a project *viewer* attempting a write currently gets a safe 404, not a
403 like the project routes give) — fail-closed and leak-safe, just less precise; refine if a UX need arises.

## Open questions

- **Org-private board content** — DONE: kanban board visibility is org-scoped via the
  `host/subjectOrgScope` seam (see the read-privacy model above). A project's board cards are no longer
  tenant-visible; agent/personal boards (ADR 0025) keep their tenant/owner visibility.
- **Project schedules.** DONE: the same additive generic owner the board got. `ScheduledJob` gains an
  optional `ownerSubject?: Subject` (alongside the legacy `rosterId`/`ownerUserId`, no migration), and
  `scheduleSubject(job)` now prefers it — so a `project:<id>` owns cron jobs on the ONE scheduler
  (`host/schedulingService.ts`), no parallel scheduler. `features/projects/projectScheduleService.ts`
  composes create/list/update/delete over the shared `listJobsForSubject` + `registerJob({ownerSubject})`;
  routes `/:id/schedules[/:jobId]` gate on org scope (read to list, write to create/patch/delete) with
  cross-project/cross-tenant IDOR fail-closed via `scheduleSubject`. `deleteProject` cascade deletes the
  project's jobs (host scheduler fns directly — no feature→feature cycle). UI: a fourth **Schedules** tab
  on `/projects/:id` (`ProjectSchedulesTab`).
  - *Follow-on — DONE:* the three near-identical schedule UIs (`ProfileSchedulesTab` /
    `AgentSchedulesPanel` / `ProjectSchedulesTab`) were collapsed into one shared
    `<SubjectSchedulesPanel>` (`src/schedules/`) — the way knowledge got `<SubjectKnowledgePanel>`. Each is
    now a thin wrapper supplying a `client` (CRUD + optional `trigger` — projects omit "Run now") + the
    `workflows` portfolio + subject `copy`; ~549 → ~340 lines, behaviour-identical. Registered in
    `DESIGN.md §5`.
  - *Run attribution (post-review):* when a project schedule fires, the daemon stamps the canonical owner
    onto the run as `metadata.schedule.ownerScope = subjectScope(scheduleSubject(job))` (so a project-fired
    run isn't anonymous), alongside the legacy `rosterId`/`ownerUserId` for back-compat. No project-runs
    surface CONSUMES that marker yet — `recordRunAttribution` is the agent-only activity index (keys on
    `rosterId`). A "Runs fired by this project" view is a deferred follow-on; the data is already on the run.
- **Project knowledge (documents).** DONE: generalized the same way subject-memory generalized
  memory. A new host-owned `host/subjectKnowledge.ts` keys a `SubjectKnowledgeBinding` on
  `${tenantId}:${subjectScope(subject)}` — a generic binding store reusable by any subject, so the
  binding no longer lives per-entity on `Profile`/`agentProfile`. `features/projects/projectKnowledgeService.ts`
  binds KB collections (a reference, no bytes on the project) + composes them with the project's
  `project:<id>` memory through the SHARED `resolveSubjectKnowledgeRetrieve` (ADR 0042). Routes under
  `/:id/knowledge/*` gate on the caller's org scope: `workspace:read` in the project's org to
  view/retrieve; **`workspace:write` in the project's org to bind/unbind/create-bind** a collection
  (mutating the binding set is a project mutation — symmetric with the memory surface, so a read-only
  collaborator can't change what the project's agents/workflows retrieve — *corrected post-review; the
  bind/create routes first shipped at project-read, an authz gap*); ingest/delete of a document edits the
  already-bound KB collection and needs project-read + `workspace:write` IN the doc's org.
  `deleteProject` cascade clears the binding. UI: a third **Knowledge** tab on
  `/projects/:id` via the SHARED `<SubjectKnowledgePanel>` (extracted from the profile Knowledge tab, so
  one browser now serves both person and project).
- **Projects UI** — DONE: `/projects` list/create + `/projects/:id` detail (Board tab via the shared
  `<AgentBoardPanel>` board renderer, Memory tab via `<MemoryBrowser>`, Knowledge tab via
  `<SubjectKnowledgePanel>`, Schedules tab via `ProjectSchedulesTab`), nav-gated on the `projects`
  toggle; reuses the shared `ui/` primitives — no bespoke board/memory/knowledge UI.

## Implementation status

| Phase | Status | Commit / test |
|---|---|---|
| project entity + board + memory + workflows + routes | implemented | `features/projects/*`, `ensureSubjectBoard`, `ownerSubject`; `projects-route.test.ts` |
| project UI (list/create + board/memory/knowledge/workflows/schedules tabs) | implemented | `features/projects/{ProjectsPage,ProjectDetailPage,routes}.tsx`, `knowledge/SubjectKnowledgePanel.tsx`, `features/projects/{ProjectWorkflowsTab,ProjectSchedulesTab}.tsx` |
| project knowledge (generic subject binding) | implemented | `host/subjectKnowledge.ts`, `features/projects/projectKnowledgeService.ts`; `projects-route.test.ts` knowledge block |
| project schedules (generic `ownerSubject` on scheduler jobs) | implemented | `host/schedulingService.ts` (`ownerSubject` + `scheduleSubject`), `features/projects/projectScheduleService.ts`; `projects-route.test.ts` schedules block |
| org-scoped board visibility (read-privacy gap closed) | implemented | `host/subjectOrgScope.ts` seam (projects fills it), `routes/kanban.ts` `authorizeBoard`/list filter; `projects-route.test.ts` board read-privacy block |
