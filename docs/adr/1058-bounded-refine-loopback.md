# ADR 1058 — Bounded refine loopback (RFC 0258 host implementation)

Status: Accepted. PR-A implemented (default OFF); PR-B open. RFC 0258 is `Active`
(suite 2.46.44, vendored). The graph behaviour and the `loopback` advert both sit
behind `OPENWOP_BOUNDED_LOOPBACK`, default OFF; turning it on in production is a
separate step, measured first.

> **CORRECTED 2026-11-12:** this line said the wire was `Draft` upstream
> (openwop/openwop#2081) and that nothing is advertised until RFC 0258 is
> `Active`. It is `Active` now, so PR-B advertises the family when the flag is on.

## Context

Book AI (P48) shows the author a candidate through `core.chat.approvalGate`. Its
"Another option" button is a `refine`. The gate returns
`{decision:'refine', approved:false}` and the node ends
(`packs/vendor.myndhyve.chat/index.mjs` ~:418-447 only counts and stores). The
workaround is a fresh run that re-runs every upstream step.

What is in place on this host, measured at `f7b5fabc3`:

- `executor/scheduler.ts` `findBackEdges` refuses every cycle unless one end is
  `core.dispatch` or `core.orchestrator.supervisor`. Node state is per node id,
  one visit.
- `executor/interruptRequestedPayload.ts` `interruptRequestKey` is the one place
  keys are derived. A native gate gets `${runId}:${nodeId}:0`. A `ctx.suspend`
  node gets `${runId}:${nodeId}:${resumeKey}`, and the chat gate's resume key is
  its node id (`index.mjs:335`). So **every visit would get the same key**, which
  breaks interrupt.md §Re-entry ("a later execution … MUST derive a different
  key"; "invoke an interrupt with key K at most once").
- `executor/sideEffects.ts` `ExecutionOrdinals.visitOf` already folds a per-node
  visit from the log (ADR 1001 D3.3), and the ADR 1002 invocation log is already
  split per visit. Each round's model call will be served by its own visit on
  replay with no change.
- ADR 0772 D5 designed host loopback on `settings.maxLoopbackIterations`. P3
  never shipped, and upstream later ruled that setting non-normative
  (openwop#1748). RFC 0258 replaces that premise with a declared edge.
- `core.chat.approvalGate` `maxRequestChangesIterations` defaults to `0`, which
  means unlimited, and on overflow it returns `decision:'reject'`.

## Decision

The RFC 0258 shape: `WorkflowEdge.loopback {on:'refine', maxIterations ≥ 1,
onExhausted:'withdraw'|'fail', historyInput?}`. Host decisions:

- **D1 — Per-visit interrupt keys, byte-identical at visit 0.** The key stays
  `${runId}:${nodeId}:${resumeKey|0}` at visit 0. At visit `v > 0` it becomes
  `${runId}:${nodeId}:${resumeKey}#v${v}` or `${runId}:${nodeId}:${v}`.
  `v` is the number of loopback markers that re-armed the node, folded from
  the log (`LoopbackVisits`). For the gate that is exactly interrupt.md's
  definition (one refine consumed per round); for the other region nodes it is
  the round number. It is not `ExecutionOrdinals.visitOf`, which counts
  completed executions and would move a retried node's visit after a
  resolution. Only a marker advances it, so without a loopback edge `v` is 0 by
  construction: the run never folds anything, and stored runs replay
  unchanged. Tests pin that. In a looping run the same `v` also feeds
  `beginNodeActivity`, so each round's model call keeps its own
  invocation-log records. Before this change a live run passed visit 0 for
  every round (`ordinals` exists only on replay forks), which would have let
  round 2's record overwrite round 1's.
- **D2 — Visit-aware lookups.** The by-node resolve route, the fork and replay
  resolution helpers (`forkInterrupts.ts`, `forkReplayResolutions.ts`
  `replay-derived` ids) and `reinvokeResolutions` select the CURRENT visit's
  interrupt. `reinvokeResolutions` is consumed by the execution it resumes
  (ADR 0772 D5.5). At visit 0 they behave as today.
- **D3 — Admission.** With the flag on, `buildGraph` removes declared loopback
  edges from the forward DAG, as it already does for dispatch back-edges.
  Registration refuses the RFC §B shapes with `400 validation_error`: a forward
  cycle, a target that is not an ancestor of the gate, an open region,
  overlapping regions, and a cap above the host ceiling. With the flag off, a
  `loopback` edge is refused with `capability_required`.
- **D4 — The marker is the record.** On a refine resolution with rounds left,
  the gate's `node.completed` carries `loopback {edgeId, targetNodeId, round,
  rearmed}`. The live drain does not release the gate's forward edges for that
  settle. It re-arms the region: states go to pending, outputs are cleared, and
  the target becomes ready. `snapshotFromEventPrefix` reads the same marker, so a
  crash-resume or a fork cut after it resumes with the region re-armed. A fork
  never resumes with the gate completed, which would skip `apply`.
- **D5 — History from the log.** When `historyInput` is declared, the target's
  port gets `[{round, outputs, refineFeedback}]`, oldest first. It is rebuilt
  from the target's `node.completed.outputs` and the gate's
  `interrupt.resolved.refineFeedback` for each round. It carries no timestamps,
  principals, run ids or keys (ADR 1002; the run-scoped-ids rule). The run
  variable bag is NOT used, because it is not rebuilt from the log.
- **D6 — Exhaustion.** `ApprovalData.loopback {round, maxIterations, exhausted}`
  goes on every visit. Under `withdraw`, `refine` is dropped from `actions`, and
  the resolve validator refuses a `refine` with `400` (`validateResumeValue`
  already enforces `actions`). Under `fail`, the host emits
  `workflow.loopback-limit`, then `cap.breached {kind:'loopback-iterations'}`,
  then `run.failed` `loop_limit_exceeded`.
- **D7 — One cap.** When the gate is the source of a loopback edge,
  `core.chat.approvalGate` ignores its own `maxRequestChangesIterations` and its
  variable-bag history writes. An unknown verb becomes a typed error, not
  `refine`. `decidedAt` stops defaulting to `new Date()`.
- **D8 — Chains.** The chain loader carries `loopback` through
  (`workflowChainPackLoader.ts` copies only known edge fields). Book AI's two
  chains declare `config.actions` explicitly.

## Alternatives weighed

- **`refineTo` on the gate's config.** Rejected. The node config is not in the
  v2 schema. It would need adding to each gate type separately, and it brings
  back the typeId whitelist of `DISPATCH_LOOP_TYPEIDS`. An edge is visible in the
  builder and already travels through chain expansion.
- **Feedback in a run variable.** Rejected because the bag is not log-derived
  (`snapshotFromEventPrefix`: "side-band variable-bag mutations … do not
  replay"), so a fork cut mid-loop would diverge from the recorded model call.
- **Bind `settings.maxLoopbackIterations`** (ADR 0772 D5.3). Rejected because
  upstream ruled it advisory.

## Phases

Each PR branches off `origin/main` with no stacking, and they merge in order.

> **CORRECTED during P1 (2026-11-04).** The first plan split P1 (keys) from P2
> (graph). Without a loopback edge no node is ever visited twice, so P1 alone
> had nothing to witness. The durable-resolution store is also keyed on
> `data.__resumeKey`, so the key qualification and the re-arm turned out to be
> one mechanism. PR-A therefore carries D1–D6 and leaves D7–D8 for PR-B.

| PR | Scope | Status |
|---|---|---|
| PR-A | D1–D6: per-visit keys, admission, marker, release suppression, fold, history port, withdraw and fail. Behind `OPENWOP_BOUNDED_LOOPBACK` (default OFF). `ApprovalData.loopback` is recorded on the interrupt data, but no projector puts it on the wire yet | implemented |
| PR-B | D7–D8: chat-gate alignment, chain-loader carry and the vendored chain schema, Book AI's chains. Project `ApprovalData.loopback` and advertise `capabilities.loopback` only after RFC 0258 is `Active` | open |

## Open questions

1. Is RFC 0258's comment window waived (its UQ 6)? Advertising waits on the
   shape lock either way.
2. Should RFC 0258's history entries carry `decidedBy`? The RFC says no, and
   this host follows the RFC.

## Implementation record (PR-A)

| Decision | Change | Witness (sabotage-checked red) |
|---|---|---|
| D1 | `qualifyResumeKey` / `nodeResumeKey` (`executor/loopback.ts`). The suspend branch qualifies `__resumeKey` past visit 0; the native key uses the visit; `beginNodeActivity` takes the loop visit | `adr1058-bounded-loopback` "ctx.suspend gate keyed by its node id" (red without the `#v` suffix); `adr1058-loopback-admission` pins `r1:gate:0` / `r1:gate:gate` |
| D2 | durable lookup, seeded resolution and `replay-derived` id are all visit-scoped | same file |
| D3 | `normalizeEdgeLoopback` + `planLoopbacks` in `validateWorkflowDefinition` and at run start; `buildGraph` drops declared loopback edges under the flag | `adr1058-loopback-admission` (refusals; `capability_required` with the flag off) |
| D4 | marker `openwop-loopback` on the gate's `node.completed`; `rearmRegion` instead of `releaseDownstream`; `snapshotFromEventPrefix` re-arms from it | native leg (red without the native re-arm), reinvoke leg, replay-fork leg (red without the fold) |
| D5 | `rebuildLoopbackHistory` onto `historyInput` | native leg (`rounds` equals round 1's outputs + feedback) |
| D6 | `loopbackInterruptData` withdraws `refine`; `resolveAndResume` refuses an exhausted refine with `400`; `emitLoopbackExhausted` for `fail` | withdraw leg (red without the refusal), fail leg |

Found while implementing:

- **The marker key.** v2's `nodeCompleted` is closed, so an undeclared
  `loopback` key is boxed under the vendor hatch on a major-2 read. A fork's
  copied prefix then lost it, and the fork completed past the gate (this is
  what the replay-fork leg caught first). While RFC 0258 is `Draft` the marker
  rides `openwop-loopback`, a hatch key carried flat, as `openwop-handoff`
  is. The reader accepts both spellings.
- **Live invocation-log visits.** `ordinals` exists only on replay forks, so a
  live run passed visit 0 for every round. In a loop, round 2's records would
  have overwritten round 1's. The loop visit now feeds `beginNodeActivity`.
- **Pre-existing, not fixed here:** `resolveAndResume` (the token, reviews and
  MCP lanes) does not enforce `actions`. Only the by-node route calls
  `validateResumeValue`. PR-A adds the exhausted-refine refusal only; widening
  it to every action is a separate change.
- **`fail` mode** fails the gate typed. Like any failed node, the run fails
  unless an author routes the failure over an `any_failed` / `all_complete`
  edge.

## PR-B (prepared locally on top of #5583; not pushed until it merges)

The wire names follow openwop-be's RFC 0258 diff (branch `df95583d9`, relayed
2026-11-08) and live in ONE module, `executor/loopbackWire.ts`. Nothing else
spells an RFC 0258 field, event, cap kind, error code or reason as a literal,
so a rename in review is a single edit.

| Decision | Change |
|---|---|
| §C.4 size cap | `capHistoryOutputs` measures the UTF-8 length of the JCS serialization of the recorded outputs (`host/canonicalJson.ts`: keys sorted by UTF-16 code unit, ECMAScript serialization, which is the JCS form for log values). Over `LOOPBACK_MAX_HISTORY_ENTRY_BYTES` (65,536; the RFC floor is 4096) the entry's `outputs` becomes `{truncated: true, bytes}`, and `round` and `refineFeedback` are kept |
| D7 `ctx.loopback` | `NodeContext.loopback {round, maxIterations, exhausted}` on a loopback gate's execution. It is carried to isolated pack workers in the dispatch envelope |
| D7 chat gate | Under `ctx.loopback`, `core.chat.approvalGate` makes no `_loopbackCount` / `_feedbackHistory` / `_previousArtifact` writes, ignores `maxRequestChangesIterations`, and refuses any non-protocol verb with `approval_action_unknown`. The refusal exists because `request-changes` would complete the gate as `refine` without the host taking the loopback. `decidedAt` keeps its fallback: the output schema requires it, and the node is `side-effectful`, so a replay fork serves recorded outputs. Without `ctx.loopback`, nothing changes |
| D8 chain loader | `expandChain` carries `FragmentEdge.loopback` through `normalizeEdgeLoopback`. It stays dormant until the vendored manifest schema admits the field |
| Cards | `interrupts/approvalResumeValue.ts`: both approval cards send `refine` as `{action, refineFeedback: {scope:'whole', text?}}`. Before this, a refine click was always a `400`. Label `actionRefine` added in 4 locales |

**After openwop 2.46.44 (RFC 0258 `Active`, 2026-11-08):**

- **Marker.** `LOOPBACK_MARKER_WRITE_KEY` is now `loopback`, the declared `nodeCompleted.loopback`. The reader still accepts `openwop-loopback`.
- **`ApprovalData.loopback`.** It is projected onto `interrupt.requested` as the closed `{round, maxIterations, exhausted}` triple.
- **Advert.** `capabilities.loopback` is `{status: experimental, since, until, witness: witnessable-gated, maxIterations: 10, maxHistoryEntryBytes: 65536}`. It is present exactly when `OPENWOP_BOUNDED_LOOPBACK` is on, and it reads the same constants admission enforces.
- **Fixtures.** `conformance-loopback-refine` and `-fail` load through `normalizeEdgeLoopback`. With the flag off, that call throws, so the fixtures are skipped and not advertised. `fixtureGraphRefused` also runs `planLoopbacks`.
- **Dependent on vendoring.** The marker flip is honest on a major-2 read only once the 2.46.44 schemas are vendored (`sync-schemas`, `sync-fixtures`, conformance pin `^2.46.44`). Those land in this PR, together with the edits above.
- **Before a certified cut.** The deploy must run with `OPENWOP_BOUNDED_LOOPBACK=true`. Otherwise nothing is advertised and every `0258.*` leg reads `inapplicable`.
