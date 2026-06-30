# ADR 0043 — Persistent conversations (one model for agent · person · group · workspace chats)

**Status:** Accepted — implemented (Phases 1–5 + lineup-from-participants landed & deployed 2026-06-15; legacy drawers + `conversations-v2` toggle RETIRED — Conversations rail is the sole chat IA. Phase 6 resolved: Person 1:1 CLOSED, Workspace = assistant chat (W-A), conversation visibility now participant-scoped)
**Date:** 2026-06-15
**Toggle:** rides the existing chat surface (always-on); a `conversations-v2` toggle gates the
new sidebar IA during rollout, then graduates.
**Depends on / composes:** the existing chat-session store (`ChatSessionRecord`/`ChatMessageRecord`
+ `Storage.{list,create,get,update,delete}ChatSession*` + `appendChatMessage`), ADR 0005 (User
Profiles — `User.userId` participant identity), ADR 0015 (workspace = tenant — scoping), ADR 0025
(user/agent orchestration symmetry — a participant is a user OR an agent, peer principals), ADR 0040
(Board of Advisors — a board becomes a GROUP conversation; subsumes its "increment 2"), ADR 0041
(subject memory — the `user:<id>` / `agent:<id>` **subjectRef** vocabulary is reused verbatim as the
participant id), the `openwop-app.chat.turn` run path, and RFC 0005 conversation primitives.
**Coordinates with (does not collide):** ADR 0042 (profile-knowledge, in flight) — confined to
profile knowledge/memory; touches no chat/conversation seam.
**Surface:** host-extension under `/v1/host/openwop-app/chat/*` (generalized) — **non-normative**.
**RFC gate:** **host work, NO new RFC.** Every turn remains an ordinary non-normative `chat.turn`
run; persistence is the host-ext store. The only wire touchpoint is the already-**Parked RFC 0101**
(normative cross-host multi-party), which this host feature does NOT require. See § RFC gate.

## Why this exists

The AI chat today has three disjoint surfaces for "who/what am I talking to and where did it go":
1. a **chat-history tab** (lists tenant-scoped `chat_sessions`),
2. an in-chat **"Active agents" panel** (FE-only `ChatSession.activeAgents.lineup`, never persisted),
3. **`@@<board>` convening** (activates a board's cohort into that FE-only lineup for the current session).

A user can't reopen "my chat with Felix" or "the Founders board" from a list the way every mature chat
product (Slack, Teams, Google Chat, WhatsApp, Discord) lets them. The board, despite ADR 0040's redo,
is still a *transient* activation, not a durable conversation. This ADR introduces **one persistent
conversation model** that the sidebar lists by type (People · Agents · Groups), so any chat — with an
agent, a person, a group (the Board of Advisors), or the workspace — persists and resumes, and the
"active participants" become a property of the conversation rather than an ephemeral panel.

## Deep-dive: how mature chat products model this (and what fits)

| Product | Conversation primitive | Participants | Read state | History | Fit for us |
|---|---|---|---|---|---|
| **Slack** | ONE `conversations.*` API, typed `im` (1:1) · `mpim` (group DM ≤8) · `public/private_channel` | channel members; **apps are members** | per-member `last_read` ts → unread | `conversations.history`, **cursor** pagination | **Strong** — one typed primitive + apps-as-members maps to agents-as-participants |
| **Google Chat** | `Space` (unified): DM · group DM · named space | `spaces.members` — **bots/apps are members like people** | per-member read state | `spaces.messages`, cursor | **Strongest** — a bot is a first-class space member = our agent-as-participant (ADR 0025) |
| **MS Teams** | `chat` with `chatType: oneOnOne \| group \| meeting` | `/chats/{id}/members` sub-resource | per-user unread | `/messages`, `@odata.nextLink` | **Strong** — discriminated `chatType` + member sub-resource |
| **WhatsApp** | chat (1:1 / group) | group participants + admin | delivery/read ticks | linear, paged | Partial — simplest IA; no threads (good — we don't want threads) |
| **Discord** | server > channel + DM / group DM (≤10) | channel members | per-channel read marker | linear + threads | Partial — servers/threads over-scoped for us |

**Convergent backend pattern (what we adopt):**
- **One conversation entity with a `type` discriminator** (Slack `conversations`, Google `Space`,
  Teams `chatType`) — NOT a table per kind.
- **A membership/participant join** where a participant may be a person OR an app/agent (Google Chat +
  Slack apps + Teams bots all model apps as members) — exactly our agents-as-participants.
- **Messages belong to a conversation**, ordered, **cursor-paginated**.
- **Per-participant read state** (`last_read` marker) → unread badges.
- **1:1 canonicalization** — a DM is keyed by its participant set so "message X" resumes the existing
  thread instead of forking a new one (Slack `conversations.open` is idempotent for a user-set).

**What we deliberately DON'T adopt:** Slack public/private channel ACLs, Discord servers, Teams meeting
chats, message **threading** (our transcript is linear — a board "round" is sequential turns in the
linear transcript, not a thread), and cross-workspace federation (Slack Connect). Scoping is
workspace = tenant (ADR 0015) + owner/participant, not a channel-ACL system.

## Gap analysis vs our architecture

| Capability | Today | Owner | This ADR |
|---|---|---|---|
| Conversation existence + history | `chat_sessions` (tenant-scoped, **no owner, no participants**), newest-first, **no message pagination** | `routes/chatSessions.ts` + `Storage.*ChatSession*` | **Generalize** — add `type`, `ownerUserId`, participants, read-state, cursor. NOT a parallel table. |
| Per-message attribution | `agentId`/`agentPersona` persisted in the message `content` JSON | `ChatMessageRecord` | Keep; lift `agentId` to a first-class column (optional) for participant grouping |
| "Active agents" lineup | **FE-only** (`ChatSession.activeAgents`, localStorage) | FE `useActiveAgents` | **Retire the panel** → persisted conversation participants (server-authoritative) |
| Chat-history tab | `listChatSessions(tenant)` | FE `ChatSidebar` history | **Retire the tab** → the typed conversation list |
| Multi-agent transcript | RFC 0005 conversation-gate (`conversation.ts`, **flag-OFF**) + the live `chat.turn` path | `host/conversationExchange.ts` / `bootstrap/nodes.ts` | Keep `chat.turn` as the turn engine; the **host-ext conversation store** is the persistence (NOT the flag-off RFC-0005 run-events model — avoid two persistence models) |
| Board of Advisors | cohort entity + `@@` activates the FE lineup | `features/advisory-board` | A board **opens a GROUP conversation** seeded from its cohort; the cohort stays the *template* |
| Participant identity | `User.userId` (ADR 0005); agent `agentId` (rosterId / `user.<t>.<slug>`) | users / roster | Reuse as `subjectRef` (`user:<id>` / `agent:<id>`) — the **same vocabulary ADR 0041 memory uses** |
| Person directory | `OrgMember` / `User` | `accessControlService` / users | Reuse for the People list — don't reinvent people |
| Read state | none | — | **NEW** — per-participant `lastReadAt` |
| Conversation ownership | none | — | **NEW** — `ownerUserId` + participant list |

**No parallel/shadow risk if:** we **extend `chat_sessions` into the conversation store** (one owner),
make participants the single source of truth for "who's in the chat" (retiring the FE lineup), and use
the existing `subjectRef` identity rather than minting conversation-local participant ids.

## Decision

Generalize the existing chat-session store into **one `Conversation` model** that all types share via a
`type` discriminator + a `ConversationParticipant` membership join. Build on the existing
`ChatSessionRecord` + `Storage` methods + `chat.turn` runs — no parallel table, no second chat runtime,
no new identity scheme.

### Data model (host-ext; extends the current store)

```ts
// Generalizes ChatSessionRecord (conversationId === the existing sessionId).
interface Conversation {
  conversationId: string;
  tenantId: string;                       // ADR 0015 scope
  type: 'agent' | 'person' | 'group' | 'workspace';   // 'project' slots in later
  title: string;
  ownerUserId?: string;                   // ADR 0005 subject (nullable for legacy/anon)
  /** Canonical key for 1:1 dedup: sorted subjectRefs of {owner + the one other party}.
   *  A second "open chat with agent X" resolves to the SAME conversation. Null for groups. */
  dmKey?: string;
  createdAt: string; updatedAt: string; lastMessageAt?: string;
  messageCount: number;
  /** For type:'group' seeded from a board — the cohort template it came from (ADR 0040). */
  boardId?: string;
}

interface ConversationParticipant {
  conversationId: string;
  /** The SAME subjectRef ADR 0041 memory uses — no new id scheme. Extensible for 'project:'. */
  subjectRef: string;                     // 'user:<userId>' | 'agent:<agentId>' (| 'project:<id>' future)
  role: 'owner' | 'member';
  addedAt: string;
  lastReadAt?: string;                    // read state → unread badge
}
// Messages stay ChatMessageRecord (role/content/meta + persisted agentId).
```

**One model, the four (→five) types are just `type` + participant shape:**
- **agent (1:1):** owner + 1 `agent:` participant. `dmKey` canonicalizes.
- **person (1:1):** owner + 1 `user:` participant. `dmKey` canonicalizes.
- **group:** owner + N participants (any mix of `user:`/`agent:`). **Board of Advisors = group** whose
  agent participants are the board's advisors (+ chair); `boardId` links the template.
- **workspace:** `type:'workspace'`, tenant-wide (participant = the workspace itself / all members).
- **project (FUTURE):** `type:'project'` + a `project:<id>` participant/subjectRef — the tagged
  `subjectRef` union already accommodates it; no model change when it lands.

### Sidebar replaces two surfaces (retire, don't duplicate)
A single **Conversations** rail, grouped **People · Agents · Groups** (workspace pinned at top).
Selecting an entry **opens-or-resumes** its persistent conversation (1:1 via `dmKey`; a group/board via
its `conversationId`). This **replaces**:
1. the **"Active agents" panel** → the open conversation's `participants` (server-persisted), rendered
   inline in the conversation header, editable (add/remove a participant = membership mutation);
2. the **chat-history tab** → the typed conversation list (it *is* the history).

`@@<board>` and "pick the board in the sidebar" both resolve to the board's group conversation.

### Migration
- **`chat_sessions` → conversations:** additive columns (`type` default `'agent'`, nullable
  `ownerUserId`/`dmKey`/`boardId`) + a new `conversation_participants` table; a **lazy backfill** on
  first open (existing sessions become `type:'agent'` assistant conversations; the FE-only lineup, if
  present in localStorage, seeds participants once). No destructive migration; old sessions keep working.
- **Advisory-board chats:** today's `@@` activations were FE-only/transient → **nothing persisted to
  migrate** (clean). The board entity (cohort) is unchanged; convening now creates/opens a group
  conversation.
- **RFC 0005 conversation-gate (flag-off):** left dormant; the host-ext conversation store is the one
  persistence model. (If RFC 0005 run-events are ever wanted as the transcript, that's a separate call.)

### Folds in ADR 0040 "increment 2"
- **Knowledge-in-`chat.turn`** (advisors recall preseeded memory) becomes a general phase: any
  `agent:` participant's turn composes ADR 0038/0041 knowledge — reusing `resolveAgentKnowledgeRetrieve`
  / the ADR 0042 generalized `resolveSubjectKnowledgeRetrieve` (coordinate at that gate).
- **Sequential boardroom cadence** becomes the **group-conversation turn policy** (one participant at a
  time, chair-framed), built on the `chat.turn` per-turn engine + a completion signal.

## RFC gate (the spec question, explicitly)

**Verdict: purely host-side. NO new RFC, and no change to an existing one.**
- The conversation/participant/message/read-state model lives entirely under the **non-normative**
  `/v1/host/openwop-app/chat/*` host-extension namespace and the host `Storage` interface.
- Every turn is still an ordinary **`openwop-app.chat.turn`** run (already non-normative host workflow).
- Participant identity reuses `User.userId` (ADR 0005) and agent ids — no wire identity change.
- **The only wire-adjacent question** is the *normative cross-host* multi-party shape — participant
  roster on `conversation.opened` + per-turn `speakerId` — which is **RFC 0101 (Parked)**, already
  flagged by ADR 0040. This host feature does **not** require it: a host can record participants +
  attributed messages locally. RFC 0101 matters only if/when a cross-host peer must *discover* the
  roster/speaker on the wire. **If** we ever expose conversations/participants on a normative `/v1`
  endpoint or run-event, THAT is the RFC trigger — the design deliberately avoids it.

## Alternatives weighed
- **A new `conversations` table beside `chat_sessions`** — rejected (the `orgs`↔`accessControl` failure
  mode: two systems for one concept that drift). Generalize the existing store instead.
- **Adopt the RFC 0005 conversation-run-events model as the persistence** (the flag-off path) —
  rejected as the primary store: it's a second persistence model (run events vs `chat_messages`), heavier
  (event-sourced reconstruction), and not the production default. Keep `chat.turn` + the host-ext store.
- **Keep the board as a transient session** — rejected; it's the very gap (the user can't reopen a board).
- **Per-type tables (agentChats / groupChats)** — rejected; the mature-product convergence is one typed
  primitive. Per-type tables foreclose the group-with-mixed-participants case and duplicate history logic.

## Phased plan
1. **Conversation model + participants (backend).** Generalize `ChatSessionRecord` → `Conversation`
   (additive cols) + `conversation_participants` table + `Storage` methods; participants are
   server-authoritative; 1:1 `dmKey` canonicalization + idempotent open. Route + storage tests.
2. **Sidebar IA (frontend).** The typed Conversations rail (People · Agents · Groups) replacing the
   history tab + the active-agents panel; open-or-resume; participants rendered inline. Toggle
   `conversations-v2` during rollout. Lazy backfill of legacy sessions.
3. **Read state + pagination.** Split into two PRs (delivery sequencing):
   - **3a — read state.** Per-participant `lastReadAt` → unread badge on the Conversations rail;
     mark-read on open. Frontend-only (rides the Phase-1 `markRead`/`lastReadAt`).
   - **3b — pagination.** Cursor pagination on message history (extend `listChatSessionMessages`
     across the sqlite + postgres backends + route + FE feed "load earlier").
4. **Board as group conversation.** `@@<board>` stamps the CURRENT chat as the board's group
   conversation (type:group + `boardId` link + cohort participants), so the Board of Advisors lives
   in history under Groups — no session fork mid-turn. (Sourcing the live routing lineup FROM the
   conversation's participants — fully retiring the FE-only lineup — landed as a follow-up: see the
   "lineup-from-participants" log row. No migration was needed — the meta sidecar already persists
   participants, so the `[[activeAgents persistence]]` cross-device follow-up is closed by deriving
   the lineup from them on open.)
5. **Group turn policy (ADR 0040 increment 2).** Two PRs:
   - **5B — knowledge-in-`chat.turn`.** Compose each routed agent's bound knowledge (ADR 0038
     `resolveAgentKnowledgeRetrieve`, which delegates to the shared ADR 0042
     `resolveSubjectKnowledgeRetrieve`) into the chat responder so advisors recall preseeded memory + KB.
   - **5A — sequential cadence.** Chair-framed boardroom cadence driven off the turn-complete signal
     (the `run.completed` SSE event flipping `isSending`).
6. **(Deferred) Person 1:1 + Workspace conversations.** Wire the People list (OrgMember/User) + the
   workspace conversation; Project type when the project feature lands.

### Implementation log
| Phase | What landed | Where |
|---|---|---|
| 1 | Conversation META sidecar (not additive cols — a `DurableCollection` keyed by the same `conversationId`, avoiding a 3-backend SQL migration; the chat_session stays the title+message store). Typed create/open-or-resume/participants/read-state routes + 6 route tests. | `host/conversationStore.ts`, `routes/chatSessions.ts`, `test/conversations-route.test.ts` |
| 2 | FE Conversations rail (People · Agents · Groups) folding in the active-agents lineup as the open conversation's participants; one tab replaces the History + Active-agents tabs when `conversations-v2` (a CORE chat toggle, OFF by default) resolves on. Legacy sessions backfill lazily via the BE `agent`/`[]` projection. `chatSessionsClient` + `useChatSessions` extended (no parallel client/hook). PATCH now returns the enriched conversation shape. | `chat/conversations/{ConversationsRail.tsx,conversationGroups.ts}`, `chat/leftRail/LeftRail.tsx`, `chat/ChatSidebar.tsx`, `client/chatSessionsClient.ts`, `chat/hooks/useChatSessions.ts`, `routes/chatSessions.ts` (toggle + PATCH) |
| 3a | Unread badge on the Conversations rail — a pure `isUnread(conversation)` (owner `lastReadAt` vs conversation `updatedAt`; empty/legacy read as read) drives a bold title + accent dot (`role="img"` + `aria-label`, never color-alone); `markRead` (optimistic, best-effort) fires on open. | `chat/conversations/{conversationGroups.ts,ConversationsRail.tsx}`, `chat/hooks/useChatSessions.ts`, `chat/ChatSidebar.tsx`, `styles/global.css` |
| 3b | Reverse cursor pagination on message history. `listChatSessionMessages(sessionId, {limit, before})` across sqlite + postgres (row-value `(created_at, message_id)` cursor — deterministic across ms ties); `GET …/messages?limit&before` returns `{messages, nextCursor}` (no `limit` → legacy full thread); FE loads the newest page then "Load earlier messages" prepends older pages (scroll held — auto-scroll only fires on bottom-append). 5 route tests. | `storage/{storage.ts,sqlite/index.ts,postgres/index.ts}`, `routes/chatSessions.ts`, `client/chatSessionsClient.ts`, `chat/hooks/useChatSession.ts`, `chat/MessageFeed.tsx`, `chat/ChatSidebar.tsx`, `test/chat-sessions.test.ts` |
| 5A | Sequential boardroom cadence. `planBoardroomTurns` (pure, 9 unit tests) orders the follow-up turns after the chair's opening — advisors × rounds in declared/round-robin, optional chair synthesis. `useBoardroomCadence` self-clocks off the falling edge of `isSending` (a turn finished) and dispatches the next via `send()` routed to that advisor with a short moderator hand-off prompt (a portable trailing user turn). Started only from a `@@<board>` summon; cancelled on New Chat. *Verified: planner unit tests + build + 83 chat tests; the live multi-agent streaming cascade was not run (no live LLM here, CI down).* | `chat/conversations/{boardroomCadence.ts,useBoardroomCadence.ts}`, `chat/ChatSidebar.tsx`, `test/.../boardroomCadence.test.ts` |
| 5B | Knowledge in `chat.turn`. The chat responder composes the routed agent's bound knowledge (ADR 0038 `resolveAgentKnowledgeRetrieve` → shared ADR 0042 `resolveSubjectKnowledgeRetrieve`) against the latest user text and appends it to the system prompt, with ADR 0038 §C trust fencing (`composeAgentKnowledgeContext`, 5 unit tests). Gated on the agent's `knowledge` capability + fully best-effort → no change for agents without a binding. | `host/agentKnowledgeComposition.ts`, `bootstrap/nodes.ts`, `test/agent-knowledge-context.test.ts` |
| 4 | Board as a group conversation. `@@<board>` stamps the current chat as the board's group conversation in place — `markAsBoardGroup` (create-or-update, idempotent) flips type→group, links `boardId`, merges the cohort as members; `POST …/sessions/:id/board` + `findByBoardId`. The boardroom turns land in a conversation that shows under Groups, no session fork. FE `attachBoard` fires (best-effort) from the `@@` summon on the current `session.id`. 1 route test. | `host/conversationStore.ts`, `routes/chatSessions.ts`, `client/chatSessionsClient.ts`, `chat/hooks/useChatSessions.ts`, `chat/ChatSidebar.tsx`, `test/conversations-route.test.ts` |
| lineup-from-participants | Retires the FE-only lineup: opening a conversation DERIVES the active-agents lineup from its server-side `participants` (`participantsToLineup`, 4 unit tests — `agent:` refs resolved via the agent catalog, owner/unresolvable dropped), so it reconstructs cross-device. Membership now writes through — single `@agent` activation + the `×` remove call `add/removeConversationParticipant`; `@@board` already did via `attachBoard`. No migration (the meta sidecar persists participants). | `chat/conversations/participantLineup.ts`, `chat/activeAgents/useActiveAgents.ts` (`setLineup`), `chat/hooks/useChatSessions.ts` (`add/removeParticipant`), `chat/hooks/useChatSession.ts`, `chat/ChatSidebar.tsx` (`selectConversation`) |
| legacy-drawer retirement | Deleted `SessionHistoryDrawer` + `ActiveAgentsPanel` + the OFF-path branching + the `conversations-v2` rollout toggle once the rail was deployed + validated live. `LeftRail` collapses to `[Conversations, Workflow]`; `ChatSidebar` drops the toggle read, the dual-mode tab normalization, and the legacy localStorage migration. `DEFAULT_ASSISTANT_*` relocated to `activeAgents/constants.ts`. The rail is now the sole chat IA. | `chat/leftRail/LeftRail.tsx`, `chat/ChatSidebar.tsx`, `chat/activeAgents/constants.ts`, `routes/chatSessions.ts` (toggle removed); deleted `chat/SessionHistoryDrawer.tsx` + `chat/activeAgents/ActiveAgentsPanel.tsx` |
| hardening (A+B) | Resolved two open questions. **A:** read state moved to a dedicated per-`(conversation, subject)` store (`conversationReadState.ts`) — `markRead` no longer rewrites the meta (kills the read-vs-membership race); the route batch-joins markers back into `participants[].lastReadAt` (wire shape unchanged, no N+1). **B:** owner-gated participant mutation (`requireOwner` → 403 for a co-tenant non-owner; legacy/no-owner stays permissive; reads open to members). 2 new route tests (concurrent-write race + RBAC). | `host/conversationReadState.ts`, `host/conversationStore.ts`, `routes/chatSessions.ts`, `test/conversations-route.test.ts` |
| Phase 6 — visibility | Participant-scoped READ visibility (`isVisibleTo`/`requireVisible`): list filters to owner-or-participant; every by-id read/mutate route 404s a non-member (no existence leak) before the owner-gate's 403. Closes the latent multi-user-tenant leak. Legacy unowned conversations stay tenant-visible; demo unchanged. The RBAC route test now layers visibility (404) under owner-gate (403). | `routes/chatSessions.ts`, `test/conversations-route.test.ts` |
| Phase 6 — workspace (W-A) | `POST …/assistant/workspace-conversation` (in the ASSISTANT feature, not core — ADR 0001 boundary) opens-or-resumes the single `type:'workspace'` chat per user, routed to the tenant's assistant-capability agent (`findAssistantAgent`, ADR 0023) via the existing chat.turn + per-agent-knowledge path. Deduped on `(owner, workspace:<tenant>)`; 404 when no assistant is configured (no orphan). Rail IA retired People + added a Workspace section + a pinned "Workspace" affordance. 3 route assertions (404 / open / dedup). | `features/assistant/routes.ts`, `client/chatSessionsClient.ts`, `chat/hooks/useChatSessions.ts`, `chat/conversations/{conversationGroups.ts,ConversationsRail.tsx}`, `chat/ChatSidebar.tsx`, `test/conversations-route.test.ts` |

> **Phase-2 scope note (correction to the plan above).** The plan read "participants rendered inline";
> in Phase 2 that means the OPEN conversation's live `activeAgents.lineup` (assistant + @-mentioned
> agents) renders as an "In this conversation" section atop the rail, with the retired active-agents
> panel's switch/remove controls folded in. The rail's per-row chip shows each conversation's stored
> member count. Wiring the *stored* `participants` (server-side membership) as the live routing set —
> superseding the FE-only lineup — lands with Phase 4 (board-as-group), where the lineup is sourced
> from the conversation rather than rebuilt per `@@` summon.

## Phase 6 decision (`/architect` spike, 2026-06-15)

Phase 6 was scoped against industry best practice (this is an *AI-workspace* product — human↔AI +
mixed human/AI groups, not a human-IM/Slack clone) and a bulletproof-UX bar (every exposed surface
fully works; no half-states, no privacy leaks, no broken-promise affordances). The three decisions:

1. **Workspace = the assistant's tenant-graph chat (W-A), accepted.** A `type:'workspace'` conversation
   is a chat with the chief-of-staff assistant (ADR 0023) bound to workspace knowledge — an *agent*
   conversation with a special participant, owner-scoped, one deduped instance per user, riding
   replay-safe `chat.turn`. NOT a second broadcast/IM runtime. Composes from existing primitives.
2. **Conversation visibility = participant-scoped (landed).** The prerequisite + the highest-value fix:
   list/get/messages/participants/read now gate on owner-or-participant (404, no existence leak), not
   bare tenant. This closes a latent multi-user-tenant leak (every org member saw every conversation)
   independent of Phase 6. Legacy unowned conversations stay tenant-visible (back-compat); the
   single-visitor demo is unchanged (the user owns all their conversations).
3. **Person 1:1 = CLOSED.** Bulletproof human↔human IM needs a real subsystem (presence, delivery/read
   receipts, real-time push, offline queue) the host's tenant-scoped notification substrate can't honor
   — and it demonstrates nothing about the OpenWOP wire (no run, no agent, no event). `type:'person'`
   stays as a RESERVED model discriminator (re-opening later is cheap), but no DM affordance is shipped
   and the sidebar IA is **Agents · Groups · Workspace** (the "People" section is retired). Re-open only
   if the product is repositioned as a team workspace OR a real multi-user org needs private DMs — in
   which case decision 2 is the foundation.

## Open questions
- **`ownerUserId` for anonymous/tenant-only sessions** — legacy sessions have no owner; keep nullable +
  tenant-visible, or backfill to the first principal? (Lean nullable; the participant-scoped visibility
  treats unowned as tenant-visible, so a backfill would only tighten the residual legacy case.)
- **Participant RBAC** — RESOLVED: membership mutation (add/remove/attach-board) is owner-gated
  (`requireOwner`) — a co-tenant non-owner gets 403; a legacy/anon conversation with no recorded
  owner stays permissive. Reads are now **participant-scoped** (Phase 6 decision 2) — a non-participant
  gets 404 (superseding the earlier "reads open to every tenant member" posture).
- **Read-state write volume** — RESOLVED: read state moved to its own per-`(conversation, subject)`
  store (`conversationReadState.ts`), so `markRead` no longer rewrites the meta (no race with a
  concurrent membership mutation); the projection joins markers back into `participants[].lastReadAt`,
  so the wire shape is unchanged. Debounce deferred — `markRead` fires only on open (low-frequency)
  and the FE is already optimistic; revisit if a per-message read position lands.
