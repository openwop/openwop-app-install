# ADR 0341 — Replay forks never fire side effects: source-outcome reproduction for impure nodes

Status: implemented (2026-07-10)

## Context

ADR 0326 P3b made `replay`-mode forks **provider-deterministic**: `callAI`
reads the source run's invocation log, so LLM attempts (including recorded
failures) reproduce exactly. But every OTHER node re-executed **live** — a
replay of a run containing `core.openwop.http.fetch` or an email/SMS/A2A send
fired the effect *again*. The grade pass filed this as `GC-FORK-2`: a
"deterministic replay" that re-sends email is a correctness surprise, and the
spec's replay semantics ("re-execute **pure** nodes deterministically") never
promised re-firing impure ones.

## Decision

1. **Classification is host-owned.** `executor/sideEffects.ts` holds a typeId
   pattern list (the `isLlmNodeTypeId` precedent) plus an optional
   `NodeModule.sideEffecting` flag for programmatic registration. It is
   deliberately NOT workflow-author config — config could lie a node "pure",
   which is a correctness hazard, since purity is a property of the node type.
   v1 families: `core.openwop.http.fetch`, `core.openwop.integration.*`
   (email/SMS/Slack/push/voice sends), and the `core.openwop.a2a.*` write
   verbs (send/push/cancel/emit/publish/trigger/coordinator). Read verbs stay
   live.
2. **Reproduce, don't re-fire.** During a replay fork the executor folds the
   SOURCE run's event log once into `nodeId → ordered terminal outcomes`
   (`indexSourceOutcomes`, batched drain) and short-circuits each flagged
   node: attempt N reproduces the source's Nth outcome — completed outputs
   verbatim, or the recorded failure — through the normal event emission, so
   the replay's event sequence stays byte-identical (ADR 0326 P3a attempt
   fidelity, extended from `callAI` to whole impure nodes).
3. **Fail closed on a missing record.** A flagged node the source never
   reached (upstream divergence, early failure) fails with
   `replay_source_missing` — *a replay never creates a NEW side effect*,
   under any circumstances. Live-execute-with-a-warning was rejected: it
   re-opens the exact hole this ADR closes.
4. **Pure and LLM nodes keep full live re-execution**, preserving the spec's
   re-execute semantics and the RFC 0041 §B refusal-divergence machinery
   (which compares live re-execution against the source and would be vacuous
   if everything were log-served). This is also why "serve ALL nodes from the
   log" was rejected.

## Wire posture

**Host-internal when this ADR landed; SUPERSEDED as of RFC 0140 / ADR 0533.**

As written, this ADR was host-internal: no run-event shape, capability advert,
or endpoint contract changes; the conformance fork scenarios (pure test nodes)
were unaffected and verified green. No RFC was required.

That is no longer the whole picture, and the reversal is worth stating plainly
rather than leaving a stale claim in place. RFC 0140 turned this behavior into
an **interop guarantee**: a calling host dispatching into a peer (RFC 0007,
RFC 0063) needs to know whether replaying a run will cost it real money, and
"host-internal" means unanswerable across a federation boundary. So the wire
surface DID change:

- `replay.sideEffectSuppression: "recorded-outcome"` is now advertised on
  `/.well-known/openwop` (`routes/discovery.ts`). RFC 0140 rule 5 forbids
  advertising it on classification alone — this ADR's mechanism is only half
  the bar; ADR 0531's default-deny seam guard is the other half, and both must
  hold.
- `replay_source_missing` is a **normatively registered** node-failure code
  (`spec/v1/rest-endpoints.md` §"Common error codes"), not a host-chosen
  string. Its spelling is now a compatibility surface.
- `GET /v1/host/sample/replay/effect-count` (ADR 0533) exposes the effect
  tally the conformance scenario reads.
- `node.failed` payloads now carry `nodeId` — required by
  `run-event-payloads.schema.json` §`nodeFailed` all along, but emitted only on
  the envelope until the RFC 0140 witness surfaced it.

A future *pack-manifest* `sideEffecting` declaration would touch the RFC
0117/0119 manifest schema — that is the recorded extension path, not this ADR.
RFC 0140 §Alternatives 5 records why it was not taken now (it would have to be
monotonic opt-in, and it overlaps `actions[].idempotent`).

## Alternatives weighed

- **Serve every node from the source log** — rejected (vacates re-execution
  semantics + divergence detection).
- **A second "side-effect invocation log"** — rejected (parallel-architecture
  smell; the event log already records every node outcome).
- **Record-only posture** — rejected (the status quo the audit flagged).
- **Author-facing config flag** — rejected (a lying flag un-suppresses a real
  side effect).

## Phase record

| Piece | Landed |
|---|---|
| `sideEffects.ts` classifier + source-outcome index | this ADR's PR |
| Executor short-circuit (per-attempt, fail-closed) + `NodeModule.sideEffecting` | this ADR's PR |
| e2e: suppression + P3a-fidelity retried sequence + fail-closed missing-record + pure-node-still-live | `executor-durability-adr0326.test.ts` |

Cross-reference: ADR 0326's phase table — this is the P3c follow-through the
P3b commit's "replay mode still full re-execution" gate note anticipated.
