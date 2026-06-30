# ADR 0089 — Chat-driven agents must run their tool loop

- **Status:** Accepted — Phases 0-4 **implemented** (Phase 4 / Option B nested agentic run landed 2026-06-22; see § Implementation ledger). Refined per `/architect` review (2026-06-21).
- **Date:** 2026-06-21
- **Scope:** `openwop-app` backend — the conversation primitive
  (`host/conversationExchange.ts`, the `openwop-app.conversation` run) and the
  existing agent tool-loop runtime (`host/agentDispatch.ts`). Frontend chat
  (`chat/hooks/useChatSession.ts`) for the streaming surface.
- **Decision type:** Architecture (agent-runtime ↔ chat integration). **Replay
  impact is minimal** — the conversation's recorded-turn model already makes tool
  execution replay/fork-safe (§Q4); per-tool events are observability, not
  determinism.
- **RFC gate:** **NO new RFC.** `openwop-app.conversation` is a host workflow
  under the app's own namespace, and the only tool event surfaced
  (`agent.toolReturned`) is already spec'd (RFC 0064). The constraint: Phase 2
  must introduce no *new* wire event type — if a "tool started" type the SDK must
  type is added, THAT is a `../openwop` RFC, not host work (§Q5).

---

## 0. Why this exists

A user @mentions the **Deep Researcher** agent in chat
(`core.openwop.agents.deep-research.default`) and asks a question. The agent
replies with a plan — "Planning the investigation… Sub-questions… **Retrieving
evidence**" — and then **stops**. Every time. The chat dead-ends at the moment
the agent should start working.

**Ground truth (prod event log, run `29a416a1`, 2026-06-21):** the run is
`openwop-app.conversation`, status `waiting-input`. Its final streamed chunk is
literally `"**Retrieving evidence**"` with `isLast:false` — **no chunk ever
marked the turn complete**. The turn was recorded
(`conversation.exchanged` → the deep-research agent) and the run **suspended**.
Not an error, not a crash, not a streaming failure (the prior cross-origin SSE
bugs were fixed in ADR 0088 / #550 / #552 — content now streams reliably). The
web-research host surface was **never invoked**; no tool ever executed.

The model narrates what it *would* do, reaches the point of calling its research
tool, and the turn just ends — because **the conversation never offered it any
tools to call**.

## 1. Root cause (code-level)

The conversation reply path passes **no tools** to the model:

```
host/conversationExchange.ts:119-155  dispatchReply()
  → dispatchChat({ provider, model, apiKey, messages, maxTokens, onDelta })
    // DispatchRequest (providers/dispatch.ts:33-66) has NO `tools` field.
```

The agent is resolved and its system prompt composed
(`conversationExchange.ts:232-242`), but its **`toolAllowlist` is never read**.
The model receives only the persona system prompt + prior turns. So an
agent whose entire value is its tool loop (research, RAG, fetch) can only
*describe* the loop, never run it. The `dispatchReply` is a single bare
completion — no observe→act iteration.

This is the gap behind the CLAUDE.md "chat-drivability = agent + **nodes**"
intent: today chat drives the agent's **voice** (persona prompt) but not its
**nodes** (tools).

## 2. What already exists (reuse, do not fork)

- **A complete tool-loop runtime:** `host/agentDispatch.ts` —
  `runAgentDispatchLive` (590-694) compiles the agent's allowlisted tools and,
  when `callAIWithTools` + `executeTool` + `resolveTool` are wired, runs
  `runToolLoop` (718-865): a bounded observe→act loop (`maxToolRounds`, default
  5), **allowlist-validated per call** (RFC 0036 / ADR 0036), executing tools
  via the injected `executeTool` and emitting RFC 0064 `agent.toolReturned`
  events. It is wired to `POST /v1/host/openwop-app/agents/{agentId}/dispatch`
  (`live:true`) but **not** to the conversation path.
- **★ The gates that make it SAFE live one layer UP, in the route**
  (`routes/agents.ts`), *around* the dispatch: the RFC 0092
  capability-requirement check (`agents.ts:71` — an agent requiring an
  unadvertised capability MUST degrade/refuse; capability honesty), the
  `assertModalitiesAdvertised` modality gate (`agents.ts:347`), and the
  degraded-capability projection (`agents.ts:165-177`). Provider *policy* travels
  with the injected deps (`policyResolver: deps.hostSuite.providerPolicyResolver`,
  `agents.ts:254`), but the **capability + modality gates are route-level**.
  Calling `runToolLoop` — or even `runAgentDispatchLive` — directly from the
  conversation would **bypass them**: a second, less-gated agentic path (parallel
  system + capability-honesty bypass; review finding #1). The integration MUST
  therefore enter through a **single gated entry**, not the inner loop (§4).
- **The chat already embeds nested runs:** `useChatSession.runWorkflowMention`
  (1066-1264) dispatches a workflow, creates a `workflow_run` chat message, and
  streams its SSE events (`workflowRunSubscription`) into an inline bubble.
- **The agent tool provider:** `createAgentToolProvider`
  (`host/agentToolProvider.ts:118-134`) resolves the host's built-in tools for
  an agent.

The fix is an **integration**, not new machinery.

## 3. Options

### Option A — Run the tool loop *inside* the conversation turn
When the resolved agent has a non-empty (policy-resolved) tool surface,
`dispatchReply` invokes the **shared gated entry** `dispatchAgentLive` (§4) —
which applies the capability/modality/policy gates and *then* runs the existing
`runToolLoop` (call model **with tools** → execute tool calls → feed results back
→ bounded depth → final answer) — instead of a bare `dispatchChat`. The agent
replies inline, exactly as today, but its reply is now the *result* of real tool
execution. One run (`openwop-app.conversation`), one bubble.

### Option B — Dispatch a separate agentic *run* on @mention
@mentioning an agent dispatches a real agentic run (its own loop), embedded as a
`workflow_run` message via the existing mention infrastructure; the chat streams
its progress + final report inline as a distinct run.

| Dimension | A — loop in the turn | B — nested run |
|---|---|---|
| Reuses the gated agentic entry | ✅ via shared `dispatchAgentLive` (§4) | ✅ (but needs a run wrapper — agent-dispatch uses a synthetic `agent-dispatch:<uuid>` runId with **no event stream**, so B needs a real run + SSE, not turnkey) |
| UX | inline agent reply (unchanged) | a first-class run bubble with progress |
| Streaming intermediate steps | tool-call/result deltas added to the conversation stream (observability; Phase 2) | already modeled by `workflow_run` events |
| Replay/fork | **already safe** — turns are recorded as `conversation.exchanged` and replay reads them; the loop runs once, live (§Q4). Tool events are for *observability*, not determinism | the nested run replays on its own (existing) |
| >60s work vs the chat budget | must run on the async-settle-over-SSE path (ADR 0067), NOT block the HTTP turn (§Q3) | naturally async — the run outlives the turn |
| Blast radius | contained to `conversationExchange` + the shared gated entry | new dispatch routing + a wrapper run/workflow |
| Fits heavy long-horizon agents | weaker (one turn) | stronger |

## 4. Decision (recommended)

**Adopt Option A as the default**, and keep Option B as a **follow-on for
long-horizon agents**. Rationale:

- A is the smaller, lower-risk change and preserves the established chat UX
  (inline reply, thinking indicator, ADR 0067 async-settle). It directly closes
  the root cause: run the agent's tool loop when the agent has tools.
- B is the *more correct* model for genuinely long-horizon research (a run that
  outlives a chat turn, with first-class progress), but it needs a real
  agentic-run wrapper (the agent-dispatch route streams nothing today) and a
  different UX — more surface than the dead-end warrants right now.
- The two are not exclusive: ship A so the agent *works*, then add B as an
  opt-in "run as a full investigation" affordance for `depth: deep` agents.

**The integration point (review finding #1, CRITICAL).** Do NOT wire the
conversation to `runToolLoop` (or `runAgentDispatchLive`) directly — that skips
the route-level capability + modality gates (§2) and stands up a second,
less-gated agentic path. Instead **factor a single gated entry**
`dispatchAgentLive(agent, messages, deps)` that:
1. applies the RFC 0092 capability-requirement check + `assertModalitiesAdvertised`
   + degraded-capability projection (today inline in `routes/agents.ts`),
2. injects the SAME `hostSuite` tool deps (`resolveTool`/`executeTool`/
   `callAIWithTools` — never a second `executeTool`; review finding #5), then
3. runs `runAgentDispatchLive`/`runToolLoop`.

**Both** the agent-dispatch route and the conversation `dispatchReply` call
`dispatchAgentLive`. The conversation becomes a *caller* of the one owner of
agentic execution, with its gates intact — not a parallel path.

**Trigger (review finding #6).** Run the loop when the agent's **policy-resolved**
tool surface is non-empty (not merely a non-empty static `toolAllowlist`): an
agent may be tool-bearing in its manifest yet policy-restricted in a given tenant
(ADR 0036). Pure-persona agents (no resolved tools) keep the single completion.

## 5. Phased plan

| Phase | Work | Verify |
|---|---|---|
| 0 (gate) | **Resolve §Q3 first**: confirm whether `handleConversationResolve` can run the loop on the async-settle-over-SSE path or blocks the HTTP turn. If it blocks, move loop execution to the async path before Phase 1. | a multi-round loop streams without exceeding the turn/CDN budget |
| 1 | Factor the shared gated entry `dispatchAgentLive` (capability + modality + degraded gates from `routes/agents.ts` + the hostSuite tool deps); call it from BOTH the route and `dispatchReply` when the agent's policy-resolved tool surface is non-empty. | a chat run with the deep-research agent runs `runToolLoop`; web-research surface IS invoked; the reply contains real findings; **a route test asserts an agent requiring an unadvertised capability degrades in CHAT, not just on the dispatch route** |
| 2 | Stream tool-call / tool-result deltas onto the conversation run for **observability** (a "searching…/fetched N sources" indicator). `agent.toolReturned` (RFC 0064) already lands on the run once the loop runs under the conversation runId; add the FE progress rendering. | FE shows tool progress; replay reproduces the recorded turn (already guaranteed — §Q4) |
| 3 | Confirm per-call allowlist + `maxToolRounds` + a per-turn tool budget hold in the conversation context (they ride inside `runToolLoop`/agentDispatch §A14); confirm BYOK/managed credential resolution for tools flows through the shared deps. | a non-allowlisted tool call is refused; the loop terminates within budget |
| 4 (follow-on) | Option B: opt-in "run as full investigation" → nested agentic `workflow_run` for long-horizon agents. | a `depth: deep` mention dispatches a streamed run bubble |

## 6. Open questions / decisions

| # | Question | Lean |
|---|---|---|
| Q1 | **Web-search provider key.** `ai.research.web` returns a *demo placeholder* unless `OPENWOP_WEBSEARCH_API_KEY` (or a BYOK `web-search` secret) is set — `webResearchSurface.ts:106-140`. Prod has **none**. Even with the loop running, research is useless without it. | Configure a search provider in prod as part of Phase 1 (cost + provider decision for the maintainer). Track separately. |
| Q2 | Default-on for all tool-bearing agents, or opt-in per agent? | Default-on when `toolAllowlist` is non-empty; it's the agent's declared contract. |
| Q3 | **(SEQUENCING GATE — review finding #3)** `handleConversationResolve` dispatches the agent *synchronously* within the resolve call; a 5-round loop (model + tool latency each) can blow the turn / ~60s CDN ceiling. | Resolve in **Phase 0**: the loop MUST run on the async-settle-over-SSE path (ADR 0067), not block the HTTP turn. If today's exchange blocks, that move is a prerequisite, not an afterthought. Bound `maxToolRounds`. |
| Q4 | **Replay/fork — already safe (review finding #2; ADR self-correction).** The earlier draft claimed tool events are *required* for replay determinism. They are NOT: `conversationExchange` records each turn as a `conversation.exchanged` event, reconstructs history from the log (`:5-10`), and a dedup index short-circuits re-dispatch (`:45`). The loop runs **once, live**; its output is the recorded turn; replay/`:fork` read the recorded turn and **never re-execute the tools**. So determinism holds without persisting per-tool events. | Tool events are a **Phase 2 observability** concern, not a correctness blocker. (Guard the one edge: never re-enter `dispatchAgentLive` for an already-exchanged turn — the existing dedup index covers this.) |
| Q5 | Does streaming tool events on the conversation run introduce a NEW wire event type the SDK must type? | **Decided: no new RFC.** `agent.toolReturned` is already spec'd (RFC 0064) and flows over the run-event stream `openwop-app.conversation` already uses. PROVIDED Phase 2 introduces no *new* event type. If a "tool started" type the SDK must type is added, THAT is a `../openwop` RFC, named before/with the host work. |
| Q6 | The deep-research prompt prose referenced stale tool ids (fixed cosmetically in #559). Does the agent need its prompt re-tuned for actual tool-calling vs. narration once tools are live? | Re-evaluate the system prompt in Phase 1 against real tool-call behavior. |

## 7. Consequences

- Chat-driven agents become genuinely *agentic*, closing the "narrates but never
  acts" dead-end — the core product promise of @mentioning a working agent.
- The conversation run grows a tool-execution surface; its event log gains
  tool-call/result records (replay-bearing).
- A new operational dependency surfaces (a real search provider key) for
  research agents to be useful.
- No new chat system, no second agent runtime — the existing `runToolLoop` is
  reused, per the no-parallel-architecture rule.

## 8. Implementation ledger

Implemented on `feat/adr-0089-chat-agent-tool-loop` (each phase: `/architect`
review before, `/code-review` + `/ux-review` after, fixes applied).

| Phase | Status | What landed | Tests |
|---|---|---|---|
| 0 — async gate | ✅ resolved | The async-settle-over-SSE path already exists (`OPENWOP_CONVERSATION_EXCHANGE_ASYNC`, ADR 0079 §3); Phase 1 force-uses it for tool agents so a multi-round loop never blocks the HTTP turn. No standalone code. | n/a |
| 1 — tool loop in conversation | ✅ implemented | Extracted the shared `runChatToolLoop` (one owner of §A14 + RFC 0064 events); `runToolLoop` delegates. New `host/conversationToolLoop` runs it for a tool-bearing @mentioned agent, reusing the SAME policy-enforcing adapter + tool executor; falls back to single completion otherwise. | `conversation-agent-tool-loop.test.ts` (loop exec / §A14 / invalid-args / provider-error / onEvent / fallbacks); 323 agent+conversation tests green |
| 2 — live tool progress | ✅ implemented | `toolActivityFromEvent` (pure, replay-guarded) → the existing `agentEvents.toolCalls` cards (`ToolCallCard`, Running→done/error). No new component/stream. | `conversationTransport.test.ts` (mapping + replay guard); FE build gate + 158 chat tests green |
| 3 — allowlist / budget / BYOK | ✅ implemented | Confirmed §A14 + round budget + BYOK ride inside the shared loop; added a `maxRounds` budget test + the `OPENWOP_CONVERSATION_MAX_TOOL_ROUNDS` ops knob. | budget-bound test |
| 4 — Option B (nested agentic run) | ✅ **implemented** (2026-06-22) | Backend MVP — a tool-bearing agent that declares `investigationDepth:'deep'` (default-off) dispatches its loop as a SEPARATE persisted run when @mentioned, embedded as a `workflow_run` bubble; non-opted agents keep the inline path unchanged. New `local.openwop-app.agent-runner` node (enters the GATED `runAgentDispatchLive` — no second executor) + the synthetic `openwop-app.agent-mention` workflow + a `conversationExchange` depth branch + route wiring. Per architect→code-review cadence: review caught a BYOK-credential-not-threaded bug (nested run needs `configurable.credentialRefs`) — fixed via `agentMentionConfigurable`. **Ops note:** a deep @mention spawns a second run (extra SSE/read fan-out) — watch `OPENWOP_RATELIMIT_IP_REQS_PER_MIN`. FE "Run as investigation" toggle deferred (agent-declared opt-in used). | `conversation-deep-investigation.test.ts` (8: opt-in truth table, deep→nested vs non-opted→inline-unchanged, runner→gated-owner + events + fail-closed, BYOK-ref registration); full suite 2640 green |

**Phase 4 deferral (architect decision, 2026-06-21).** Option B (a first-class
nested agentic *run* embedded as a `workflow_run` bubble) is a UX enhancement,
not a correctness fix — Phases 0-3 close the dead-end. It is deferred at a real
gate, NOT trimmed for size:
- No reusable primitive exists (no agent-runner node, no agentic workflow); it
  is net-new (a node that runs the loop as a persisted run + a workflow + an FE
  "deep investigation" affordance).
- It is speculative without a concrete trigger — no installed agent currently
  overflows the inline loop (force-async + tunable `maxRounds` handle multi-round
  work); building for a hypothetical inverts the Scope Rule.
- The gate to build it: a concrete long-horizon agent that needs run-grade
  progress **and** a product decision on the "run as full investigation" UX.
- The design is already recorded in §3-4; the FE seam (`runWorkflowMention` +
  the `workflow_run` channel) exists and is ready when the gate is reached.

**Phase 4 implementation plan (architect review, 2026-06-22).** A surface map
confirmed the minimal reuse-maximizing path is **~250 LOC, zero new runtime
abstractions** — it wraps the Phase 1–3 loop in a persisted run and reuses the
existing `workflow_run` chat-bubble seam verbatim. Net-new pieces + plug points:

| Piece | Status | Plug point |
|---|---|---|
| Inline tool loop (Phases 1–3) | ✅ reuse as-is | `host/conversationToolLoop.ts:112` → `runChatToolLoop` (`host/agentDispatch.ts:796`) |
| Tool-eligibility gate | ✅ extend | `host/conversationExchange.ts:328-330` — add a `depth === 'deep'` branch |
| FE mention→`workflow_run` dispatch + SSE + bubble | ✅ reuse as-is (generic, run-agnostic) | `chat/useChatSession.ts:1216 (runWorkflowMention)` + `workflowRunSubscription.ts` + `WorkflowRunBubble.tsx` |
| **agent-runner node** | ❌ net-new (~100 LOC) | new `host/agentRunnerNode.ts` — calls the GATED `runAgentDispatchLive` (inherits capability/modality/policy gates + the shared tool executor; no second path), emits RFC 0064 `agent.*` events on the run |
| **synthetic agent-mention workflow factory** | ❌ net-new (~80 LOC) | new `host/agentMentionWorkflows.ts` — wraps the agent-runner node as a one-node workflow dispatched via the standard `/v1/runs` path |
| dispatch routing on `depth:deep` | ❌ net-new (~25 LOC) | `conversationExchange` (BE branch) + `useChatSession` (FE: route deep mentions to `runWorkflowMention`) |
| opt-in trigger | ❌ net-new (~40 LOC, MVP-optional) | an agent-declared `investigationDepth:'deep'` field (default for research agents) + an optional FE "Run as investigation" toggle |

No new RFC (agent.* = RFC 0064; synthetic workflows are host-local), no new DB
table, no new event type, no parallel async path. Replay is inherited (the nested
run replays itself; the parent turn records the mention). **Implementation is a
focused follow-on PR** sized for a dedicated pass at the per-phase quality bar
(`/architect` ✅ done here → implement → `/code-review` + `/ux-review` → fixes),
since it stands up agentic-runtime wiring (dispatch/replay/capability-gate paths)
that must not be rushed.

**Known operational follow-ups (not code):**
- The managed tier resolves to `minimax`, whose tool-calling is a whole-loop
  dispatcher incompatible with the single-round `toolsRoundDispatcher` — so
  managed/"Try it free" users fall back to a single completion. Tools engage for
  BYOK with anthropic/openai/google. Unblocking managed = wiring a single-round
  minimax tools path (or pointing the managed tier at a tool-calling provider).
- `ai.research.web` returns a demo placeholder without `OPENWOP_WEBSEARCH_API_KEY`
  (or a BYOK `web-search` secret) — configure a search provider for real
  research results (§Q1).


## § Follow-on — Escalation Choreographer (innovation strategy, 2026-06-24)

The innovation strategy proposes **predictive** intervention: detect drift signals
*during* a run (tool-failure loops, low confidence, policy conflict, cost overrun,
deadline/frustration risk) and choreograph the right move (clarify, pause, switch model,
reduce scope, human review, read-only mode, split task, summarize-and-confirm). This is a
**phase on THIS ADR's loop** (decided during the 2026-06-24 innovation-strategy
decomposition NOT to stand up a parallel intervention system): the tool loop already has
`maxRounds` + records `agent.*` events + composes HITL (ADR 0075) and tool-output
compaction (cost). Add a per-round signal detector + an intervention-policy resolver that
emits the existing interrupt/approval or a model-switch (ADR 0124) — reactive signals
become *predictive* interventions. Careful defaults (learn from dismissed interventions)
to avoid annoyance. Host-extension, no new RFC.
