# ADR 0324 — Voice ⇄ chat tool-execution scope parity (one composer, host-bound acting user)

Status: implemented

## Context

A live realtime-voice conversation with Iris (board-of-directors group) failed on
"draft that briefing" and "add a kanban task" with an improvised apology, while
the same asks work over text chat. The deep-dive found the tools were **offered**
correctly over voice — `resolveAgentToolDecls` composes the same ADR 0104
override / ADR 0315 default-on baseline as chat, so `openwop:documents.draft` and
`openwop:kanban.add-todo` were declared to the realtime model and it called them —
but **execution** failed closed:

- The chat tool loop composes its executor scope with the run owner's
  `actingUserId` (ADR 0308 P1) and the conversation (ADR 0309):
  `conversationToolLoop.ts` → `createAgentToolProvider({ tenantId, runId,
  agentProfileId, actingUserId, conversationId })`.
- The realtime bridge hand-rolled its own scope with only `{ tenantId, runId,
  agentProfileId }` (`toolBridge.ts`), so every ADR 0308 deliverable tool
  returned `acting_user_required` over voice. The ADR 0308 scaffold *telling*
  the agent it can draft reached voice (it rides `composeChatContext`), so the
  agent promised, called, failed, and apologized — the anti-fabrication
  contract surfacing a real host gap.

Root cause class: **two transports wired separately with no parity contract.**
ADR 0141 asserted "voice-initiated tool calls run through the SAME RBAC +
firewall + HITL as typed turns" — true for allowlist/firewall/executor, but the
scope *fields* were assembled independently per transport and drifted when
ADR 0308 threaded `actingUserId` into the chat loop only.

## Decision

1. **One scope composer.** `createScopedAgentToolProvider(scope)` in
   `host/agentToolProvider.ts` is the single place a conversational tool-call
   execution scope (`tenantId`, `runId`, `agentProfileId`, `actingUserId`,
   `conversationId`) is assembled. Both transports — the chat tool loop and the
   realtime bridge (`executeRealtimeToolCall`) — MUST build their executor
   through it. A new scope field lands there once and reaches every transport,
   or reaches none. (The bridge's tool-DECLARATION resolver may still construct
   a bare provider — it resolves defs only and executes nothing.)
2. **The acting user is host-bound at session open, never client-asserted.**
   - Gemini/browser path: `POST …/voice/realtime/session` binds the
     authenticated caller (`resolveCallerUser`) + the conversation onto the
     host-issued session record (`sessionRegistry`); `POST …/tool-call`
     recovers both server-side, exactly as it already recovered the `agentId`
     (RTV-3). A client-body `actingUserId`/`conversationId` is ignored.
   - OpenAI sideband path: `/openai/connect` stamps the resolved caller onto
     the `SidebandSession`; `handleSidebandEvent` threads it into every
     ordinary tool call — including while a delegation (ADR 0304) holds the
     floor: the delegate acts for the same human under its own allowlist.
   - No authenticated caller ⇒ no acting user ⇒ deliverable tools keep failing
     closed (same as system runs — the correct floor, per ADR 0308).
3. **The bound conversation is existence+visibility-gated at bind time.** Voice
   takes a client-supplied `conversationId` (chat's `chatSessionId` is
   server-stamped, so chat never had this exposure). Both voice routes now gate
   it with the same `getChatSession` existence + `isVisibleToAsync` check the
   transcript-stream route enforces, fail-closed to an unscoped session. On the
   OpenAI path this also closes a pre-existing hole: a caller could previously
   bind another user's conversation id and have transcripts persisted into it.
4. **Parity is test-pinned.** `test/voice-tool-parity.test.ts` pins (a) both
   transports to the composer at the source level (a hand-rolled
   `createAgentToolProvider({...})` executor in either file fails the suite),
   (b) the bridge threading `actingUserId`/`conversationId` to the tool, and
   (c) the host-bound identity (forged client-body values never reach the
   scope; the mint binding round-trips the registry).

## Alternatives weighed

- **Route voice tool calls through `conversationToolLoop` itself** — full DRY,
  but the loop is a provider-round loop (it owns the model round-trip); in
  realtime the *provider* owns the round-trip and the host only executes one
  call. Sharing the executor + scope composer is the honest seam; sharing the
  loop would be a fiction.
- **Duplicate the threading in the bridge (no shared composer)** — exactly the
  drift pattern that caused this incident; rejected.
- **A `voice:system` synthetic acting user for unresolved callers** — would
  defeat the ADR 0308 fail-closed floor (ownership/RBAC would attach to a
  phantom principal); rejected.

## Consequences

- Deliverable tools (documents.draft, email.draft, kanban.add-todo,
  notify-me, schedule-followup) now work in live voice for signed-in callers,
  on both providers, including for ADR 0304 delegates.
- `schedule-followup` gains its unforgeable delivery destination over voice
  (ADR 0309 parity) — but only when the session opened with a visible, existing
  conversation.
- An anonymous/unresolvable caller in live voice keeps a working session
  (compose already degraded fail-soft) but deliverable tools refuse — matching
  chat's system-run behavior.
- Known non-parity that REMAINS (deliberate): the walkie/board path generates
  replies through the ordinary chat run (`onSend` → tool loop), so it was never
  affected; `runAgentDispatchLive` (ad-hoc dispatch) and `agentRunnerNode`
  (workflow node) construct their own provider scopes — they are not
  conversational transports and have no acting human by design. Extending the
  composer there is a follow-up if either ever grows a human principal.

## Phase record

| Phase | Landed |
|---|---|
| P1 | `createScopedAgentToolProvider` + both transports switched; registry/sideband caller binding; conversation gate; corrections to ADR 0141/0308; `voice-tool-parity.test.ts` (9 tests) |
