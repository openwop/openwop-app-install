# ADR 1094 — A paged portfolio read across projects

Status: Accepted (2026-11-10). Implemented in the PR that records it.

Extends [ADR 0054](0054-collaborative-project.md), [ADR 1091](1091-project-health-providers.md) and [ADR 1093](1093-project-detail-tool.md). Host extension only, so no wire RFC is involved.

## Context

`GET /projects` returns every project the caller can see in one response (`features/projects/routes.ts`, bounded by `PROJECT_CAP` = 200 per tenant).
- It has no paging and no filter by org, lead or status.
- It doesn't carry the computed health (ADR 1091 left lists to P2).
- `openwop:projects.list` gives agents the same shape.

A principal's overview of a busy studio needs one page at a time, filtered, with health and the next milestone on each row. Today that means one read per project.

## Boundaries audit

- **Route collision:** `GET /projects/portfolio` would be captured by `GET /projects/:id`, because Express matches the first registered route. The new route is registered before `/:id`, and a test pins it.
- **One visibility rule:** rows come from `listVisibleProjects` (ADR 0054 D5), the same scan the list route uses. A private project the caller isn't a member of never appears.
- **Health is ADR 1091's:** each row calls `resolveComputedProjectHealth`, at most `PORTFOLIO_CONCURRENCY` (5) rows at a time. Each provider call is already time-boxed, so a page waits on at most its slowest few providers.

## Decision

### D1. The read

`GET /host/openwop-app/projects/portfolio`. Query parameters:
- `orgId?`;
- `lead?` (`me` or a subject);
- `status?` (one of the charter statuses);
- `cursor?` (an offset a previous page returned);
- `limit?` (1 to 100, default 25).

Archived projects are left out unless `status=archived`. Rows are sorted by name.

Each row carries:
- `id`, `name`, `orgId`, `status` and `access`;
- `health: { manual, computed? }`;
- `lead: { ref, name }?`, from the member with role `lead`, named from the org directory;
- `memberCount`;
- `nextMilestone: { title, dueDate }?`, the earliest open milestone with a date.

The response also carries `total` and `nextCursor?`. An invalid `limit`, `cursor` or `status` is a 400 naming the field.

### D2. The agent tool

`openwop:projects.portfolio` takes the same filters and returns the same page. It needs an acting user (`lead: "me"` is that user), is `untrusted`, and is allowlisted for the chief of staff (`vendor.openwop-app.assistant.agents` 1.0.7).

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `projects` (`portfolio.ts`, route, tool) |
| 2 | Toggle | None (projects is always on) |
| 5–6 | Chat, agents | D2 |
| 8 | RBAC | The visibility scan; `workspace:read` in each project's org is what makes it visible |
| 9 | Replay | Read only |
| 10 | Frontend | None in this ADR. The projects page can adopt the read for paging later |

## Phased plan

| Phase | Work |
|---|---|
| P1 | D1 and D2, with tests: paging and totals, filters (org, lead `me`, status, archived), computed health on rows, the next milestone, a private project hidden, invalid inputs, route order against `/:id`, the tool and its refusal without an acting user, and the ratchets |

## Grades (2026-11-10)

**Code — A.**
- One visibility rule (`listVisibleProjects`), with filters applied after it, so a filter can't widen what a caller sees. A private project stays hidden (tested).
- Inputs are validated by field (`limit`, `cursor`, `status`, `lead: me` without a person), with 400s tested.
- Health providers run with bounded concurrency (`PORTFOLIO_CONCURRENCY` = 5), each still time-boxed by ADR 1091, so a 100-row page can't fan out unbounded.
- Org directory names are read once per org per page.
- The route is registered before `/:id`, which would swallow "portfolio". Every route test exercises the order.
- Fixed in grading: the lead filter stripped the `user:` prefix from the caller. A member ref is `user:` plus the user id, and an id can itself start with `user:`, so `lead=me` matched nothing. It now matches the bare subject or a full ref, and the test that caught it stays.
- Open: `U5C-1` (Improvement) the page sorts the whole visible set in memory, bounded by `PROJECT_CAP` (200). A larger cap needs an indexed scan.

**UX — not applicable** (no screen in this ADR). **Workflows — not applicable, verified** (no chain, node or registration path).

**AI exchange — A (pattern B).**
- The tool is the route's own read, so the model and the screen see the same rows.
- The input schema's `status` enum is the service's `STATUSES`, and the description names every returned field, including `total` and `nextCursor` for paging.
- Typed refusals (`acting_user_required`, `validation_error` with the reason) are tested.
- The chief of staff's allowlist and prompt carry it (pack 1.0.7). The reach ratchet and the census pin it.
- Open: `U5AI-1` (Nice-to-have) a principal asking "which projects are at risk?" filters client-side today. A `health` filter (by computed or manual level) would save a page walk.
