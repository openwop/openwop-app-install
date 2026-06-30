# ADR 0067 - AI chat conversation-run default

**Status:** implemented  
**Date:** 2026-06-18  
**PRD:** `docs/ai-chat-a-plus-prd.md`  
**Depends on / composes:** ADR 0043 (Persistent conversations), ADR 0051 (A2UI), RFC 0005 conversation primitives, `host/conversationExchange.ts`, `routes/interrupts.ts`, `routes/chatSessions.ts`.  
**Surface:** existing protocol conversation interrupt/exchange behavior plus host-extension chat-session persistence.  
**RFC gate:** no new RFC if this only completes already-advertised `conversationPrimitive` behavior. Any new event field, endpoint contract, or capability claim requires an OpenWOP RFC before the host advertises it.

## Why this exists

The chat UI has two conversation concepts:

1. the implemented host conversation store from ADR 0043, which owns durable chat sessions, participants, read state, and message pagination; and
2. the RFC 0005 `core.conversationGate` exchange path in `host/conversationExchange.ts`, which reconstructs a suspended run's turns from `conversation.*` events.

The PRD target is an A+ human-in-the-loop chat where a user can reload, continue, inspect, and close a long-lived AI conversation without falling back to a one-run-per-turn transcript wrapper. Current code already has the right seams, but `conversationExchange.ts` still explicitly says BYOK-direct conversation dispatch is not wired and the frontend transport is not the normal production path.

## Feature-refinement audit

| Concept | Existing owner | Decision |
|---|---|---|
| Chat session, title, participants, read markers, paged messages | ADR 0043 host conversation store | Keep as the transcript and IA owner. Do not create a second conversation table. |
| In-flight conversation gate | OpenWOP run interrupt + `core.conversationGate` | Keep as the runtime owner for a suspended conversational run. |
| Agent response dispatch | Existing chat turn/provider path | Reuse it for conversation exchange, including BYOK. |
| Conversation events | Run event log | Keep replay/fork reconstruction event-sourced for the suspended run. |
| Conversation rail | `frontend/react/src/chat/conversations/*` | Keep as the user-facing persistent list. |

The key boundary is that ADR 0043 remains the durable product conversation model, while `core.conversationGate` is the runtime mechanism for a long-lived AI exchange inside a run. They must be linked, not collapsed into competing stores.

## Decision

Make conversation-run transport the default AI chat path only after it reaches parity with per-turn chat:

- BYOK, managed, and mock provider dispatch use the same provider policy and redaction path as `openwop-app.chat.turn`.
- Each exchange carries an idempotency key so a retried POST cannot append duplicate user/assistant turns.
- Conversation event loading supports tailing or cursoring instead of reconstructing from sequence 0 on every UI refresh.
- Closing a conversation intentionally resolves/closes the suspended gate and records a `conversation.closed` event.
- The per-turn path remains as a fallback for one release behind an operational flag, then is retired or kept only for emergency rollback.

The host conversation store remains responsible for the visible session. A conversation-run can be attached to a `conversationId`, but the rail, participants, read state, and messages still come from ADR 0043 routes.

## Data and event contract

The host should treat the runtime conversation state as:

```ts
interface ConversationRuntimeLink {
  tenantId: string;
  conversationId: string;
  runId: string;
  nodeId: string;
  interruptId: string;
  status: 'open' | 'closing' | 'closed' | 'failed';
  openedAt: string;
  closedAt?: string;
  lastEventSeq?: number;
}
```

This can live as a host-extension sidecar if the existing interrupt/run rows cannot answer "which suspended gate backs this visible conversation?" efficiently.

Run events remain the replay-safe source for individual `conversation.opened`, `conversation.exchanged`, and `conversation.closed` turns. The sidecar is an index, not a second transcript.

## Security and replay invariants

- Provider credentials are resolved server-side only and never persisted into conversation events.
- Persisted turns pass through the same free-text bounds and secret-stripping helpers as per-turn chat.
- Replay/fork reads historical conversation events verbatim; it does not re-run the model to regenerate prior turns.
- A closed or terminal run cannot accept a new exchange.
- A stale interrupt token returns an explicit stale/closed response instead of reopening the run.
- Authorization is checked against the visible conversation and the backing run before exchange.

## Phased plan

1. **Provider parity.** Refactor `conversationExchange.ts` to call the same dispatch path as normal chat, including BYOK-direct. Add managed, BYOK, and mock tests.
2. **Idempotency and stale safety.** Add exchange keys, duplicate suppression, closed-run checks, and stale token responses.
3. **Runtime link.** Add a small index from `conversationId` to the open gate so reload can resume without scanning run history.
4. **Event tailing.** Add `lastEventSeq` or cursor support for the frontend reconstruction path.
5. **Frontend default.** Flip the default in staging, then production. Keep per-turn fallback for one release.
6. **Retirement checkpoint.** Remove fallback or document it as an emergency-only path after parity and telemetry are clean.

## Acceptance criteria

- Production chat can use conversation-run exchange without setting a dev-only flag.
- Managed, BYOK, and mock providers pass parity tests against per-turn chat.
- Reload reattaches to an open suspended conversation gate.
- Retried exchange requests do not duplicate user or assistant turns.
- Closing the chat records a close event and prevents further exchanges.
- The frontend can tail updates without full replay on every refresh.
- No credential, hidden prompt, or cross-tenant data appears in persisted conversation events.

## Test plan

- Backend route tests for open, exchange, close, reload, terminal-run rejection, stale interrupt, retry idempotency, and provider parity.
- Frontend tests for `conversationTransport`, `useChatSession`, reload recovery, and fallback behavior.
- Manual QA with managed provider, BYOK provider, mock provider, addressed-agent turns, and browser reload during an open gate.

## Alternatives considered

- **Keep per-turn chat as primary.** Rejected because it never becomes a durable orchestration surface; it makes each chat turn a separate run and leaves long-lived gate semantics unused.
- **Use run events as the only visible conversation store.** Rejected because ADR 0043 already owns user-facing conversation IA, participants, read state, and pagination.
- **Create a third conversation runtime.** Rejected as a duplicate system.

## Open questions

- Should the runtime link live in the ADR 0043 conversation meta sidecar or a separate `chat:runtime-link` collection?
- What is the release metric for retiring per-turn fallback: error rate, latency parity, manual QA sign-off, or all three?
- Should closed conversation runs be archived automatically or retained as inspectable runs in the normal run list?

## Implementation record

Phases 1–5 landed together; Phase 6 (fallback retirement) landed 2026-06-21 once parity + telemetry were clean.

| Phase | Change |
|---|---|
| 1 Provider parity | `host/conversationExchange.ts` `dispatchReply` adds the BYOK-direct branch (`resolveSecret({ tenantId })` → `dispatchChat`), keeping mock + managed. An unresolvable key fails closed with `credential_unavailable` (422) instead of the old "not wired" 422. |
| 2 Idempotency & stale safety | New `host/conversationExchangeIdem.ts` (`DurableCollection` CAS claim/commit/release). `ConversationResolve.exchangeKey` short-circuits a retried exchange; a terminal-run guard (`isTerminalRunStatus`) rejects exchange/close on a dead run. |
| 3 Runtime link | **Correction to the open question:** no new sidecar. Reload reuses the session's `conversationRunId` + the existing interrupt store (`listOpenInterrupts(runId)`) — standing up a `conversationId→gate` collection would have been a second source of truth for state the interrupt store already owns. |
| 4 Event tailing | `conversationTransport.fetchTurns(runId, sinceSeq)` returns `{ turns, lastSeq }`; the hook keeps a turn accumulator + cursor and folds only new events. **Correction:** tailing is a frontend read optimization — the backend `loadTurns` still folds full history because the model prompt needs every prior turn, so no `fromSeq` was added to the exchange handler. |
| 5 Frontend default | `conversationChatEnabled()` flipped to ON; the per-turn path is reachable only by explicit opt-out (`VITE_OPENWOP_CHAT_CONVERSATION=false` / `localStorage openwop:chat-conversation = "0"`). |
| 6 Fallback retirement | The conversation primitive is now the SOLE chat transport. Removed `conversationChatEnabled()` + the `send()` per-turn branch + the `VITE_OPENWOP_CHAT_CONVERSATION` flag; deleted `chat/hooks/chatTurnSubscription.ts` and the now-orphaned `chat/lib/composeProviderMessages.ts`. **Backend `openwop-app.chat.turn` workflow definition is KEPT** (`host/index.ts`) so historical/in-flight per-turn runs still replay + `:fork` (the wire contract) — only NEW per-turn sends are gone. Known follow-up (out of scope): aborting a single in-flight conversation `exchange` (`cancel()`/Stop currently no-ops mid-chat — cancelling the long-lived run would tear down the whole thread). |

**Idempotency key placement (correction to "Each exchange carries an idempotency key"):** the key lives ONLY in the host-ext sidecar, never on the `conversation.exchanged` event payload — stamping it on a normative RFC 0005 event would be a wire-shape change requiring an OpenWOP RFC. This keeps the work host-only as the RFC gate intends.

Tests: `backend/test/conversation-exchange.test.ts` (idempotent-retry no-duplicate; BYOK `credential_unavailable` fail-closed), `frontend conversationTransport.test.ts` (turn→bubble mapping + streaming guards), `useChatSession.integration.test.tsx` (Phase 6: pins the conversation send path — lazy-open + run reuse, wire-turn rebuild, error-bubble-preserves-user-turn; the @mention `workflow_run` block still pins the createRun + SSE lifecycle).

