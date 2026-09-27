# ADR 0738 — Core Kanban work-item execution

Status: Accepted (2026-09-20 — implementation authorized)

## Context

OpenWOP already has the correct Kanban foundations: one shared board renderer,
durable tenant-scoped boards and cards, assignment access controls, and a trigger
lane that reaches the normal workflow-run delivery path. It does not yet provide
a canvas-neutral execution model for taking a reviewed plan into durable,
dependency-aware work, nor does it expose user-owned Workflow Builder chains
consistently from the Kanban UI.

The resulting gap has prompted tempting but invalid shortcuts: an App
Builder-local task queue, a browser-side card runner, static workflow choices,
and an in-memory "automation" rules map. Each would create a second owner for
work or orchestration. This decision completes the existing stack model instead.

## Decision

### D1 — Kanban remains a core, reusable stack

`host.kanban` remains the single owner of board/card persistence and the shared
`KanbanBoardView` remains the single board renderer. It is neither an App
Builder feature nor a graphical canvas document. Every use case—App Builder,
CRM, agents, a future canvas type, or a host extension—uses the same board,
card, command, assignment, review, and trigger seams.

Canvas types and feature packages may extend Kanban through typed registrations:

- a **scope resolver** that supplies an explicit tenant + project/canvas/document
  discriminator and validates visibility;
- a **card renderer** that adds compact domain metadata without replacing the
  shared card, drag, keyboard, selection, or accessibility contract;
- a **work-target mapper** that validates a domain artifact/task against an
  eligible user-owned workflow chain; and
- a **materialization adapter** that converts a reviewed typed artifact into a
  proposal consumed by the core command seam.

No registration may install a second board, private task table, background
runner, direct run writer, or cross-tenant lookup.

### D2 — A WorkItem is the executable aggregate; a card is its projection

Add an optional, versioned `WorkItem` aggregate owned by `host.kanban`. It is
tenant-scoped and explicitly scope-tagged, carries an ordered position,
dependency references, a validated workflow binding, assignment/claim state,
policy and input binding, source-artifact provenance, run/evidence/review
references, block reason, and audit history. A `KanbanCard` optionally points to
one `workItemId`; existing cards remain valid and render normally without one.

The aggregate owns execution state. The card is the board projection. This keeps
the existing renderer broadly reusable while allowing domain-specific work to be
strictly traceable and runnable.

### D3 — One replay-safe command and one delivery bridge

All card/work-item mutations use a versioned `applyBoardCommand` boundary. It
validates the complete intent before writing, checks tenant/board/card/work-item
access, uses compare-and-swap ordering, records an audit/outbox entry, and returns
the canonical revision. REST routes, host-surface calls, agents, materializers,
AI proposals, and bulk UI actions all use this boundary.

The command outbox is the only source of trigger, automation, notification, and
workflow-delivery evaluation. A move cannot update fields successfully and then
fail a destination check; a host-surface move cannot bypass the trigger bridge;
and a repeated materialization cannot create duplicate work.

**Implementation correction (2026-09-20):** `applyBoardCommand` now owns all
card patch/move/reorder and WorkItem materialization/lifecycle mutations. The
long-standing create/delete and board-metadata routes remain narrow existing
service operations; they do not yet become synthetic command variants. WorkItem
commands—not cosmetic card edits—write the command audit/outbox. This preserves
the actual boundary instead of claiming an audit event for every title edit.

### D4 — Chains and stacks are the only workflow shapes

The core dispatcher considers only eligible `WorkItem`s: dependencies complete,
WIP policy permits dispatch, assignment/claim and approval policy allow it, and a
validated workflow binding exists. It creates normal claims and starts the bound
tenant-owned workflow through the existing durable run/delivery path. Runs keep
their ordinary metadata, events, replay/fork, approvals, evidence, retries, and
dead-letter behavior.

New orchestration ships as RFC 0013 workflow-chain packs loaded through the
existing loader, then instantiated through `/workflows/from-chain` into a
tenant-owned, Builder-editable workflow. There are no in-tree workflow
definitions, client timers, private queues, or alternate executors.

### D5 — Plan handoffs are generic, App Builder is one adapter

Add a pack-loaded `kanban.materialize` chain node that consumes a typed reviewed
plan artifact, produces a dry-run proposal, validates targets/dependencies/policy,
and calls `applyBoardCommand` idempotently after the configured approval.

App Builder contributes a typed execution-plan artifact and an App-Builder target
mapper to this generic seam. It may select a board, scope and user-owned chain,
but it never owns a work table or task runner. Other feature/canvas types can
provide equivalent adapters without adding a Kanban variant.

### D6 — Automation must be durable and Builder-editable

The existing process-local `automateRules` behavior is not an automation engine.
Until it is replaced, its pack operation is unavailable rather than successful
but inert. Durable automation bindings attach to the command outbox, reference
user-owned editable workflow chains, and use the same normal trigger/delivery
life cycle as lane triggers. They carry idempotency keys, actor/provenance, run
results and dead letters.

### D7 — The work surface reuses neutral primitives, not the canvas document model

Kanban may reuse shared surface chrome, command registration, live-region
announcements, responsive-detail behavior, focus restoration, error boundaries,
and design-system primitives. It retains its own semantic WorkBoard interaction:
keyboard/pointer sort, roving focus, detail drawer, horizontal/mobile behavior,
and virtualized projections. It must not masquerade as a node graph or canvas
document solely to share a chassis.

## Ownership and boundaries

| Concern | Single owner |
|---|---|
| Board/card/work-item state, rank, dependencies, commands, projections | `host.kanban` / `kanbanService` |
| Tenant, subject and member authorization | existing identity, access-control, subject-access seams |
| Run creation, delivery, retries, replay/fork, evidence and approvals | existing workflow executor, trigger bridge, run/approval services |
| Builder-editable workflow definitions | workflow-chain pack loader + workflow ownership/catalog |
| Domain-plan interpretation | feature/canvas registration adapter, validated by core Kanban |
| UI board behavior and accessibility | `KanbanBoardView` + Kanban feature UI |
| Domain presentation extras | registered card/detail projection only |

## RFC verdict

No RFC is needed for the initial implementation. The work remains under the
existing non-normative `/v1/host/openwop-app/kanban/*` surface and uses existing
workflow/run behavior. An upstream RFC is required before adding an advertised
OpenWOP capability, a public run-event field, a normative endpoint/behavior, or
a new wire workflow shape. That gate precedes any such change.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| App Builder task queue or table | Duplicates core work ownership; cannot serve other canvas types; drifts from the board. |
| Client-side autoplay runner | Loses durable claims, retries, policy enforcement, and multi-instance safety. |
| Static workflow catalog on cards/columns | Makes workflow selection non-editable and misrepresents templates as tenant-owned workflows. |
| Make Kanban a canvas subtype | Couples a semantic work board to graphical-document lifecycle and excludes normal feature use cases. |
| Keep in-memory automation rules | Restarts lose state and no consumer makes the rules operational. |

## Delivery plan

| Phase | Outcome | Acceptance evidence |
|---|---|---|
| 0 | Contract, ADR and compatibility inventory | architecture review; no route collision; no wire change |
| 1 | Truthful current integration | dynamic workflow picker, fixed deep link, one trigger bridge, inert automation unavailable, tests |
| 2 | Core command/data spine | WorkItem schema, additive migration/read projection, CAS rank/command/outbox/audit tests |
| 3 | Generic editable plan materialization | loaded chain pack, typed proposal/review, App Builder adapter, provenance tests |
| 4 | Durable eligible-work execution | server dispatch/claims, dependency/WIP/policy, normal run/evidence/review, retry/DLQ tests |
| 5 | Operational reusable work surface | redacted projection, shared WorkItem status/run affordance, responsive/a11y UI tests |
| 6 | Scale and release confidence | safe index projection, bounded metrics, data/lifecycle probes, browser matrix, CI, PR, deploy smoke |
| 7 | Core command resilience | one CAS card patch/move/reorder command, durable idempotency receipts, retention sweep, focused concurrency regressions |

## Compatibility and migration

The migration is additive and reversible: new records are versioned; cards do not
change identity; `workItemId` is optional; old cards remain readable and mutable;
read projections tolerate both forms; dispatch can be disabled independently; and
backfill uses deterministic keys. Tenant erasure and card/board deletion must
erase or unlink work-item records through the established subject/lifecycle seams.

## Implementation record

| Phase | Commit / evidence | Status |
|---|---|---|
| 0 | This ADR and architecture review | implemented |
| 1 | Dynamic tenant-owned workflow inventory; shared RFC 0083 trigger delivery; terminal-lane lifecycle parity; pack trust manifest and focused backend/frontend suites | implemented |
| 2 | Canvas-neutral WorkItem aggregate, deterministic card projection, tenant-indexed audit/outbox, dependency lifecycle and CAS reconciliation; focused backend tests and TypeScript check | implemented |
| 3 | Core `core.openwop.kanban-work-items` pack and schema, chain-backed App Builder proposal adapter, native approval-gate composition, deterministic delivery key, pack attestation, type checks and focused regression suites | implemented |
| 4 | Lease-backed core WorkItem outbox, dependency/WIP/policy eligibility, deterministic idempotent normal-run delivery, terminal card reconciliation, bounded retry/dead-letter state, and focused multi-worker regressions | implemented |
| 5 | Input-free tenant-index work projection; generic shared WorkItem summary and manual delivery action; policy/mode guard, metric seams, i18n, focused backend/frontend checks | implemented |
| 6 | Projection validation, content-free board projection, durable receipt retention sweep that skips held tenants before deleting any batch member, delivery outcome metrics, subject-erasure inventory, generated pack/served-set ratchets | implemented pending final browser/CI/deploy evidence |
| 7 | CAS-backed full card patch intent, fractional core lane ranks, durable workflow-surface receipts and notification keys; every workflow-surface board/card lookup now proves the bound tenant before read or mutation; P7 regression suite | implemented pending final browser/CI/deploy evidence |

## Open decisions

1. A storage-native lane/position index and bounded rank rebalance policy for
   unusually dense repeated inserts. Current fractional ranks are correct under
   CAS and intentionally keep the first rollout compatible with the existing
   collection abstraction.
2. Whether manual moves over a WIP limit need a policy-controlled reason or a
   hard rejection; automated dispatch is always capped.
3. The first approved artifact schema accepted by the generic materializer.
4. The retention duration and content redaction policy for work-item audit/evidence
   projections.
