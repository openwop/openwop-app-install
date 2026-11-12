# ADR 1092 — Project-scoped knowledge search for agents, and approved memory writes

Status: Accepted (2026-11-10). P1 (D1) and P2 (D2) are implemented.

Extends [ADR 0046](0046-project-subject.md) and [ADR 0054](0054-collaborative-project.md). Follows the read-tool seam the projects feature already uses for `openwop:projects.list` (`features/projects/agentTools.ts`). Host extension only, so no wire RFC is involved.

## Context

An agent can search the workspace's knowledge (`openwop:knowledge.search`, `host/agentToolProvider.ts`) or the collections bound to its own profile, but not one project's.

The project chat grounds each turn in the project's bound collections and memory. A specialist agent working across projects (a principal's assistant, an adopter's studio agent) can't ask "what does this project's record say about X?" without searching everything.

The project already has the right read: `retrieveForProject` (`features/projects/projectKnowledgeService.ts:194`) composes the project's bound documents and its memory, and reports sources that failed.

Agents also can't write project memory. Today memory is written only by a person on the Memory tab, or by the agent's own turn summary.

## Decision

### D1. `openwop:projects.knowledge.search`

A read tool: `projectId`, `query`, optional `resultLimit` (1 to 20, default 6).
- **Gate:** an acting user who can read the project (`resolveProjectAccess`). A missing project and a hidden one answer the same `not_found`.
- **Result:** the chunks, each `kb` or `memory` with its `contentTrust`, plus `hasResults` and `failedSources`, so an empty answer is never mistaken for "nothing there".
- **Trust:** `contentTrust: 'untrusted'`, so the host fences it.

### D2 (P2). Approved memory writes

A write tool, `openwop:projects.memory.propose` (`projectId`, `text`), files a pending memory proposal on the project. It doesn't write memory.
- A person with write access approves or dismisses the proposal on the Memory tab; approval adds the memory fact.
- Proposals name the proposing agent and are erased with the project.

This follows the propose → review → apply shape of ADR 0473 rather than the per-conversation approval scope (ADR 0132), because a project's memory outlives any one conversation.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `projects` (`agentTools.ts`) |
| 2 | Toggle | None (projects is always on) |
| 5–6 | Chat, agents | A feature agent tool; any agent pack may allowlist it |
| 8 | RBAC | Acting user plus project read access; uniform not-found |
| 9 | Replay | Read only |
| 10 | Frontend | None in P1; the Memory tab's proposal list in P2 |

## Phased plan

| Phase | Work |
|---|---|
| P1 | D1, with tests: results from bound docs and memory, refusals (no acting user, no id, a private project, a missing one), the ratchets (`safe-mode-baseline-census`, `schema-read-exemption-completeness`) |
| P2 | D2: the proposal store, routes, the tool, the Memory tab's review list, and erasure |

## Grades (2026-11-10, P1)

- **AI exchange — A (pattern B).**
  - `retrieveForProject` is the same read the project chat grounds on, so the tool and the chat can't disagree.
  - Chunks keep their `kind` and `contentTrust`, and `failedSources` keeps a failed source from reading as "nothing there".
  - The description tells the model when to prefer it over the workspace search, and the chief of staff's allowlist and prompt carry it.
- **Code — A.** Shared gate, bounded `resultLimit`, empty query refused (tested).
- **UX and workflows — not applicable** in P1. The P2 memory-proposal review on the Memory tab gets its own UX grade.

## Grades (P2, 2026-11-10)

**UX — A.**
- Pending proposals sit above the Memory list in a labelled card, with a heading that counts them and a line saying they become memory only when someone approves.
- A writer gets Approve and Dismiss; a reader sees the proposals without buttons.
- Nothing shows when none are pending. A failed read says so, with Retry, rather than hiding.
- Approving reloads the memory list, so the new fact appears at once. Four locales.
- Fixed in grading: every row's buttons had the same accessible names ("Approve", "Dismiss"). Each button is now described by its proposal's text (`aria-describedby`), so a screen reader says which one it acts on.
- Open: `U3UX-1` (Nice-to-have) the card doesn't say which agent proposed each fact. The proposer is an id today; a display name needs the roster lookup.

**Code — A.**
- Proposing is idempotent: the same pending text files once. A cap of 20 pending applies.
- Deciding goes through compare-and-swap. A decided proposal answers 409, an unknown decision 404, and a reader 403 (all tested). Only a writer reaches it (`requireProject(…, 'workspace:write')`).
- Proposals are a project dependent (`registerSubjectDependent`), deleted with the project (tested). They carry a subject eraser that the census sees through `createdBy`.
- Fixed in grading:
  - A failed note write after "approved" left a proposal approved with no memory. The decision now reverts and the error surfaces.
  - An erased person's pending proposal kept `pending` with "[erased]" text and could be approved into memory. Erasure now also dismisses it (tested).
  - Decided proposals grew without bound. Proposing now prunes past the 50 kept.
  - An inline-regex route parameter, which Express 5 drops, was replaced by a checked parameter.

**Workflows — not applicable, verified** (no chain, node or registration path).

**AI exchange — A (pattern B with a gated apply).**
- The model's write reaches project memory only through a person's approval: the propose → review → apply shape of ADR 0473.
- The description tells the model it isn't saved yet and to say so. The safe-mode census records why it needs no per-call ask.
- The chief of staff's allowlist and prompt carry it (pack 1.0.8).
