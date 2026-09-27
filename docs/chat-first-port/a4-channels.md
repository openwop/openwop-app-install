# Channels (team messaging) — chat-first port review (unit A4)

**Scope:** `backend/typescript/src/features/channels/` +
`frontend/react/src/features/channels/` (whose real UI lives in the shared
`frontend/react/src/chat/conversations/`). Single-feature mode.

**Headline verdict:** Channels is a **reference "already rides the engine"
feature** — the falsifiable, positive outcome the skill allows. A channel is a
`conversation` with `type:'channel'` over the ONE conversation store; its UI is a
section of the ONE chat's rail rendered through the shared `ConversationView`;
its intelligence (agent replies, catch-up, scheduled posts) is expressed through
`startWorkflowRun` → a single core `agent-runner` node. There is **no parallel
message store, no second chat, no second scheduler, no toothless agent, and no
orphaned workflow.** No PARALLEL and no THEATER were found. Two thin ADAPTERs and
two PAGE-LEGIT surfaces round it out. There is essentially nothing to port; this
document records why, with the evidence, and names the handful of watch-items.

---

## Step 1 — Contract scouting (what holds, with evidence)

**Conversation owner — RIDES, not shadowed.** `createChannel` calls
`ensureConversationMeta(tenantId, channelId, { type:'channel', … })` and
`hostExtStorage().createChatSession(...)` — the same meta + session stores every
DM/group conversation uses (`channelService.ts:89-94`). Membership is
`addParticipant`/`removeParticipant` on that meta
(`channelService.ts:98,120,360,370,398,414`), not a private roster table.
Messages are `appendChatMessageLive(...)` on the shared chat message bus
(`channelService.ts:461`), read back via `hostExtStorage().listChatSessionMessages`
(`channelService.ts:517`). The header comments state the invariant explicitly:
"A channel is a NEW conversation `type:'channel'` (NOT a parallel message store)"
(`channelService.ts:3-8`, `feature.ts:1-9`).

**The ONE chat — RIDES, not forked.** The frontend feature package is only
redirect shims: `/channels` → `/`, `/channels/:id` → `/?conversation=<id>`
(`frontend/react/src/features/channels/routes.tsx:16-25`). The real surface is a
"Channels" section in the shared `ConversationsRail`
(`chat/conversations/ConversationsRail.tsx:268-282`) whose body is the shared
`ConversationView` (ADR 0073, `chat/ConversationView.tsx:2-11`). No bespoke chat
panel exists — consistent with CLAUDE.md's "one AI chat, never recreate" law.

**Run engine + node catalog — RIDES.** The channel agent-turn workflow
`openwop-app.channel.turn` is a **single core `agent-runner` node**
(`channelTurnWorkflow.ts:26-47`, importing `AGENT_RUNNER_TYPE_ID` from
`host/agentRunnerNode.js:17`). It is registered idempotently at boot
(`channelTurnWorkflow.ts:50-52`, called from `routes.ts:45`). No channel-local
run model, no custom executor.

**Ignition — real, not declared.** Every run of the workflow has a real igniter:
(1) a human post that addresses an agent member fires
`dispatchChannelAgentTurns` → `startWorkflowRun` (`routes.ts:202`,
`channelAgentDispatch.ts:99-105`); (2) the AI catch-up route fires the same
workflow with `conversationId` omitted (`routes.ts:255-261`); (3) scheduled posts
fire it through the existing scheduler (below). No orphaned `WorkflowDefinition`.

**Agent tool allowlist vs capability — honest.** The only agent tool is
`openwop:channels.list`, a **read-only** tool that shares
`listChannelsForViewer` with the discovery route (predicate lives in the service,
`agentTools.ts:11,30`) and **fails EMPTY** without an acting user
(`agentTools.ts:24-29`) — exactly the ADR 0308 / read-tool contract. It is not a
"toothless authoring agent" because channels do not claim an authoring agent; the
acting intelligence is the agent-runner reply, which is a real turn.

**Scheduler owner — RIDES, not shadowed.** Scheduled channel posts are the
existing `scheduled-agent-chats` feature (ADR 0125) under a channel-scoped route
`/scheduled-chats/channels/:channelId/chats`
(`features/scheduled-agent-chats/routes.ts:6-7,39,127`). It imports the channel
authz helpers (`assertChannelManage`, `isChannelAgentMember`, `getChannel` —
`scheduled-agent-chats/routes.ts:23`), forces `conversationId` to the channel
(`routes.ts:136`), and reconciles on agent removal (SCHED-2 reconcile-on-read
`routes.ts:112-121`, driven by `publishChannelAgentRemoved`,
`channelService.ts:403`). No second scheduler.

**Authority parity — one predicate, reused everywhere.** `caller(req)` resolves
one identity for owner-stamp, management authz, and access (`routes.ts:32-34`).
Management ops all funnel through `assertChannelManage` (owner-only, fail-closed,
404-masking non-members — `channelService.ts:263-273`); reads through
`canAccessChannel`/`getChannel` default-deny (`channelService.ts:248-254,423-428`);
the SSE stream, presence, and scheduled routes all re-run the same gates
(`routes.ts:177,275,289`; `scheduled-agent-chats/routes.ts:130`). The tool shares
the route predicate by construction.

**Constraints that bound (and don't block) the port:** presence is in-memory
per-instance ephemeral live state, RFC 0110, **off by default** and operator-
warned on multi-instance (`routes.ts:39-55`, `channelPresenceTracker.ts:1-14`) —
so it is honestly deferred, not painted green. ADR statuses: 0126 in-progress
(Phases 1–2 shipped), **0154 implemented + deployed**, 0192 Accepted, 0202
Accepted (D1/D2/D4/D5/D3/D6 implemented).

**No blockers.** Every scouting assumption that the skill would test held. There
is nothing here of the "array-map isn't an iterator / child gates are invisible /
there was no stored plan" class that produced ADR 0458's blockers.

---

## Step 2–3 — Capability inventory + verdicts (ten port tests applied)

| # | Capability | Today | Verdict | Evidence / port note |
|---|---|---|---|---|
| 1 | Create a channel | create dialog → `POST /channels` | **RIDES** | Instantiates the conversation owner (`channelService.ts:89-103`). Creating a container is *structural*, not "describe intent" — a dialog is the right shape (skill law 7). |
| 2 | Browse / discover channels | discovery list (public + own private) | **PAGE-LEGIT** | Read-only, minimal public shape, no roster leak (`channelService.ts:147-211`). Honesty loop closed: counts + `lastActivityAt` read from the session header, not faked (`:164-206`). |
| 3 | Join / leave channel | self-serve buttons | **RIDES** | `addParticipant`/`removeParticipant` on the meta; owner-leave 409 invariant (`channelService.ts:216-228,350-361`). |
| 4 | Rename / describe / archive | manage dialog | **RIDES** | `setConversationChannel` + session-title mirror (`channelService.ts:275-293,363-366`). Owner-gated via the one predicate. |
| 5 | Member + agent membership; agent reply policy | manage dialog controls | **RIDES** | Participant records on the conversation meta; policy is a real membership mutation, LWW-safe (`channelService.ts:110-134,368-416`). |
| 6 | Post a message | composer → `POST …/messages` | **RIDES** | `appendChatMessageLive` on the shared bus, dual-parses text/envelope (`channelService.ts:442-466`). |
| 7 | Read history (paginated) | feed | **RIDES** | Shared chat-session store + one cursor owner `host/messageCursor` (`routes.ts:114-168`). |
| 8 | Live delivery (SSE) | `…/stream` | **RIDES** | `subscribeConversationMessages` on the shared bus; membership-gated; store stays SoT (`routes.ts:172-188`). |
| 9 | Message reactions | reaction pills | **RIDES** | `messageReactionsStore` (ADR 0195), one batched read (`routes.ts:150-162`). |
| 10 | **Agent replies on @mention** (the intelligence) | fire-and-forget on post | **RIDES** | `startWorkflowRun` → `openwop-app.channel.turn` → **core** `agent-runner`; reply appended as an assistant turn (`routes.ts:202`, `channelAgentDispatch.ts:52-108`, `channelTurnWorkflow.ts:26-47`). This is intelligence expressed *through the engine*. |
| 11 | AI catch-up summary | "catch me up" → `POST …/catchup` | **ADAPTER** | Same workflow, `conversationId` omitted so the summary is returned out-of-band, not spammed in-channel (`routes.ts:249-265`, `channelService.ts:475-503`). Thin, honest wrapper; see watch-item W1. |
| 12 | Scheduled recurring agent posts | owner-only cadence picker | **ADAPTER** | Rides `scheduled-agent-chats` (ADR 0125 scheduler owner); friendly picker composes a cron for the real scheduler, member-gated, reconciled on agent removal (`ChannelSchedulePanel.tsx:1-11,37-48`; `scheduled-agent-chats/routes.ts:127-136`). Bespoke picker = legit chrome over the owner, see W2. |
| 13 | `openwop:channels.list` agent tool | chat-time read tool | **RIDES** | `registerFeatureAgentTool`, shares the route predicate, fails EMPTY without a user (`agentTools.ts:15-44`). |
| 14 | Presence + typing | ephemeral SSE, **off by default** | **PAGE-LEGIT** | In-memory, never persisted, RFC 0110, operator-warned; honestly deferred, not painted (`channelPresenceTracker.ts`, `routes.ts:39-62,267-313`). |

**Verdict tally: RIDES = 9, ADAPTER = 2, PARALLEL = 0, THEATER = 0,
PAGE-LEGIT = 3.**

**Port-test notes that matter:**
- **HITL test (5):** channels have *no* gate/approval machinery — correctly. An
  agent reply in a channel is a conversation turn, not model output reaching
  durable authored state; there is nothing to approve. Absence of HITL here is
  right, not a gap.
- **Card-mechanism test (10.5):** channel agent replies render as plain assistant
  turns (`MessageBubble`), not A2UI surfaces or interrupt cards. Correct: the
  card shapes are app-known conversation messages, not model-variable layouts or
  decision cards. No wrong-mechanism pick.
- **Lifecycle test (9):** every durable row rides an existing owner's lifecycle —
  channel metas erase via conversation subject-erasure (ADR 0464), scheduled
  posts have a death seam wired through `publishChannelAgentRemoved`
  (`channelService.ts:403`) → SCHED-2 reconcile. Retries reuse the runId; the
  reply append is idempotent on it (`channelAgentDispatch.ts:91-96`).

---

## Blockers (from scouting), each with the honest alternative

**None.** No scouting assumption failed. This section is intentionally empty — the
skill's most valuable output (a falsified mechanic) does not exist here, and
saying so with evidence is the correct, falsifiable result.

---

## Demolition list (with regression pins)

**Nothing to demolish.** No bespoke surface substitutes for a primitive the
platform already owns. The create/manage/schedule dialogs configure a *structural
container* and bind the *real scheduler*; they are not "talk to AI" surfaces and
are not second implementations of an owned concept. Keep them.

The already-shipped demolition (the retired standalone `/channels` page,
superseding ADR 0145 §4) is done and pinned by the redirect shims + the rail
tests (`features/channels/routes.tsx:5-25`; `ConversationsRail.listonly.test.tsx`).

---

## New-code inventory

**Empty.** No new tools, nodes, workflows, reads, or seams are required — every
one the feature needs already exists and is correctly instantiated.

---

## Watch-items (drift guards for the two ADAPTERs — not ports)

- **W1 — Catch-up is a second entry point to the same intelligence.** The
  "catch me up" button (`routes.ts:249`) does what a human could also do by
  posting `@agent summarize what I missed`. It is **not** parallel architecture
  (identical workflow, server-resolved unread span, out-of-band delivery so it
  doesn't post noise). The only chat-first refinement available: demote the
  button to a **suggested-prompt chip** in the composer that pre-fills that
  mention, so there is one visible path to the capability. Optional polish, not a
  correctness issue — file it, don't build it.
- **W2 — The cadence picker is bespoke UI over the scheduler.** Legitimate chrome
  (the scheduler owner ships no UI), but it hand-composes cron strings
  (`ChannelSchedulePanel.tsx:37-48`) and humanizes them back
  (`:79-92`). If `scheduled-agent-chats` ever grows a shared cadence component,
  this should consume it rather than keep its own composer. Watch for drift, no
  action now.

---

## Deferred honestly (already deferred by the feature, not by this review)

- **Presence / typing / receipts** — RFC 0110, in-memory per-instance, **off by
  default**, operator-warned that multi-instance fragments it
  (`routes.ts:39-55`). Honestly deferred; not painted green.
- **Cross-host channels** — explicitly RFC-gated and not shipped
  (`channelService.ts:5-8`, ADR 0126 status line).
- **Threading** — ADR 0126 Phase 5, pending. Not claimed as present.

---

## Definition-of-done statement

Channels is the falsifiable positive case the skill names in its Definition of
Done: **"already rides the engine" — evidenced.** Every capability either
instantiates the owning primitive (conversation, run engine + core agent-runner,
scheduler, message/reactions stores, subjectDisplay) or is an honest read-only
page/live-state surface. Zero PARALLEL, zero THEATER, zero blockers, an empty
demolition list, and an empty new-code inventory. The only follow-ups are two
optional drift guards (W1, W2).
