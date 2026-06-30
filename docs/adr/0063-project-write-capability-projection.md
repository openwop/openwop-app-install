# ADR 0063 — Project write-capability projection (pre-gate write controls)

**Status:** Accepted
**Date:** 2026-06-17
**Toggle:** none — the projects surface is always-on (ADR 0054 §Correction).
**Capability:** no new `AgentCapabilityId`; this projects the caller's existing RBAC
`workspace:write` (ADR 0006) into the project read so the FE can pre-gate.
**Depends on / composes:** ADR 0054 (collaborative project — D2/D5 *visibility ≠
authority*; write is `workspace:write` in the project's org, never membership),
ADR 0045 (Subject model — a Subject confers no authority), ADR 0006 (RBAC scopes /
`resolveEffectiveAccess`). Reuses the existing `resolveProjectAccess` seam
(`features/projects/projectsService.ts`) — the SAME function `requireProject` gates on.
**Surface:** host-internal, under the existing always-on `/v1/host/openwop-app/projects/*`.
**RFC gate:** **NO new RFC.** Host-extension only — no wire field on `/v1/*`, no
capability flag, no normative MUST. Additive response field on a non-normative route.

## Why this exists

ADR 0054 made the project **Members** + **Chat** surfaces always-on (graduated off the
`project-collab` toggle, 2026-06-16). Per ADR 0054 D5, *visibility ≠ authority*: a project
**member** can READ the project, but WRITE always requires `workspace:write` in the
project's org — membership never grants it. So "is a member" and "can write" are genuinely
different sets.

The frontend conflated them. Every project write control — Delete, Edit/Save charter,
Add/Remove member, the Org-visible/Private toggle, Open chat + Save cadence, Assign/Unassign
workflow, and the embedded memory/knowledge/schedule write actions — rendered
**unconditionally**. A read-only member (or org viewer) saw the affordance and got a **403 on
use**. Graduating the tabs to always-on made that reachable for every project reader in prod.

This is the **show-then-403** anti-pattern. The fix is to pre-gate on a known capability so
non-writers don't see controls they can't use.

## Decision

**Project the caller's effective write access in the read; the FE consumes it.**

1. **Backend projection.** The project read projection (`view()` in `routes.ts`) gains an
   additive `canWrite?: boolean`, computed as `resolveProjectAccess(tenant, id, caller) ===
   'write'`. This is the **same** function the write gate uses, so the FE never re-derives the
   org-authority/visibility/membership rule (no-parallel-architecture). Applied to the per-id
   GET, the access-scoped LIST, and the POST/PATCH responses.

2. **Frontend gate.** `ProjectDetailPage` reads `project.canWrite` (fail-closed: absent ⇒ no
   write) and threads it to every tab; the page hides Delete and shows a one-line "read-only
   access" `<Notice>`. Each tab **hides** its primary create/destroy affordances for
   non-writers (and disables the inline visibility toggle). The shared
   `MemoryBrowser` / `SubjectKnowledgePanel` / `SubjectSchedulesPanel` gain an optional
   `readOnly` prop (default `false`, so agent/profile surfaces are unaffected); the project
   tabs pass `!canWrite`. The projects **list** page (`ProjectsPage`) likewise hides its
   *Create project* form unless the caller holds `workspace:write` in the active workspace
   (`getEffectiveAccess` — the workspace write union; the backend still re-checks per-org, so
   a multi-org caller who picks a non-writable org is rejected fail-closed).

3. **The FE gate is a UX hint ONLY.** `requireProject('workspace:write')` remains the
   authority on every write route, unchanged. Hiding a button is never the access control —
   the server still rejects a forged write with 403. The projection just stops surfacing dead
   affordances.

### Why projection over FE recompute

The alternative — the FE calling `getEffectiveAccess()` and checking `scopes.includes(
'workspace:write')` for the project's org — would duplicate the *visibility ≠ authority* rule
on the client and drift from `resolveProjectAccess`. Surfacing one boolean from the single
source of truth keeps the rule in one place.

## Scope (deliberate)

Applied to the **projects** feature only. The same show-then-403 pattern exists on agent
workspaces and orgs admin; this ADR establishes the projection pattern but does not
retrofit it everywhere. Generalizing `canWrite` to all subject-owned surfaces (agents,
projects) is a tracked follow-up, not this change. The embedded **board** (`AgentBoardPanel`)
keeps its own access story via the kanban `subjectAccess` seam and is out of scope here.

## Phased implementation

| Phase | Files | Gate |
|---|---|---|
| 1 — backend projection | `features/projects/routes.ts` (`view()` + threading `actingUserOf`), `projectsClient.ts` (`Project.canWrite?`) | `projects-route.test.ts`: org-writer read ⇒ `canWrite:true`; read-only private member ⇒ `canWrite:false` |
| 2 — page + tab gating | `ProjectDetailPage`, `ProjectOverviewTab`, `ProjectMembersTab`, `ProjectChatTab`, `ProjectWorkflowsTab`, `ProjectSchedulesTab` | `npm run build` (tsc) |
| 3 — shared-panel `readOnly` | `MemoryBrowser`, `SubjectKnowledgePanel`, `SubjectSchedulesPanel` (opt-in prop; agent/profile defaults unchanged) | existing agent/profile panel behavior unaffected |
| 4 — tests + docs | `projects-route.test.ts`, FEATURES / DESIGN / CHANGELOG / this ADR | `npm run ci` green |

## Risk / invariants

- **Security:** the server gate is untouched; this only hides affordances. A reviewer MUST
  confirm no `requireProject('workspace:write')` is removed or softened.
- **Cross-surface:** `readOnly` defaults to `false` on the shared panels, so agent-workspace
  and My-Profile surfaces are byte-for-byte unchanged.
- **Staleness:** `canWrite` is fetched with the project; a mid-session role change is stale
  until refetch — acceptable (the server gate is still live).
- **Replay / BYOK / wire:** none — host-ext read projection only.

## Open follow-ups

- Generalize the `canWrite` projection (or a `subjectAccess` projection) to agent + other
  subject-owned surfaces, retiring show-then-403 app-wide.
- A read-only path to *open* the project group chat (today's `ensureProjectChat` is
  write-only because it reconciles the lineup), so read-only members can view the room.
