# ADR 0102 — Chat history persistence, restore, and message authorship

Status: implemented (Phases 1–3 — persistence + restore + live re-attach; authorship
(`author_subject`) + author-or-owner edit authz; feedback-on-reopen — all shipped to
`main`; see the Implementation ledger below. Status line corrected 2026-06-22: the code
(sqlite mig 29 / pg mig 26, `routes/chatSessions.ts` authz gate, the feedback endpoint)
and tests are merged; the header had lagged at `Proposed`.)

Composes / extends: ADR 0043 (persistent conversations — meta + participants),
ADR 0067 (AI chat = the RFC 0005 conversation run by default), ADR 0089
(chat-driven agent tool loop / `workflow_run`), ADR 0006 (RBAC), ADR 0054
(subject-scoped group chats).

> **Scope note.** This is a *core-chat architecture* ADR, not a feature-package
> (ADR 0001). Chat lives in core (`frontend/react/src/chat/`,
> `backend/typescript/src/routes/chatSessions.ts`, `host/conversation*`), so there
> is **no toggle, no node/agent pack, and no `ctx.<feature>` surface** — those
> matrix rows are N/A. The live concerns are persistence/restore correctness,
> RBAC/authorship, and replay safety.

## Why this exists

A run of bug reports against the live chat traced to one root cause: the RFC 0005
**conversation primitive became the sole chat transport (ADR 0067) but never got a
durable display projection.** Conversation turns lived only in the run event log +
the current browser's localStorage; the `workflow_run` card was written only at
terminal. So reopening a past chat from the Conversations rail showed a **blank
thread** (only the user's prompt survived), and a HITL-suspended workflow lost its
entire card. This ADR records the persistence/restore model that fixed it
(shipped, see "Phase record"), unifies the message-id scheme, and settles the
**message-authorship + UPDATE authorization** question the fix surfaced.

The authoritative record stays the **run event log** (replay/fork-safe, on the
wire). What this ADR governs is the **non-normative host-extension projection** the
chat UI restores from — under `/v1/host/openwop-app/chat/*`. No wire change.

## Boundaries audit (Step 3)

- **Persistence store — not a parallel system.** Chat history is the existing
  `chat_messages` table + `chat:conversation` meta (ADR 0043), reached through the
  sanctioned `Storage` / `DurableCollection` seam. The conversation primitive now
  *writes to that same projection* (it previously only the `@mention`/`workflow_run`
  path did). No second store. (`backend/typescript/src/storage/sqlite/schema.ts:234`
  `chat_messages`; `host/conversationStore.ts:89` the meta collection.)
- **`conversationRunId` — single home.** Stored on `ConversationMeta`
  (`host/conversationStore.ts`), not a new table. (`setConversationRun`,
  `PUT …/chat/sessions/:id/conversation-run`.)
- **Message authorship — projects the wire, not a new identity model.** Author
  already exists on the wire: a `ConversationTurn` carries `from`/`agent.agentId`
  (`host/conversation.ts`), and channel messages carry `agentId`. Per-message author
  is *projected onto the row*, not invented. No collision with the principal model
  (RFC 0048) or `accessControl`.
- **Route namespace.** All routes are sub-paths of the chat-sessions module that
  already owns `/v1/host/openwop-app/chat/sessions/*` (`routes/chatSessions.ts`) —
  no shadowing.
- **Canonical id.** `conversationMessageId` (sanitized wire turn id) is the ONE id
  used live + stored + on reopen (retired the dual-id drift).

## Decision

### 1. The projection model
- The **run event log is authoritative**; `chat_messages` (keyed by chat
  `sessionId`) is the **display/history projection** the rail restores from.
- Conversation turns are mirrored into `chat_messages` as they reconcile
  (`mergeConversationTurns` → `persistTurns`), append-once, deduped.
- `ConversationMeta.conversationRunId` records the long-lived gate run so reopening
  a chat **reuses** the suspended run (server-side context preserved) instead of
  orphaning it and opening a fresh one.

### 2. One canonical message id
`conversationMessageId(wireId)` = the wire turn id (`${runId}:gate:0:N:role`)
sanitized to the store's `^[A-Za-z0-9_-]{1,64}$` pattern (hash-fallback if >64).
Used identically live, in storage, for dedup, and on reopen — so feedback /
regenerate / "load earlier" all key on one value.

### 3. Mutable (run-backed) messages
A `workflow_run` message's state (node cards + the HITL interrupt card) grows
across its lifecycle, so it is **re-saved as it evolves** (dispatch → suspend →
resolve → terminal), not appended once. This requires UPDATE on the store:
- `Storage.updateChatMessageContent(sessionId, messageId, content, meta)` (sqlite +
  postgres; `memory://` is sqlite).
- `PUT /v1/host/openwop-app/chat/sessions/:sessionId/messages/:messageId`.
- Client upsert `persistOrUpdateMessage` (append first, UPDATE thereafter; 409 →
  UPDATE).
On reopen, `rehydrateWorkflowRuns` rebuilds cards + HITL from the event log and
**re-attaches the live SSE** for non-terminal runs (the run stays actionable +
keeps streaming).

### 4. Message authorship + UPDATE authorization — **Option A (target)**
**Problem.** `appendChatMessage` and `updateChatMessageContent` are gated only by
`requireVisibleAsync` (read-visibility). In a chat with multiple **human**
participants, any visible member could append forged messages or **overwrite an
existing message by id**. `chat_messages` has no per-message author, so the gate
cannot distinguish "edit your own" from "tamper with another's".

**Decision.** Add a server-stamped **`author_subject`** to `chat_messages`
(projected from the authenticated caller on append; host-written assistant/
workflow turns stamp the agent/system subject — never client-supplied). Gate
mutation as:
- **UPDATE / DELETE:** `author_subject === caller` **OR** `requireManageAsync`
  (session owner/manager). This preserves the #593 use case — a non-owner member's
  *own* `workflow_run` upsert still succeeds (they are its author) — while
  preventing cross-member overwrite. Owner can always moderate.
- **APPEND:** unchanged (`requireVisibleAsync`) but now stamps `author_subject`.

**Sequencing (real gate, not scope-cut).** Today **no shipped surface seeds a
multi-human-writable chat** — project/notebook group chats seed *agent*
participants only (`features/projects/routes.ts:362`), and 1:1/board/notebook chats
have a single human writer. So the exposure is **latent** (the participants API
*accepts* `user:` refs — `SUBJECT_REF_PATTERN`, `routes/chatSessions.ts:56` — but
nothing adds them as co-writers). Therefore:
- **Now:** record Option A as the model; no behavior change required for current
  surfaces.
- **Phase 2 (tracked obligation):** implement the `author_subject` column + the
  author-or-owner gate **before/with the first feature that adds human co-writers**
  to a chat. Until then the single-writer reality bounds the gap.

## Phased plan

- **Phase 1 — Persistence + restore + live re-attach (SHIPPED).** §1–§3 above.
- **Phase 2 — Authorship + authz (this ADR's open commitment).** `author_subject`
  migration (sqlite ALTER ADD COLUMN + postgres; both backends), `ChatMessageRecord.
  authorSubject`, server-stamp on append, UPDATE/DELETE gate `author||manage`,
  route-level tests (member A cannot overwrite member B's message; author can; owner
  can), backfill: null author ⇒ owner-writable. Land with the first multi-human chat.
- **Phase 3 — Feedback on reopen (open gap).** Message ids are now unified, so the
  feedback key matches across reopen, but the FE never *loads* feedback on session
  open (app-wide, pre-existing). Add a feedback load to the restore path.
- **Core-app extension surface:** none. No node pack, agent pack, `ctx.<feature>`
  surface, or `/.well-known` advertisement — chat persistence is internal host
  state, not a workflow-drivable capability.

## Alternatives weighed (authz)

- **B — keep visibility-gate, document shared-transcript mutability.** Zero work,
  but leaves the overwrite gap; rejected as the long-term model.
- **C — owner-only UPDATE (`requireManageAsync`).** Simple, no migration, but a
  non-owner member's own `workflow_run` upsert would 403 — a functional regression
  of #593 in multi-human chats. Rejected.
- **A (chosen)** is the only option that is both correct and non-regressing; cost is
  one additive migration.

For the **regenerate** semantics question (replace vs append) see the append-style
"Try again" decision already shipped (RFC 0005 §195 rejected in-conversation
branching; true variant-compare is the future *sibling-conversation* mechanism, not
this layer).

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** Everything here is the non-normative
`/v1/host/openwop-app/chat/*` projection + host storage. The authoritative
conversation record stays the RFC 0005 run event log, unchanged; replay/fork are
unaffected (the projection is live-rebuilt, never the source of truth). The
`PUT …/messages/:id` and `author_subject` are host-internal.

## Replay / fork safety

The run event log is untouched and remains authoritative. The `chat_messages`
projection and `conversationRunId` are display/continuity state, not run state — a
`:fork` re-derives the thread from the forked run's events. Nothing new is stamped
on a run by this ADR.

## Open questions

1. **Backfill of `author_subject`** for pre-Phase-2 rows — treat null as
   owner-writable (chosen) vs a one-time migration stamping the session owner.
   Chosen: null ⇒ owner-writable (no historical author data to recover).
2. **DELETE endpoint** — Phase 2 may add `DELETE …/messages/:id` for true
   regenerate-supersede; deferred (append-style "Try again" made it unnecessary so
   far).
3. **Feedback load granularity** (Phase 3) — per-message fetch vs a batch
   `GET …/feedback?messageIds=` on session open.

## Phase record

| Phase | Status | Evidence |
|---|---|---|
| 1 — persistence (conversation turns) | shipped | PR #580 |
| 1 — server-side `conversationRunId` | shipped | PR #586 |
| 1 — canonical id unification | shipped | PR #590 |
| 1 — `workflow_run` lifecycle persist (UPDATE) | shipped | PR #593 |
| 1 — live re-attach on reopen | shipped | PR #596 |
| 2 — authorship + authz (`author_subject` + author-or-owner gate) | implemented | sqlite mig 29 / pg mig 26; `routes/chatSessions.ts` PUT gate; `conversations-route.test.ts` authz test |
| 3 — feedback on reopen | implemented | `listMessageFeedbackForSession` + `GET /chat/sessions/:id/feedback`; `loadSessionFromBackend` merge; route + FE tests |

> **Phase 2 note (correction to the sequencing above):** implemented unconditionally
> rather than deferred to "the first multi-human-writable chat." Owned chats are now
> strictly gated (author or owner; others 403); a null-owner tenant-visible chat
> degrades to author-or-any-tenant-member, consistent with the pre-existing
> `requireOwner`/append posture for unowned chats. `author_subject` is server-stamped
> from the caller, never client-supplied; host-written workflow activity stamps null.
