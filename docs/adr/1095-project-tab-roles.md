# ADR 1095 — Project tabs by project role

Status: Accepted (2026-11-10). Implemented in the PR that records it.

Extends [ADR 1090](1090-project-tab-seam.md) (contributed project tabs) and [ADR 0054](0054-collaborative-project.md) (project membership). Frontend plus one read field; no wire RFC is involved.

## Context

A project's members carry a role: `lead`, `contributor` or `observer` (`features/projects/projectsService.ts:62`). Under ADR 0054 D2, a role is a label, never an RBAC scope.

A feature that adds a project tab (ADR 1090) may want it shown only to some members. Examples:
- an internal planning view hidden from an `observer`;
- a client-facing summary that only matters to one.

The page knows the caller's write access (`canWrite`) but not their role on the project.

## Boundaries audit

- **Authority stays where it is.** Access to a project is `resolveProjectAccess` (org scope plus visibility plus membership). Access for outside stakeholders is the ADR 0958 external-collaborator grants. This ADR changes neither. Showing or hiding a tab by role is presentation: each tab's reads keep their own backend checks, and the ADR says so in the type's docblock.
- **The role comes from one place:** the project's own `members` row for the caller (`user:<id>`). It is computed in the single-project read beside `canWrite`, by the same view function.

## Decision

### D1. `myRole` on the single-project read

`GET /projects/:id` (and the PATCH response) carries `myRole?: ProjectRole`: the caller's role on the project when they are a member, absent otherwise.

### D2. `ProjectTab.forRoles`

`forRoles?: ProjectRole[]` limits a contributed tab to callers whose `myRole` is listed.
- A caller with write access always sees every tab, so the people who run the project are never locked out of a view.
- Without `forRoles`, a tab shows to everyone who can open the project, as before.
- A deep link to a tab the caller can't see falls back to Overview (ADR 1090).

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `projects` (view field, page filter) and `registry.ts` (field) |
| 8 | RBAC | None changed. Presentation only; a tab's data keeps its own gates |
| 10 | Frontend | D2 |
| Others | — | None |

Tests:
- the read stamps the member's role and omits it for a non-member;
- a `forRoles` tab shows for a listed role, hides for an unlisted one, and always shows for a writer;
- the deep-link fallback.

## Grades (2026-11-10)

**UX — A.**
- A role-limited tab is filtered before the shared `Tabs` renders, so it never flashes in and out.
- A writer always sees every tab, so the people running a project are never locked out of a view.
- A deep link to a tab the caller can't see lands on Overview rather than an empty panel. All three are tested.
- Open: `U6UX-1` (Nice-to-have) no hint tells a writer which tabs are limited to a role. A small "visible to observers" note on the tab would help the people who set it up.

**Code — A.**
- `myRole` is computed in the same view function as `canWrite`, after its early return for internal callers (no subject means no role). It matches the exact member ref `user:<caller>`, so a user id that itself starts with `user:` still resolves (the ADR 1094 lesson).
- The page filter's memo depends on `canWrite` and `myRole`, so a role change re-filters.
- Tests: the read for a member and a non-member; the filter for a listed role, an unlisted one and a writer; the deep-link fallback.
- The type's docblock says the filter is presentation only.

**Workflows — not applicable, verified** (no chain, node or registration path). **AI exchange — not applicable, verified** (no tool, prompt or model call). A feature that limits a tab by role should give agent tools the same rule on the backend; that is the contributor's duty, as in ADR 1090.
