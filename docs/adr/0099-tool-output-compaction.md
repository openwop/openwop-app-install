# ADR 0099 - Tool-output compaction (deterministic, in-process, replay-safe)

**Status:** Accepted — **implemented** (all four phases, 2026-06-20; see the implementation-status table)
**Date:** 2026-06-20
**Surface:** host-internal only — a pure compaction kernel applied at the **typed tool-result
boundary** (the host tool executor's `{content, isError}` return / the provider `tool_result`
construction — the one place a string is *known* to be tool output), with the compaction
decision resolved **once per run** and carried on `run.metadata` (the `trustBoundary` precedent),
plus an optional explicit workflow node. **No wire change, no new RFC** (see §RFC verdict).

> **Architecture-review corrections (2026-06-20, three `/architect` passes).** The seam choice
> moved twice as review falsified each prior framing — the reasoning trail is kept per the ADR
> discipline:
> - **Pass 1 (single line):** the first draft patched `agentDispatch.ts:823` and claimed chat
>   would "inherit it for free." Falsified — multiple tool-execution paths, and that request
>   carries none of the needed inputs.
> - **Pass 2 (AI-adapter boundary):** corrected to wrap `callAIWithTools` as the "single
>   convergence point." Falsified by the *review-all-work* pass: `AiCallMessage.role` is only
>   `user|assistant|system` (`executor/types.ts:32`) — at the adapter the tool result is an
>   **opaque `role:'user'` string**, indistinguishable from a genuine user turn without
>   fragile prefix-sniffing. Wrong granularity.
> - **Pass 3 (this revision — typed tool-result boundary):** research found tool output is
>   **already typed** one layer earlier — at the host tool executor's `{content, isError}`
>   (`agentToolProvider.ts:68,99,123`) and the provider `tool_result` block
>   (`dispatchAnthropicTools.ts:176`, `dispatchMiniMaxTools.ts:155`, `dispatchProviderTools.ts`).
>   That boundary is unambiguously tool output, covers chat + pack-nodes + manifest dispatch,
>   needs **no new `'tool'` message role**, and is the seam this ADR now specifies.
>
> The **decision** (build our own kernel; reject headroom), the **run-once/replay-verbatim**
> mechanism, and the **no-wire/no-RFC verdict** held across all three passes.
**Composes:** ADR 0001 (feature-package), ADR 0014 (workflow surface / `/.well-known`),
ADR 0031 (rich `agentProfile` config for the per-agent lossy opt-in), ADR 0015
(`tenant`-bucketed toggle), and the replay/fork invariant (`run.metadata.featureVariant`,
the ADR 0001 §3.4 + CRM `routes.ts:179-233` pattern).

## Why this exists

Verbose tool outputs are the single largest avoidable token cost in agent runs. When an
agent calls a tool (a CRM list, a BigQuery result, an MCP resource, an HTTP read), the raw
result is pushed verbatim into the message history and re-sent to the model on every
subsequent round of the tool loop — `host/agentDispatch.ts:823`:

```ts
messages.push({ role: 'user', content: `Result of ${call.name}: ${execOut.content}` });
```

A 14 KB pretty-printed JSON list (40 rows of mostly-empty metadata) costs ~3.5 K tokens —
billed to the operator's BYOK key — and is re-billed each round. Pretty-print whitespace and
structurally-empty fields (`""`, `null`, `[]`, `{}`) carry no signal the model uses.

### Why we are NOT installing a third-party compressor

This work began as an evaluation of [`chopratejas/headroom`](https://github.com/chopratejas/headroom),
a context-compression toolkit. We **rejected installing it**, on evidence:

- Its npm package (`headroom-ai`) is **not a compressor — it is a client to a stateful
  Python+Rust proxy daemon** (its own type docs: *"compresses via the proxy"*). Run
  standalone with no daemon it tries `net.connect` to `localhost:8787` and returns the
  payload **verbatim** (measured ratio 1.01 — *larger* than input). There is no inline mode.
- The real compression lives in a daemon with a **local CCR cache + license/`syncState`/
  `beacon` surface** — stateful, single-host, phone-home-shaped. That is hostile to our
  **stateless, autoscaling, multi-instance Cloud Run** backend (local cache neither persists
  nor shares across instances) and to **BYOK honesty** ("your key, your data").
- It is pre-1.0 (npm `0.22.4` trailing the Python `0.26.0`), ~5 months old, 339 open issues.
  Too much to bet a conformance host's replay/wire behavior on.

A validated ~60-line **pure, deterministic, zero-dependency** kernel reproduces headroom's
headline savings on the identical payload (**52 % lossless / 95 % lossy**) with none of the
daemon, cache, or telemetry. We build that and own the replay path.

## PRD-vs-architecture corrections

The triggering plan called this a **"node pack."** Two corrections, recorded per the ADR
discipline:

1. **The token win is in the agent tool loop, which is engine-core — not a graph node.** A
   node pack only helps workflows that *explicitly* place a compaction node; it cannot touch
   the verbose tool outputs inside an agent's `agentDispatch` loop (chat + workflow agents),
   which is exactly where the cost is. So the **primary** surface is a **core IoC transform
   seam** that a feature registers into (the `setNodePackResolver` / `registerFeatureSurface`
   / `getNotificationEmitter` inversion pattern), keeping the core→feature import boundary
   intact (ADR 0001). The explicit **workflow node is a secondary, optional surface** for
   compacting a large payload mid-graph.
2. **Lossy elision is unsafe as a global default.** Dropping middle rows of a list breaks
   agents that must reason over the full set. So the **global toggle enables only the
   lossless transform** (minify + drop structurally-empty); **lossy array elision is
   strictly per-agent opt-in** via `agentProfile.compaction` (ADR 0031), never global.
3. **The single owner is the *typed tool-result boundary*, not a message-array line (review
   correction, 3 passes).** Live model calls reach the provider through **two tool-loop
   architectures**: a **provider-driven loop** (`dispatchAnthropicTools.ts` /
   `dispatchMiniMaxTools.ts` / `dispatchProviderTools.ts`) that calls a host-supplied
   `onToolUse(...) → {content, isError}` and builds a structured `tool_result` block — used by
   the **chat responder node + pack nodes**; and a **host-driven loop** (`runAgentDispatchLive`,
   `agentDispatch.ts:756-825`) that executes via `executeTool(...) → {content, isError}` and
   flattens to `role:'user'` "Result of …:" (`:823`) — the `/agents/:id/dispatch` route only.
   **Both draw tool output from the same typed `{content, isError}` host boundary** before it is
   wrapped or flattened. That boundary — not the AI-adapter message array (where the result is an
   opaque `role:'user'` string; `AiCallMessage.role` is `user|assistant|system` only,
   `executor/types.ts:32`) — is the single owner. The kernel is applied at the handful of typed
   tool-result points (+ a `ctx.compactToolOutput` helper for packs that hand-roll loops), never
   as a per-loop copy and never by sniffing message prose.

## Boundaries & pre-existing-surface audit

- **No existing compaction.** `grep -rniE 'compact|toolOutputTransform|truncat'` over
  `host/`+`features/` finds only unrelated cold-read truncation (`reviewProjection.ts:307`,
  `webResearchSurface.ts:152`, `workforceService.ts:549`) — none on the tool-loop path. This
  is net-new; nothing to extend.
- **Tool output is content-free in recorded events.** `host/agentDispatch.ts:815-822` records
  `agent.toolReturned` with `status` + `durationMs` **and no `content` field**; the raw tool
  output is inserted into the transient `messages[]` only, persisted nowhere as an event.
  **Compacting the in-flight `messages[]` therefore changes no recorded event and no wire field.**
- **Two tool-loop architectures; one typed tool-result boundary (review finding, 3 passes).**
  Provider-driven (`dispatchAnthropicTools.ts:165-177` etc., via host `onToolUse → {content}`,
  used by chat + pack nodes) and host-driven (`runAgentDispatchLive`, via `executeTool → {content}`,
  flattened at `agentDispatch.ts:823`). The AI-adapter message array is the **wrong** seam — there
  the result is an opaque `role:'user'` string (`AiCallMessage.role` = `user|assistant|system`,
  `executor/types.ts:32`). The **typed** boundary is the host tool executor's `{content, isError}`
  (`agentToolProvider.ts:68,99,123`) + the provider `tool_result` construction; that is where the
  kernel goes (see §application seam).
- **`run.metadata` read-at-run-start is precedented; the write side is new (G1).** `trustBoundary`
  is *read* from `run.metadata` at run-start and held constant (`executor/types.ts:176-177`) —
  compaction reuses that **read** mechanism. But `trustBoundary` is *written* by the run's creator
  with no resolver, and the `crm` `featureVariant` stamp lives in CRM's own route; compaction owns
  no run-creation path (central `runDispatch.ts:54`/`runStarter.ts`), so it adds a new
  `registerRunStartContributor` seam to resolve-and-freeze the decision at creation.
  `NodeContext` carries `runId`/`tenantId` (`executor/types.ts:146,148`).
- **IoC registration precedent.** `nodeRegistry.setNodePackResolver` (`executor/nodeRegistry.ts`),
  `registerFeatureSurface` (`host/featureSurfaces.ts:35`), `getNotificationEmitter` — core
  holds a function pointer; features set it at boot. We add one more: `host/toolResultTransform.ts`
  (applied at the typed tool-result points), plus the G1 `host/runStartContext.ts` decision seam.
- **Toggle + variant-stamp precedent.** `features/crm/routes.ts:179-233` stamps
  `run.metadata.featureVariant = { feature, variant, bindings }` at run creation and reads it
  verbatim on `:fork`; `test/feature-replay-fork.test.ts` proves it survives toggle-off. We
  reuse this exactly.
- **agentProfile config precedent.** ADR 0031's rich `agentProfile` already carries per-agent
  config params + admin controls; `compaction` is one more typed field — no new store.

## Decision

**Add a core IoC transform seam in the agent tool loop; ship a feature-package that registers
a pure, deterministic compaction transform behind a `tenant`-bucketed toggle (default OFF);
gate lossy elision per-agent via `agentProfile`; stamp the decision into `run.metadata` for
replay/fork. No data ever leaves the process.**

### The kernel (pure, deterministic, structure-preserving)

`features/tool-output-compaction/compact.ts` — exported pure function, no I/O:

1. **Pass-through guard.** If `content` is not parseable JSON, return it untouched. (Prose,
   code, errors are never mangled.)
2. **Structure-preserving (default ON when the feature is enabled):**
   - Re-serialize JSON **minified** (strip pretty-print whitespace).
   - **Drop structurally-empty fields** — `""`, `null`, `[]`, `{}` (recursively). Every **row**
     and every non-empty value is preserved.
   - *Not byte-lossless:* a consumer that distinguishes "key present = null" from "key absent"
     would see a difference. This is lossless for **LLM comprehension** (the model ignores empty
     fields), which is the only consumer of a tool result in the loop — but the distinction is
     stated so Phase 1 doesn't over-claim. *(−52 % on a representative empty-field-heavy payload;
     real savings vary with how sparse the JSON is — not a baseline.)*
3. **Lossy elision (per-agent opt-in only):** collapse homogeneous arrays longer than
   `head + tail + 1` to `[…head, { "_elided": N }, …tail]`, preserving the **true count** so
   the model still knows the list size. *(−95 % on the same payload; illustrative, not a
   baseline.)* Tunable `head`/`tail` per agent.

Same input → byte-identical output (verified). No `Date.now()`/randomness/network/disk.

### The decision, resolved once per run (the `trustBoundary` precedent)

The compaction *decision* — `mode: 'off'|'lossless'|'lossy'` plus the lossy `head`/`tail` — is
**resolved once at run-start and held constant across the run**, exactly as the host already
does for `trustBoundary` (`executor/types.ts:176-177`: *"Read from `run.metadata.trustBoundary`
at run-start; constant across the run"*). This single move fixes three review findings at once:

- **async toggle resolution** (`resolveOne` is `async`, `featureToggles/service.ts:149`) — done
  once at run-start, not per-tool-call, so the application path stays a **pure sync kernel**;
- **missing seam inputs** — the decision rides `run.metadata`, which `NodeContext` already
  carries (`runId`/`tenantId`, `executor/types.ts:146,148`), so no per-call tenant lookup;
- **replay/fork** — see below.

**The write side needs a new core seam (G1 — feature-refinement filter).** The `trustBoundary`
precedent is the *read* side only: core reads it from `run.metadata` at run-start and freezes it
(`executor/types.ts:176-177`), but it is *written by whoever creates the run*, with no resolver.
And the `crm/routes.ts:179-233` `featureVariant` pattern stamps **in CRM's own run-creation
route** — tool-output-compaction owns **no run-creation path** (runs are created centrally in
`host/runDispatch.ts:54` and `host/runStarter.ts`, which merely merge caller-supplied
`metadata`). So the feature cannot reuse either as-is. It introduces a **new generic core seam**,
`host/runStartContext.ts` (`registerRunStartContributor(fn)`), invoked once where runs are
created (`runDispatch.ts`/`runStarter.ts`): each registered contributor resolves its decision
(here: the toggle for the run's `tenantId` + the dispatched agent's `agentProfile.compaction`)
and **freezes it into `run.metadata`** (merged, not overwritten):
`{ feature: 'tool-output-compaction', mode, head?, tail? }`. On `:fork`/replay `run.metadata` is
copied verbatim (ADR 0001 §3.4) and the decision is **read back, never re-resolved** — so a run
replays with the compaction it was born with regardless of later toggle flips. Covered by a
`feature-replay-fork`-style test. (The seam is generic — any future cross-cutting "resolve once
per run, replay verbatim" need rides it; recorded in `ARCHITECTURE.md`.)

### The application seam — the typed tool-result boundary (single owner)

Tool output is **typed as a tool result** one layer before it becomes either a `tool_result`
block or a flattened user string. Both loop architectures pass it through the host tool
executor's `{ content: string; isError?: boolean }` return:

- **Provider-driven loop** — the provider adapter calls `req.onToolUse(...) → {content, isError}`
  and builds `{ type: 'tool_result', tool_use_id, content }` (`dispatchAnthropicTools.ts:165-177`;
  same in `dispatchMiniMaxTools.ts:155`, `dispatchProviderTools.ts`). Covers **chat responder +
  pack nodes**.
- **Host-driven loop** — `runAgentDispatchLive` calls `executeTool(...) → {content, isError}`
  (`agentToolProvider.ts:123`, results built at `:68,:99`) and flattens at `agentDispatch.ts:823`.
  Covers **manifest dispatch**.

The kernel is applied to `content` **at these typed points**, using the run-resolved `mode`. Every
such string is *unambiguously* a tool result — no prefix-sniffing, no risk of compacting a genuine
user/assistant message (the failure mode the rejected AI-adapter-boundary seam carried). ~4 typed
interception points (3 provider adapters + the host-driven flatten) cover chat + pack-nodes +
manifest dispatch, provider-agnostic, with **no new `'tool'` message role required**.

**The seam is a new core IoC registry (G2 — feature-refinement filter, re-scoped in pass 3).**
There is no existing transform hook at the tool-result points, so we add
`host/toolResultTransform.ts` (`registerToolResultTransform(fn)`), called at each typed point with
`(content, { decision, toolName })`; the feature registers the kernel at boot, core imports nothing
from the feature — the same inversion shape as `registerFeatureSurface`/`setNodePackResolver`. The
run-resolved `decision` (G1) is threaded to these points via the dispatch request (an optional
`compaction` field on `AiToolCallRequest`, populated from `run.metadata`) so the provider layer has
it in scope without reaching back into run context. Packs that hand-roll their own loop get an
explicit `ctx.compactToolOutput(content)` helper bound to the same decision.

Fail-open to identity on any disabled/missing-decision/error path — compaction must never break
or stall a run; the worst case is "no savings."

### The runless dispatch path

`POST /v1/host/openwop-app/agents/:id/dispatch` (`runAgentDispatchLive`) is a **single turn with
no run** — `AgentDispatchRequest` (`agentDispatch.ts:66-81`) carries no `runId`/`metadata`/
`tenantId`. It therefore has **no replay surface and no invocation-log key**, so compaction there
is a pure free optimization needing **no stamp**. Its calling route (`routes/agents.ts`) holds
the authenticated tenant, so it MAY resolve the decision and pass it in via an optional
`compaction` field on the request; if absent, the path runs uncompacted (identity). This path is
explicitly out of the replay reasoning above.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | `src/features/tool-output-compaction/` — `compact.ts` (pure kernel), `decision.ts` (run-start toggle+agentProfile resolver), `feature.ts` (registers the kernel transform + the run-start resolver via the two new seams). Appended to `BACKEND_FEATURES`. **Not purely feature-local (filter G1/G2):** it adds **two new generic core seams** — `host/runStartContext.ts` (`registerRunStartContributor`, applied in `runDispatch.ts`/`runStarter.ts`) and `host/toolResultTransform.ts` (`registerToolResultTransform`, applied by the tool-result **builder** — the `onToolUse` return in the workflow tool-loop node (`bootstrap/nodes.ts:1726`) and the `agentDispatch` host-driven loop (`agentDispatch.ts:832`); the provider dispatchers `dispatchAnthropicWithTools`/`dispatchMiniMaxWithTools` then **relay** that already-compacted `content` verbatim into the `tool_result` block — they do **not** transform it themselves, so there is no double-compaction) — both identity/`mode:'off'` by default and **recorded in `ARCHITECTURE.md`'s seam table**. This is the legitimate inversion pattern (`registerFeatureSurface` et al.), not a core route/nav edit. **G3:** `BackendFeature.registerRoutes` is required by the interface, so the feature still implements it — a no-op at MVP (or the Phase-3 stats read). Import boundary respected (core never imports the feature). |
| 2 | **Toggle + admin UI** | toggle id `tool-output-compaction`, **default OFF**, `bucketUnit: 'tenant'` (workspace-wide infra behavior, ADR 0015). Server-authoritative resolution inside the transform. Manageable in `FeatureTogglePanel`. No variants needed at MVP (binary on/off; the stamp carries `mode`). |
| 3 | **Workflow surface (ADR 0014)** | Optional read-only `ctx.features.toolOutputCompaction.stats()` (tokens-saved counters) behind the same toggle, advertised as `host.sample.tool-output-compaction`. Deferred to Phase 3 — not load-bearing. |
| 4 | **Node pack** | **Secondary surface (Phase 3):** `feature.tool-output-compaction.nodes` exposing one `action` node `compact` that runs the kernel over an input payload for explicit mid-graph use. Signed via the registry pipeline (Ed25519 + SRI), declared in `requiredPacks`. The kernel is shared with the core transform (one implementation). |
| 5 | **AI-chat integration + envelopes** | None. The chat responder node runs the **provider-driven** tool loop (`dispatchAnthropicTools` via `onToolUse`), so it is covered by the typed tool-result seam automatically — no chat-specific wiring, no new envelope type. |
| 6 | **Agent pack** | None — this is not an AI persona surface. (Honest "none.") |
| 7 | **Public surface** | None. Never added to `PUBLIC_PATH_PREFIXES`. |
| 8 | **RBAC + isolation (ADR 0006)** | Decision resolved once per run from the toggle for the run's own `tenantId`; the optional stats read requires `workspace:read`. No mutating route. Fail-**open to identity** (disabled/missing-decision/error → content unchanged) — safe direction, worst case "no savings," never a broken or cross-tenant run. The kernel sees only the in-flight run's own tool output. |
| 9 | **Replay / fork safety** | Decision stamped into `run.metadata` at run creation (merged `featureVariant` block), **read back verbatim at run-start on `:fork`, never re-resolved** — the `trustBoundary` precedent (`executor/types.ts:176-177`). Kernel deterministic + pure; no new recorded event. Runless `/agents/:id/dispatch` has no replay surface (no stamp). Covered by a dedicated replay/fork test. (See §The decision + §runless path.) |
| 10 | **Frontend** | Phase 4 (optional): a toggle description + a "tokens saved" stat in `FeatureTogglePanel`. No new page/route. Per-agent `compaction` opt-in surfaces in the existing agent-profile editor (ADR 0031). |

## RFC verdict

**Host-internal — NO new RFC, rides no RFC.** Compaction is a deterministic in-process
transform applied between tool execution and message assembly. It touches **no run-event
field** (tool content is not recorded — `agentDispatch.ts:815-822`), **no capability flag, no
endpoint contract, no normative MUST.** Nothing reaches `/.well-known/openwop` except an
optional non-normative `host.sample.*` stats surface. `OPENWOP_REQUIRE_BEHAVIOR=true` is
unaffected — we advertise nothing we don't honor.

## Phased plan

- **Phase 1 — kernel + tool-result seam + run-start decision + replay stamp (the whole win).**
  `compact.ts` + unit tests (determinism, structure-preserving −52 %, lossy −95 %, non-JSON
  pass-through, malformed-JSON safety); the two new core seams — `host/toolResultTransform.ts`
  (`registerToolResultTransform`, applied at the typed tool-result points: the 3 provider
  `tool_result` constructions + `agentDispatch.ts:823`) and `host/runStartContext.ts`
  (`registerRunStartContributor`, applied in `runDispatch.ts`/`runStarter.ts`) — plus the
  feature's kernel transform + run-start resolver registered into them; the `compaction` field
  threaded onto `AiToolCallRequest`; feature-package + toggle (OFF); verbatim-on-fork read;
  replay/fork test. Structure-preserving only. **Cover the chat (provider-driven `onToolUse`)
  path and a workflow-node path in the test matrix — not just manifest dispatch** (the review's
  coverage finding). Wire the runless `/agents/:id/dispatch` optional `compaction` field last
  (no replay surface).
- **Phase 2 — per-agent lossy opt-in.** `agentProfile.compaction { mode, head, tail }` (ADR
  0031 typed field + editor control); transform honors it; stamp records `mode: 'lossy'`.
- **Phase 3 — explicit surfaces (optional).** `feature.tool-output-compaction.nodes.compact`
  workflow node (shares the kernel) + `ctx.features.toolOutputCompaction.stats()` read +
  `/.well-known` advertisement.
- **Phase 4 — observability (optional).** Tokens-saved counter + `FeatureTogglePanel` stat.

## Alternatives weighed

- **Install headroom (rejected).** §Why — daemon/cache/telemetry hostile to stateless Cloud
  Run + BYOK; pre-1.0; the npm lib is a no-op without the daemon.
- **Compact at record time / mutate persisted output (rejected).** Tool content isn't
  recorded, so there is nothing to mutate; and compacting before the *event* would risk
  divergence. Compacting the transient `messages[]` only is both sufficient and replay-clean.
- **Node-pack only (rejected as primary).** Misses the agent tool loop where the cost lives
  (correction #1). Kept as a secondary explicit surface.
- **Single per-loop patch at `agentDispatch.ts:823` (rejected — review pass 1).** Covers only
  manifest dispatch; misses chat + workflow nodes; that request carries none of the needed inputs.
- **AI-adapter message-array boundary (rejected — review pass 2/3).** Looked like the single
  convergence point, but `AiCallMessage.role` is `user|assistant|system` only
  (`executor/types.ts:32`): a tool result is an **opaque `role:'user'` string**, indistinguishable
  from a genuine user turn without fragile prefix-sniffing — and compacting any large user message
  would corrupt real user/assistant content. Wrong granularity.
- **Add a `'tool'` message role so the adapter can type results (rejected — unnecessary).** Tool
  output is **already typed** one layer earlier at the host tool executor / provider `tool_result`
  boundary; no new message role is needed. Kept as a *possible* future cleanup, not a prerequisite.
- **Resolve the toggle per-tool-call inside the transform (rejected — review).** Async hop on
  the hot path + a fresh replay-divergence risk. Resolve once at run-start instead
  (`trustBoundary` precedent).
- **LLM-summarization of tool outputs (rejected for MVP).** Non-deterministic, costs tokens to
  save tokens, and breaks replay determinism. Structural compaction is deterministic and free.
- **Global lossy default (rejected).** Unsafe for full-list reasoning (correction #2);
  per-agent opt-in instead.

## Open questions

- **Per-tool / per-size threshold? — RESOLVED (§residuals).** *Per-size:* the global `minChars`
  default is **0 (compact everything)** — the kernel's own never-regress guard already prevents bloat
  on tiny payloads, so a floor would only forgo small-but-real savings. `minChars` remains a per-agent
  override (`agentProfile.configParameters.compaction.minChars`), now honored in **both** lossless and
  lossy modes (previously lossy-only). *Per-tool:* `CompactionDecision.exemptTools` (frozen in the
  decision, replay-safe) lets named tools stay byte-exact; resolved per-agent from
  `configParameters.compaction.exemptTools`; the seam skips a tool whose name matches.
- **O3 — tool-result identification. RESOLVED (review pass 3).** Tool output is positively typed
  at the host tool executor's `{content, isError}` / the provider `tool_result` construction, so
  no string-sniffing and no `'tool'` message role are needed. Residual: a pack that hand-rolls its
  *own* loop via `ctx.callAIWithTools` (host-driven style) must opt in via `ctx.compactToolOutput`
  — a small, enumerable, logged gap, not a correctness risk.
- **`mode` granularity in the stamp.** Per-agent lossy means a run touching multiple agents could
  mix modes. Proposed: stamp the tenant-level `mode` at run-start; the per-agent lossy `head`/`tail`
  is read from the (fork-copied) agent snapshot's `agentProfile.compaction`. Confirm `agentProfile`
  is captured in the run/agent snapshot on fork (verify in Phase 2).
- **Telemetry of savings — RESOLVED (Phase 4).** Fold into observability, NOT a bespoke counter
  store. The seam reports a `CompactionSaving` to a swappable observer (default: an **info** log — it
  is the savings signal the feature exists to surface, so it must be visible in a standard
  `info`-level deploy; a `debug` default left it invisible in prod) when
  output shrinks — side-channel telemetry, not a recorded run event / durable state / wire, so it is
  replay-safe (re-emitting on replay is harmless; a durable counter would double-count). A bespoke
  per-tenant `DurableCollection` counter was **rejected** (parallel store + hot-path durable write +
  replay corruption — against no-parallel-architecture). *(Note: `emitRawCostAttrs` is deliberately
  NOT used — its allowlist drops non-`openwop.cost.*` keys.)* **This supersedes the original Phase-4
  "FeatureTogglePanel stat" / aggregate `stats()` line** (matrix rows 3 & 10): a user-visible
  aggregate would require the rejected store; per-call savings are already on the Phase-3 `compact`
  surface (`originalChars`/`compactedChars`), and aggregate savings live in the observability
  pipeline. A future in-app savings dashboard, if wanted, is a separate feature over the run-metrics
  surface — not a counter here.

## Implementation status

> **Seam-location clarification (post-implementation review, 2026-06-21 — correct, don't rewrite).**
> The transform is applied at the tool-result **builder** — the point a string is first known to
> be tool output and is about to enter the model context — **not** inside the provider dispatcher.
> There are exactly two builders and both compact: the `agentDispatch` host-driven loop
> (`agentDispatch.ts:832`) and the workflow tool-loop node's `onToolUse` return
> (`bootstrap/nodes.ts:1726`). The provider dispatchers (`dispatchAnthropicWithTools`,
> `dispatchMiniMaxWithTools`) build their wire `tool_result` from `await req.onToolUse(...).content`
> — i.e. they **relay** the already-compacted content; adding `applyToolResultTransform` inside a
> dispatcher would **double-compact** and is a bug. An external review (and the original §245 / seam-table
> wording "applied at `dispatchAnthropicTools.ts:176`") mistook the dispatcher's lack of a transform
> call for "this path is uncompacted"; it is not. End-to-end relay now pinned by
> `tool-output-compaction-relay.test.ts` (2): a compacted `onToolUse` return is the verbatim
> `tool_result` the model receives, and identity is preserved when no decision is frozen.

| Phase | Status | Commit / test |
|---|---|---|
| 1 | **Implemented** | kernel + seams + decision + replay; `tool-output-compaction-kernel.test.ts` (12) + `tool-output-compaction-seam.test.ts` (12) + `tool-output-compaction-relay.test.ts` (2, end-to-end relay); full backend suite green |
| 2 | **Implemented** | per-agent lossy opt-in via `agentProfile.configParameters.compaction`, frozen at run-start, replay-safe; shared `extractRunAttribution` helper; `tool-output-compaction-phase2.test.ts` (10); suite green (2280) |
| 3 | **Implemented** | `ctx.features['tool-output-compaction'].compact` surface (one shared kernel) + `feature.tool-output-compaction.nodes.compact` delegating node pack + `/.well-known` advertisement; `tool-output-compaction-surface.test.ts` (7); suite green (2287). Stats surface deferred to Phase 4. |
| 4 | **Implemented** | savings observability via a swappable telemetry observer in the seam (no parallel counter store — open-Q resolved); `tool-output-compaction-telemetry.test.ts` (5); suite green (2292) |
| §res | **Implemented** (2026-06-21) | deferred residuals closed: runless `/agents/:id/dispatch` wired via core seams; per-agent `minChars` honored in both modes (default floor 0); per-tool `exemptTools`; `tool-output-compaction-residuals.test.ts` (9); suite green (2320) |

### Phase 1 — implementation notes (refinements found during build + review)

- **Single run-insert seam (not 3 stamp sites).** The `/architect` pre-phase review found
  `startWorkflowRun` bypasses `buildRunRecord`; the `/code-review` then found **~11**
  `storage.insertRun` call sites total (scheduler, Kanban, trigger-bridge, MCP, CRM,
  sub-workflows, canvas, …). Rather than stamp at each (drift-prone), all run creation funnels
  through one new owner — `host/runInsert.ts` `insertRunWithStartContext(storage, run)` — which
  derives the tenant from the run and applies the `runStartContext` contributors once. A new
  run-creation path inherits the stamp by using the seam. Fork routes through it too (the
  no-overwrite merge preserves the source's frozen decision).
- **Decision key:** `run.metadata.compaction` (a sibling of `run.metadata.trustBoundary`), read
  into `NodeContext.compaction` at run-start in `executor/executor.ts`; the core type +
  reader + key live at the executor level (`executor/compaction.ts`) so `host/` and the feature
  share them with no host→executor cycle and no core→feature import.
- **Application points (typed tool-result boundary):** `bootstrap/nodes.ts` onToolUse return
  (chat + workflow LLM-tools node, provider-agnostic) and `agentDispatch.ts:827` (manifest
  dispatch). Both call `applyToolResultTransform` (identity default, fail-open).
- **Runless `/agents/:id/dispatch` — WIRED (§residuals).** The earlier boundary concern is solved by
  reusing the EXISTING core seams instead of importing the feature: the route resolves the decision
  via `stampRunStartContext({}, { tenantId, agentId })` + `readCompactionDecision(...)` (both core) and
  passes it as `AgentDispatchRequest.compaction`. Toggle off ⇒ undefined ⇒ identity. Per-agent lossy
  applies only when the manifest agentId is also a profile (roster) id; else the tenant lossless
  default. No new seam, no feature import.
- **Residual (logged, fail-open):** `workforceEval` deterministic-eval runs are not stamped (no
  live model); packs that hand-roll their own `ctx.callAIWithTools` loop opt in via the future
  `ctx.compactToolOutput` helper (Phase 3).

### Phase 2 — implementation notes

- **Per-agent lossy opt-in** lives in `agentProfile.configParameters.compaction = { lossy, head?,
  tail?, minChars? }` (ADR 0031 open config map — no profile schema change; parsed defensively).
  `resolveCompactionDecision` reads it ONCE at run-start (tenant-scoped, fail-closed cross-tenant
  via `getAgentProfile`) and freezes `{ mode: 'lossy', … }` into `run.metadata.compaction`. The
  application points still read only `ctx.compaction` — never the profile live — so editing the
  profile later cannot change an in-flight/forked run (replay-safe; covered by a test).
- **Single source of the attribution convention:** extracted `extractRunAttribution(metadata)` in
  `host/agentRunActivityIndex.ts` (the `/architect` MEDIUM) so the run-insert seam and the activity
  index read the heartbeat/schedule/kanban/approval block the same way. Profile key = **rosterId**
  (profiles are keyed by roster id, `upsertAgentProfile(tenantId, rosterId)`).
- **Coverage limit (by design, replay-safe):** per-agent lossy fires only on **agent-attributed**
  runs (heartbeat / scheduler / roster / kanban). Multi-agent workflow runs and non-attributed chat
  runs stay tenant **lossless** — which is safe for all (lossless never drops rows). A per-node-agent
  lossy path would require reading the binding's profile at dispatch (breaks replay) and is out of
  scope. Set the opt-in via the existing `agentProfile` API (`configParameters.compaction`); a
  dedicated editor control is a Phase-4 FE nicety.

### Phase 3 — implementation notes

- **One kernel, two surfaces:** the `ctx.features['tool-output-compaction'].compact` surface and the
  `feature.tool-output-compaction.nodes.compact` node both run the same `compactToolOutput` — the
  node delegates to the surface (no kernel duplication in the isolated pack ESM). Auto-advertised at
  `/.well-known/openwop` as `host.sample.tool-output-compaction`.
- **Gate asymmetry (intentional):** the EXPLICIT compact node **hard-fails** `host_capability_disabled`
  when the tenant toggle is OFF (the author explicitly asked to compact — honest), while the
  AUTOMATIC tool-result boundary **fails open** to identity (an optimization must never break a run).
  Both are replay-safe — automatic via the frozen run decision, explicit via the recorded node output
  (replay never re-gates). Matches every other feature-surface node (csm/priority-matrix).
- **Residual closed:** a pack that hand-rolls its own `ctx.callAIWithTools` loop now compacts its tool
  results by calling `ctx.features['tool-output-compaction'].compact` — so no separate
  `ctx.compactToolOutput` core field was added.
