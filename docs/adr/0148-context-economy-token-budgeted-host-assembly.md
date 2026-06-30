# ADR 0148 — Context economy: token-budgeted host-internal assembly (Tier A)

Status: implemented (Phases 1–6, 2026-06-26 — all levers gated, default off)

Owner: openwop-app backend (host context assembly: agent loop + provider dispatch)

Composes: RFC 0061 (`transcriptWindow` advertisement, already Accepted), RFC 0062
(scheduled memory distillation), ADR 0073/0058 (chat + agent-driven surfaces).
Touches `host/agentLoop.ts`, `providers/dispatch.ts`,
`providers/dispatchAnthropicTools.ts`, `aiProviders/aiProvidersHost.ts`,
`host/agentKnowledgeComposition.ts`, `routes/discovery.ts`, `index.ts`.

RFC verdict: **none.** Every lever in this ADR changes only **host-internal
context assembly** — what bytes the host feeds its own LLM provider each
iteration. None of it changes the OpenWOP wire, an event shape, a capability
contract, or a normative `MUST`. The one capability *advertisement* this ADR
turns on (`transcriptWindow`) rides the **already-Accepted RFC 0061**, so it is
honest host work, not a new wire claim. (The wire-facing followers — a compact
tool-projection endpoint, a declarable cross-host `cachePrefixId`, JSON-Patch
delta envelopes — are **out of scope here** and tracked separately as Tier B;
each needs its own RFC in `../openwop` before any host advertises it.)

## Context

A third-party token-efficiency review ("Red Team & Patch Set", 2026-06-15)
diagnosed OpenWOP correctly: the protocol governs **the wire** well
(content-free events, reference-by-id, `updates` delta streams as default,
ETag/304 on capability + prompt docs) but **deliberately leaves host-internal
context assembly ungoverned**. The token burn lives there, not on the wire. The
load-bearing citation checks out verbatim:

> `spec/v1/multi-agent-execution.md:238` — `transcriptWindow` … *"Absent ⇒
> unbounded on the wire."* (RFC 0061, execution-model version ≥ 5)

A conformant host MAY re-send the full transcript, the full tool surface, full
memory, and a freshly-composed prompt **every iteration**. Cumulative cost then
grows ≈ `O(turns²)`. This is spec-permitted, and **this reference app currently
takes the expensive path on every lever**:

| Lever | App today | Evidence |
| --- | --- | --- |
| Transcript bound | **none** — full history sent each turn; `transcriptWindow` not advertised | `agentLoop.ts` (`runTurn` per iteration), `routes/discovery.ts:1062` advertises `statefulResume` but no `transcriptWindow` |
| Provider prompt caching | **none** — plain JSON body, no `cache_control` | `providers/dispatchAnthropicTools.ts` (no `cache_control`/`ephemeral` anywhere in `providers/`) |
| Tool-surface size | full `inputSchema` per tool, name-only allowlist filter | `aiProviders/aiProvidersHost.ts:627`, `host/agentDispatch.ts` |
| Memory injection | top-k=6 retrieval, **no distillation/budget** | `host/agentKnowledgeComposition.ts` (`DEFAULT_KNOWLEDGE_TOP_K = 6`) |
| Transport | ETag/304 on prompts + tarballs; **no gzip on SSE/JSON** | `routes/prompts.ts`, `index.ts` (no `compression()`) |

The numbers in the review (≈63 tok/event, ≈168 tok/tool, 50K for 20 tools, etc.)
are the author's own `chars/4` directional estimates, not spec facts — we treat
them as **directional, not benchmarks**, and will measure our own deltas. But the
*structural* diagnosis is verified and actionable, and these are wins this host
has simply not taken.

### Why a single feature, not five scattered patches

The levers share one concern — **the host's per-iteration context budget** — and
one failure mode (lossy compaction degrading answer quality). Bundling them under
one toggle + one budget config + one set of quality guardrails (never compact the
active task; keep last-k turns verbatim; pair summarization with the existing
RFC 0090 verifier) keeps the trade-off governable in one place rather than
drifting across the dispatch layer.

## Decision

Add a host feature-package **`context-economy`** (toggle key `context-economy`,
default **off** until measured, then on) that owns one **context-budget policy**
applied during host-internal assembly. Six host-internal levers, all
conformance-safe today:

### A1 — Token-budgeted transcript
Replace "unbounded" with a hard per-iteration transcript budget: **keep the last
`k` turns verbatim** (within a text-char budget); older turns are elided with a
deterministic truncation marker so the model knows context was dropped. Target:
cumulative `O(turns²)` → ≈ `O(turns)`.

> **Correction note (2026-06-26, implementation — Phase 3).** The original draft
> said to bound `agentLoop.ts` and **advertise `multiAgentExecution.transcriptWindow`**
> (RFC 0061). Implementation found this would be a **dishonest wire claim**: the
> app's multi-agent orchestrator loop (`agentLoop.ts runAgentLoopDriven`) runs **no
> real model turns** in production (only a mock supervisor), so there is no
> orchestrator transcript to bound — and `transcriptWindow` describes precisely
> that orchestrator window. Advertising it would violate "advertise only
> behaviorally honored" (`OPENWOP_REQUIRE_BEHAVIOR` would fail it). The ACTUAL
> unbounded transcript re-send is the **chat** path (`conversationExchange.ts`
> folds full history every exchange; the tool-loop history derives from it — one
> seam bounds both). So Phase 3 bounds the **chat history fold** as a
> host-internal, presentation-only transform (the event log stays full-fidelity →
> replay/fork-safe) and **deliberately does NOT advertise `transcriptWindow`**;
> `discovery.ts` is untouched. The rolling-summary of older turns (an LLM call) is
> **deferred** — it carries replay + cost risk and must pair with the RFC 0090
> verifier per this ADR's quality guardrails; Phase 3 ships deterministic last-`k`
> windowing only.

### A2 — Provider context caching (highest leverage, zero quality risk)
Front-load a **byte-identical, stable prefix** (system prompt + tool surface +
pinned memory) and mark it `cache_control: { type: "ephemeral" }` on the
Anthropic dispatch (`dispatchAnthropicTools.ts`), with the equivalent prefix-cache
hint for other providers that support it. This neutralizes most of the A1
transcript cost **without any summarization** — it is the one lever with no
context-loss trade-off, so **it ships first**. Requires the prefix to be
assembled deterministically and ordered stable→volatile (volatile turns last).

### A3 — Tool-surface diet
Sub-allowlist tools **per task/agent** (the allowlist already filters by name;
extend it to scope by the active agent's declared tool needs) and emit a
**compact descriptor** (name + one-line description + minimal schema) for the
model-facing catalog, reserving the full `inputSchema` for validation, not for
the prompt. Host-internal only — we do **not** add a `?view=compact` endpoint
here (that is Tier B / RFC).

### A4 — Memory injection budget
Extend the existing top-k (`agentKnowledgeComposition.ts`) with a **token budget
and distillation**: rank by relevance (already done), then summarize-to-budget
rather than dump the top-k verbatim. Reuses RFC 0062 distillation, no new wire.

### A5 — A2UI deltas
Where the host emits agent-authored UI, prefer the `emitCard`/`updateCard` by-id
path (RFC 0102) over re-emitting the full component tree.

> **Audit outcome (2026-06-26, implementation — Phase 6): NO CHANGE — already lean.**
> The Open Question #1 audit found the app's A2UI emission is already delta/read-on-demand,
> so there is no full-tree re-emission to optimize:
> - `host/chatSurface.ts:110` `emitCard` stores the payload **once** in the
>   in-process card store and appends a single `workflow_run` bubble; `:122`
>   `updateCard` patches the card **in-process** (`merge`/`replace`) and emits
>   **nothing** to the stream — already a by-id delta.
> - Interactive artifacts (`host/runArtifactStore.ts`, `artifactProjection.ts`)
>   are written once at node completion and fetched **on demand via GET** — never
>   re-folded into the model's per-turn context (`turnsToMessages` reads only
>   `t.content`, not the card/artifact stores).
> - No "values-class" stream re-sends a full snapshot per update (deck F5): the
>   default is the `updates` delta stream; `state.snapshot` is emitted only on the
>   `values` tier, which this app does not drive per turn.
>
> A finer JSON-Pointer/JSON-Patch surface-write delta would be a **wire-level**
> change (RFC 0102 surface), i.e. Tier B — out of scope for this host-internal ADR.
> Phase 6 therefore ships no code; A5 is recorded as already-satisfied.

### A6/A7 — Transport economy
Gzip JSON responses; leave SSE and the wire event-shape alone.

> **Correction note (2026-06-26, implementation — Phase 5).** The original draft
> said "gzip the JSON **+ SSE** responses and strip optional `meta` from
> `ai.message.chunk` frames." Implementation narrowed both on honesty/architecture
> grounds:
> - **SSE gzip — REJECTED.** `host/sseChannel.ts` deliberately sets
>   `Cache-Control: no-transform` + `X-Accel-Buffering: no` and disables proxy
>   buffering so frames flush live; gzipping the stream re-introduces exactly that
>   buffering. SSE stays uncompressed.
> - **A7 "strip `ai.message.chunk` meta" — DEFERRED to Tier B.** The SSE-serialized
>   run event (`routes/streams.ts` `data: ${JSON.stringify(ev)}`) **is** the
>   governed wire shape SDK clients parse; stripping envelope fields is a
>   wire-shape divergence needing an RFC (the deck's own Tier-B "compact
>   transport"). The chunk *payload* is already minimal (`{chunk,isLast}`).
> - **Delivered (A6):** a stdlib-`zlib` middleware (`middleware/jsonGzip.ts`) that
>   gzips **`res.json` only** — structurally excluding SSE (`res.write`), media
>   (`res.send`/`sendFile`), and the ETag/304 path. No new dependency (the repo is
>   zero-dep). Justified by the white-label self-host deployers (Fly/Render/ECS/k8s
>   per ARCHITECTURE.md) who have **no edge CDN**; in the Firebase prod path it's a
>   harmless belt-and-suspenders. Gated on `OPENWOP_CONTEXT_ECONOMY[_TRANSPORT]`,
>   off by default.

## Quality guardrails (non-negotiable)

Compaction is the only risk surface. Therefore, by construction:
1. **Never compact the active task / current turn** — last `k` turns stay verbatim.
2. **Pair summarization with the RFC 0090 verifier** where gating is on — a
   `fail` verdict after compaction routes back to an actor turn (existing seam).
3. **Budgets are configurable and observable** — emit the per-iteration budget
   spend (verbatim vs summarized vs cached-read token split) to the existing
   usage emitter so regressions are visible, not silent.
4. **Off by default until measured.** Land instrumentation first; flip the
   toggle on per-lever once the answer-quality delta is shown ≈ neutral.

## Phased plan

| Phase | Lever | Delivered | Env flag | Status |
| --- | --- | --- | --- | --- |
| 1 | A2 provider caching + usage instrumentation | `host/contextEconomy.ts`, `providers/promptCaching.ts`, 3 Anthropic body sites, `cacheHit` + OTel span split | `…_PROVIDER_CACHE` | ✅ implemented |
| 2 | A3 tool-surface diet | `providers/toolSchemaCompaction.ts`, both model-facing funnels | `…_TOOL_DIET` | ✅ implemented |
| 3 | A1 transcript budget | `host/transcriptBudget.ts`, `conversationExchange.ts` chat fold; **advert withheld** (honesty) | `…_TRANSCRIPT` | ✅ implemented (no advert) |
| 4 | A4 memory budget | `host/memoryBudget.ts`, `agentKnowledgeComposition.ts` char cap | `…_MEMORY` | ✅ implemented |
| 5 | A6 transport (gzip JSON) | `middleware/jsonGzip.ts`; **SSE gzip rejected; A7 → Tier B** | `…_TRANSPORT` | ✅ implemented (A6 only) |
| 6 | A5 A2UI deltas | **no code — already lean** (`emitCard`/`updateCard` + read-on-demand) | — | ✅ audited, no-op |

All flags default off (inherit the `OPENWOP_CONTEXT_ECONOMY` master, default off). Each
lever is independently revertible via its flag. The `context-economy` BackendFeature
toggle is admin-visibility only (does not gate dispatch).

Each phase was architect-reviewed before implementation and code-/ux-reviewed after,
with fixes applied; 44 new unit tests; backend `tsc` + full vitest green at each step.

## Alternatives weighed

- **Do nothing / rely on provider caching alone.** A2 is the biggest single win
  and risk-free, but it only addresses *cost*, not *context-window occupancy*;
  long runs still hit the window ceiling without A1. Rejected as incomplete.
- **Make per-iteration assembly spec-normative (the review's "flagship RFC").**
  Tempting, but it contradicts OpenWOP's design line — the spec governs the wire
  and leaves host internals to the host. A blanket `MUST` on context assembly is
  a philosophy shift, not an additive RFC. **Deferred to Tier B as an *opt-in,
  capability-advertised* profile** (honest advertisement, soft-skip when absent),
  not a mandate — and out of scope for this host-only ADR.
- **One big-bang refactor of the dispatch layer.** Rejected; the per-lever toggle
  + phased plan keeps each trade-off (esp. compaction) independently governable
  and revertible.

## Open questions

1. ~~**A5 emission behavior**~~ — **RESOLVED (Phase 6):** audited already-lean
   (`emitCard`/`updateCard` by-id + read-on-demand artifacts; no full-tree
   re-emit). A5 ships no code. See the A5 section.
2. **Default `k` and budget ceilings** — pick from measured runs (15-turn agent,
   20-tool surface is the review's reference shape), not a priori.
3. **Cross-provider cache hints** — A2 maps cleanly to Anthropic ephemeral cache;
   confirm the equivalent for the other managed/BYOK providers before claiming the
   lever universally (honest per-provider gating otherwise).
4. **Tier B hand-off** — once A2/A3 are proven here, the compact tool projection
   (`?view=compact`) and declarable `cachePrefixId` become candidate RFCs in
   `../openwop`. Authored separately; this ADR does not pre-commit the wire.

## Status log

- 2026-06-26 — Proposed. Diagnosis verified against `spec/v1/multi-agent-execution.md:238`,
  `stream-modes.md`, `tool-catalog.md`, and the app dispatch/loop seams.
- 2026-06-26 — **Implemented (Phases 1–6).** All Tier-A levers landed gated +
  default-off. Three honesty corrections recorded inline (see the lever sections):
  Phase 3 withholds the `transcriptWindow` advert (orchestrator runs no real model
  turns); Phase 5 rejects SSE gzip (live-flush architecture) and defers A7 envelope
  compaction to a Tier-B RFC (the SSE-serialized run event is the governed wire);
  Phase 6 found A5 already-lean (no code). Tier-B follow-ons (compact tool
  projection `?view=compact`, declarable `cachePrefixId`, JSON-Patch surface deltas)
  remain candidate RFCs in `../openwop`, authored separately.
