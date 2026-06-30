# ADR 0165 — RFC 0118 parallel sub-workflow fan-out: host witness

Status: implemented

## Context

RFC 0118 (parallel sub-workflow fan-out + join) is `Active` on `openwop/openwop`. It adds an
additive wire shape to `core.dispatch`: `fanOutPolicy: 'parallel'` + `joinPolicy` (`mode` ×
`onChildFailure`) + `maxConcurrency` on `dispatch-config.schema.json`, the
`core.dispatch.fanOut` / `core.dispatch.join` event `$defs` on `run-event-payloads.schema.json`,
and `capabilities.dispatch.{fanOutSupported, fanOutPolicies, joinModes, maxFanOut}`. The
conformance scenario `dispatch-fanout-parallel.test.ts` ships in
`@openwop/openwop-conformance@1.45.0`.

openwop-app is the reference dispatch host, so it is the natural **witness #1** toward
`Active → Accepted` (the dual-witness rule: graduation needs a second independent non-steward
witness too). This is host work riding an `Active` RFC — the same reference-witness posture as
ADR 0153 Track 2 / RFC 0117: the host advertises the capability **only** because it genuinely
serves it, so the claim survives `OPENWOP_REQUIRE_BEHAVIOR=true`.

## Decision

Land the host witness as a self-contained, single-source seam — no new run/dispatch model, no
parallel surface:

1. **`host/dispatchFanOut.ts`** — the load-bearing, host-agnostic RFC 0118 logic and the single
   source of truth for advertise/serve parity:
   - `foldJoin(terminals, joinPolicy)` — the normative join-fold: `joinOutcome`
     (`satisfied`/`failed`/`partial`) × counts × `mergeOrder`, per `mode`
     (`wait-all`/`quorum`/`first`/`race`) and `onChildFailure` (`collect`/`fail-fast`/`absorb`).
     `mergeOrder` is the replay-deterministic tiebreak — recorded at terminal-fold time in the
     parent host's observed terminal order, never recomputed from child timestamps.
   - `runParallelFanOut(...)` — the bounded-concurrency coordinator
     (`min(maxConcurrency, maxFanOut)`, no child dropped above the ceiling) that emits the
     `core.dispatch.fanOut`/`join` events and folds via `foldJoin`. The caller supplies how a
     child is actually dispatched, so the same logic serves the witness seam and the future
     executor path.
   - `validateDispatchFanOutConfig(config, fanOutSupported)` — the registration cross-field MUSTs
     (`joinPolicy`-without-`parallel`; `quorum` mode without `quorum`; `parallel` on a
     non-supporting host).
   - `dispatchCapability()` — the advertised `dispatch` family.

2. **`routes/dispatchFanOut.ts`** — `POST /v1/host/openwop-app/dispatch/fanout` (product, always
   on) + the conformance alias `POST /v1/host/sample/dispatch/fanout` (env-gated
   `OPENWOP_TEST_SEAM_ENABLED`, like the RFC 0117 ui-plugin seam). The seam runs the REAL
   coordinator + fold; it supplies a deterministic child-dispatcher (each `nextWorkerIds[i]` → a
   `completed` child terminal) so the witness exercises the genuine join semantics without needing
   registered child workflows.

3. **`routes/discovery.ts`** — advertises `dispatch` at the document root (RFC 0073), read from
   `dispatchCapability()`.

### Honesty note — what is real vs. simulated

The **normative core** (the join-fold + bounded coordinator + the advertised capability) is real
production logic, unit-tested and exercised end-to-end by the conformance scenario. What the
witness seam *simulates* is the child **dispatch** substrate: it folds synthetic `completed`
terminals rather than spawning real child runs through the executor. This mirrors the RFC 0117
`conformance-canary` pattern (real logic, synthetic inputs) and is what makes the behavioral leg
non-vacuous. **Full executor-integrated parallel `core.dispatch`** (real child runs + emitted run
events through a live run context) is the production consumer and is deliberately out of scope
here — a follow-on, exactly as the RFC 0117 Track-2 front-end loader was. Accept needs witness #2,
not the live consumer.

## Verification

`@openwop/openwop-conformance@1.45.0`, `dispatch-fanout-parallel.test.ts`, non-vacuous under
`OPENWOP_REQUIRE_BEHAVIOR=true`:

```
OPENWOP_CONFORMANCE_ROOT=<vendored-suite> OPENWOP_REQUIRE_BEHAVIOR=true \
  npm run test:conformance -- --filter dispatch-fanout
# → dispatch-fanout-parallel.test.ts: 10 passed, exit 0
```

18 host unit/HTTP-boot tests green; `tsc --noEmit` clean. Recorded in `conformance.md` (RFC 0118
section, suite 1.45.0).

| Phase | Status |
|---|---|
| Join-fold + coordinator + validator + capability (`host/dispatchFanOut.ts`) | implemented |
| Witness seam + conformance alias (`routes/dispatchFanOut.ts`) | implemented |
| Discovery advertisement (`dispatch` root family) | implemented |
| Executor-integrated real `core.dispatch` parallel path | implemented (executor arm, below) |

## Executor arm — real `core.dispatch` `fanOutPolicy:'parallel'`

The witness seam proved the join semantics; this arm makes a *registered* workflow actually run
parallel fan-out. It was `/architect`-reviewed first (replay/fork is the #1 risk) and built per
that review's two reframes.

**Registration (`host/workflowDefinitionValidation.ts`).** Flipped from rejecting all non-`sequential`
fan-out to **accepting `parallel` when advertised**, single-sourced off `dispatchCapability()` /
`validateDispatchFanOutConfig()` so advertise/accept can't drift. Negative cases enforced at
`POST /v1/workflows`: unknown policy → `capability_not_provided`; `joinPolicy` without `parallel`,
`joinPolicy.mode ∉ joinModes`, `mode:'quorum'` missing `quorum`, and `onChildFailure:'fail-fast'` →
`validation_error`. This closed an honesty gap the witness PR left open: discovery advertised
`fanOutSupported:true` while registration still rejected `parallel`.

**Dispatch (`bootstrap/nodes.ts` `core.dispatch`).** When `fanOutPolicy:'parallel'` with >1 worker,
the serial `await`-loop is replaced by the bounded `runParallelFanOut` coordinator dispatching each
child via the **existing** `dispatchSubWorkflow` (lineage/ancestry/cycle checks unchanged — they are
properties of the immutable persisted ancestor chain, so concurrent siblings are safe). It emits
`core.dispatch.fanOut` (wave begin, `causationId` = the consumed `runOrchestrator.decided`) and
`core.dispatch.join` (`causationId` = the `fanOut`), keeps per-child `node.dispatched`, and produces
the RFC 0118 §D node output `{joinOutcome, children:[{workflowId, childRunId, childStatus, error?}]}`.

**Replay/fork determinism (R1 — the dominant risk).** Children are dispatched **without**
`outputMapping`; the parent variable bag is written **once, in the recorded `mergeOrder`** (the
observed terminal order, recorded on the `core.dispatch.join` event) as a post-join fold — so a
colliding parent variable resolves to the last-in-`mergeOrder` winner **reproducibly**, never
recomputed from child wall-clock. This mirrors the RFC 0061 iteration-counter pattern (record on the
event, re-emit verbatim on replay). The falsifiable gate is `test/dispatch-fanout-executor.test.ts`:
the first-dispatched child is made to terminate last, and the test asserts *its* value wins the
collision — which only holds if application follows `mergeOrder`, not dispatch/array order.

### Honest v1 limitations (advertise only what is honored — capabilities.md)
- **Only `joinMode:'wait-all'` is advertised/accepted.** `quorum`/`first`/`race` and
  `onChildFailure:'fail-fast'` need cancelling in-flight children per the interrupt-profiles
  parent-child cascade, but `executor/subWorkflowDispatcher.ts` always awaits a child to terminal
  with no mid-run cancel hook (ENG-9). `foldJoin` already implements all four modes — they light up
  when child cancellation lands. Narrowing the advertisement keeps `OPENWOP_REQUIRE_BEHAVIOR=true`
  honest.
- **`onChildFailure ∈ {collect, absorb}`** (neither short-circuits) are honored; `fail-fast` is rejected.
  Made **discoverable** via the `onChildFailureModes` descriptor (below).
- A child that **suspends** under a parallel wave is treated as a child-level failure in the join (v1);
  the suspension-cascade is honored on the sequential `core.subWorkflow` path. Documented limitation.

### `onChildFailureModes` capability descriptor (RFC 0118 §seam amendment, openwop#789)

The original cut capability-gated only `joinPolicy.mode` (`joinModes`). The second axis,
`onChildFailure`, was honored-or-rejected at registration but **not discoverable** — a portable
workflow pinning `onChildFailure:'fail-fast'` registered on a host that cancels children yet failed
registration here, with nothing in `/.well-known/openwop` to explain why (the undiscoverable-footgun
gap, surfaced by openwop-1's architect review on the 0117 coordination queue). The amendment adds an
additive `capabilities.dispatch.onChildFailureModes` descriptor mirroring `joinModes`:

- This host advertises **`["collect","absorb"]`** (single-sourced off `dispatchCapability()`; both
  honored without child cancellation). `fail-fast` is omitted.
- Registration gate: `onChildFailure ∉ onChildFailureModes` → `validation_error`
  (`workflowDefinitionValidation.ts`, driven off the descriptor — no longer a hard-coded `fail-fast`
  check, so accept/advertise can't drift).
- Per the amendment, **absent ⇒ `["collect"]`** and a non-advertising host MUST reject
  `fail-fast`/`absorb`; advertising the descriptor is precisely what lets this host keep honestly
  accepting `absorb`. Purely additive (new optional descriptor, no `DispatchConfig` wire change),
  safe under Active RFC 0118.

**Sequencing:** this host change lands as a follow-on PR but **merges only once openwop#789 reaches
`Accepted`** (host work rides the Accepted amendment).

**Consumer contract (campaign-orchestration P1.5, owned by a parallel session) — all stable + landed:**
(1) `capabilities.dispatch.fanOutSupported:true`; (2) validation accepts `parallel` + `joinPolicy`;
(3) the `{joinOutcome, children[]}` node-output shape.

| Executor-arm phase | Status |
|---|---|
| Registration validation flip + negative cases | implemented |
| Capability narrowed to honorable `wait-all` | implemented |
| Parallel coordinator + `fanOut`/`join` events + node output | implemented |
| R1 — `outputMapping` re-applied in recorded `mergeOrder` (+ falsifiable replay test) | implemented |
| `quorum`/`first`/`race` + `fail-fast` (needs child cancellation) | deferred |

## Status toward graduation

openwop-app is **witness #1** for RFC 0118 (gate #1: published-suite reference witness). The
remaining gate is a **second independent non-steward witness vs 1.45.0** — external, not host
work.
