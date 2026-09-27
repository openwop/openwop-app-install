# Scheduled agent chats (unit A3) — chat-first port review

**Scope:** `backend/typescript/src/features/scheduled-agent-chats/` +
`frontend/react/src/features/scheduled-chats/` (ADR 0125; ADR 0202 D3 channel
scope; ADR 0308/0309 follow-ups). Single-feature mode.

**Headline:** The backend is a near-textbook **RIDES** — it instantiates the ONE
scheduler (`registerJob`), the ONE dispatch owner (`runAgentDispatchLive` via the
agent-runner node), the managed-key boundary, and the conversation append; there
is **zero parallel architecture**. Every real defect is on the human-facing
chat-first surface: **there is no way to author a *recurring* schedule by
describing intent** (the only chat tool is the one-shot follow-up), the FE
**create client is orphaned** (dead code, no surface calls it), the admin page
**paints a dishonest status** (a paused chat renders "Active"), and **pause/resume
has no surface at all** despite a full backend.

---

## Contract scouting — what holds, what doesn't

**Owners instantiated (the RIDES greps all pass):**

- Scheduler is the single owner. `createScheduledChat` calls `registerJob(...)`
  on the shared scheduling service — `scheduledChatService.ts:99`; pause is
  `setJobEnabled` (`:153`), delete is `deleteJob` (`:183`). No parallel poller.
  The ADR's boundaries audit (0125 §Context) is honored in code.
- Fire-once + run-start ride the shared daemon: the tick fires a run of the
  built-in turn-workflow via `scheduleDaemon`/`claimIdempotency`
  (integration-pinned by `scheduled-chat-firing.test.ts`, per ADR 0125 Phase 4).
- Dispatch rides the SINGLE gated owner. The turn-workflow is one `agent-runner`
  node (`scheduledChatTurnWorkflow.ts:30`), and that node enters agentic
  execution only through `runAgentDispatchLive` — "NO SECOND AGENTIC PATH"
  (`agentRunnerNode.ts:11`). Autonomy/approval for a `review` agent is enforced
  inside that owner (`result.status` `completed`|`escalated`,
  `agentRunnerNode.ts:181`), not re-implemented here.
- Conversation projection rides the chat bus: the reply posts as an `assistant`
  turn via `appendChatMessageLive` with a deterministic idempotent id
  `sched:<runId>` (`agentRunnerNode.ts:166-176`) — no second transcript store.
- Managed-key boundary: the autonomous tick has no user/BYOK, so it dispatches on
  the host-owned `managed:openwop-free` (`scheduledChatTurnWorkflow.ts:22`,
  `scheduledChatService.ts:106`) — the widget's host-key posture.
- Lifecycle seams are wired to real owners: roster-member delete → *pause* (never
  delete) across all scopes (`feature.ts:39`, `scheduledChatService.ts:167`);
  channel agent-removed → delete the agent's posts (`feature.ts:45`,
  `scheduledChatService.ts:190`) with a reconcile-on-read backstop
  (`routes.ts:116`). Keys are tenant/scope-deterministic
  (`scheduledChatService.ts:55`).

**The one chat-time tool is the follow-up, and it is exemplary — but one-shot.**
`openwop:tasks.schedule-followup` (`agentTools.ts:40`) is a proper action tool:
acting-user gated (`:61`), delivery destination **unforgeable** — it takes no
conversation input and binds `scope.conversationId` (`:65`), deterministic
content-hashed jobId (`:99`), cron sentinel `ONE_SHOT_CRON` +
`firstFireAtMs` (`:105`), horizon/lead/pending-cap bounds, and it is in the
ADR 0315 default-on baseline (`agentToolAllowlistService.ts:67`). Its jobs are
owned by the acting user (`ownerSubject:{kind:'user'}`, `:108`) and are
listed/cancelled from the shared **Schedules** panel
(`ProfileSchedulesTab.tsx` → `SubjectSchedulesPanel` → `listMyJobs`).

**What does NOT hold (blockers):**

- **B1 — No igniter for a *recurring* schedule from chat.** The only chat tool is
  one-shot (`ONE_SHOT_CRON`). `createScheduledChat` (the recurring path, backed by
  a cron `ScheduledJob`) is reachable **only** by HTTP route
  (`routes.ts:49,127`). "Every weekday at 8am, summarize yesterday's signups" —
  the canonical describe-intent digest — has no chat path. This is the central
  chat-first gap.
- **B2 — The FE create client is orphaned.** `createScheduledChat` in
  `scheduledChatsClient.ts:47` is imported by **no** component (grep-confirmed):
  the admin page (`ScheduledChatsPage.tsx`) only lists + deletes. Dead code that
  advertises a create UI the ADR (0125 Phase 10) promised and never shipped.
- **B3 — Pause/resume has no surface.** `setScheduledChatEnabled` + the
  `/pause` routes (org `routes.ts:82`, channel `:143`) are fully implemented, and
  the FE `ScheduledChat.enabled` field is fetched — but no surface reads or flips
  it. A chat paused by the roster-delete seam is invisible and un-resumable in
  the UI.
- **B4 — Painted status (honesty-loop break).** The page's Status column renders
  `r.workflowId ? Active : Inert` (`ScheduledChatsPage.tsx:73`). Since
  `createScheduledChat` now **always** defaults a `workflowId`
  (`scheduledChatService.ts:85`), every row is "Active" — **including a paused
  (`enabled:false`) chat**. The status badge never reads `enabled`. The one thing
  the status column exists to tell you (is this firing?) is the one thing it gets
  wrong.
- **B5 (constraint, not a defect) — Owner mismatch for an in-chat recurring
  tool.** The route-level recurring path is `workspace:write` org-scoped
  (`routes.ts:51`) and its jobs are org-owned; the follow-up path is
  user-owned and cancel-surfaced in the personal Schedules tab. A new in-chat
  recurring tool must pick ONE owner. Honest alternative: own it by the **acting
  user** (like the follow-up), reusing the existing Schedules-tab cancel surface
  and sidestepping the org-RBAC-from-a-chat-turn mismatch; leave the org-scoped
  admin page for workspace-level digests an admin authors.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Bind agent+cron+prompt+conversation → scheduler job | `createScheduledChat` → `registerJob` (`scheduledChatService.ts:99`) | **RIDES** | Leave. Single-owner exemplar. |
| Tick → agent run → reply as conversation turn | daemon → turn-workflow → `runAgentDispatchLive` → `appendChatMessageLive` (`agentRunnerNode.ts:166`) | **RIDES** | Leave. |
| Schedule a one-shot follow-up from chat | `openwop:tasks.schedule-followup` action tool (`agentTools.ts:40`) | **RIDES** | Leave. Chat-first exemplar. |
| Cancel my follow-ups | shared Schedules panel via `listMyJobs`/`SubjectSchedulesPanel` | **RIDES** | Leave. |
| Channel-scoped scheduled posts | same service+scheduler, membership-gated, `conversationId` forced to channel (`routes.ts:127-141`) | **RIDES** | Leave (no FE surface — deferred). |
| Schedules admin page (list + delete) | `ScheduledChatsPage.tsx` (org picker, DataTable, `confirm` delete) | **PAGE-LEGIT** | Keep as page; fix its honesty loop (B3/B4) + add create/pause. |
| Status display ("Active/Inert") | reads `workflowId` presence, never `enabled` (`:73`) | **THEATER** (painted status) | Render `enabled` (+ `nextRunAt`); a paused chat must read paused. |
| Author a **recurring** schedule from chat | none — one-shot tool only | **THEATER** (missing igniter; FE create client orphaned) | Add a `registerFeatureAgentTool` recurring-schedule tool mirroring `schedule-followup`. |

**Verdict tally: RIDES 5 · ADAPTER 0 · PARALLEL 0 · THEATER 2 · PAGE-LEGIT 1.**

---

## Port tests — the load-bearing results

- **Interface (recurring):** authoring "every weekday at 8am, digest X" is pure
  describe-intent → belongs in the ONE chat, driven by an agent tool. Today it is
  a route with no UI. **Fail → B1.**
- **Agency:** the follow-up tool is a real action tool sharing the acting-user
  predicate and failing closed without a user/conversation (`agentTools.ts:61-71`)
  — **pass**. No recurring analogue exists — **the gap, not a toothless persona.**
- **Ignition:** the turn-workflow has a real igniter (the daemon tick); the
  follow-up job has one (the tool). The **recurring** config has an igniter only
  via HTTP — **partial**, B1.
- **Composition:** one `agent-runner` node reusing the catalog; no substantive
  logic in a bespoke node. **Pass.**
- **HITL:** no bespoke approve/submit button; a `review`-autonomy scheduled run
  escalates through `runAgentDispatchLive` (`agentRunnerNode.ts:181`), the shared
  owner. **Pass** (rides the dispatch gate; verify escalation surfaces to the
  reviews inbox for a system-fired run — deferred-honestly item D1).
- **SSoT:** the scheduler is the single owner of fire timing;
  `listScheduledChatsWithStatus` **joins** `getJob` rather than storing a second
  next-fire (`scheduledChatService.ts:129`). **Pass** — except the page then
  discards the joined truth for the workflowId heuristic (B4).
- **Authority-parity:** org path = `workspace:{read,write}`; channel path =
  membership (owner manage / member list); create validates agent-resolves +
  caller-can-see-conversation and normalizes-once to close the padded-id IDOR
  (`routes.ts:62-68`). **Pass** — a genuinely careful surface.
- **Honesty-loop:** status column fails (B4); pause state has no read (B3).
- **Lifecycle:** deterministic keys, roster-delete pause, channel-remove delete +
  reconcile-on-read, idempotent turn id. **Pass** — best-in-class.
- **Card-mechanism:** the scheduled reply is a plain `assistant` conversation
  turn, not a card — correct; no A2UI/typed-renderer decision applies. An in-chat
  create tool (B1) returns a plain tool result the agent narrates (the
  follow-up's precedent) — no new card mechanism needed.

---

## Demolition list (with regression pins)

- **`scheduledChatsClient.ts:47` `createScheduledChat`** — orphaned. Either wire
  it into the admin-page create affordance (Phase 2) or delete it. Pin: a lint/
  dead-export check, or the create test added in Phase 2 becomes its only caller.
- **`ScheduledChatsPage.tsx:73` status = `workflowId ? Active : Inert`** — demolish
  the heuristic; replace with `enabled`-driven status. Pin: a page test asserting
  a chat with `enabled:false` renders the paused chip (guards the resurrection of
  the workflowId heuristic).

No PARALLEL surfaces to demolish — nothing here shadows the scheduler, dispatch,
conversation, or approvals owners.

---

## New-code inventory (small)

1. **One agent tool** — `openwop:tasks.schedule-recurring-chat` via
   `registerFeatureAgentTool`, mirroring `schedule-followup`: acting-user gated,
   `conversationId` from scope (unforgeable), `cronExpr` validated with
   `parseCron` up front, deterministic content-hashed jobId, pending-cap. Reuses
   `createScheduledChat` with a **user-owned** binding (B5) so it lists/cancels in
   the existing Schedules tab. Add to the ADR 0315 default-on baseline only after
   review. (No new node, no new workflow — the turn-workflow already exists.)
2. **Two thin FE affordances on the existing page** — a create form (wire the
   orphaned client) and a pause/resume toggle (existing `/pause` route). No new
   owner.
3. **One status fix** — render `enabled` + `nextRunAt`, delete the workflowId
   heuristic.

That is the whole port. No new scheduler, dispatch, run model, transcript store,
approval machinery, or card renderer.

---

## Phased plan (each phase closes with /code-review + /ux-review, fixes applied)

- **Phase 1 — Honesty first (no new capability).** Fix the painted status (B4):
  status reads `enabled`; surface `nextRunAt`/`lastRunAt` already joined. Add the
  pause/resume toggle (B3) over the existing route. Gate: page test pins
  paused→paused-chip; build green. *Compliance seam before anything new.*
- **Phase 2 — Wire or demolish the create client (B2).** Add a minimal create
  affordance to the admin page (agent picker + cron + prompt + conversation) using
  the existing `createScheduledChat` client, OR delete the orphaned client if
  Phase 3 supersedes it. Gate: create test is the client's caller.
- **Phase 3 — The chat-first igniter (B1).** Ship
  `schedule-recurring-chat` as a `registerFeatureAgentTool` action tool
  (user-owned per B5), so a user authors a recurring digest by describing it in
  the ONE chat. Gate: tool test (acting-user + conversation fail-closed, cron
  validation, deterministic id, pending-cap), and the job appears in the Schedules
  tab. Re-run `/grade-ai-exchange` (new model-facing tool → tracker row +
  tripwire).
- **Phase 4 — Channel surface (optional).** If demand exists, extend the page (or
  the channel settings) to the channel scope the routes already serve.

---

## Deferred honestly

- **D1 — Reviews-inbox visibility for a system-fired `review` agent.** ADR 0125
  §RBAC claims a `review`-autonomy scheduled pick "queues for approval." The
  dispatch owner does escalate (`agentRunnerNode.ts:181`), but a scheduled tick
  carries **no `actingUserId`** — confirm the escalation lands somewhere a human
  actually sees (reviews inbox / notification), or state it as unverified. Do not
  paint it green.
- **D2 — Channel-scope FE.** Routes + service fully support channel-scoped posts;
  no admin/chat surface exists. Real capability, no UI — deferred, not faked.
- **D3 — OQ-3/OQ-5 (ADR 0125).** Completion notifications and per-schedule
  `skipIfMissed` remain unbuilt-by-design; unchanged by this port.
