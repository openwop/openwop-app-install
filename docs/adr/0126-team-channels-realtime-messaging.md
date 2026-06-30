# ADR 0126 — Team channels / real-time messaging (B18)

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): channel model + membership. `type:'channel'` added to ConversationType + a `channel` descriptor on ConversationMeta (NOT a parallel store) + `setConversationChannel` mutator; `features/channels/` CRUD (create/list/get/rename/archive) + membership (add/remove via the existing `addParticipant`/`removeParticipant`), tenant-scoped + toggle-gated (`channels` OFF/tenant). v1 local-host, presence-free (presence/typing/receipts + cross-host stay RFC-gated, NOT shipped). **Phase 2 (membership-gated post + read) implemented** (2026-06-24): `postChannelMessage`/`listChannelMessages` + the `/channels/:id/messages` POST/GET routes. DEFAULT-DENY gate — a public channel admits any tenant member; a private channel admits only its participants (an undefined viewer on a private channel is denied). Phases 3–5 (presence/delivery — may need an RFC, frontend rail, threading) pending. **Date:** 2026-06-23
**Toggle:** `channels` · default **OFF** · `bucketUnit: tenant` (a B2B team-workspace surface — opt-in per tenant, like every collaboration feature).
**Surface:** host-extension under `/v1/host/openwop-app/channels/*` (non-normative) + the existing notification/run SSE feeds for delivery. **No new wire contract for v1 (local-host).**
**Depends on / composes (all Accepted/implemented — this is assembly, not new infra):**
- **ADR 0043 (Persistent conversations)** — the `Conversation` model (`type` discriminator + `ConversationParticipant` membership join + per-participant `lastReadAt`). A channel is a **new conversation `type`**, NOT a parallel message store. (`host/conversationStore.ts:53` `ConversationMeta`, `:37` `ConversationParticipant`, `:96` the `chat:conversation` `DurableCollection`.)
- **ADR 0088 (run-read authz + unified SSE channel)** — `host/sseChannel.openSseChannel` is the ONE delivery transport (headers + heartbeat + per-key concurrent-stream cap + teardown). A channel feed rides it exactly like notifications do (`host/sseChannel.ts:102`; consumed at `routes/notifications.ts:87`). No new transport.
- **ADR 0050 (per-recipient notification targeting)** — `recipientUserId` / `recipientRole` addressing + the leak-safe inbox filter (`notifications/emitter.ts:51`). A channel post `@mention` or membership event addresses the recipient through this channel, not a new fan-out.
- **ADR 0006 (RBAC) / ADR 0015 (workspace = tenant)** — `host/accessControlService.ts` + `resolveEffectiveAccess`; per-channel membership gates read/post/manage, fail-closed, uniform-404.
- **ADR 0041 (subject memory subjectRef vocabulary)** — `user:<id>` / `agent:<id>` membership ids reused verbatim (an agent can be a channel member — the Google-Chat / Slack "apps are members" pattern ADR 0043 already adopted).

**RFC verdict:** **EVALUATE — boundary stated below.** v1 is scoped to **local-host channels** (membership, posts, read-state, delivery within ONE host) = host-extension over Accepted RFCs + implemented ADRs, **NO new RFC**. **BUT** any of (a) **presence/typing/delivery-receipt** semantics or (b) a **cross-host multi-party channel** (a member on a different host) WOULD put participant-roster + per-message-speaker + presence on the wire → that needs a **new `openwop` RFC first** (the **RFC 0101 multi-party "Parked"** precedent, flagged by ADR 0040/0043). **Recommendation: ship v1 local-host (no presence/typing/receipts), defer cross-host + presence to a future RFC.** This is the SAME deferral ADR 0043 §"Phase 6 decision / Person 1:1 = CLOSED" recorded: "bulletproof human↔human IM needs a real subsystem (presence, delivery/read receipts, real-time push, offline queue) the host's tenant-scoped notification substrate can't honor."

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 **B18** (line 608: "Team channels / real-time messaging — topic-organized channels w/ presence; explicitly deferred in ADR 0043. **RFC gate: possibly** (presence/delivery semantics)") + §11.1 (line 693, Open WebUI Channels → "Missing · Medium · Monitor"). Competitor impl: **Open WebUI** `backend/open_webui/models/channels.py` + `socket/` + `src/lib/components/channel/` (group/private/direct, roles/mute/pin/read-state, webhook ingestion, searchable by models — research §3.2 line 175); per-resource `AccessGrant` across channels (line 172). LobeHub partial; LibreChat/AnythingLLM/Jan absent (research §8 matrix line 503: `Team channels / real-time | ○ | ● | ◐ | ○ | ○ | ○`).

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a channels service with its own message table, its own membership table, its own real-time socket, and its own presence tracker." Every one of those already has a single owner here; re-implementing any is the `no-parallel-architecture` violation (the ADR 0043 lesson: "a new `conversations` table beside `chat_sessions` — rejected, the `orgs`↔`accessControl` failure mode").

| Concern | Existing owner (file:line) | How channels reuses it |
|---|---|---|
| Conversation existence + typed model + membership | ADR 0043 `host/conversationStore.ts:53` (`ConversationMeta`, `type` discriminator) + `:37` (`ConversationParticipant`) | Add a **`type:'channel'`** discriminant + reuse the existing participant join. NOT a new table. The `dmKey` 1:1 canonicalization is null for channels (group-shaped, like `type:'group'`). |
| Messages (ordered, cursor-paginated) | ADR 0043 `ChatMessageRecord` + `listChatSessionMessages(sessionId,{limit,before})` (Phase 3b reverse cursor) | Channel posts ARE messages on the channel's `conversationId`. Reuse the cursor pagination verbatim. |
| Per-member read state → unread badge | ADR 0043 `host/conversationReadState.ts` (per-`(conversation,subject)` marker) | Channel unread = the same `lastReadAt` marker. No new read-state store. |
| Real-time delivery transport | ADR 0088 `host/sseChannel.ts:102` `openSseChannel` (the ONE SSE seam) | A `GET …/channels/:id/stream` rides `openSseChannel` exactly like `routes/notifications.ts:87`. NOT a new WebSocket/socket.io runtime (the Open WebUI `socket/` approach we deliberately don't copy). |
| Addressed signal (`@mention`, "added to #x") | ADR 0050 `notifications/emitter.ts:51` (`recipientUserId`/`recipientRole` + leak-safe filter) | A mention/membership event emits an addressed notification through the existing emitter. No new fan-out path. |
| Membership identity (human OR agent) | ADR 0041 subjectRef (`user:<id>`/`agent:<id>`, `host/conversationStore.ts:38`) | A channel member is a subjectRef — an agent can be a member (Slack/Google-Chat apps-as-members, already ADR 0043's posture). No new id scheme. |
| Per-channel access control | ADR 0006 `host/accessControlService.ts` + `resolveEffectiveAccess` | Read/post/manage gate on org membership + channel membership; fail-closed; uniform-404 on non-member (the `conversationStore` Phase-6 visibility precedent — a non-member 404s, no existence leak). |
| The turn engine (if an agent posts) | the `openwop-app.chat.turn` run path (ADR 0043) | An agent member's post is an ordinary `chat.turn` — channels add NO second runtime. |

**Net new (small):** one `type:'channel'` discriminant + a thin **channel descriptor** (name, topic, visibility `public`/`private`, archived flag) on the conversation meta; a per-channel **membership-manage** route set under `/v1/host/openwop-app/channels/*`; a `GET …/channels/:id/stream` SSE feed over `openSseChannel`; the channel-list + channel-view UI; and the addressed-notification wiring for `@mention`/membership events. **No new message store, no new membership store, no new transport, no new identity scheme, no new read-state store.**

---

## Decision

Ship a **`channels` feature-package** (`src/features/channels/`, default-OFF, `bucketUnit:tenant`) that adds a **`type:'channel'` conversation** — a topic-organized, multi-member (humans + agents) durable conversation with per-member read-state and **local-host real-time delivery over the ADR 0088 SSE seam**. It is the ADR 0043 model extended by one discriminant, not a parallel chat system.

**v1 is local-host and presence-free by deliberate scope** (see RFC verdict). Channels deliver posts in real time *within one host* by pushing new-message events down the per-channel SSE feed; they do NOT advertise presence, typing indicators, or delivery/read receipts on any wire surface (those are the RFC-gated extension below).

### Data model — one discriminant + a thin channel descriptor (extends ADR 0043)

```ts
// host/conversationStore.ts — ConversationMeta gains:
type: 'agent' | 'person' | 'group' | 'workspace' | 'channel';   // NEW discriminant

// A thin channel descriptor (only present when type:'channel'):
channel?: {
  name: string;                  // '#product', tenant-unique slug
  topic?: string;
  visibility: 'public' | 'private';   // public = any org member may join/read; private = invite-only
  archived?: boolean;
};
// Membership stays ConversationParticipant (subjectRef + role 'owner'|'member', lastReadAt).
// Messages stay ChatMessageRecord on this conversationId. NO new tables.
```

A **public** channel is readable/joinable by any member of the channel's org (resolved via `resolveEffectiveAccess`); a **private** channel is visible only to its participants (the ADR 0043 Phase-6 participant-scoped 404 rule applies verbatim).

### Real-time delivery (local-host, no presence)
`GET /v1/host/openwop-app/channels/:id/stream` opens an `openSseChannel` (ADR 0088 — inherits headers, heartbeat, per-key concurrent-stream cap, teardown). On a new post the feature publishes a `channel.message` SSE frame to that channel's open streams (in-process pub/sub, the same posture as the notification feed). An `@mention` additionally emits an **addressed notification** (`recipientUserId`, ADR 0050) so a member not currently streaming the channel still gets the inbox signal. **No presence/typing frame is emitted** — there is no wire surface that would honor it (RFC-gated).

### RBAC & isolation
Org-scoped (ADR 0006/0015): creating/archiving/renaming a channel needs `workspace:write` in the channel's org; posting needs membership; reading a private channel needs membership. Every by-id route resolves org FROM the channel meta and authorizes via `resolveEffectiveAccess` — a **non-member 404s** (never 403, no existence leak), layering under the owner-gate 403 exactly as `routes/chatSessions.ts` does post-ADR-0043-Phase-6. Fail-closed; IDOR-safe; uniform-404.

### Replay / fork
None — a channel is product state (a conversation + membership + messages), not run config. An agent member's post is an ordinary replay-safe `chat.turn` run (ADR 0043); the channel meta/membership/read-state are host-ext `DurableCollection` rows, never in a run event log. Nothing new touches replay/fork.

---

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `src/features/channels/` — a `BackendFeature` (`feature.ts` + `routes.ts` + a thin channel service over `conversationStore`). Core never imports it. |
| 2 | Toggle / admin | `channels` toggle, default **OFF**, `bucketUnit:tenant`, category Collaboration (the `knowledge-sync/feature.ts:15` `toggleDefault` shape). |
| 3 | Workflow surface | None net-new — an agent member's post rides the existing `chat.turn`. |
| 4 | Node pack | None — no new tool. (A future `core.chat.postToChannel` node is optional sugar, deferred.) |
| 5 | AI-chat envelopes | None — channel posts are ordinary messages; A2UI surfaces (ADR 0051) already render in any conversation if an agent emits one. |
| 6 | Agent pack | None — any roster agent can be added as a channel member (subjectRef). |
| 7 | Public surface | None — channels are auth-scoped host-ext routes. (A *public* embeddable channel widget is B19, out of scope.) |
| 8 | RBAC + isolation | Per-channel membership; `workspace:write` to manage; private-channel 404 for non-members; fail-closed; uniform-404 IDOR (ADR 0006/0043 Phase-6). |
| 9 | Replay / fork | None — product state, not run config. |
| 10 | Frontend | A channel list (under the ADR 0043 Conversations rail, a new "Channels" section) + a channel view reusing `ConversationView`/the existing feed + composer; unread badge reuses `isUnread`. No new chat runtime (CLAUDE.md "one AI chat"). |

---

## Phased plan

1. **Channel model + membership (backend).** Add the `type:'channel'` discriminant + `channel` descriptor to `ConversationMeta`; channel CRUD + membership routes under `/v1/host/openwop-app/channels/*` (create/list/get/archive/rename, join/leave for public, add/remove for private). Reuse `conversationStore` participants + `conversationReadState`. RBAC + uniform-404 tests.
2. **Channel list + view (frontend).** A "Channels" section in the ADR 0043 Conversations rail; the channel view reuses the existing `ConversationView` feed + composer + cursor pagination + unread badge. No second chat surface.
3. **Real-time delivery (local-host).** `GET …/channels/:id/stream` over `openSseChannel` (ADR 0088) + an in-process publish on new post; FE subscribes while the channel is open. `@mention`/membership events emit addressed notifications (ADR 0050).
4. **Agent membership.** Allow an `agent:` subjectRef as a channel member; an `@agent` post in a channel routes the existing `chat.turn` to that agent (the ADR 0043 lineup-from-participants path, reused).
5. **(RFC-gated, deferred) Presence/typing/receipts + cross-host.** Only after a new `openwop` RFC defines the wire shape (see RFC verdict). Until then: NOT shipped, NOT advertised.

## Alternatives weighed

1. **A bespoke channels service with its own message + membership tables and a socket.io runtime (the Open WebUI shape).** Rejected — quadruple `no-parallel-architecture` violation (the `Conversation` model, the membership join, `conversationReadState`, and `openSseChannel` already exist). ADR 0043's "one typed primitive, not a table per kind" is the binding precedent.
2. **A new `type:'channel'` but a separate real-time transport (WebSocket).** Rejected — ADR 0088 deliberately unified the three SSE feeds onto `openSseChannel` to stop transport drift; a channels WebSocket would re-fragment it. SSE carries server→client post delivery fine (channels are not low-latency-bidirectional like voice).
3. **Ship presence/typing in v1 (match Open WebUI parity).** Rejected for v1 — presence needs a wire surface (and a real presence substrate the tenant-scoped host can't honor today, the ADR 0043 Phase-6 finding); shipping it host-only would be a dishonest "real-time team chat" claim. Defer to the RFC.
4. **Reopen `type:'person'` 1:1 DMs at the same time.** Out of scope — ADR 0043 §"Person 1:1 = CLOSED" stands; channels are group-shaped and reuse the same foundation if DMs are ever reopened.

## RFC gate (the spec question, explicitly)

**EVALUATE → v1 = NO new RFC; presence + cross-host = NEW `openwop` RFC first.**
- **Local-host channels (v1)** — membership, posts, read-state, and same-host SSE delivery live entirely under the non-normative `/v1/host/openwop-app/channels/*` namespace + the host `conversationStore`/`sseChannel` seams. Nothing reaches the OpenWOP wire (no run-event type, capability flag, or normative MUST). **No RFC.**
- **The RFC trigger (deferred, explicit):** the moment a channel must (a) expose **presence / typing / delivery-receipt** state to a peer, or (b) include a **member on another host** (cross-host multi-party), the participant roster + per-message speaker + presence/receipt semantics become wire-observable → a **new `openwop` RFC** is required *before* that host work (authored via `/prd`, reaching ≥`Accepted`). This is the **RFC 0101 (Parked, multi-party)** precedent ADR 0040/0043 already flagged; advertising presence without an Accepted RFC would fail `OPENWOP_REQUIRE_BEHAVIOR=true`. Run `/architect` (wire-shape + multi-party replay) at that point.

## Open questions

1. **OQ-1 — Channel-scoped vs org-scoped membership.** Is a private channel's membership a subset of one org, or can it span orgs within a tenant? Lean: scoped to one org (resolve via `resolveEffectiveAccess`), matching the conversation-org model; cross-org channels are a later refinement.
2. **OQ-2 — Public-channel default-join.** Does a public channel auto-include all org members (read), or require an explicit join? Lean: explicit join for the membership/unread list, but readable on demand (the Slack public-channel posture).
3. **OQ-3 — `@here`/`@channel` broadcast.** Map to `recipientRole`-style addressing (ADR 0050) or a per-member fan-out? Lean: reuse the ADR 0050 addressing channel; revisit only on a real fan-out case (the ADR 0050 `recipientUserIds[]` deferral).
4. **OQ-4 — Mute/pin (Open WebUI parity).** Per-member mute + message pin are nice-to-have; defer to a follow-on (pure product state on the membership/message rows, no new seam).
5. **OQ-5 — Search.** Channel message search rides B1 (conversation full-text search, a separate ADR) rather than a channels-local index.
6. **OQ-6 — Presence substrate, when the RFC lands.** Even with a wire shape, presence needs a real-time substrate (heartbeat + offline queue) the current tenant-scoped notification path can't honor — note this as the implementation cost of the RFC-gated phase, not a code edit.

> **Phase 3a (2026-06-24) — FE client:** `channelsClient.ts` — list/create channels + read/post membership-gated messages (the backend owns the default-deny gate). A clean http helper (no banned 204-cast). The channels rail component (consuming this) is Phase 3b.

> **Phase 3b (2026-06-24) — management page:** `features/channels/ChannelsPage.tsx` (+ routes + i18n×4 + a component test), registered under the Workspace nav (`featureId: channels`). Tenant-scoped list (name · visibility · active/archived labeled StatusBadge) + a create form (name + visibility); all states; toggle-gated. /architect GO (reviewed admin-page precedent), /code-review + /ux-review clean (labeled inputs, §5.3, i18n×4). The in-chat message rail is a follow-on.

> **Phase 3c (message view) implemented** (2026-06-24):** the `ChannelsPage` now opens a channel into a membership-gated message view — an Open action per row → a `ChannelMessages` panel (read the channel's messages + a post box). Reuses the Phase-2 client (`listChannelMessages`/`postChannelMessage`, already present) over the conversation message model (no parallel store); the backend enforces the public/private DEFAULT-DENY gate. Lazy admin route → no entry-budget impact (162.4 kB). Token-styled (no hex), aria-labelled (input + section), i18n×4. /architect (inline — composes the existing channel conversation + Phase-2 routes, no new store/runtime), /code-review + /ux-review clean. 1 new test (open → list → post → refresh) + 4 prior green. Presence/typing/threading (Phases 4–5, may need an RFC) remain.

> **Presence — wire RFC filed** (2026-06-24): channel presence (online + typing) is a real-time, cross-host-projectable wire fact (the ADR scoped v1 as presence-free + RFC-gated), so the wire surface was authored as **openwop RFC 0110 — channel presence** (Draft, openwop/openwop PR #767) via the five-architect `/prd` pass: an OPTIONAL capability-gated `channel.presence` event — EPHEMERAL (NOT persisted to the replay log, replay/:fork-invisible — the load-bearing distinction from `conversation.exchanged` turns), membership-gated (DEFAULT-DENY / CTI-1, never delivered to a non-member), opaque subject-refs only (no PII), riding the existing SSE feed (SHOULD debounce). The host emit (debounced presence over the channel SSE) is the follow-on host work, gated on RFC 0110 reaching **Accepted** — presence MUST NOT ship as a host-only wire claim before then. Read receipts + anonymous-widget presence + cross-host federation are explicitly out of scope (future RFCs).

> **Presence — wire RFC now Accepted; host emit DEFERRED with cause** (2026-06-24): **openwop RFC 0110 — channel presence is now `Accepted`** (merged openwop/openwop#768): the `channel.presence` RunEventType + `channel-presence-payload.schema.json` (closed, no-PII, opaque RFC 0041 subject refs), the `channelPresence` capability, and a server-free conformance scenario — promoted Draft→Accepted via the documented bootstrap single-maintainer comment-window waiver (the RFC 0101 precedent). The wire surface is frozen + conformance-covered. **The host emit is DEFERRED — for real architectural reasons, NOT merely 'not done':** (1) this app's channels (ADR 0126) are **fetch-based — there is no per-channel SSE/live transport** for presence to ride; adding one is substantial new infrastructure; (2) presence is in-memory live state, but the demo runs **multi-instance Cloud Run** where per-instance in-memory presence is incomplete (a member on instance B is invisible to instance A) and global presence needs shared live state the **tight Cloud SQL connection budget** (db-f1-micro, OPENWOP_PG_POOL_MAX=4) cannot hold; advertising `channelPresence.supported` with per-instance-only presence would be a **dishonest wire claim** under `OPENWOP_REQUIRE_BEHAVIOR`. So the host does NOT advertise `channelPresence` (absent ⇒ honest no-advertisement). A **single-instance / sticky-session deployment** is the natural first emitter (the RFC's acceptance criteria explicitly permit deferring the reference-host emit). This is the honest terminal state for ADR 0126 presence on THIS deployment: the wire is done; the emit awaits a deployment topology that can honor it.

> **Presence host emit IMPLEMENTED** (2026-06-24):** correcting the earlier deferral — per-instance presence is RFC-0110-CORRECT (its MUSTs are correctness: refs are real connected members, no non-members, no PII, EPHEMERAL — NOT completeness; a subset is valid best-effort presence). So the emit was tractable, gated default-OFF (the `imageGeneration` honesty pattern). `channelPresenceTracker.ts` — pure in-memory, per-instance, NEVER persisted (no `log.append`/event-log write, so replay/:fork untouched), present iff ≥1 live connection (multi-tab safe via per-ref conn count), debounced broadcast. `GET /channels/:id/presence` (SSE via the shared `openSseChannel`) — opening it marks the caller present (membership-gated by `assertChannelAccess`: DEFAULT-DENY 403/404, RFC 0041 `user:` ref), frames carry the RFC 0110 `channel.presence` shape but ride the dedicated presence SSE (not the durable log); `POST /channels/:id/presence/typing` sets typing. Discovery advertises `channelPresence: { supported: channelPresenceEnabled() }` — `OPENWOP_CHANNEL_PRESENCE_ENABLED`, default OFF ⇒ honest no-advertisement on the multi-instance demo; an operator flips it ONLY on a single-instance/sticky topology (also what enables the routes — 404 when off). /architect (inline — reuses the channel membership gate + the SSE primitive; ephemerality preserved; honest advertisement gate; per-instance correctness verified against the RFC MUSTs); /code-review clean (0 banned; tracker has NO persistence call). 9 tests (tracker present/multi-tab/typing/debounce/isolation + assertChannelAccess member/non-member/undefined/404). FE presence rendering (avatar stack + typing indicator) is the consumer follow-on; the wire + host emit are done. **ADR 0126 is now COMPLETE.**

> **Presence FE consumer implemented** (2026-06-24):** the `ChannelMessages` view now renders live presence end-to-end. `channelsClient.subscribeChannelPresence(channelId, cb)` opens an authed fetch-stream to the `GET /channels/:id/presence` SSE (reusing the shared `readSseFrames` parser), parsing `event: channel.presence` frames into `{present, typing}`; `setChannelTyping` POSTs the typing flag (debounced on input, cleared on idle/send/unmount). A `aria-live="polite"` presence bar shows `{{count}} present` + `{{count}} typing…`. SILENT when the host hasn't enabled presence (the SSE 404s ⇒ no bar — honest: the UI shows presence only when the host emits it). The connection itself is the presence signal (open = present), so opening the channel view marks the viewer present. /code-review + /ux-review clean (0 banned/hex, aria-live live-region, i18n×4 with count interpolation, entry 163.1 kB). 3 client tests (frame parse / 404-silent / typing POST). **ADR 0126 presence is now COMPLETE end-to-end (host emit + FE rendering).**

> **Presence behavioral conformance witness** (2026-06-24):** the RFC 0110 behavioral leg is now non-vacuous. openwop landed `channel-presence-behavioral.test.ts` (capability-gated; closed-shape / members-only / no-PII / non-vacuous-member; soft-skips on 404, openwop/openwop#769) + the `/v1/host/sample/channel-presence/snapshot` seam contract (host-sample-test-seams.md §13). This host provides the WITNESS: `GET /v1/host/openwop-app/channels/:id/presence/snapshot` — a non-normative conformance seam that does a TRANSIENT join → `snapshotOf` → leave (so `present` is non-vacuous), through the SAME `assertChannelAccess` membership gate (DEFAULT-DENY) + the closed RFC 0110 shape; 404 when presence is OFF (capability unadvertised ⇒ scenario soft-skips). All three presence routes now resolve the acting identity (`req.userId ?? req.principal?.principalId`, the chat-export pattern) so a subject ref always exists. /architect GO (Track A+B: the seam is non-normative test plumbing reusing the membership gate + tracker; no new wire; the JSON-snapshot shape is the right driver vs holding an SSE). /code-review clean. 3 route tests (404-off / closed-shape + caller-present / non-member denied) + the tracker/service suites (18/18). This closes RFC 0110's reference-host acceptance criterion (the dual-staging witness). **ADR 0126 is COMPLETE incl. the conformance witness.**

> **Presence FE reconnect hardening** (2026-06-24):** `subscribeChannelPresence` now RECONNECTS — a real-time SSE drops (host restart, network blip), and the prior consumer opened once + died silently (presence stuck/empty until a manual remount). One shared abort signal across reconnects (the unsubscribe aborts the loop + any in-flight fetch/backoff); EXPONENTIAL BACKOFF + full jitter (1s→capped 30s) to avoid a thundering-herd reconnect storm when a host restarts and N clients retry at once; a successful connect resets the backoff; a **404/405 is TERMINAL** (presence disabled isn't transient — don't hammer the host); the backoff sleep is abortable (teardown isn't blocked up to 30s). The connection=presence semantics hold: a transient drop is a brief honest absence, then reconnect re-marks present. /architect (inline — a client resilience change to the presence design already /architect'd this session; the failure modes reviewed: reconnect storm → jitter, abort races → one-signal + abortable sleep, 404-terminal, backoff cap), /code-review + /ux-review clean (0 banned/hex; the aria-live presence bar tolerates the reconnect gap gracefully). 2 new tests (reconnects after stream end across two connections; no-retry on 404) + the prior presence-client tests (5/5).
