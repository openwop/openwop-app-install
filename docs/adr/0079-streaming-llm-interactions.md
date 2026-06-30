# ADR 0079 - Streaming posture for all LLM interactions

**Status:** implemented
**Date:** 2026-06-19
**Depends on / composes:** RFC 0005 (conversation primitive), RFC 0024 (agent reasoning streaming), the chat streaming path (`bootstrap/nodes.ts` chat-responder `onDelta` → `node.message`, `client/streamsClient.ts` `subscribeToRun`), the provider dispatch layer (`providers/dispatch.ts` `onDelta`), the optimistic thinking bubble (`useChatSession.sendViaConversation`), the LLM-route timeout budget (`middleware/requestTimeout.ts`).

> **Correction (2026-06-21, ADR 0067 Phase 6):** the per-turn FE handler `chat/hooks/chatTurnSubscription.ts` cited below was deleted when the per-turn transport was retired. The conversation handler in `useChatSession.sendViaConversation` (`streamDeltaFromEvent`) is now the sole FE `ai.message.chunk` consumer; backend streaming is unchanged.
**Surface:** host-extension behavior at the LLM dispatch sites + the `frontend/react/src/chat` (and other reply-rendering) surfaces. No core route/nav edits.
**RFC gate:** **Host work — no new RFC.** Token streaming rides the **spec-canonical** `ai.message.chunk` run event (`stream-modes.md`, `messages` mode; same event MyndHyve standardized on — see Prior art). RFC 0005 §Alternatives explicitly anticipates conversation streaming: *"Conversations MAY also stream chunked content within a single turn via `output.chunk` events; that surface is unchanged."* No new event type, field, capability, or endpoint contract on the wire; the normative turn/result events remain the source of truth.

## Why this exists

Streaming is currently **inconsistent**. The per-turn chat node streams its tokens (they type out live, via the run's SSE on a direct `*.run.app` URL that bypasses the Firebase `/api` CDN), but most other LLM interactions **block** — the dispatch holds the request while the full reply generates, then returns it whole. That produces three recurring failures, most visibly in advisor chat:

1. **Frozen UI.** A blocking reply (tens of seconds for a reasoning model) shows nothing — or, in the conversation path, an *optimistic* "Thinking…" bubble that doesn't reflect real progress.
2. **The Firebase `/api` CDN caps the request** at ~60s. Raising the *backend* budget (`OPENWOP_LLM_REQUEST_TIMEOUT_MS`) doesn't help a reply that runs past the CDN ceiling — the content has to ride the CDN-bypassing SSE instead of a blocking `/api` POST.
3. **No live progress** for any non-chat LLM surface (workflow-authoring AI, agent replies through `aiProvidersHost`).

The streaming machinery to fix all of this **already exists** (provider `onDelta`, a token-delta run event, the SSE client, the FE animation batcher) — it's just not applied consistently, and the existing per-turn path emits a **non-canonical** `node.message` event where the spec (and MyndHyve) use `ai.message.chunk`. This ADR makes **streaming the default posture for every LLM interaction**, standardizes the delta event on `ai.message.chunk`, and closes the gaps — with the conversation exchange as the flagship.

## The streaming contract

Every LLM dispatch in the app SHOULD stream, in two halves:

- **Producer half (backend).** A site that calls the provider passes an `onDelta` callback and emits a token-delta run event — **`ai.message.chunk`** (the spec-canonical streaming event; `{ runId, nodeId, chunk, isLast }`, `messages` mode) — on the owning run/node's event stream during generation. The final, authoritative event (the turn / node output) is emitted at the end, unchanged. Deltas are **transient** (UI progress), appended fire-and-forget so emission never blocks token delivery, and are never the replay source of truth (RFC 0024: "consumers MUST tolerate both").
- **Consumer half (frontend).** A surface that renders an LLM reply tails the run's SSE (via `subscribeToRun`, the direct CDN-bypassing URL) and renders deltas progressively through the shared `useApplyAnimation` batcher; on settle it reconciles to the persisted event as the final content.

Carve-out: an **internal, non-user-facing** LLM call with no progressive UI (a one-shot translation/classification/extraction) MAY stay blocking — streaming there is cheap but low-value; it is not required, only allowed. The contract is "stream wherever a human watches the reply form."

## LLM dispatch inventory (audit)

| Site | Streams today? | Decision |
|---|---|---|
| `bootstrap/nodes.ts` chat-responder (per-turn chat + workflow chat nodes) | ✅ `onDelta` → `node.message` (non-canonical) | Keep the stream; **migrate the event to `ai.message.chunk`** (Phase 0) so there is one convention. Dual-emit during transition; FE handler accepts both, then drop `node.message` (Phase 5). |
| `host/conversationExchange.ts` `dispatchReply` (advisor / council chat) | ❌ blocks | **Flagship fix** (Phases 1–3): stream deltas + dispatch async. |
| `aiProviders/aiProvidersHost.ts` (`ctx.features.aiProviders` — authoring AI, agent replies) | ❌ blocks | **Phase 4:** add `onDelta` pass-through; stream where a surface renders the reply progressively. |
| `features/cms/translate.ts` (section translation) | ❌ blocks | Internal one-shot, no progressive UI → stream-optional (carve-out). Revisit if a live "translating…" surface is added. |
| Providers (`dispatch.ts` Anthropic/OpenAI/Google/MiniMax, `managedProvider`) | ✅ already expose `onDelta` | Reuse — no change. **Mock** provider gains a chunked `onDelta` path so the test/demo path streams. |

## Prior art — MyndHyve (the baseline this app ports from)

MyndHyve runs **async ack-and-stream over SSE** in production; reviewing it confirmed the model and surfaced four concrete decisions:

- **It standardizes on `ai.message.chunk`** (`functions/src/ai-proxy/messageChunkEvents.ts`), appended to the event log fire-and-forget, `messages` stream-mode only. → **Adopt:** use `ai.message.chunk`, not `node.message` (decision above).
- **Its transport is the chat request's own streaming response body** (`functions/src/ai-proxy/index.ts:899`). That works on Cloud Functions; it would NOT here, because our exchange POST is behind the Firebase `/api` CDN that buffers SSE. → **Diverge:** stream on the direct-`*.run.app` run-event SSE we already use (Alternatives §6).
- **Idempotency is at the fetch layer** (`fetchWithIdempotency`, keyed `(runId, nodeId, attempt)`) so a retry replays the *same tokens* across restarts. → **Defer:** our `exchangeKey` claim is enough for the flagship; note the fetch-cache as future hardening.
- **Providers stream via Web `ReadableStream` async-iteration** (migrated off node emitters so the fetch is wrappable — `ai-providers/.../anthropic.ts:402`), with SSE line-buffering for partial UTF-8 and the terminal chunk carrying `usage`/`toolCalls`. → **Adopt** these robustness patterns.
- **Caveat:** MyndHyve's *agent/council* chat is **not** token-streamed — it `generate()`s the full reply and delivers it as a doc (`messaging-gateway/agentProcessor.ts:183`). So our streamed council goes *further* than the baseline; the reusable parts are MyndHyve's `aiProxyStream` infra, not its agent path.

## Decision

Adopt the per-turn streaming pattern as the standard, standardized on the canonical event, and close the gaps in inventory order. The shared mechanism (provider `onDelta` → **`ai.message.chunk`** → run SSE → FE animation batcher) is the one path every site reuses.

### Flagship — conversation exchange (advisor / council chat)

1. **Backend, stream deltas.** `dispatchReply` accepts an optional `onDelta(delta)` and passes it to all dispatch paths; `handleConversationResolve` supplies an `onDelta` that appends an `ai.message.chunk` event on the gate node, so a subscribed client renders tokens live. The **mock** provider streams its canned reply.
2. **Backend, dispatch async.** The exchange becomes async: the resolve route validates + acks quickly and the reply generation runs in the **background** (mirroring `host/runDispatch.ts` `dispatchRunInBackground`), emitting deltas during generation and the final `conversation.exchanged` (+ channel-message append) at the end. The POST no longer blocks for the full generation → the `/api` CDN ceiling no longer applies to it.
   - **Idempotency** (ADR 0067 `exchangeKey`): a retried POST for an in-flight `exchangeKey` MUST NOT dispatch a second generation; it returns the in-flight/known state.
   - **Error after ack:** a generation that fails after the ack emits a terminal event the FE renders as the error bubble (it can't be the POST's 4xx anymore).
3. **Frontend, tail the run SSE.** `sendViaConversation` keeps the optimistic, agent-attributed thinking bubble, then `subscribeToRun(runId, …)` with a lightweight `makeConversationStreamHandlers`: `ai.message.chunk` → animation batcher → the optimistic bubble types out; on settle (the turn's `conversation.exchanged`) it reconciles via the existing `fetchTurns` (event-log replay) so the persisted turn (wire attribution + `messageId`) is the final content.

### Standard — other LLM surfaces

`aiProvidersHost` gains the same `onDelta` pass-through so authoring-AI / agent replies stream wherever a surface renders them progressively (Phase 4). New LLM dispatch sites inherit the contract by passing `onDelta` and emitting `ai.message.chunk`.

### Net effect
Replies type out live everywhere a human watches them form; the sidebar "thinking" pulse becomes a genuine in-flight signal; a >60s reasoning reply succeeds via the CDN-bypassing SSE rather than a blocking `/api` POST; and "does this LLM call stream?" stops being a per-feature decision.

## Alternatives considered

1. **Keep blocking, raise the timeout further.** Rejected — frozen UI persists and the `/api` CDN ceiling (~60s) is not ours to raise.
2. **Chunked HTTP response on the POST.** Rejected — the `/api` CDN buffers streamed bodies (the documented reason SSE uses a direct `*.run.app` URL).
3. **A new normative `conversation.delta` / streaming event (new RFC).** Rejected — RFC 0005 §Alternatives already sanctions in-turn chunk streaming and the spec-canonical `ai.message.chunk` already exists. A normative event would be a wire change for no benefit.
4. **A per-feature streaming flag.** Rejected — that is the status quo (inconsistent). A single contract + shared mechanism is the point.
5. **Keep emitting `node.message` (the openwop-app per-turn convention).** Rejected — MyndHyve and `stream-modes.md` both use `ai.message.chunk`; perpetuating `node.message` widens a latent spec divergence. Standardize, dual-emit during the per-turn migration.
6. **Stream the exchange POST's own response body (MyndHyve's model).** Rejected *for this deployment* — the exchange POST traverses the Firebase `/api` CDN, which buffers SSE; the content must ride the direct-`*.run.app` run-event SSE (which the per-turn path already uses). MyndHyve's same-request streaming works because Cloud Functions isn't behind that CDN.

## Replay / determinism / idempotency

- **Source of truth unchanged.** Persisted turn/output events remain authoritative; `reconstructConversation`/`fetchTurns` rebuild from them on reload. `ai.message.chunk` deltas are transient (verified stream-only — no channel reducer folds them), not replayed into content (RFC 0024 "tolerate both").
- **Determinism.** No new non-deterministic state is stamped on a run; deltas carry only the text the final event already contains.
- **Idempotency.** The `exchangeKey` dedup (`conversationExchangeIdem` claim→commit) extends to the async path → one generation + one final event under retry. *Future hardening (MyndHyve precedent, not Phase-1 scope):* a fetch-layer idempotency cache keyed `(runId, nodeId, attempt)` would replay the **same tokens** across process restarts, not just prevent re-dispatch.
- **Reconnect.** SSE drop mid-stream → reconcile via `fetchTurns` (cursored run-event poll) on resubscribe, the same backfill the per-turn path + notifications store already use.

## Phased implementation plan

| Phase | Scope | Gate |
|---|---|---|
| 0 | **Standardize the delta event.** Backend emits `ai.message.chunk` for the existing per-turn chat node (dual-emit alongside `node.message` during transition); the FE handler accepts both. Confirm `providers/dispatch.ts` streams via Web `ReadableStream` async-iteration (MyndHyve lesson — fetch-wrappable) not node emitters. | BE `tsc` + per-turn streaming still renders; FE handler test accepts `ai.message.chunk`. |
| 1 | `dispatchReply` accepts `onDelta`; `handleConversationResolve` emits `ai.message.chunk` during generation (still synchronous). Mock provider streams its canned reply (chunked, deterministic cadence). | BE `tsc` + a conversation-exchange test asserting `ai.message.chunk` events emit in order before the final `conversation.exchanged`. |
| 2 | FE: `makeConversationStreamHandlers` (shares the chunk→animation accumulation with the per-turn handler) + `sendViaConversation` subscribes to the run SSE and types deltas into the optimistic bubble; reconcile via `fetchTurns` on settle. | FE `npm run build` + a handler unit test (deltas accumulate → bubble; reconcile replaces with the wire turn). |
| 3 | Conversation exchange goes **async** (background dispatch + ack); extend `exchangeKey` dedup; terminal error event after ack. | BE route test: POST returns promptly; deltas + final event arrive on the stream; a same-key retry doesn't double-dispatch; >60s reply path works via SSE. |
| 4 | `aiProvidersHost` `onDelta` pass-through; render progressively on the surfaces that show those replies (authoring AI, agent replies). | BE test (deltas emit) + the relevant FE surface renders progressively. |
| 5 | Drop the transitional `node.message` dual-emit (all producers + the FE handler on `ai.message.chunk`); cross-surface verification + ADR → `implemented` (phase→commit table); document the contract in ARCHITECTURE/CONTRIBUTING so new LLM calls inherit it. | Manual long-reply + council smoke; one delta convention; doc updated. |

*(Phase 0 unifies the delta event; Phases 1–2 deliver live streaming for advisor chat (common case); Phase 3 removes the >60s ceiling; Phase 4 generalizes; Phase 5 retires the legacy event. Each phase is independently shippable — un-migrated sites keep working on the current blocking path, and the dual-emit keeps the per-turn path working throughout.)*

## Open questions / decisions checklist (architect-reviewed)

- [x] **No-RFC determination — CONFIRMED.** The delta event (`ai.message.chunk`, like the verified-stream-only `node.message`) is transient — no channel reducer folds it — `conversation.exchanged` is unchanged, and `interrupt.md` frames the exchange as suspend/resume with the turn delivered via the *event* (not the POST body). Async-ack is scoped to the conversation branch of a host route. Additive, host work, no RFC.
- [x] **Replay/determinism — SAFE.** Deltas are transient (stream-only, ignored by `reconstructConversation`); the persisted `conversation.exchanged` turn is authoritative on reload/`:fork`.
- [x] **`exchangeKey` dedup — already exists.** `host/conversationExchangeIdem.ts` has a `claim(pending) → commit(committed)` lifecycle keyed `tenantId:conversationId:exchangeKey`; async holds the claim across the background dispatch and a mid-flight retry sees `pending` and does not re-dispatch.
- [x] **HIGH (must-fix #1) — stale `pending` claim on failure/crash — DONE (Phase 3).** The async background `.catch` calls `releaseExchange` (idempotent with `finishExchange`'s inner dispatch-catch release), and `claimExchange` already carries the `STALE_MS` (180s) TTL so a hard crash mid-generation self-heals. `conversationExchange.ts`.
- [x] **HIGH (must-fix #2) — terminal error event after the ack — DONE (Phase 3).** The same `.catch` emits a terminal `ai.message.error` event (`{ conversationId, turnIndex, code, message }`) on the run log. The FE's async settle-wait (`exchangeSettleSignal`) resolves on it, rethrows so the shared catch renders the classified `ErrorCard` bubble (code preserved) and drops the optimistic "thinking" bubble.

### Phase 3 implementation notes (flag-gated rollout)

- **Default OFF.** The async path is gated on `OPENWOP_CONVERSATION_EXCHANGE_ASYNC=true` (read at call time). Unset = the proven synchronous exchange, byte-for-byte. This bounds the blast radius of a sync→async semantic change that can't be browser-verified headlessly (failure mode: a stuck "thinking" bubble). **Gate to flip the flag in prod: a `DEPLOY-SMOKE` long-reply (>60s) + error-path browser check.**
- **FE infers async from the wire, not a response flag.** After `exchange()`, if `fetchTurns` did NOT advance the cursor (`lastSeq <= cursor`), the turn isn't emitted yet → async; the FE awaits the SSE settle signal (agent `conversation.exchanged` or `ai.message.error`, newer than the subscribe cursor) before merging, so a merge never erases the optimistic user bubble over a still-empty wire. A generous 180s settle timeout (matching the dispatch budget) falls back to a retry error. No backend response-shape or SDK-type change.
- **Council (multi-agent) note.** `exchangeSettleSignal` resolves on the FIRST agent turn newer than the cursor — correct for the current one-`to`-agent-per-exchange path. A future fan-out exchange (N agent turns) would need a per-bubble settle; tracked for Phase 4/5.
- **Same-key retry under async.** A mid-flight retry of the SAME `exchangeKey` still sees `in_progress` → 409, as in the sync path; the per-send key (one `crypto.randomUUID()` per `sendViaConversation`) means normal double-clicks use distinct keys and don't collide.

### Phase 4 implementation notes (aiProvidersHost pass-through)

- **Plain-text only.** `callAI` builds a `streamDelta` and passes it to `dispatchPlain` (→ the same `onDelta`-capable `dispatchChat`). The structured branch (`dispatchStructured` + the NL-to-format retries) does NOT stream — emitting a JSON body token-by-token across parse-retry attempts is noise, not progress. Structured/embedding/tool calls are unaffected.
- **Opt-in per call (`req.stream`) — architect-review correction.** Phase 4 originally gated streaming only on an emit-capable `AdapterScope`, but `executor.ts` wires `emit` for EVERY node, so that streamed `ai.message.chunk` for every plain `callAI` app-wide — including non-interactive `agentDispatch`/`kb`/`documents`/batch nodes that nothing tails — appending one durable event per token (write amplification, larger `:fork`/debug payloads). Corrected: streaming is now **opt-in** via `AiCallRequest.stream` (default off → no deltas). An interactive surface that tails the run sets `stream: true`; the chat paths (Phases 1–3) stream via their OWN `onDelta`, so they don't depend on this. No current caller opts in, so the producer ships inert-but-ready — same posture as the default-OFF async flag.
- **Transient + SR-1 + replay-safe.** Best-effort try/catch; stream-only (no reducer folds it); the node's result stays authoritative — replay/`:fork` safe. Chunks are `stripSecretsFromPersisted`'d via the executor `emit` wrapper (the conversation path's own `onDelta` was brought to parity — see below).
- **No new FE surface.** The FE already consumes `ai.message.chunk` (originally in both the per-turn `chatTurnSubscription.ts` and conversation `useChatSession` handlers; post-Phase-6 the conversation handler is the only one). The "render progressively" deliverable is the existing handler, not new code.

### Post-merge architect-review fixes (follow-up)

- **HIGH — SR-1 redaction parity.** The conversation `onDelta` chunk and the Phase 3 terminal `ai.message.error` were `log.append`'d WITHOUT `stripSecretsFromPersisted`, unlike the sibling `conversation.exchanged` emit and the executor-level `emit`. A model echoing a run secret could leak it into the durable event log via the un-stripped chunk ahead of the sanitized turn. Fixed: both payloads now wrap in `stripSecretsFromPersisted`; a conversation test asserts the conformance canary is scrubbed from the streamed chunks.
- **HIGH — write amplification.** See the Phase 4 opt-in correction above.
- **MEDIUM — concurrent-exchange serialization (recorded, not a code change).** `turnIndex` is computed from a `loadTurns` snapshot, so two exchanges on the same conversation with distinct `exchangeKey`s could collide on `turnIndex`. This is pre-existing in the sync path; async (Phase 3) widens the server-side window because the ack returns before the turns are emitted. It is **mitigated by client serialization**: `sendViaConversation` awaits the settle signal, so no second send fires until the first lands, and the per-`exchangeKey` claim blocks same-key retries. There is no server-side conversation lock — the integrity guarantee rests on the FE not firing concurrent exchanges. Acceptable for the demo host; a future multi-writer/council exchange would need a server-side per-conversation sequence guard.
- [x] **Council settle/attribution — serial.** `useBoardroomCadence` dispatches advisors serially (next on the falling edge of `isSending`), so exactly one exchange streams at a time; the `ai.message.chunk` deltas (same gate `nodeId`) attribute to the single in-flight optimistic bubble, and the FE reconciles on that turn's `conversation.exchanged`. **Documented assumption:** concurrent conversation exchanges would need an `exchangeKey`/correlation id on the delta event — out of scope while the cadence serializes.
- [x] **Delta event choice — DECIDED: `ai.message.chunk`** (spec-canonical `stream-modes.md` + the MyndHyve baseline). Supersedes the prior `node.message` leaning; the per-turn path dual-emits during migration (Phase 0) and retires `node.message` (Phase 5), so the app runs ONE delta convention instead of widening the divergence.
- [x] **Ack response shape:** 202 `{ runId, nodeId, status: 'generating' }`-style; the FE reads content from events (`fetchTurns`), never the POST body (verified — no FE consumer reads the exchange response for content).
- [ ] **Mock streaming cadence** — chunk size/interval for deterministic tests + a visible demo (Phase 1).
- [ ] **`aiProvidersHost` surfaces** — which render progressively (worth streaming) vs one-shot (carve-out), to bound Phase 4.
- [ ] **Contract documentation** — ARCHITECTURE.md "extension seams" + a CONTRIBUTING/DESIGN note so new LLM calls stream by default (Phase 5).
- [ ] **Shared delta-accumulation** — keep the `ai.message.chunk → animation` accumulation logic shared between the per-turn and conversation handlers to avoid drift (Phase 2).
- [x] **Idempotency depth — fetch-layer cache deferred.** The `exchangeKey` claim prevents double-dispatch (enough for the flagship); MyndHyve's fetch-layer `(runId, nodeId, attempt)` token-replay cache is recorded as future hardening, not Phase-1 scope.
- [ ] **Provider stream impl** — confirm `providers/dispatch.ts` uses Web `ReadableStream` async-iteration (fetch-wrappable, MyndHyve lesson) not node emitters; apply SSE line-buffering + terminal-chunk metadata patterns (Phase 0).

## Phase → commit record (implemented)

| Phase | Landed | Commit | Notes |
|---|---|---|---|
| 0 | Standardize the delta event on `ai.message.chunk` (per-turn node dual-emit + FE handler reads it) | `6e9a2b5a` | Dual-emit alongside `node.message` during migration. |
| 1 | `dispatchReply` accepts `onDelta`; `handleConversationResolve` emits `ai.message.chunk`; mock streams its canned reply | `331574df` | Synchronous; route test asserts deltas precede the final `conversation.exchanged`. |
| 2 | FE `sendViaConversation` tails the run SSE → types deltas into the optimistic bubble; replay-guarded `streamDeltaFromEvent` | `350fdc4d` | Shares the `animation` batcher with the per-turn handler. |
| 3 | Async exchange behind `OPENWOP_CONVERSATION_EXCHANGE_ASYNC` (default OFF) + must-fix #1 (claim release + STALE_MS TTL) + #2 (terminal `ai.message.error`) | `6cfec874` | FE infers async from the wire (cursor didn't advance) + settle-wait. Flag flip gated on a browser long-reply smoke. |
| 4 | `aiProvidersHost.callAI` plain branch streams `ai.message.chunk` via `dispatchPlain`; structured/JSON excluded | `a2dce99e` | No new FE — existing handlers consume it. |
| 5 | Retire the `node.message` dual-emit (sole convention is `ai.message.chunk`); document the streaming contract in `ARCHITECTURE.md` | _(this commit)_ | Verified no remaining consumers; comments updated. |

The flagship (advisor/agent chat) streams live on all paths; the async ceiling-removal ships dark behind a flag pending a browser smoke. Correct the record inline (don't rewrite) if later work overturns a decision.
