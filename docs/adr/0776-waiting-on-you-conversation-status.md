# ADR 0776 — "Waiting on you" for every conversation, from the one review inbox

Status: implemented (P1 + P2)

## Context

ADR 0768 P3 put "Waiting on you" / "Running" on conversation rows, but only for
conversations the client HOLDS (the multi-tab deck's open tabs). A closed
conversation showed nothing, because the conversation list (`ChatSessionHeader`)
carries only message and read counts.

The obvious fix, a pending counter on the session row or a new "status per
conversation" endpoint, would be a SECOND system for a concept that already has
an owner: the review inbox (`host/reviewProjection.ts` `listReviews`, ADR
0068/0070/0074) is the authorized list of approvals a caller may act on, and
both chat shells already hold it client-side (`reviewStatusStore`,
ref-counted, hydrated on connect).

Measured on origin/main while designing this:

- `listReviews` already reads open interrupts through the TENANT-indexed
  `listOpenInterruptsForTenant` (a join on `runs.tenant_id`), not the global scan.
- **A latent bug:** `interruptToReview` declared `data.conversationId` on its
  input type and never mapped it, and ignored the run's `metadata.chatSessionId`.
  So every interrupt review had no `conversationId`, and the EXISTING
  `GET /reviews?conversationId=` filter silently returned approvals only.
- The client store never ADDS a pending review from a live frame (frames only
  patch quorum or evict terminal ones), so a new approval stayed invisible
  until the next navigation.

## Decision

1. **Backend (a bug fix):** `interruptToReview` stamps `conversationId` from
   `run.metadata.chatSessionId` (the stamp chat-dispatched runs carry), falling
   back to the interrupt data's explicit `conversationId`; absent when neither
   exists, never invented. This also repairs `?conversationId=`.
2. **Client:** `useReviewCountsByConversation()` groups the ONE inbox by
   conversation (memoized on the list identity). Both shells feed the
   Conversations rail's `liveStatusFor` from it; the deck merges it with its
   open tabs' live state (waiting-on-you outranks running).
3. **Freshness:** a live frame for a PENDING review the inbox has never seen
   triggers a debounced, single-flight re-read (400 ms), since frames never add.

"Waiting on YOU" means the inbox's own semantics: approvals visible to and
actionable by the caller (tenant + `runs:read`, with `mayViewApproval` for
approvals). No stricter per-assignee rule is invented here.

## Alternatives rejected

- **A pending counter on the session row**, incremented at interrupt creation:
  a second owner of "what is pending" that must be kept in step with every
  resolve/expire/cancel path, which is exactly how two counts drift.
- **A new `/conversations/status` endpoint:** a second projection over the same
  data, and another N-row read on the chat list's hot path.
- **Computing it from each session's messages server-side:** the server never
  parses `workflow_run` message content, and it would scan every conversation.

## Known gaps (measured, recorded)

- **Unstamped runs are uncounted, silently.** `chatSessionId` is stamped per
  agent tool (`...(scope.conversationId ? { chatSessionId } : {})`, about ten
  tools plus `workflowComposeTool`), not by one dispatch seam. A tool that forgets
  the spread produces approvals the row cannot attribute. Follow-up: stamp it
  once at the run-creation seam the agent lane uses, then a ratchet.
- The inbox is capped at `INTERRUPT_SCAN_LIMIT` (500) per tenant; beyond it,
  counts are a floor (the projection already logs the truncation).

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| **P1** | `conversationId` mapping; per-conversation selector; rail wiring in both shells; refresh on unknown pending frame | **implemented** |
| P2 | "Running" for closed conversations (see §P2 correction) | **implemented** |

### P1 record

| Item | Where | Test |
| --- | --- | --- |
| `conversationId` from `chatSessionId` → data fallback → absent | `host/reviewProjection.ts` `conversationIdOf` | `review-projection-context.test.ts` (3 new; removing the mapping turns 2 red) |
| Per-conversation grouping | `reviewStatusStore.ts` `useReviewCountsByConversation` | `reviewStatusStore.test.ts` › groups the ONE inbox |
| Refresh on an unseen pending frame; debounced into one read; none for terminal or known | `reviewStatusStore.ts` `_applySignal` / `scheduleRefresh` | › re-reads… / does NOT re-read… |
| Rail status in both shells | `ChatSidebar.tsx`, `tabDeck/TabChatDeck.tsx` `liveStatusFor` | typecheck + existing rail suites |

### P2 correction (2026-09-29) — no new index was needed

P2 was planned as a run → conversation index written at dispatch. Measured
before building it: every chat-originated run ALREADY carries
`metadata.chatSessionId` (the SPA's `/workflow` dispatch at
`useWorkflowRunMentions.ts` and the agent tools' spread), and storage already
answers "this tenant's pending/running runs" (`listRuns` by tenant + status).
A second store would have been a second owner of that fact. So P2 is one
bounded read:

- `GET /v1/host/openwop-app/chat/sessions/running`: `runs:read` (the inbox's
  gate); pending + running (approval waits stay the inbox's), 200 per status
  with `truncated` beyond; the always-open conversation run
  (`openwop-app.conversation`) excluded; reported only for conversations the
  caller may read (`isVisibleToAsync`, the rail's own rule); no acting user ⇒
  empty. Registered before `/chat/sessions/:sessionId`, which would match it.
- `GET /v1/runs` could NOT serve this client-side: its snapshot projects only
  `callerMetadata`, so tool-dispatched runs (top-level stamp only) would be
  invisible, and the conversation run would mark every open chat as running.
- Client: `useRunningConversations` reads on mount, every 20 s while visible,
  and on focus; a failed read keeps the last answer. Both shells merge it under
  waiting-on-you.

The "unstamped runs are uncounted" gap above still applies to P2: a tool that
forgets the spread is invisible here too. The one-seam stamp + ratchet remains
the follow-up.

| Item | Where | Test |
| --- | --- | --- |
| Route + projection | `host/runningByConversation.ts`, `routes/chatSessions.ts` | `running-by-conversation.test.ts` (3); removing the exclusion, the visibility check, or registering after `:sessionId` each turn it red |
| Poll + keep-last + hidden | `chat/conversations/useRunningConversations.ts` | `useRunningConversations.test.ts` (4); clearing on failure, polling hidden each turn one red |
| Rail merge | `ChatSidebar.tsx`, `tabDeck/TabChatDeck.tsx` | shell suites (17 files) |

## RFC gate

None. `/v1/host/openwop-app/reviews` is a host extension; `conversationId` on a
review was already part of its response type. No run-event, capability or
wire change.
