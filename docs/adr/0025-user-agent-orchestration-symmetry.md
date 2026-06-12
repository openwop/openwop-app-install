# ADR 0025 — User / Agent orchestration symmetry (personal boards, schedules, assigned workflows)

**Status:** **Implemented** — all phases shipped + tested. Phase 1 (polymorphic board owner + `boardOwner()` accessor + auto-provisioned personal boards at `ensurePersonalWorkspace`) **implemented + tested** (`dc3673a`, `user-board-symmetry.test.ts`). The **profile orchestration tabs** now ship: the **My Board** tab (Phase 1's deferred headline) and the **Connections** tab (a Phase 3 item, pulled forward since ADR 0024's `connectionsClient` was ready) — `ProfilePage` is now tabbed (Profile / My Board / Connections), reusing the same `AgentBoardPanel` an agent profile uses (`personal-board-route.test.ts`). The **Assigned-workflows** tab (`Profile.workflows[]` + `setOwnWorkflows`) and the **Schedules** tab (user-owned `ScheduledJob`s via `owner:'me'` + owner-access) now ship too (`profiles-route.test.ts`, `personal-board-route.test.ts`). The **Activity** tab **now ships** as well — **all five Phase-2 profile tabs are complete**. (It was implemented via the metadata-scan projection, **not** the storage-index change first feared: the `projectAgentActivity` projection already scans run metadata, so a `userId` filter + `ownerUserId` attribution stamp avoids any `AgentRunAttributionRow` schema change.) The Phase-3 **"Waiting on me" approval lane** now ships too — the My Board tab embeds the existing `ApprovalsInbox` (the review-mode pending-approval queue), so a human approves/rejects an agent's proposed run on their board with **zero new backend** (ADR §4's "reuse the existing mechanism"). **ADR 0025 is fully implemented.**
**Date:** 2026-06-10 (Phase 1 implemented 2026-06-11)
**Depends on:** ADR 0005 (User Profiles), ADR 0015 (workspace = tenant), RFC 0086 (roster + heartbeat + board attribution), RFC 0052 (scheduler). Composes `host.kanban`, `rosterService`/`heartbeatService`, Notifications (ADR 0010).
**Consumed by:** ADR 0023 (Executive Assistant assigns work to, and routes approvals through, the *human's* board on the same rails an agent uses).
**Surface:** extends `host.kanban` board ownership + `features/profiles` (no new top-level namespace).
**Toggle:** folds under `profiles` (the board/connections tabs render when `profiles` is on); the heartbeat/autonomy bits ride existing roster infra.

> **The thesis.** This app's whole point is **multi-agent workflow orchestration**:
> an agent is *identity + a kanban board + schedules + assigned workflows + an
> activity feed*, and a human is **notified to approve** when the agent's autonomy
> says so. Today only **agents** (roster members) are first-class orchestration
> principals. This ADR makes a **human user** a peer principal on the *same rails*
> — every new user is auto-assigned their own board, surfaced on their profile
> exactly as a board is surfaced on an agent's profile. No parallel machinery: the
> human and the agent share one orchestration substrate.

---

## Context — the agent model already is the blueprint (audited)

| Agent capability | Where it lives | Reusable for a user? |
|---|---|---|
| Identity | `RosterEntry` (`rosterService.ts:45`) | users already have `User`/`Profile` |
| Owns a board | `KanbanBoard.rosterId?` — **optional** (`kanbanService.ts:108`), so a board can stand alone | yes — generalize the owner |
| Has schedules | `ScheduledJob.rosterId?` (`schedulingService.ts`) | yes — add a user owner |
| Assigned workflows | `RosterEntry.workflows[]` (the portfolio) | yes — a per-user portfolio |
| Activity feed | `agentRunActivityIndex` + `/roster/:id/activity` | yes — attribute by `userId` |
| Autonomy + **approval inbox** | heartbeat `autonomyLevel: auto│guided│review`; **`review` queues a pending approval** (`heartbeatService.ts:92-101`) | yes — this *is* the human-approval loop |
| Profile UI (board + schedules + activity) | `agentViewModel.ts:24` composes entry+board+cards+jobs | mirror on the profile page |

**Today there is no per-user board, per-user schedule, or per-user portfolio** —
those are agent-only. The board owner field is already optional, and the user
provisioning choke point already exists (`ensurePersonalWorkspace()`,
`accessControlService.ts:578-617` — lazy, idempotent, durable-only). So this is a
**generalization**, not new infrastructure.

---

## Decision

**Generalize the orchestration principal from "roster agent" to "any principal
(agent | user)," auto-provision a personal board per user, and surface board +
schedules + assigned workflows + connections on the user profile — mirroring the
agent profile.** Approvals reuse the existing heartbeat `review`-mode pending-
approval queue + Notifications; nothing parallel is built.

### 1. Polymorphic board / schedule ownership

Generalize the optional `rosterId?` owner into an explicit owner ref, keeping
back-compat:

```
KanbanBoard.owner?  = { kind: 'agent', rosterId } | { kind: 'user', userId }
ScheduledJob.owner? = { kind: 'agent', rosterId } | { kind: 'user', userId }
```

- Existing `rosterId?` is read as `{kind:'agent', rosterId}` (no migration; the
  field stays, the typed accessor normalizes).
- **Ownership stays immutable** (board attribution safety, RFC 0086 §C) — a board
  is bound to its principal at creation.
- Run attribution stamps `{ source, owner:{kind,id} }` so the activity index
  (`agentRunActivityIndex`) records human-owned runs the same way — the existing
  index gains a `userId` attribution branch alongside `rosterId`.

> **Implementation note (2026-06-11) — board access is owner-based, not
> active-tenant-based.** The personal board lives in the user's *personal*
> tenant, but a user can be working in a shared `ws:` workspace when they open
> their profile. The original kanban routes guarded every board with
> `board.tenantId === tenantOf(req)` (the *active* tenant), which would 404 a
> personal board from any other workspace. The Phase-1-tabs work replaced that
> copy-pasted guard with **one** `authorizeBoard(req, boardId)` helper
> (`routes/kanban.ts`): a caller reaches a board when it belongs to the active
> workspace **OR** the caller is the board's personal owner
> (`board.ownerUserId === callerSubject(req)`). This makes a human's board
> reachable + mutable from any workspace — true symmetry with how an agent
> board surfaces — while preserving the existing tenant-member path and staying
> fail-closed (uniform 404, no existence leak). A personal board's card→run
> trigger now also fires into the **board's** tenant (`board.tenantId`), not the
> caller's active tenant. The personal-board route itself is **durable-only**
> (anon `anon:<sid>` sessions are refused), reusing the same
> `isDurableCaller()` rule the workspace choke point enforces (promoted to
> `host/requestSubject.ts` as the single home for that predicate).

### 2. Auto-provision a personal board (one choke point)

In `ensurePersonalWorkspace()`, right after the workspace row is created, create a
**personal board** owned by `{kind:'user', userId}` with the default To Do / Doing
/ Done columns, and store `personalBoardId` on the user's `Profile`. Idempotent
(skip if the user already has one); durable-only (never for anon sessions) — it
inherits those properties from the choke point. Every signed-in human therefore
has a board the moment they have a workspace, exactly as a seeded agent does.

### 3. The profile becomes the human's orchestration home

Extend `features/profiles` (ADR 0005) — the profile page gains tabs that mirror
`agentViewModel`:

- **My Board** — embeds the shared `KanbanBoardView` (the one board renderer,
  DESIGN.md §5.1) for `personalBoardId`. Cards moving into a trigger column fire
  workflows on the human's behalf, same as an agent board.
- **Schedules** — the user's `ScheduledJob`s (`owner.kind:'user'`), reusing the
  scheduler routes filtered by owner.
- **Assigned workflows** — a per-user `workflows[]` portfolio (a new `Profile`
  field) — the set the human (or their assistant) runs.
- **Connections** — the user's `Connection`s from ADR 0024 (Google/Slack/Zoom/…),
  add/manage/revoke. Org-shared connections appear here read-only with their
  admin-managed status.
- **Activity** — the human's run history from the attribution index.

`ProfileView` extends to compose these (board + jobs + connections), the exact
shape `agentViewModel` already uses for agents.

### 4. Approvals = the existing heartbeat `review` loop + Notifications

When any principal (an assistant agent, a scheduled job) needs the human to
approve an action, it uses the **already-built** path: the action is queued as a
**pending approval** (the same mechanism heartbeat `review`-mode uses,
`heartbeatService.ts:92-101`), a **Notification** (ADR 0010 inbox + bell + SSE +
Web-Push) tells the user, and approving claims the pending approval to start/allow
the run. The user's board shows the item in a "Waiting on me" lane. **No new
approval store** — the assistant's outbound actions (ADR 0023) are pending
approvals on this loop.

### 5. RBAC & isolation

A user's personal board / schedules / connections are owned by that user;
`workspace:read` lets teammates *see* a board (profiles are team-visible, ADR 0005)
but only the owner (or an admin) mutates it. Per-user connections are isolated from
teammates (ADR 0024). Fail-closed.

---

## RFC gate

**Host work — no new RFC.** Generalizing an existing optional owner field, an
auto-provision hook, and profile tabs are all host-local; board attribution +
heartbeat + scheduler already ride Accepted RFCs 0086/0052. No wire shape changes.

## Boundaries audit

| Concept | Single owner |
|---|---|
| Boards + columns + cards | **`host.kanban`** — generalize its owner field, don't fork |
| Schedules | **`schedulingService`** — add a user-owner branch |
| Roster agents | **`rosterService`** — unchanged; users are a *peer* principal, not a roster entry |
| The human's profile (board/schedule/portfolio/connections tabs) | **`features/profiles`** (ADR 0005) — extend |
| Approvals / notifications | **heartbeat pending-approval + Notifications (0010)** — reuse |
| Per-user connections | **`connections`** (ADR 0024) — compose |

## Phased plan

- **Phase 1** — ✅ polymorphic owner accessor + auto-provision personal board in
  `ensurePersonalWorkspace`; **My Board** tab (the profile is now tabbed, reusing
  `AgentBoardPanel`; owner-based `authorizeBoard` access; `/boards/personal`
  route). *(`personalBoardId` on `Profile` was unnecessary — the board id is the
  deterministic `personalBoardId(tenant, user)` hash, resolved server-side.)*
- **Phase 2** — ✅ **complete**: **Assigned workflows** tab (`Profile.workflows[]`),
  **Schedules** tab (user-owned `ScheduledJob`s, `owner:'me'`, owner-access +
  personal-tenant firing), and the **Activity** tab (user-attributed run feed via
  the metadata-scan projection + `ownerUserId` stamping — no storage-schema
  change, so the feared collision was avoided entirely).
- **Phase 3** — ✅ **complete**: **Connections** tab (ADR 0024, pulled forward with
  the Phase-1 tabs) and the **"Waiting on me" approval lane** — the My Board tab
  embeds the existing `ApprovalsInbox` (the review-mode pending-approval queue),
  so a human approves/rejects an agent's proposed run on their board with no new
  store (ADR §4).

### Phase → commit/test

| Phase | What | Where | Test |
|---|---|---|---|
| 1 | polymorphic owner + auto-provision | `kanbanService.ts`, `routes/workspaces.ts` | `user-board-symmetry.test.ts` |
| 1 | My Board tab + owner-based board access + `/boards/personal` | `routes/kanban.ts`, `features/profiles/ProfilePage.tsx`, `agents/AgentBoardPanel.tsx` | `personal-board-route.test.ts` |
| 2 | Assigned-workflows portfolio + tab | `features/profiles/profilesService.ts` (`workflows[]` + `setOwnWorkflows`), `features/profiles/routes.ts`, `ProfileWorkflowsTab.tsx` | `profiles-route.test.ts` |
| 2 | Schedules tab — user-owned jobs + owner-access | `host/schedulingService.ts` (`ownerUserId` + `listJobsByUser`), `routes/scheduler.ts` (`owner:'me'` + `jobAccessible`), `ProfileSchedulesTab.tsx` | `personal-board-route.test.ts` |
| 3 | Connections tab | `features/connections/ConnectionsManager.tsx`, `ProfilePage.tsx` | (covered by `connections` route tests) |
| 2 | Activity tab — user-attributed run feed (scan projection, no storage change) | `host/agentActivity.ts` (`userId` filter + `ownerUserId`), `routes/kanban.ts` + `host/scheduleDaemon.ts` (`ownerUserId` stamp), `features/profiles/routes.ts` (`/me/activity`), `ProfileActivityTab.tsx` | `agent-activity.test.ts`, `profiles-route.test.ts` |
| 3 | "Waiting on me" approval lane — reuse the review-mode pending-approval inbox on My Board (no new backend) | `features/profiles/ProfilePage.tsx` (embeds `notifications/ApprovalsInbox`) | (covered by `approvals.test.ts`) |

## Open questions (ranked)

1. **(High) Should a human optionally have a *heartbeat*** (autonomy that pulls
   their own To Do card and runs an assigned workflow), or is the human board
   strictly human-driven + assistant-fed? *Recommend: human board is fed by the
   assistant + manual; no human auto-heartbeat in v1 (autonomy stays an agent
   trait).*
2. **(Medium) Board visibility default** — team-readable (mirrors profile
   visibility) vs. private. *Recommend team-readable, owner-writable.*
3. **(Medium) One board per user, or many?** *Recommend one personal board v1;
   project boards (ADR 0023 `Project.boardId`) are separate.*
