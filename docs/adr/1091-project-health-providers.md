# ADR 1091 — Project health providers

Status: Accepted (2026-11-10). P1 (D1–D3) is implemented in the PR that records it; P2 remains.

Extends [ADR 0046](0046-project-subject.md) (the project charter) and [ADR 0054](0054-collaborative-project.md) (project access). Follows the provider-registry pattern of `host/chatSubjectContextProviders.ts`. Host extension only, so no wire RFC is involved.

## Context

A project's health is a value a person picks (`ProjectCharter.health`, `features/projects/projectsService.ts:48`, `on-track | at-risk | off-track`). Nothing computes it, so it is right only as long as someone remembers to change it.

A feature that holds a project's real records has no seam to say what they mean for the project's health. A schedule, approvals or orders, or a white-label adopter's domain records are all examples.

## Boundaries audit

- **One owner of health:** the projects feature owns the charter and its `health` field. This ADR doesn't add a second health field. It adds a computed reading next to the manual one.
- **No route collision:** the projects routes have no `/:id/health` (`features/projects/routes.ts`: `/:id`, `/delete-preview`, `/memory`, `/knowledge`, `/schedules`, `/members`).
- **Reuse:**
  - the gate is `requireProject(req, 'workspace:read')`, the same read access and uniform 404 every project-owned surface uses (`routes.ts:93`);
  - the registry copies `registerChatSubjectContextProvider`: idempotent by id, run in registration order, and a provider's failure is logged and skipped, never fatal.

## Decision

### D1. The registry

`host/projectHealthProviders.ts`:

```ts
interface ComputedProjectHealth {
  level: 'on-track' | 'at-risk' | 'off-track';
  /** One sentence a person can act on. */
  reason: string;
  /** Who computed it, shown to people: the providing feature's name. */
  source: string;
  /** The day the reading is for (YYYY-MM-DD). */
  asOf: string;
}
type ProjectHealthProvider = (req: { tenantId: string; project: Project; callerUserId?: string }) => Promise<ComputedProjectHealth | undefined>;
registerProjectHealthProvider(id, fn);
resolveComputedProjectHealth(req): Promise<{ computed?: ComputedProjectHealth & { providerId: string }; failed: string[] }>;
```

The first provider in registration order that returns a reading wins. Each call has a 2-second budget (`PROVIDER_TIMEOUT_MS`); a provider that runs over is skipped and named in `failed`, so a project read never waits on a hung provider. A provider returns nothing for a project it doesn't know, or when the caller may not read its records; it applies its own toggle and access. Its output is validated: an unknown `level`, or an empty `reason` or `source`, is treated as no reading and logged.

### D2. The route

`GET /host/openwop-app/projects/:id/health`, behind project read access, returns:

```json
{ "manual": "at-risk" | null, "computed": { "level", "reason", "source", "asOf", "providerId" } | null, "failed": ["providerId"] }
```

`manual` is the charter's value. It stays the override and is never written by a provider.

The single-project read (`GET /projects/:id`, and the `PATCH` response) also carries the reading as `computedHealth`, so the detail page needs no second request. The list does not, to avoid one provider call per row (P2 batches it).

### D3. The Overview

The Overview tab shows the computed reading beside the manual chip: a chip for the level, then its reason and source ("from …"). When both exist and disagree, it says so ("Set by hand: on track"). With no reading, nothing new shows; the manual chip stays as today.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `projects` (route, Overview); `host/projectHealthProviders.ts` (registry) |
| 2 | Toggle | None new; each provider applies its own |
| 3 | Workflow surface | None in P1; a chain reads the route through the providing feature's own nodes |
| 4–7 | Nodes, chat, agents, public | None |
| 8 | RBAC | Project read access (uniform 404); providers re-check their own records |
| 9 | Replay | Read only |
| 10 | Frontend | D3, four locales |

## Phased plan

| Phase | Work |
|---|---|
| P1 | D1 to D3. Tests: first provider wins, a throwing provider is skipped and named in `failed`, an invalid reading is dropped, the route's access (a private project's non-member gets 404), the Overview showing computed beside manual and the disagreement line |
| P2 | Project lists (the projects page, dashboard tiles) show the computed level, batched |

## Alternatives weighed

- **Let a feature write `charter.health`.** That loses the person's own judgement, and two features would overwrite each other.
- **Store a computed field on the project.** It goes stale between writes. Computing on read is cheap for one project; lists are P2.

## Open questions

1. With more than one provider, should the worst reading win, rather than the first? P1 keeps registration order, which is predictable; a deployment usually has one.

## Grades (2026-11-10, P1)

**UX — A.**
- The computed reading sits in the charter's lineup as a labelled group: "Computed:", a level chip from the shared `HEALTH_CHIP` mapping, then the reason and "(from source)".
- When the two values disagree, a "Set by hand: …" line keeps the person's override visible. It also shows on a project with no charter yet.
- With no reading, nothing new appears, so a deployment without providers looks as it did.
- Four locales.
- Fixed in grading:
  - an `aria-label` on a plain `div` (prohibited without a role) is now `role="group"`;
  - the computed chip looked identical to the manual one, so it now carries a visible "Computed:" prefix.
- Open: `U2UX-1` (Improvement) project lists and cards don't show the computed level yet (P2).
- Click-through: both chips at 375 px wrap without truncating the reason.

**Code — A.**
- The registry is the `chatSubjectContextProviders` shape: idempotent by id, registration order, failures logged and named rather than thrown.
- Output is validated before use: level from the enum, non-empty reason and source, `asOf` a date, and the reason trimmed and capped at 500 characters.
- The route sits behind `requireProject(req, 'workspace:read')`, the uniform 404 every project surface uses (tested: a private project's non-member, a missing id).
- The reading rides the single-project GET and PATCH, not the list, so there is no per-row provider call.
- Fixed in grading: a provider had no time limit and a hung one would stall every project page. Each call now has a 2-second budget (tested with fake timers).
- Tests: the backend legs (first wins, failures named, idempotent id, invalid dropped, access, single-read carry, timeout, bounds) and the Overview legs.
- Open: `U2C-1` (Improvement) providers run one after another. With several, run them concurrently and keep the first in order.

**Workflows — not applicable, verified.** The change is a host registry, one route, a field on the project read and the Overview line. Searching the diff for `registerWorkflow`, `builtinWorkflows`, `registerHostWorkflow`, `workflow-chain` and `WorkflowDefinition` finds nothing. No chain, node or registration path changes.

**AI exchange — not applicable here, verified, with one gap.** The diff adds no prompt, tool, node, envelope or model call (no `registerFeatureAgentTool`, no `callAI`). Agents don't see the computed reading yet: the project-chat charter summary (`projectsService.ts`, the convener's "Status · Health" line) still shows only the manual value.
- Open: `U2AI-1` (Exchange gap) carry the computed level and reason into the charter summary, or rely on U4 (the project detail tool, ADR 1093) to read it. U4 is preferred: the per-turn summary shouldn't wait on providers.
