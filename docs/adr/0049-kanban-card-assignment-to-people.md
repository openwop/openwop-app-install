# ADR 0049 — Kanban card assignment to people (notifications, inbox, personal-board mirror)

**Status:** implemented (Phases 1–6). The role-source open question is **resolved**:
`assigneeRole` resolves against **ADR 0006 RBAC workspace roles** (`member.roles`), so a
role-addressed card surfaces in the mirror of every holder of that role (pull model); the
role→holders **push** fan-out is intentionally not built (the pull mirror covers it).
**Date:** 2026-06-15
**Toggle:** none — this **extends the core `host.kanban` surface** (lives in
`backend/typescript/src/host/`, not `src/features/`), so it is always-on host behavior,
not a toggle-gated feature-package. See § "Why this is a host-surface extension, not a
feature-package". The one user-facing net-new view ("My Assigned Work") may ride an
existing nav gate if desired, but the assignment/notification mechanics are core.
**Capability:** no new `AgentCapabilityId`; reuses the advertised `host.kanban` surface
(`taskAssign` already exists) + the notifications seam.
**Depends on / composes:** **ADR 0050 (per-recipient notification targeting — the
prerequisite that lets an assignment reach one person's inbox; G2 is delegated there)**,
ADR 0010 (Notifications — the inbox + emitter this rides),
ADR 0025 (user/agent orchestration symmetry — the polymorphic `BoardOwner`, the agent that
assigns to a human), ADR 0006 (RBAC — scope gating + IDOR), ADR 0015 (workspace = tenant —
why per-recipient targeting is *required*, not optional), ADR 0014 (`host.kanban` workflow
surface). Reuses `host/kanbanService.ts`, `host/kanbanSurface.ts`, `notifications/emitter.ts`,
`routes/notifications.ts`, `routes/kanban.ts`, and the SSE `board.changed` fan-out.
**Surface:** host-internal, under the existing `host.kanban` routes / `/v1/host/openwop-app/*`.
**RFC gate:** **NO new RFC.** Host-extension only — no wire field, event type, capability
flag, or normative MUST changes. See § "RFC gate".

## Why this exists

The plan (this conversation, 2026-06-15):

> *"We need the concept of assigning kanban tasks to an individual. If there is a kanban
> board for a project, or an agent, that requires a person to respond, the person is
> assigned the task, but the kanban task remains in the board it belongs to. The person
> gets a notification, sees the task in their inbox, and the card appears in their
> personal kanban board."*

Three caller decisions are fixed inputs:

1. **The personal board is a LIVE MIRROR** of the origin cards — one source of truth,
   status edits sync both ways. Not a copy.
2. **An agent can assign a card to a person** — the HITL responder can be a designated
   **role** or a specific **person** (an agent board that needs a human to respond).
3. When the assigned work is done the card **"should be marked as completed"** — exact
   propagation/sync semantics decided here per best practice.

A boundaries audit (below) found the plan's premise is **already ~70% shipped at the
primitive level** in the host kanban surface. The net-new work is small and specific:
**(a)** honor assignment notifications (an already-advertised-but-dead param), **(b)** add
**per-recipient** notification targeting (today's notifications are tenant-wide — a
blocker for B2B), and **(c)** a derived "assigned to me" view that *is* the personal board
mirror. No new entity, no card duplication, no new board type.

## Boundaries audit (MANDATORY — Step 3)

Kanban is a **host surface** (`host.kanban`), the single owner of boards/cards/columns.
Everything assignment-related already has a home here; nothing below is net-new infra.

### Already shipped — compose, do not fork
- **Single-assignee field already exists.** `KanbanCard.assigneeId?: string`
  (`host/kanbanService.ts:88`) + `assignmentReason?` ("why Sally?", `:82`). Set today via
  `host.kanban` `taskAssign` (`host/kanbanSurface.ts:108-115`) and read by
  `resourceMonitor` for per-assignee WIP/load (`:209-221`). **The data model already
  carries assignment.**
- **The card never moves.** A card is bound to exactly one board via `card.boardId`
  (`createCard :302`, `moveCard :390`). "Assignment is a reference, not a move" is already
  structurally true — assigning only writes `assigneeId`.
- **A personal board primitive already exists.** `personalBoardId(tenantId, ownerUserId)`
  (`:192`), `getPersonalBoard` (`:198`), `ensurePersonalBoard` (`:207`) — a deterministic
  per-user board owned via `ownerUserId` (`:162`) and the polymorphic `BoardOwner`
  (`{kind:'user'|'agent'}`, `:119-121`, ADR 0025). **But today it is an empty board the
  user *owns*, NOT an aggregation of cards assigned to them from other boards.** This is
  the gap the mirror fills (see Correction #1).
- **Live cross-board read already exists.** `listBoardsWithCards(tenantId)` (`:255-275`)
  does a single boards-scan + single cards-scan — the exact shape an "assigned to me"
  aggregation needs, without an N+1.
- **Live two-way sync already exists.** Every card mutation publishes `board.changed` on
  the cross-instance pub/sub bus (`notifyBoardChanged :439`, `subscribeBoardChanges :433`)
  → open SSE clients refetch. Because the mirror is a *derived view over the one card
  record*, "edit on origin or mirror syncs both ways" is automatic — same record, same
  event. **The live-mirror decision is free given this architecture.**
- **The inbox is the Notifications inbox (ADR 0010).** `actionUrl: '/inbox'`
  (`features/assistant/surface.ts:186`); emitter at `notifications/emitter.ts:34`
  (`getNotificationEmitter().emit`, storage-insert + subscriber fan-out + Web Push).

### Gaps the feature must close (the actual net-new work)
- **G1 — `notifyAssignee` is advertised but DEAD.** `taskAssign`'s signature declares
  `notifyAssignee?: boolean` (`host/kanbanSurface.ts:59`) but the implementation
  (`:108-115`) only writes the field and **never emits a notification**. This is a
  capability-honesty violation (param accepted, behavior dropped). Honoring it is core to
  the feature.
- **G2 — notifications have NO recipient; they are tenant-wide.** `NotificationRecord`
  (`types.ts:232-252`) is keyed by `tenantId` with **no `recipientUserId`**; the inbox
  route filters by `tenantId` only (`routes/notifications.ts:100`). Under ADR 0015
  (workspace = tenant, many users), an assignment notification today would broadcast to
  the **entire workspace**, not the assignee. **Per-recipient targeting is a prerequisite,
  not a nicety — and it is cross-cutting (approvals-to-initiator, @mentions all want it),
  so it is its own decision: see ADR 0050. This ADR consumes ADR 0050's
  `recipientUserId`; it does not re-derive it.**
- **G3 — no "assigned to me, across all boards" read.** No route/surface op returns the
  cards assigned to a given user across the tenant. The personal mirror needs it.

### No collision
- `grep -rn "personalBoard\|assigneeId"` shows a single owner (`host/kanbanService.ts`).
  The `/boards/*` namespace is owned by `host.kanban` (ADR 0040 already records this).
  No second module models assignment, inbox-per-user, or a personal aggregation.

## Decisions

### D0 — Shape: extend the host surface; the mirror is a derived view, not a copy
The personal board the assignee sees is a **derived projection**: "all cards in my tenant
where `assigneeId == me` (or a role I hold), grouped into lanes." It reads the *same* card
records that live on their origin boards. There is **no copy, no sync job, no second
record** — which is precisely why the live-mirror + two-way-sync + completion-propagation
guarantees hold for free (one record, one `board.changed` event). This directly honors the
caller's "live mirror, one source of truth" decision and the "card remains in its board"
requirement.

### D1 — One **accountable** assignee per card (singular), collaborators deferred
**Decision: keep `assigneeId` singular — one accountable owner per card.** Rooted in the
dominant industry pattern: Asana, Jira, and Linear all model exactly **one assignee** (the
single throat-to-choke) and treat additional people as *collaborators / watchers /
subscribers* — a separate, notification-only role. GitHub permits multiple assignees but
its own guidance is "assign one." A single accountable owner also keeps the "assigned to
me" inbox unambiguous (no shared-ownership diffusion) and is the **non-breaking** choice —
the field is already singular and read as singular by `resourceMonitor`.

- **Collaborators/watchers** (multiple notify-only recipients, no ownership, no personal-
  board placement) are a clean **future additive extension** (`card.watcherUserIds?:
  string[]`) — explicitly deferred, logged in Open Questions, not built now.
- *Alternative rejected — multi-assignee array:* would break the existing `assigneeId`
  read sites, the WIP/load tally semantics (whose WIP?), and accountability; net-negative
  UX for a HITL-routing feature whose whole point is "this person must respond."

### D2 — Role-addressed assignment resolves to a person via a **claim** model (HITL)
The caller's decision #2 ("the HITL responder can be a designated role or person") maps
onto the singular owner without a multi-assignee model:

- **Person assignment:** `assigneeId = <userId>` — direct, accountable now.
- **Role assignment:** `assigneeRole = <roleKey>` with `assigneeId` unset → the card is
  *unclaimed* and notifies **every holder of that role** in the workspace; the first
  holder to **claim** it sets `assigneeId = themselves` and clears the role-pending state
  (the others' inbox items are withdrawn). This is the standard queue/claim pattern
  (PagerDuty/Zendesk group-queue → individual acceptance). It preserves "exactly one
  accountable owner" while letting an agent address *a role* when it doesn't know the
  person. An agent owner (ADR 0025 `BoardOwner.kind==='agent'`) assigns identically.

### D3 — Completion: terminal-column state on the one record; inbox item resolves
"Completed" must be a **card-level** signal, not "is in a column literally named Done"
(columns are per-board and renamable). Decision:

- Add a **column-level `terminal?: boolean`** flag (origin board owns its own workflow /
  lane semantics; the canonical Done lane is marked terminal). A card is **complete when
  it sits in a terminal column.** No new card field needed for state; optionally stamp
  `completedAt` for audit when it first enters a terminal column.
- **Propagation is automatic and bidirectional** because origin board and personal mirror
  render the *same record*: moving the card to a terminal lane from **either** surface is
  the same `moveCard` mutation + the same `board.changed` event. The caller's "marked as
  completed" + "syncs both ways" is satisfied by the derived-view architecture (D0) — no
  reconciliation logic.
- **Inbox lifecycle (best practice — actionable items resolve when the work resolves):**
  - **Completed** → the assignment notification is marked **resolved/read**; the card
    drops out of the *active* mirror lanes (still visible under the mirror's Done lane;
    never deleted).
  - **Unassigned / reassigned** → the card leaves the old assignee's mirror immediately
    (derived view), their pending assignment notification is **withdrawn** (read+archived),
    and a fresh notification fires for the new assignee. (Reassign = unassign-then-assign.)
  - **Deleted on the origin board** → the card vanishes from the mirror automatically
    (derived view over a now-absent record) and any pending inbox item is withdrawn.

### D4 — Permissions: tenant isolation hard; assignment confers card-scoped access
- **Tenant/workspace isolation is absolute (ADR 0006/0015):** you may assign **only** to a
  member of the **same workspace/tenant**. Cross-tenant assignment is rejected
  fail-closed (IDOR-guarded — assignee membership verified against the tenant, never
  trusted from the request).
- **Within the workspace, assignment grants the assignee scoped access to *that card*** —
  read + move + mark-complete — **even if they are not a member of the origin board /
  project.** This is the Asana/Jira norm ("being assigned a task lets you act on it") and
  is *required* for the mirror to function: the assignee must see and progress work routed
  to them. The grant is **card-scoped, not board-scoped** — it confers no visibility into
  the rest of the origin board.
- **Who can assign:** a user with write scope on the origin board, or the agent that owns
  it (ADR 0025). The assignee need not pre-have board access.
- **The personal mirror is private:** only the assignee (and workspace admins) can view
  "assigned to user X." It is not a shared surface.

## Data model (additive, backward-compatible)

```
// host/kanbanService.ts — KanbanCard (extend)
assigneeId?:    string   // EXISTS — the one accountable person (a userId)
assigneeRole?:  string   // NEW — role-addressed, unclaimed (D2); cleared on claim
completedAt?:   string   // NEW (optional) — first entry into a terminal column (D3)

// host/kanbanService.ts — KanbanColumn (extend)
terminal?:      boolean  // NEW — marks the Done/terminal lane (D3)

// NotificationRecord.recipientUserId — provided by ADR 0050, NOT defined here.
// This ADR sets recipientUserId = assigneeId when emitting the assignment notification.
```

The per-recipient notification field, the two-channel (addressed/broadcast) inbox
visibility rule, and the storage/emitter changes live in **ADR 0050**. This ADR's only
notification responsibility is to **emit** a `task.assigned` notification with
`recipientUserId = assigneeId` and to withdraw it on reassign/unassign/complete (D3).

## Phased plan

- **Phase 1 — per-recipient notifications (G2, prerequisite — lands via ADR 0050).** The
  `recipientUserId?` field, two-channel inbox filter, storage column, and emitter
  passthrough are ADR 0050's deliverable. This ADR is **blocked on ADR 0050 Phases 1–2**
  before Phase 2 below can emit an addressed notification.
- **Phase 2 — honor assignment notifications (G1).** In `taskAssign`
  (`host/kanbanSurface.ts`), when `notifyAssignee !== false`, emit a notification
  (`type: 'kanban.assigned'`, `recipientUserId: assigneeId`, `actionUrl` → the card on the
  personal board, `metadata: {cardId, boardId, assignmentReason}`). Withdraw the prior
  assignee's notification on reassign/unassign (D3). Mirror the same on the REST assign
  route in `routes/kanban.ts`.
- **Phase 3 — completion + lifecycle (D3).** `terminal?` on columns; default Done lane
  marked terminal; stamp `completedAt`; resolve/withdraw inbox items on
  complete/unassign/delete.
- **Phase 4 — the "assigned to me" mirror (G3, D0).** A read that projects
  `listBoardsWithCards`-style scan → cards where `assigneeId == me || assigneeRole ∈
  myRoles`, grouped into lanes, returned as the personal board. Wire it to the existing
  `ensurePersonalBoard` surface so the user's board shows assigned work. Reuses
  `board.changed` SSE for live refresh.
- **Phase 5 — permission grant (D4).** Card-scoped authorization: assignee may
  read/move/complete an assigned card without origin-board membership; tenant-membership
  check on the assignee at assign time (fail-closed).
- **Phase 6 — frontend.** "My Assigned Work" view (the personal mirror) in the kanban SPA
  (`frontend/react/src/kanban/`); assignee picker + assignment-reason on the card;
  notification deep-links to the card. `ui/` cohesion + a11y + tokens (`/ux-review`).
- **Core-app extension surface.** `host.kanban` already advertises `taskAssign`; Phase 4
  adds an "assigned-to-me" read op to the surface (behind the same RBAC). Optional node
  pack: an `assignTask` workflow node + a "card assigned to me" sensor trigger (additive
  to `feature.kanban` packs). Agent pack: none net-new — an agent assigns via the existing
  `taskAssign` surface op. `/.well-known/openwop` advertisement is unchanged except the
  new read op.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | **N/A — host-surface extension.** Kanban is core (`host/`), single owner of boards/cards. No new `src/features/<id>/`; edits land in `host/kanbanService.ts`, `host/kanbanSurface.ts`, `routes/kanban.ts`, `notifications/`, `routes/notifications.ts`. |
| 2 | Toggle + admin UI | **None** — core host behavior (assignment + per-recipient inbox). Splitting it behind a toggle would fragment the single-source-of-truth model (Correction #2). |
| 3 | Workflow surface (0014) | Extends `host.kanban`: `taskAssign` (exists) + new "assigned-to-me" read op, behind existing RBAC, advertised at `/.well-known/openwop`. |
| 4 | Node pack | Optional additive `feature.kanban` nodes: `assignTask` write node + "assigned-to-me" sensor. Signed via the registry pipeline. |
| 5 | AI-chat envelopes | None net-new; assignment flows through the surface op, not a new envelope. |
| 6 | Agent pack | None net-new — agents assign via `taskAssign` (ADR 0025 owner symmetry). |
| 7 | Public surface | **None.** Personal mirror is private (D4); no `PUBLIC_PATH_PREFIXES` entry. |
| 8 | RBAC + isolation (0006) | Assign requires board-write or agent-owner; assignee verified in-tenant (fail-closed, IDOR-guarded); card-scoped grant (D4); mirror private to owner+admin. |
| 9 | Replay / fork safety | No variant influences a run; assignment is product state, not run config. Packs decoupled from any toggle. No `run.metadata` stamp needed. |
| 10 | Frontend | "My Assigned Work" mirror view + assignee picker in `frontend/react/src/kanban/`; nav via existing kanban entry; notification deep-links. |

## RFC gate (Step 5)

**Verdict: NO new RFC; this is host-extension work.** Nothing touches the OpenWOP wire:
no new run-event field, event type, capability flag, endpoint contract, auth/scale
profile, or normative MUST. `assigneeId`/`assigneeRole`/`completedAt`/`terminal` and
`recipientUserId` are host-internal product state on `host.kanban` + Notifications (ADR
0010), under `/v1/host/openwop-app/*` (non-normative). `taskAssign` is an *already
advertised* `host.kanban` op — Phase 2 makes its `notifyAssignee` param honest rather than
changing its shape. Capability advertisement stays truthful
(`OPENWOP_REQUIRE_BEHAVIOR=true` would now pass `notifyAssignee`, which today it should
not).

## PRD-vs-architecture corrections

1. **"Card appears in their personal kanban board" → the personal board *becomes* the
   assignee mirror.** The plan implies pushing a card onto a separate personal board.
   `ensurePersonalBoard` already exists but as an *owned, empty* board. We reshape it: the
   personal board renders a **derived projection of assigned cards**, not copies. This is
   what makes "live mirror, one source of truth" actually true — the alternative
   (copying cards onto a personal board) would reintroduce the two-record sync problem the
   caller explicitly ruled out.
2. **"Add as ADR(s)" with a toggle (the matrix default) → no toggle.** The matrix assumes
   a toggle-gated feature-package. Kanban is a **core host surface**; assignment +
   per-person inbox are core mechanics, and gating them would fracture the
   single-source-of-truth guarantee. Recorded as a deliberate deviation.

3. **Correction (2026-06-16) — the mirror is a column on the personal board, not a
   separate page.** Phase 6 originally shipped the mirror as a standalone `/my-work`
   route + top-level nav item (`MyAssignedWorkPage`). That *duplicated a navigation
   surface* alongside the boards, and drifted from correction #1 above ("the personal
   board *becomes* the assignee mirror") and from the plan's own words ("the card appears
   in their **personal kanban board**"). Refolded: the mirror is now a collapsible
   **"Assigned to me" rail** rendered as the leftmost column of the personal board
   (`AssignedColumn`, passed to `KanbanBoardView` as `leadingColumn`), showing the caller's
   **open** (non-terminal) assigned cards and collapsing away entirely when empty. The
   derived-view invariant (D0) is unchanged — these are the same records on their origin
   boards, read-only here, each linking to its origin board (assignment grants the
   card-scoped access to act, D4); the Claim action for role-addressed cards moves with
   them. `/my-work` becomes a query-preserving redirect to `/boards` so already-emitted
   assignment notifications keep working, and the notification deep-link target moved from
   `/my-work?card=` to `/boards?card=` (`kanbanAssignmentNotify.cardActionUrl`).
3. **"Mark as completed" under-specified → terminal-column state, not a magic "Done"
   string.** Columns are per-board and renamable; completion is modeled as a
   `terminal` column flag + optional `completedAt`, so it survives renames and varies per
   board workflow.

## Open questions

- **Collaborators / watchers** (multi-recipient, notify-only, non-owning) — deferred
  additive extension (`watcherUserIds?`); confirm demand before building (D1).
- **Role → holders resolution** (D2): ✅ **RESOLVED at implementation** — `assigneeRole`
  resolves against **ADR 0006 RBAC workspace roles** (`member.roles`, via
  `callerRolesIn()` in `routes/kanban.ts`). Role-addressed cards surface in the mirror of
  every holder (pull); a role→holders *push* fan-out is deferred (the mirror covers it).
- **Notification de-dup / digest** when one person is assigned many cards in a burst
  (an agent fanning out HITL): per-card now; batch/digest is a later polish (composes the
  ADR 0010 preferences surface).
- **Should an agent-owned board's HITL assignment auto-create a suspend/approval point**
  on the triggering run (ADR 0023/approvals), or is the inbox notification sufficient?
  Lean: notification-only for v1; wire to approvals only if a run is actually blocked.

## Phase → commit/test (filled on implementation)

| Phase | Status | Tests |
|---|---|---|
| 1 — per-recipient notifications (→ ADR 0050) | implemented (ADR 0050) | see ADR 0050 |
| 2 — honor `notifyAssignee` (`host/kanbanSurface.ts` `taskAssign` + `host/kanbanAssignmentNotify.ts` emit/withdraw) | implemented | `test/kanban-assignment-0049.test.ts` — emits + withdraws on reassign; silent when `notifyAssignee:false` |
| 3 — completion + lifecycle (`KanbanColumn.terminal`, `completedAt` stamp in `moveCard`; withdraw on complete/unassign/delete in `routes/kanban.ts`) | implemented | `test/kanban-assignment-0049.test.ts` — terminal stamp/clear |
| 4 — assigned-to-me mirror (`listCardsAssignedToUser`, `GET /kanban/assigned`) | implemented | `test/kanban-assignment-0049.test.ts` — direct + role aggregation, board provenance |
| 5 — card-scoped permission (`authorizeCard`, tenant-membership gate on assign, claim) | implemented | typecheck + route guards (assignee move-only; cross-tenant assign rejected) |
| 6 — frontend (`AssigneeControl` on board cards, `kanbanClient` methods; the "assigned to me" mirror) | implemented | `npm run build` green (tsc + CSS/token gates) |
| 6.1 — refold the mirror into the personal board as the collapsible **"Assigned to me"** rail (`AssignedColumn` → `KanbanBoardView` `leadingColumn`); delete `MyAssignedWorkPage`; `/my-work` → `/boards` redirect; deep-link `/boards?card=` (correction #3, 2026-06-16) | implemented | `npm run build` green; backend kanban tests green (29) |
