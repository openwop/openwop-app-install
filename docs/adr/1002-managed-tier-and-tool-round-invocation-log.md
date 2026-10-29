# ADR 1002 — managed tier and tool round invocation log

Status: Accepted (P1 in PR; `implemented` on merge)

## Context

A `replay` fork re-executes AI nodes and expects the invocation log to serve
every model response from the source run (ADR 0326 P3a/P3b, ADR 0341). Before
this ADR, three of the four model-call paths in
`backend/typescript/src/aiProviders/aiProvidersHost.ts` never touched the log:

| Path | Recorded | Served on replay |
|---|---|---|
| `callAI`, BYOK | yes | yes |
| `callAI`, managed (`callAIManaged`) | no | no |
| `callAIWithTools`, BYOK | no ("NOT cached") | no |
| `callAIWithTools`, managed (`callAIWithToolsManaged`) | no | no |

The managed short-circuit said why: "Replay determinism does NOT apply: managed
dispatch is for ad-hoc chat, not workflow runs (which keep using BYOK)." That
premise is false. `agentDispatch.ts` resolves agent nodes with
`preferManaged: true`, so an agent node with no pinned credential runs on
`managed:openwop-free`. Every agent turn that has tools goes through
`callAIWithTools`.

So replaying or forking a run with an agent node called the model live. The
replay was not deterministic, it re-ran tools on fresh model output, and on the
managed tier it spent the tenant's free-tier budget.

**Measured in prod, 2026-10-28, read-only.** All 11 managed `provider.usage`
events came from `local.openwop-app.agent-runner`, in 6 runs. A second method,
matching `managed:` in stored run inputs, found 46 runs. None of those runs has
ever been forked or replayed, by either method. All 769 prod forks are
conformance workflows. The join is not blind: it finds 13 replay forks whose
parents carry `mock` usage. So exposure to date is zero, and the defect is
latent.

## Decision

**D1. All three unrecorded paths write to the same invocation log as BYOK
`callAI`.** They use the same key shape `(runId, nodeId, attempt,
invocationId)` and the same identity: `logicalInvocationId` over tenant, run,
node, the logical ordinal from `nextLogicalInvocationOrdinal`, and the RFC 0150
§C v2 semantic digest. For a tools round the digest also covers the tool
definitions (`tools`, which the v2 recipe already defines) and web search, as
`providerOptions['vendor.<provider>.webSearch']`. A provider failure is
recorded as the same failure envelope `callAI` uses, and a replay re-throws it.

**D2. These three paths READ the log only on the replay lane**
(`scope.replayInvocationsFromRunId` set). A live run behaves exactly as it did
before:

- A loop that revisits the same node at the same attempt with an identical
  request calls the provider again. This needs the replay-only read. The
  executor's `beginNodeActivity` rewinds the ordinal to 0 on every re-entry at
  the same attempt (B1, found by the replay-ordinal work), so the identity
  alone cannot tell two such visits apart. This ADR does not change the
  ordinal.
- A retry (a new attempt) calls the provider again. The tool-round docblock
  promised this, and a replay-only read keeps it.

On the replay lane the read order is:

1. the fork's own `(identity, attempt)` record, written by an earlier pass of
   this fork (a resumed replay fork re-enters its nodes);
2. the source run's record, under the source run's identity, recomputed
   because `runId` is in the preimage.

A source hit is copied under the fork's own key, like `callAI`'s
copy-on-read, so a fork of a fork replays from its parent. A miss calls live.
That covers both a node the source never reached and a request that diverged.

BYOK `callAI` keeps its existing read path unchanged, including the live-lane
retry-stable read.

**D3. The served record carries its own `provider.usage` payload.** When it
records a call, the adapter keeps the exact payload it emitted, and a replay
re-emits that payload verbatim. `callAI`'s fallback re-emits the source node's
FIRST `provider.usage` event. For a multi-round node that would repeat round
1's usage for every round. This ADR does not change `callAI`'s re-emit.

**D4. Tool results are recorded and served on replay too. An unrecorded tool
call on a replay fails closed.** (Revised 2026-10-28 after review by the
release manager. The first draft left tool execution unchanged. That was
wrong for two reasons, below.)

*What happens to tools on a replay fork TODAY (before this ADR):* nothing
serves a tool result. The agent node is not ADR 0341-classified (AI nodes are
held back so RFC 0041 §B divergence keeps working). `agent.tool-returned`
carries no result payload (`agentDispatch.ts`, "this host never sets
`outcome`"), so the source's tool results exist nowhere a replay could read.
RRWF-19 (ADR 0772 D6) only made sure a resumed replay keeps
`replaying = true`; it does not serve tool results. Each tool call the model
makes is EXECUTED again:

| Tool class | Today (live model on replay) | P1 as first pushed (served model, live tools) | This revision (D4) |
|---|---|---|---|
| read-only (`crm.list-*`, `kb.search`) | re-runs on current state | re-runs; if state changed, the result differs → round N+1 digest differs → LIVE model call | served from the record; 0 executions |
| read-before-write | the read re-runs; the write re-runs if the new model output asks for it | the write re-runs DETERMINISTICALLY on the recorded call | both served; 0 executions |
| side-effecting, guarded seam (email send, webhook, http, notify, Stripe) | `assertEffectAllowed` throws → `tool_execution_failed` result → model diverges | same throw → the result differs → LIVE model call | served; 0 executions |
| side-effecting, UNGUARDED internal write (`kanban.add-todo`, `email.draft`, `tasks.schedule-*`) | **re-executes: a duplicate card/draft/schedule.** `kanban.add-todo`'s idempotency key folds in `runId`, so a fork mints a new card | **same duplicate, now every time** | served; 0 executions |
| workflow-as-tool child run | `runStarter`/`subRunDispatcher` assert `dispatch` → refused → model diverges | refused → LIVE model call | served; 0 executions, no child |

> **Lane note (measured while writing the P2 witness).** In the agent-runner
> (workflow) lane, `tasks.schedule-followup` and `tasks.schedule-recurring`
> refuse with `conversation_required` BEFORE any write, because
> `agentRunnerNode.ts` builds the tool scope without a `conversationId`. So in
> that lane they cannot leave a `scheduler:job` row behind today. They write
> in the chat lane, which carries a conversation. The P2 witness drives the
> real tools with that writing scope, so its "zero new `scheduler:job` rows"
> is not vacuous. `kanban.add-todo` writes in the run lane (it needs only the
> acting user and the agent), and the node-level witness uses it.

So P1 as first pushed had two defects. It made the unguarded-write duplicate
deterministic. And it did not deliver "zero live model calls" whenever any
tool's replayed result differed from the source's (every guarded effect,
every read of changed state), because the next round's digest then missed.

*Mechanism.* `host/replayToolResults.ts` (new, in the invocation-log seam)
wraps the agent-runner's `executeTool` OUTERMOST, around the ADR 0889
`maybeCaptureExecuteTool` wrap in `agentRunnerNode.ts`, so a served call runs
neither the tool nor the eval capture. It reads its inputs from the ADR 0531
run-effect context. That context gains one field, `replaySourceRunId`, which
the executor sets from the same `replayInvocationsFromRunId` it hands the AI
adapter (`executor.ts`, the `effectCtx` literal). A resumed replay fork
therefore keeps its source (ADR 0772 D6). It makes no change to
`agentDispatch.ts`.
- Identity: the same `logicalInvocationId`, with an ordinal from the same
  per-node allocator (`nextLogicalInvocationOrdinal`). The `providerKey` is a
  sha256 over the canonical `{recipe:'openwop-app.tool-call.v1', name, input}`.
  The model call id is excluded: providers mint call ids, and a served round
  carries the source's ids anyway.
- Live run: execute, then record `{content, isError, errorCode,
  continueTurn}`. A throw is recorded as a failure envelope. The write is
  best-effort, like D1. Results over 1 MB are not recorded, so a replay of
  that call fails closed (below).
- Replay lane: the fork's own record, then the source's (copy-on-read). A hit
  returns the recorded result WITHOUT executing, and a recorded throw
  re-throws. **A miss does not execute, and it FAILS THE NODE** with the typed,
  non-retryable `replay_source_missing`, the code ADR 0341 uses for a
  side-effecting node the source never reached. "A replay never creates a new
  side effect."
  > **CORRECTED 2026-10-28 (release-manager review, before merge).** The first
  > P2 draft returned the miss to the model as a tool error. A model shown a
  > different result than the source's continues LIVE, so the replay then
  > diverged with live calls. `runChatToolLoop` turns every `executeTool`
  > throw into a tool result (only `LeaseLostError` escapes), so the miss
  > cannot be thrown through it without an `agentDispatch.ts` change. Instead,
  > the guard (`createReplayToolGuard`) records the first miss and refuses
  > every later call without executing. It also wraps the node's tools-round
  > call so that no model round runs after a miss (`ReplayToolMissError`;
  > off the replay lane the model call is passed through as-is). The
  > agent-runner then returns `replayMissFailure(miss)`, which also covers a
  > miss in the loop's final round. Witnessed through the REAL agent-runner
  > node: the node fails `replay_source_missing`, files no card, and the model
  > is called once (round 1, itself a D2 miss), never after the refusal.
- Read tools are NOT exempted from the fail-closed miss. The only read/write
  signal, `BuiltinTool.effect`, is documented as "DISPLAY ONLY … never an
  input to gating", and MCP tools carry none. A miss only happens after the
  model has already diverged, so refusing costs fidelity that was already
  lost.
- The ADR 0531 backstop stays underneath as a second line.

*Privacy.*
- **Deletion.** Tool records sit in `invocation_log` under the run's `run_id`,
  like the model records, so `deleteRun` and `deleteAllTenantData` delete them.
  Witnessed for both, with tool and model records: after either delete, a
  replay misses. An undeleted control is served.
- **Tenant.** Every new record (tool, and the D1 model records) is stamped with
  `tenantId`. The tenant is already in the identity preimage, so another
  tenant's record cannot be addressed. The stamp is the explicit second guard.
  A replay read whose record names another tenant is refused: a tool gets
  `replay_tenant_mismatch` and does not execute, and a model call throws
  without dispatching. The record is never copied under the fork's key.
  Witnessed for both lanes.
- **Scrubbing.** Tool records go through `stripSecretsFromPersisted`, the scrub
  the model failure envelopes use. For parity, the new D1 success records do
  too. (BYOK `callAI`'s existing success records are unchanged.) A scrubbed
  result differs from what the source model saw. If a credential shape
  appears, the next served round misses and the replay degrades, which is the
  right side to fail on.
- **Size.** A record over 1 MB (`MAX_RECORDED_TOOL_RESULT_BYTES`, measured
  after the scrub) is not written. Its replay gets `replay_source_missing`
  and does not execute.

**D4a. Ordering inside a node.** Model rounds (D1) and tool calls (D4) draw
ordinals from one allocator, in loop order: round 1, its tool calls, round 2,
and so on. Served rounds reproduce the same tool calls in the same order, so
source and replay allocate identical ordinals.

**D4b. What this ADR needs from the ordinal (B1), and the clarification-cards ADR's API.** ("The clarification-cards ADR" is the B1 owner's ADR on branch `feat/clarification-cards`. It has no number on `main` yet, so it is not cited by number here.)
- *Stability across replay* (needed). Source and fork must allocate the same
  ordinal to the same logical call. Within one visit this holds today.
  Across a mid-body resume it needs the clarification-cards ADR D3.3's
  `peekNodeActivityOrdinal()`/`seedNodeActivity()` (branch
  `feat/clarification-cards`, `a031e9d8f`). Both the source's continuation and
  the fork's seed from the checkpointed cursor, and because D1 and D4 use the
  same allocator, the cursor covers tool calls too. **The API meets this,
  provided the agent-runner seeds before the resumed loop's first model
  round.** That is the clarification-cards ADR's planned call order.
- *Per-visit uniqueness for loop revisits* (REQUIREMENT R1 on the clarification-cards ADR, **met at `fc21f759d`**, see below). Two visits of a
  node at the same attempt (an ADR 0772 loopback) both start at ordinal 0, so
  identical calls share one record and a replay serves the LAST write to both.
  This ADR keeps live runs safe without it: the log is read only on replay
  (D2). `seedNodeActivity` does not solve it, because it is opt-in for resume
  and does not tell a resume of visit k apart from a new visit k+1. **The
  change needed, through the clarification-cards ADR's owner:** have `beginNodeActivity` take
  the executor's ADR 0772 visit ordinal and start each visit's cursor at a
  partitioned base (for example `visit * 2^20`). Visit 0 keeps ordinal k, so
  every existing record still matches. A same-visit resume still rewinds to
  that visit's base, and the base is stable even when a diverged replay makes
  a different number of calls. This ADR does not edit `effectIdentity.ts`.

  > **R1 MET (2026-10-28) by the clarification-cards ADR on `feat/clarification-cards`
  > `fc21f759d01137e89defe1aa227c515a29534cdb`, with one correction this ADR
  > accepts.** The "visit" is NOT the raw ADR 0772 execution ordinal: a retry
  > opens a new execution, and the raw ordinal would break RFC 0150 §B retry
  > stability. `ExecutionOrdinals.visitOf(nodeId)` folds the log instead. The
  > first start is visit 0. A start after a FAILED execution is a retry and
  > keeps the visit. A start after a COMPLETED execution is a revisit (+1). A
  > re-entry to an open execution keeps the visit.
  > `beginNodeActivity(runId, nodeId, attempt, visit = 0)` uses base
  > `visit * 2^20`. A new attempt rewinds to the visit base, and
  > `seedNodeActivity` keeps both the attempt and the base. Visit 0 is
  > byte-identical to main. That meets both needs above: per-visit uniqueness
  > for revisits, and stability across replay. A retry keeps its visit, so
  > D2's "a retry is a new `attempt`, a different key" is unchanged.
  > **Trap, stated so it is not lost:** the executor folds `ExecutionOrdinals`
  > on replay forks ONLY, so a live run always passes visit 0. Today that is
  > harmless. Nothing re-enters a COMPLETED node on this host (there is no
  > loopback; dispatch and supervisor iterate inside one execution), so the
  > "two visits at the same attempt" case is UNREACHABLE today, and so is the
  > "last write served to both visits" limit below. When ADR 0772 loopback
  > lands, the live executor MUST fold ordinals too. Otherwise a live run
  > records visit 1 at base 0 while its replay reads base 2^20, and every
  > revisit's replay misses (fails closed, D4).
  >
  > **REQUIREMENT R1 (as originally addressed to the clarification-cards ADR) (owner of `host/effectIdentity.ts`
  > and the B1 fix).** `beginNodeActivity` MUST take the executor's ADR 0772
  > visit ordinal `v` and set the node's cursor to `v * 2^20`. Visit 0 MUST
  > stay unchanged (cursor 0), so every record written before the change
  > still resolves. A re-entry of the SAME visit (a `SuspendSignal` resume)
  > MUST rewind to that visit's base, never to 0. `seedNodeActivity` (D3.3)
  > composes with it: it moves the cursor within the visit. Until R1 lands,
  > ADR 1002 is correct for live runs (replay-only reads) and for single-visit
  > replays. For a node revisited with identical calls, a replay serves the
  > last write to every visit. The witness to add when R1 lands: a 2-visit
  > loop whose visits make identical calls with different recorded results;
  > the replay serves each visit its own.

**D5. The `mock` tools round is unchanged.** Its scripted programs are RFC 0041
§B divergence injections and must keep reaching the mock on replay.

## Alternatives

- **Read on every lane, like BYOK `callAI`.** Rejected. Under B1 a live loop
  revisit with an identical request would be served the earlier visit's
  answer, which changes live behaviour.
- **Put a per-visit discriminator in the identity.** Rejected. It changes the
  RFC 0150 §B preimage, which is the ordinal's job (B1), not this fix's.
- **Mark agent nodes side-effecting (ADR 0341 fast path).** Rejected. That
  serves the whole node outcome and kills RFC 0041 §B divergence, which
  `sideEffects.ts` says AI nodes must keep.
- **Serve model rounds, re-execute tools (P1 as first pushed).** Rejected
  (D4): it made unguarded duplicate writes deterministic, and any differing
  tool result sent the next round live.
- **Gate the replay miss on `BuiltinTool.effect`** (execute reads, refuse
  writes). Rejected: that field is display-only by contract, MCP tools have
  none, and a miss is already a diverged replay.
- **Put tool results on `agent.tool-returned.outcome`** (RFC 0064 §F permits
  it). Rejected for this ADR: that is a wire-visible payload change on every
  tool return, it needs PII/size review for the event log, and the invocation
  log already has the replay key, lifecycle and erasure.

## Consequences

- A replay fork of an agent node with tools makes zero live model calls AND
  zero tool executions when the source recorded them, on both tiers. So it
  writes no duplicate card, draft, schedule or transient workflow, starts no
  child run, meters no managed credits and emits no new cost events. A replay
  that diverges (a miss) refuses every unrecorded tool call with
  `replay_source_missing` and calls the model live for the unrecorded rounds.
- Out of scope, recorded as follow-ups. The per-tool trace found
  `workflows.compose-and-run` and `workflows.propose` writing their transient
  draft BEFORE the `dispatch` guard (`workflowComposeTool.ts`); D4 covers the
  agent lane, and the guard order still matters for any other caller. It also
  found `ai.research.web` swallowing the replay refusal into example results,
  and a native-search leg whose dispatch may be unguarded.
- Live runs write one invocation-log row per tool round. The rows live and
  die with their run: `deleteRun` and tenant erasure already delete
  `invocation_log` (`storage/postgres/index.ts`, `storage.ts`), the same as
  the rows `callAI` writes today. Prod volume is low: 2,038 usage events in
  five months. The chat loop's BYOK path (`conversationToolLoop.ts`) uses the
  same adapter without a replay source, so it writes rows that nothing reads
  yet. That is accepted: it costs one row per chat tool round and keeps the
  adapter uniform.
- **Records are DECODED, never cast** (Codex static review of `7fb807c12`,
  which flagged `return result as unknown as T`). A replay read validates the
  stored shape field by field (`decodeAiCallResult`,
  `decodeAiToolCallResult`, `decodeProviderUsage`, `decodeFailureEnvelope`,
  `decodeToolResultRecord`). A record this host did not write fails CLOSED. In
  the model lane that is `replay_record_invalid`, thrown with no dispatch. In
  the tool lane it is a miss: `replay_source_missing`, which fails the node and
  executes nothing. Both are witnessed.
- **The success write is best-effort** (a warning on failure, never a throw).
  A storage hiccup must not fail a live model call that already succeeded and
  was already metered. If the write is lost, that call's replay calls live,
  which is the old behaviour. BYOK `callAI`'s awaited write is unchanged.
- **No installed invocation backend** (a bare adapter outside a booted host)
  means nothing to record or serve, so the three paths dispatch exactly as
  before. BYOK `callAI` still throws there, as it always did.
- Records hold the model's output (text, tool calls, usage), never credentials.
  Failure envelopes go through `stripSecretsFromPersisted`, as before.
- **Within-node replay fidelity under B1: unreachable today.** Two visits
  that share one record would make a replay serve the LAST write to both
  visits. Nothing on this host re-enters a COMPLETED node today, so the case
  cannot occur. the clarification-cards ADR's visit partition (R1, met) closes it for when
  loopback lands, PROVIDED the live executor then folds `ExecutionOrdinals`
  too (the trap recorded in D4b).
- Runs recorded before this change hold no tool-round records. Replaying them
  still calls live, as before. Tool rounds now take ordinals from the same
  per-node counter as `callAI`. In an old run where a node mixed tool rounds
  with a later plain `callAI`, that `callAI`'s replay identity shifts and it
  calls live once.

## Implementation

| Phase | What | Witness |
|---|---|---|
| P1 | D1–D3 in `aiProvidersHost.ts`; corrected the false managed-tier comment | `test/adr1002-managed-and-tools-round-replay.test.ts` |
| P2 | D4: `host/replayToolResults.ts` (`createReplayToolGuard`, `replayMissFailure`); guard in `agentRunnerNode.ts` (outermost executeTool wrap, model-round guard, miss → node failure); `replaySourceRunId` on the run-effect context (`runEffectContext.ts`, `executor.ts`); tenant stamp, check and scrub on the D1 records | `test/adr1002-managed-and-tools-round-replay.test.ts` (20 cases) and `test/run-effect-context.test.ts` (the executor sets `replaySourceRunId` on a replay fork only). The witnesses: a replay of a 2-round, 3-tool agent (a read whose live answer CHANGED, a guarded effect, an unguarded write) makes 0 model calls AND 0 tool executions on both tiers. Through the real agent-runner with `kanban.add-todo`, a live run files one card and the replay files zero. An unrecorded call FAILS THE NODE with `replay_source_missing` and files nothing. The real `tasks.schedule-followup` and `tasks.schedule-recurring` add zero `scheduler:job` rows on replay. Also witnessed: tenant mismatch on both lanes, `deleteRun` and tenant erasure, the scrub, and the 1 MB cap. |

## Architecture review (2026-10-28, before code)

Track A (host code), plus the replay half of Track B. No wire change: the
invocation log is host-internal, and `provider.usage` keeps its existing
schema. No RFC is needed.

- **MEDIUM, data lifecycle.** The first draft said the log was TTL-bounded. It
  is not: it is deleted with its run and on tenant erasure. Corrected above.
- **MEDIUM, live behaviour.** An awaited success write could have made a DB
  failure fail a live, already-paid call. The write is now best-effort.
- **LOW, write amplification.** Chat-loop BYOK rounds write rows that are never
  read. Accepted and documented.
- **Pass:** boundaries (one log, one identity, no second store); secrets (the
  record is model output plus usage, credentials are excluded from the digest,
  failure envelopes are stripped); cost (a served round meters no managed
  credits and emits no cost event); resumed replay forks (the executor derives
  the replay source from `run.forkMode`, so resumed passes also read the log).
  No new imports reach the provider modules, so `vi.mock`/`importOriginal`
  order is unchanged.
