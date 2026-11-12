# ADR 1093 — `openwop:projects.get`, one project for agents

Status: Accepted (2026-11-10). Implemented in the PR that records it.

Extends [ADR 0046](0046-project-subject.md), [ADR 0054](0054-collaborative-project.md) and [ADR 1091](1091-project-health-providers.md). Host extension only, so no wire RFC is involved.

## Context

`openwop:projects.list` gives an agent each project's id, name, goal and status. To work on one project, an agent needs what a person sees on its Overview:
- the charter (objectives, brief, dates, milestones, the health a person set);
- the members and the bound workflows;
- since ADR 1091, the computed health and its reason.

No tool returns that.

## Decision

A read tool, `openwop:projects.get` (`projectId`), behind the same gate as ADR 1092 D1: an acting user who can read the project, and one `not_found` for missing and hidden projects.
- It returns name, visibility, the caller's access, facet, charter, members (ref and role), workflows, and the ADR 1091 computed health when a provider has one.
- It is `contentTrust: 'untrusted'`, because charter text is written by people.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `projects` (`agentTools.ts`) |
| 8 | RBAC | Acting user plus project read access; uniform not-found |
| 9 | Replay | Read only |
| Others | — | None |

Tests: the full read for a member, the computed health when a provider answers, the refusals, and the ratchets.

## Grades (2026-11-10)

- **AI exchange — A (pattern B).**
  - A live read with a typed input. The description names every returned field. `untrusted`.
  - The chief of staff's allowlist and prompt both name it (`vendor.openwop-app.assistant.agents` 1.0.6). The reach ratchet and the census pin it.
  - Fixed in grading: members came back as raw refs (`user:…`), which a model can't name. They now carry the org directory's display name.
- **Code — A.** One gate shared with ADR 1092 D1 (`readable`), and refusals typed and tested (no acting user, no id, missing, private). Open: `U4C-1` the directory read on each call; cache per turn if it shows up in traces.
- **UX — not applicable** (no screen). **Workflows — not applicable, verified** (no chain, node or registration path).
