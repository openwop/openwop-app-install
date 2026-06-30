# ADR 0133 — Run/task deck (a projection of pending, blocked, and delegated work)

**Status:** implemented — all 4 phases (2026-06-24). P1 the `run.metadata.parentRunId`/`delegatedBy` linkage stamp in `subRunDispatcher` (+ the `bootstrap/nodes.ts` call site); P2 the pure `taskDeckProjection` read-model (`features/task-deck/taskDeckProjection.ts` — buckets + parent/child grouping + blocked join, no tasks table); P3 the `GET /v1/host/openwop-app/tasks` route + ownership-filter RBAC (own runs + their direct children, IDOR-safe, bounded + truncation-logged); P4 the FE deck (`frontend/react/src/taskDeck/`, status columns + nested cards, lazy-loaded). Each phase: `/architect` GO + `/code-review` CLEAR (+ `/ux-review` PASS for P4); 11 backend tests + the FE gate green. The deferred `ctx.tasks` workflow read (Phase 5) remains the only open item.
**Date:** 2026-06-24
**Toggle:** `task-deck` · default **OFF** · `bucketUnit: tenant` (a shared
operator-console surface a workspace opts into). When OFF, runs surface exactly as
today — per-run progress (`chat/workflowProgress/WorkflowProgressPanel.tsx`) + the
run inspector; no aggregate board.
**Surface:** host-extension — a **read-only projection** over the existing run store +
run-events, plus one additive `run.metadata.parentRunId`/`delegatedBy` stamp at
sub-run creation so child runs group under their parent. No new store, no OpenWOP wire
field, no run-event type.
**Depends on / composes:** `subruns/subRunDispatcher.ts` (`dispatchSubRun` — the
delegated work this surfaces; needs the parent-linkage stamp), the run store +
`routes/runs.ts` (the source rows), `host/reviewProjection.ts` (ADR 0068 unified
review — the **blocked** bucket IS a read over this), `host/approvalService.ts` (ADR
0075) + `routes/interrupts.ts` (the suspend reasons), ADR 0083 `artifactProjection.ts`
/ ADR 0068 `reviewProjection.ts` (the **projection pattern** this follows — read-model,
not a table), the `recipientUserId` addressed-notification channel (ADR 0050 — a
delegated/blocked task notifies its owner via the EXISTING channel), ADR 0031 (the
`run.metadata` stamp + replay invariant for the parent linkage).
**RFC verdict:** **host-extension — NO new RFC.** A read-only projection over
already-durable runs + run-events; the parent linkage is non-normative
`run.metadata`. No run-event field, capability flag, event type, endpoint contract, or
normative MUST is added.

> **Origin.** Third-party competitive analysis (`compare.md`, June 2026) §"Run Task
> Deck" / §"Project Threads and Delegation" — LobeHub's Agent Task Manager + LibreChat
> subagents. The codebase fact-check confirmed the gap is **frontend-only**: sub-runs
> already dispatch on the backend (`subruns/subRunDispatcher.ts`) but are **opaque** in
> the UI — there is no pending/blocked/delegated/completed board; the existing
> `WorkflowProgressPanel` is per-run only. The value: visualize agent work as a
> queue of inspectable, resumable units, not a flat message stream.

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a tasks table the chat writes to." That would create a **parallel
work store** shadowing the run store — the exact anti-pattern
[[no-parallel-architecture]] warns against. A "task" here is **not a new entity**: it
is a *view* of an existing run (and its sub-runs). The deck is a **projection**,
mirroring `reviewProjection.ts` (ADR 0068) and `artifactProjection.ts` (ADR 0083).

| Concern | Existing owner (file:line) | How the deck reuses it |
|---|---|---|
| The work units | the run store + `routes/runs.ts`; run snapshots (`subRunDispatcher.ts:85` `RunSnapshot`) | A "task" is a run row. The deck projects runs scoped to a conversation/project/user — **read-only**, newest-first, cursor-paginated. No tasks table. |
| Delegated work | `subruns/subRunDispatcher.ts` `dispatchSubRun` (`SubRunRequest`/`SubRunResult`, posts to `/v1/runs`, polls the snapshot) | The dispatcher stamps `run.metadata.parentRunId` + `delegatedBy` at sub-run creation (the **one** net-new write) so the projection groups children under the parent that spawned them. |
| The "blocked" bucket | `host/reviewProjection.ts` (ADR 0068 unified review) + `host/approvalService.ts` (ADR 0075) + `routes/interrupts.ts` | A run is **blocked** iff it is suspended on a HITL interrupt/approval. The deck reads the unified review for the suspend reason + the resume link — it does **not** re-derive interrupt state. |
| Status buckets | run `status` + interrupt presence | `pending` (queued), `running`, `blocked` (suspended on interrupt — composes ADR 0068/0075), `delegated` (a sub-run dispatched to another subject), `completed`, `failed` — all derived from existing fields. No new status vocabulary. |
| Deep links | the run inspector + the chat turn that spawned the run + the HITL card | Each deck card links to the inspector / the spawning turn / the blocking interrupt's resume affordance (the existing `interrupt.approval` card). Reuses replay/fork. |
| Notifications | `notifications/notify.ts` + the `recipientUserId` addressed channel (ADR 0050) | A delegated/blocked task notifies its owner through the **existing** addressed-notification channel — no new notification type. |

**Net new (small):** the `run.metadata.parentRunId`/`delegatedBy` stamp in
`dispatchSubRun`, a `taskDeckProjection.ts` read-model (group children under parents,
bucket by status, join the blocked reason from the review projection),
`/v1/host/openwop-app/tasks` read routes, and the FE deck. **No tasks table, no new
run status, no new interrupt seam, no new notification type.**

---

## Decision

Add an optional **task deck**: a **read-only projection** over runs + sub-runs scoped
to a conversation / project / user, bucketed into `pending · running · blocked ·
delegated · completed · failed`, with each card deep-linking to the run inspector, the
spawning chat turn, and (when blocked) the resume affordance. Delegated sub-runs group
under the parent run that spawned them via an additive
`run.metadata.parentRunId`/`delegatedBy` stamp. The deck owns **no state** — it reads
the run store, the unified review (ADR 0068), and the interrupt seam.

### Data model — a projection, not a store

```ts
// the ONE net-new write — stamped at sub-run creation in dispatchSubRun
run.metadata.parentRunId?: string      // the run whose tool-call spawned this sub-run
run.metadata.delegatedBy?: Subject     // the agent/subject that delegated it

// the read-model (computed, never persisted)
TaskCard
  { runId, parentRunId?,
    title,                              // derived: workflow name / first turn intent
    status: 'pending'|'running'|'blocked'|'delegated'|'completed'|'failed',
    blockedReason?,                     // joined from reviewProjection (ADR 0068): which interrupt/approval
    resumeRef?,                         // the interrupt/approval to resolve (deep-link)
    owner?, delegatedBy?,               // who is responsible / who delegated
    spawnedFrom?: { conversationId, seq },  // the chat turn that started it
    startedAt, updatedAt, children: TaskCard[] }

TaskDeck { scope: {conversationId?|projectId?|userId}, buckets: Record<status, TaskCard[]> }
```

### The projection (read-only)

`taskDeckProjection(scope, cursor) → TaskDeck`:
1. Page runs in scope from the run store (newest-first).
2. Group children under parents via `run.metadata.parentRunId`.
3. Bucket each by `status`; for `blocked`, join the suspend reason + `resumeRef` from
   `reviewProjection` (ADR 0068) — never re-derive interrupt state.
4. Derive `title`/`spawnedFrom` from run inputs + the spawning conversation turn.

Pure over its inputs; no writes; safe to recompute on every poll/SSE tick.

### RBAC & isolation

`workspace:read` for the scope + the conversation/project access predicate (ADR
0043/0054); a task is visible iff its run is visible to the caller. Tenant + org
IDOR-guarded; uniform-404. Mutations are **out of scope** — the deck links to the
existing inspector/resume surfaces, which own their own RBAC (resuming a blocked task
requires the ADR 0075 approver eligibility).

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `features/task-deck/` — the projection (`taskDeckProjection.ts`) + read routes + FE. features→core only; the run store + review projection stay the owners. The sub-run parent stamp lands in the existing `subRunDispatcher` (core), gated to be inert when the feature is off. |
| 2 | Toggle + admin UI | `task-deck` toggle, OFF default, `bucketUnit:'tenant'`; standard `requireEnabled` gate; managed in `FeatureTogglePanel`. |
| 3 | Workflow surface (0014) | None new in v1. A read-only `ctx.tasks` (list scoped tasks) is a deferred additive follow-on (OQ-3). |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | None — the deck is a sibling surface to chat, reading the same runs. It deep-links into the chat turn that spawned each task. |
| 6 | Agent pack | None. |
| 7 | Public surface | None. Authed, scope-gated read. |
| 8 | RBAC + isolation (0006) | `workspace:read` + the conversation/project access predicate; a task visible iff its run is; tenant/org IDOR-404; resume actions inherit the ADR 0075 approver gate. |
| 9 | Replay / fork safety | The deck is a **pure read-model** — no replay impact. The `parentRunId`/`delegatedBy` stamp is write-once at sub-run creation, read verbatim on `:fork` (a forked sub-run keeps its parent linkage; ADR 0031). |
| 10 | Frontend | A **Task Deck** surface (a tab in the chat nav and/or a docked panel) showing the status columns; each card → inspector / spawning turn / resume; live via the existing run-event SSE seam (ADR 0088); `ui/` tokens, a11y, light+dark. |

---

## Phased plan

1. **The parent-linkage stamp.** Stamp `run.metadata.parentRunId`/`delegatedBy` in
   `dispatchSubRun` (inert/no-behavior-change when the feature is off; the stamp is
   harmless metadata). Test: a fork preserves the linkage.
2. **The projection.** `taskDeckProjection(scope, cursor)` — group children, bucket by
   status, join the blocked reason from `reviewProjection`. Unit-tested over fixture
   runs (each bucket, parent/child grouping, blocked-reason join, pagination).
3. **Read routes + RBAC.** `GET /v1/host/openwop-app/tasks?scope=…`, `workspace:read` +
   access predicate, tenant/org IDOR-404.
4. **Frontend deck.** The status-column board + deep-links + live SSE refresh;
   `/ux-review`.
5. **(Deferred) `ctx.tasks` read surface + the `/.well-known` advert** — only if a
   workflow-facing read is needed (OQ-3).

## Alternatives weighed

1. **A `tasks` table the chat/dispatcher writes to.** Rejected — a parallel work store
   shadowing the run store ([[no-parallel-architecture]]); it would drift from run
   truth and double-write. A task is a *view* of a run.
2. **Extend `WorkflowProgressPanel` to show many runs.** Rejected — that panel is a
   per-run step list; an aggregate, status-bucketed, cross-run board is a different
   surface. It composes the inspector/panel via deep-links rather than overloading them.
3. **A new `task.*` run-event family.** Rejected — runs already emit the status +
   interrupt events the deck needs; a new event family would be redundant wire surface
   (and would need an RFC). The projection derives everything from existing events.
4. **Make "delegated task" a portable cross-host concept now.** Deferred — that would
   be an RFC (a normative delegation/parent-run contract). v1 is a host-local
   projection over `run.metadata`, needing no RFC.

## Open questions

1. **OQ-1 — Default scope.** Per-conversation, per-project, or a global "my tasks"
   inbox? Lean: ship per-conversation + per-project first (the run access predicate is
   already scoped there), then a "my tasks" cross-scope inbox as a follow-on.
2. **OQ-2 — Sub-run depth.** `dispatchSubRun` can nest. Lean: project the full tree but
   render two levels by default (parent + children), expand-on-demand, to avoid a
   runaway UI for deep agentic runs.
3. **OQ-3 — `ctx.tasks` workflow read.** Should a workflow be able to *read* the deck
   (e.g. a "what's blocked?" agent)? Lean: defer to a Phase 5 additive read-only
   `ctx.tasks`; not needed for the FE value.
4. **OQ-4 — Retention/closed tasks.** Completed/failed runs accumulate. Lean: page +
   default-collapse terminal buckets; the run store's existing retention governs
   lifetime (the deck adds none).

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** The deck is a read-only **projection** over
already-durable runs + run-events (mirroring ADR 0068 `reviewProjection` and ADR 0083
`artifactProjection`, both host-ext). The only write is the non-normative
`run.metadata.parentRunId`/`delegatedBy` stamp (ADR 0031 precedent). It adds no
run-event field, capability flag, event type, endpoint contract, or normative MUST.
A *portable* delegated-task contract across hosts would be an RFC, but v1 is host-local
and needs none.
