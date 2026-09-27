# ADR 0491 — Turn-scoped run-dispatch surfacing (one turnIndex allocator, one honest status surface)

Status: implemented

## Context

On 2026-07-25 a user asked the Challenge Author (KickTodo Creator) in the ONE chat
to build a "20-Minute Chef" challenge. The agent replied:

> Great! I have … successfully created a new candidate and dispatched the
> "20-Minute Chef" challenge into the Factory. **The Run is Active** … a review
> card will appear right here in our chat.

Nothing appeared. The Workflow-progress rail read "No workflow runs yet".

The investigation (Cloud Run rev `openwop-app-backend-00571-dll`) found the tool
had **really dispatched** — `challenge_factory_dispatched` fired twice, runIds
`80badc96…` and `0abf0e52…`. Each run then logged exactly one thing and went
silent: `host.webResearch | web search (demo — no provider key configured)`.

Four distinct defects, in three layers:

1. **Two turnIndex allocators (data integrity).** `conversationExchange` computes
   `nextIndex` once from turns loaded at exchange start and reserves N (user) /
   N+1 (agent). The tool loop runs INSIDE the subsequent dispatch, and each of
   FIVE feature-local `appendWorkflowRunTurn` copies re-read the log — which still
   lacked the not-yet-persisted user turn (dispatch is deliberately first) — and
   allocated **N again**. `loadTurns` folds with a bare `list.push` and no dedup,
   so both rows survived at one index and the run bubble sorted against the user's
   own message.
2. **The run turn never reached the client.** The exchange returns
   `[...existing, userTurn, agentTurn]` where `existing` predates the tool call, so
   the out-of-band append was persisted but absent from the response — invisible
   until a full page reload.
3. **The client could not have rendered it anyway.** `turnsToBubbles` had no
   `workflow_run` case: a `{kind:'workflow_run', runId, agentId}` turn fell to the
   assistant branch and `asText` rendered it as **raw JSON**. Only a
   `workflow_run` message carries run state, so the progress rail stayed empty by
   construction.
4. **The run was DOA.** The Factory's research spine is fail-closed on demo
   sources (`creatorService.ts` `StubSourceError` on `engine: 'stub'|'demo'`).
   With no live search adapter configured, EVERY source is demo — so a run started
   without one can only die. Nothing pre-flighted this.

Layered on top: the agent (Gemini 3.1 Flash-Lite) narrated an entire happy path —
approval gate, review card, timing — from a bare `{runId, candidateId}` payload.

**Five byte-identical copies** of `appendWorkflowRunTurn` existed (campaign-brief,
campaign-channels, campaign-orchestration, kicktodo-core, kicktodo-creator),
differing only in a `nodeId` and a log message. Every one carried defects 1 and 2.

## Decision

**The conversation exchange owns turn allocation and owns the response, so it owns
run-dispatch surfacing.** A tool RECORDS an ignited run on its turn scope; the
exchange DRAINS the record and materializes the `workflow_run` turns itself.

- New seam `host/turnRunDispatch.ts` — the ONE owner. `createTurnRunDispatchCollector`
  (exchange side, dedupes by runId), `buildRunDispatchTurns` (pure allocation),
  `surfaceDispatchedRun` (what features call), `appendRunTurnDirect` (the fallback).
- `onRunDispatched` rides `AgentToolCallScope` → `BundleScope`, threaded by
  `createScopedAgentToolProvider` — the ADR 0324 one-composer rule, so the field
  reaches every transport or none.
- `conversationExchange` allocates run turns at `agentIndex + 1 …`, persists them in
  the SAME `persistExchangedPair` call, and includes them in the returned `turns`.
- The dispatching tool also carries `workflowId`/`workflowName` (it is the only party
  that knows them), so the bubble and rail render a real title instead of a blank
  header; the client falls back to the workflow id, then a translated generic label.
- The five feature copies are deleted; all five call the shared seam.
- Frontend `turnsToBubbles` projects a `workflow_run` reference to a run-backed
  bubble; `mergeConversationTurns` builds the run-backed `ChatMessage` and calls
  `rehydrateWorkflowRuns`, which reconciles authoritative state from the event log
  and attaches the live stream.
- `runFactoryRunTool` pre-flights `liveWebSearchConfigured(tenantId)` — exported
  from `webResearchSurface` and reading through the SAME `resolveSearchKey` the
  search path uses (one predicate, no drift) — and refuses with a typed
  `research_adapter_unconfigured` **before** creating a candidate.

### On model honesty

A typed error cannot stop a weak model from narrating success — that is not a
solvable problem at the return-value layer. The decision is to **stop relying on
narration**: the run bubble is the authoritative status surface, live-attached and
reconciled from the event log, so a run that fails says so regardless of what the
model claimed. The tool description additionally states the precondition and that
`runId` means *started*, not *will succeed*, and forbids promising an outline or
an approval card — supporting measures, not the primary one.

### How the turn actually reaches the client (code-review correction)

The first draft of this ADR said the run turn "rides the exchange response". That is
only half right, and the honest version matters for anyone debugging this later.

`conversationExchange` **always takes the ASYNC path for a tool-bearing agent**
(`process.env.OPENWOP_CONVERSATION_EXCHANGE_ASYNC === 'true' || toolAgent`, ADR 0089
Phase 0/1 — a multi-round observe→act loop must not block the ~60s CDN ceiling). That
path acks with `turns: existing` and runs `finishExchange` in the background. Since a
run can only be dispatched by a tool, and a tool only runs when `toolAgent` is set,
**the returned `runTurns` are never observed on the live path.**

Actual delivery: `finishExchange` persists the run turns as `conversation.exchanged`
events; the client waits for the settle signal, then `fetchTurns(runId, cursor)` tails
the event log and folds the result through `mergeConversationTurns`. So the fix that
carries the user's experience is the **correct persisted index** plus the **frontend
projection** — the return-value change is defensive only, and is retained so the
synchronous path stays correct if a future non-tool caller ever dispatches a run.

## Alternatives weighed

| Option | Why not |
|---|---|
| Extract the 5 copies into one shared helper, unchanged | Preserves BOTH the collision and the invisibility — one bug in one place instead of five. Rejected. |
| `AsyncLocalStorage` for turn scoping | No ALS precedent in the repo, and the call chain (exchange → tool loop → executeTool) is already explicit. Ambient state for a problem explicit plumbing solves. Rejected. |
| A new per-conversation SSE for out-of-band appends | The channel bus is membership-gated and channel-shaped; a 1:1 chat would need new authz surface. The exchange already returns turns — no new transport needed. Rejected. |
| Blanket merge-refresh after every turn | An extra round-trip per turn to fix a case that the response can carry directly. Rejected. |
| `hostOwned` for challenge-factory (P4) | **Rejected** — see below. |

## P4 — challenge-factory's absence from the workflow list is CORRECT

`registerLegacyDefsChainBacked` registers chain-backed with `postProcess` only, no
`hostOwned`, so the workflow resolves by id but is absent from the tenant ownership
index that `/builder` and the `/` picker read. Adding `hostOwned` would push a
host-owned, non-editable definition into every tenant's ownership index — the
"unowned ≠ free for host system defs" hazard a prior `/grade-data` pass flagged.

ADR 0472's intent is that reachability comes from the **chain gallery** plus
`from-chain` minting. Verified: `routes/workflows.ts` lists chains where
`chain.internal !== true`, and `kicktodo-challenge-factory`'s parent chain is not
internal (its `lesson-batch` child correctly is). No change; pinned by test.

## Wire / RFC gate

**No wire change.** `ConversationResolveResult` is host-internal by construction
("never a persisted turn/event or the wire"), `workflow_run` is an existing turn
kind, and `onRunDispatched` is an in-process scope field. Host work only — no RFC
required in `../openwop`.

## Implementation record

| Phase | Change | Test |
|---|---|---|
| P1 | `host/turnRunDispatch.ts` seam; scope threading; 5 copies deleted | `test/turn-run-dispatch.test.ts` (incl. the collision pin, sabotage-probed) |
| P2 | Exchange allocates + persists + RETURNS run turns | `test/turn-run-dispatch.test.ts`, `test/conversation-exchange.test.ts` |
| P3 | `turnsToBubbles` run-bubble projection + live re-attach; `liveWebSearchConfigured` pre-flight; tool-description honesty | `conversationTransport.test.ts`, `kicktodo-challenge-author-tools.test.ts` |
| P4 | Verified gallery discoverability; `hostOwned` rejected | chain-gallery assertion |

## Operator note

`app.openwop.dev` has **no** web-search provider configured, which is why the
Factory was DOA. Set the `web-search` secret in the Secrets Vault (host-global) or
`OPENWOP_WEBSEARCH_API_KEY` on the Cloud Run service. Until then the Factory now
refuses honestly and up front instead of starting runs that cannot finish.
