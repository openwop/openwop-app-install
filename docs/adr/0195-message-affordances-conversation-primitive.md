# ADR 0195 — Message affordances on the conversation primitive (edit · delete · reactions · threads-are-Comments)

**Status:** Accepted (architect-gated 2026-07-03; four blocking amendments folded in — see §Gate corrections)
**Owner:** openwop-app chat + channels
**Date:** 2026-07-02

**Composes:** ADR 0102 (server-stamped `authorSubject` + the author-or-manager
message-UPDATE authz), ADR 0067 (the in-place message PUT), ADR 0154 FU-6 / ADR 0192 D6
(the chat message bus as the multi-party post-processing choke-point), ADR 0021
(Comments — the ONE per-message thread system), ADR 0175 (messaging gateway envelope v2
— declared inbound `reaction`/`edit` kinds), ADR 0192 (channels UX parity; this is its
"message affordances" sibling).

**RFC verdict: none.** Host-ext routes + host-internal stores; no wire surface.

---

## Context

Channels (and group chats) now look like a real messaging surface (ADR 0192) but
messages are immutable and unacknowledgeable: no edit, no delete, no reactions. Every
incumbent trains these. Three architect-review boundary rulings bind this ADR:

1. **Message mutation has ONE owner** — `PUT /chat/sessions/:sessionId/messages/:messageId`
   (`routes/chatSessions.ts:696`, ADR 0102: author-or-manager, 404-first). A
   channel-specific edit route is forbidden; this ADR extends the existing one.
2. **Reactions must have ONE store shared with the messaging gateway** — envelope v2
   already declares inbound `ChatInboundKind 'reaction' | 'edit'` and outbound
   `reactions?: string[]` (`messaging/types.ts:18,41,67`). Verified: **no normalizer
   emits these kinds yet** — so this ADR defines the store as the declared sink and
   records the gateway wiring as a named deferral (not an omission).
3. **Threads are Comments** (ADR 0021, `chat_message` resource,
   `chat/MessageComments.tsx`) — never a second thread system. This ADR only wires the
   existing affordance into channel feeds (it needs an `orgId`).

### Pre-existing-surface audit

| Concern | Owner | This ADR |
|---|---|---|
| Edit authz + route | ADR 0102 PUT (author-or-manager) | Extended: channel-aware manage fallback, archived guard, `editedAt`, live `updated` frame |
| Delete | none (no route) | Tombstone via the SAME route family (`DELETE` sibling); `createdAt`/`role`/`messageCount` immutable so ADR 0192 unread differencing is unaffected |
| Reactions | none (types declared, unwired) | New `chat:message-reactions` DurableCollection — the single sink for in-app + (future) gateway reactions |
| Threads | Comments (ADR 0021) | Surface `MessageComments` in channel feeds (orgId wiring) — zero new machinery |
| Live delivery | `chatMessageBus` (FU-6 + 0192 D6) | Frame gains `kind: 'appended' \| 'updated' \| 'deleted' \| 'reaction'` (additive; the FE's debounced reload handles all) |

## Decision

### D1. Edit — extend the ONE route

`PUT …/messages/:messageId` gains:
- **Channel-aware authz:** for `type:'channel'` metas the non-author fallback uses the
  channel-manage semantics (`isChannelOwner`), NOT `requireManageAsync` — whose
  ownerless-permissive branch would let any tenant member edit others' messages in an
  ownerless legacy channel (the ADR 0192 finding-2 class). Archived channels reject
  edits (`validation_error`, mirroring posts).
- **Visibility stays single-owner (gate correction #3):** channel-awareness lands in
  `isVisibleToAsync` (`host/conversationVisibility.ts` — THE predicate, ADR 0112),
  consulting `canAccessChannel` for `type:'channel'` metas, NOT in per-route
  branches. This also fixes a live asymmetry: a tenant member may post to a
  public channel without joining, but the chat-sessions family 404s their own
  edit/react because the generic predicate doesn't know public-channel
  visibility.
- **`editedAt`** stamped into the message `meta` JSON (the meta field is the
  established per-message extension point); role/createdAt stay immutable.
- **Live `updated` frame** published via `publishChatMessageAppended`'s bus channel
  with `kind:'updated'` for multi-party conversations.
- The run-backed `workflow_run` re-persist path (ADR 0067's original purpose) is
  UNCHANGED — `editedAt` stamps only when the caller marks the update a user edit
  (`{ userEdit: true }` in the body), so card-lifecycle re-saves don't masquerade as
  human edits.

### D2. Delete — tombstone, same owner

`DELETE …/messages/:messageId` (same route family, same author-or-manager +
channel-aware authz as D1): replaces content with a canonical tombstone envelope
(`{"deleted":true}`) + `meta.deletedAt` + `deletedBy` (subjectRef). NOT a row delete:
`messageCount` (and therefore ADR 0192's unread differencing), ordering, and
`branchedFrom.fromSeq` anchors all survive. Reactions for the message are cascade-
deleted (best-effort). The FE renders a muted "message deleted" row —
detected by `meta.deletedAt`, never by parsing the content sentinel — and
deleted messages never trigger `dispatchChannelAgentTurns` (gate correction
#10). Bus frame `kind:'deleted'`.

### D3. Reactions — one keyed store, batched reads

`chat:message-reactions` DurableCollection, key
`${tenantId}:${conversationId}:${messageId}:${subjectRef}:${emoji}` — one row per
(reactor, emoji), so add/remove are idempotent point puts/deletes and **one
`listByPrefix('${tenantId}:${conversationId}:')` loads a whole conversation's
reactions** (no per-message N+1 on feed load).

- Routes: `PUT/DELETE …/messages/:messageId/reactions/:emoji` on the chat-sessions
  family (membership/visibility-gated exactly like reads; any VIEWER may react —
  Slack semantics — including in channels; archived channels reject).
- Emoji vocabulary: a curated set (👍 ✅ 👀 🎉 ❤️ 😄 🚀 🤔) validated server-side —
  content, not iconography, so the no-emoji-as-icons design rule is not violated;
  an out-of-set emoji is a 400 (bounded storage, no grapheme-validation rabbit hole).
- Projections: the channel/chat message list responses gain
  `reactions?: Array<{ emoji, count, mine }>` per message (computed from the batched
  read + the caller's subject).
- Bus frame `kind:'reaction'` (payload: messageId only; state reloads).
- **Gateway (named deferral):** when a provider normalizer first emits
  `ChatInboundKind 'reaction'`, its sink is THIS store — and the wiring MUST map
  the platform `targetMessageId` (a Discord/WhatsApp id, arbitrary charset) to
  the internal messageId via the relay's existing mapping, rejecting
  unmappable / `ID_PATTERN`-violating ids so the key space stays colon-safe
  (gate correction #6). Outbound envelope-v2 `reactions[]` reads this store. No
  second reaction model may be introduced at that point.
- **Scale posture (recorded):** the per-conversation `listByPrefix` reaction
  read is conversation-lifetime-unbounded — the same accepted posture as
  `listMessageFeedbackForSession` and the unpaginated channel feed itself; when
  channel pagination lands, reactions page with the message window (messageId
  is in the key). The bus frame `kind` is forward-compat metadata: today's
  subscribe callback + SSE re-serialization drop it, and the FE's debounced
  full reload re-fetches `editedAt`/tombstones/`reactions[]` from the durable
  store — no phase of this ADR needs to consume `kind`.

### D3b. Reactions vs. message feedback — the boundary ruling (gate correction #1)

`chat:message-feedback` (ADR 0071, the thumbs) and reactions are BOTH
per-(user, message) signals — but they are different systems and both stay:
feedback is a **private AI-quality rating** (feeds the ADR 0123 leaderboard;
never shown to other members; one rating per user); a reaction is **public
social state** (visible to the room; one row per (user, emoji)). Boundary
rules: reactions never feed quality aggregation; feedback never renders
publicly; gateway inbound reactions sink ONLY to the reactions store. **UI
de-confliction:** on multi-party surfaces (`channel`/`group`) the hover bar
carries reactions and the feedback thumbs are SUPPRESSED (feedback remains the
1:1 assistant-chat affordance) — `ChatSidebar`/`TabSession` currently pass
`onFeedback` unconditionally and become surface-aware. Both stores'
headers gain a cross-reference.

### D4. Threads = Comments in channels

`MessageFeed`'s existing `MessageComments` mount needs `orgId`; channels are
tenant-scoped, not org-bound, so the channel surface passes the caller's workspace
org (the same resolution the chat page already uses for `commentsContext` —
`listOrgs()[0]`, tenant-scoped server-side so all members converge on one
thread). If no org resolves, the affordance self-hides. **Accepted coupling
(gate correction #8):** channel threads inherit the `comments` toggle + the
`workspace:read/write` org-scope authz; a scoped-out member gets a graceful
403 in the panel (Phase 2 verifies).

### D5. Frontend

Hover action bar on message rows (multi-party surfaces): react (picker with the
curated set) · edit (own messages, inline textarea, Esc/Enter) · delete (own,
`ui/confirm`) · comment (existing). Reaction chips under the bubble with counts,
`mine` highlighted; "(edited)" marker from `meta.editedAt`; tombstone row for
deleted. All strings ×4 locales.

## Replay / RBAC / wire

Product state only; no run-event changes; reactions/tombstones never enter run logs.
All routes resolve visibility via the existing predicates, fail closed, uniform-404.
No RFC (host-ext).

## Phases

- **Phase 1 (backend):** D1 + D2 + D3 stores/routes/frames + route tests
  (authz matrix: author edit ✓, non-author member edit ✗ (403), channel-owner edit ✓,
  ownerless-channel non-author edit ✗ (the closed branch), archived rejects, tombstone
  immutables, reaction idempotence + vocabulary bound + viewer gating;
  gate-mandated additions: a public-channel NON-JOINED author can edit/react to
  their own post (the visibility fix), an edit containing `@channel` does NOT
  re-bump mentionCount, a tombstoned message never dispatches an agent turn,
  and `messageCount` is unchanged across edit+delete — the differencing pin).
- **Phase 2 (frontend):** D4 + D5 + `/code-review` + `/ux-review` + fixes.

## Gate corrections (architect pass, 2026-07-03)

Four blocking amendments folded into the Decision above: (1) the
reactions↔feedback boundary ruling + multi-party thumbs suppression (§D3b);
(2) publish-only bus export — mention stamping stays append-only, edits never
re-notify; (3) channel-awareness lands in `isVisibleToAsync` (the ONE
predicate), also fixing the public-channel non-joined author asymmetry;
(4) `editedAt` is server-derived from role + content-change, not a client
flag. Plus recorded notes: gateway platform-id mapping, scale posture,
comments coupling, tombstone detection, and four gate-mandated test cases.
