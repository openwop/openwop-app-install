# ADR 0208 — Edge conditions are control-flow, not just data-flow (executor conformance fix)

**Status:** implemented
**Date:** 2026-07-03
**Depends on:** ADR 0207 (chain edge conditions — this fixes the executor beneath it), RFC 0013 §edges, `spec/v1/workflow-chain-packs.md`

## Why this exists

While reviewing the ADR 0207 deferred work, an empirical probe of the DAG scheduler revealed that **edge conditions did not actually route**. The executor evaluated a condition only to decide whether a source's output *contributed to the target's input* (`buildNodeInputs`, `scheduler.ts:344`), but `evaluateTrigger` decided whether a node *runs* purely from its upstreams' **states**. A completed source whose edge condition was **false** left the target `ready`, so it **executed anyway** — with empty inputs.

Probe (`buildGraph`/`freshSnapshot`/`releaseDownstream`): `A → B (sev==major)`, `A → C (sev!=major)`, complete `A` with `{sev:'routine'}` → **`B=ready, C=ready`**. Both branches ran. A `core.flow.router`/`if` never routed; the ADR 0207 `data-ops.content-router` fired all three branches (unmatched ones calling `notification-push` with `undefined` title/body — a spurious/empty send).

## The spec already mandates control-flow

- `spec/v1/workflow-chain-packs.md §edges`: an edge condition is "**a branch that fires only when the condition holds** against the source node's output … Hosts that honor edge conditions on top-level workflows MUST honor them on expanded chain edges identically."
- `spec/v1/node-packs.md`: `core.conditional` — "Routing on edge conditions" is a reserved capability.

So this is **not a capability gap and not a wire change — it is a host executor conformance bug.** No RFC (the wire already specifies the behavior; the host was violating it).

## Decision

In `evaluateTrigger` (`executor/scheduler.ts`), fold each incoming edge's condition into an **effective upstream state**: a `completed` source whose edge condition evaluates **false** is treated as **`skipped`** (a not-taken branch), then the existing trigger-rule logic runs unchanged over the effective states. A branch whose only active incoming edge is condition-false therefore resolves to `skip` (default `all_success` sees `allTerminal && !anyCompleted`), and skip propagates downstream as it already does for failed branches.

This is minimal (reuses all five trigger rules), and `buildNodeInputs` already omitted false-conditioned edges — so inputs and control now agree.

### Consequences unlocked

- **`data-ops.content-router` becomes correct as shipped** — only the matching branch fires (what ADR 0207 claimed but did not yet deliver; see that ADR's Correction). No chain change.
- **`it-support.incident-triage` now routes** (the ADR 0207 deferral). Rewritten (pack 1.1.0→1.2.0): a `core.ai.structuredOutput` classifier emits `{severity: major|routine}`, `classify.data → route.value` feeds a `core.flow.router`, and the two branch edges gate on `{contains, branches, major|routine}`. Only the matched branch fires; the major branch stays human-gated (`approvalGate` before the Slack send); the merge node (`summary`) still runs on the taken branch (the skipped sibling is terminal-not-failed, so `all_success` releases it). Replaces the old vestigial `core.flow.if` + fragile-prose classification with honest structured routing.

## Replay/fork

`evaluateTrigger` now reads `snapshot.nodeOutputs` for a completed source and runs the deterministic `evaluateCondition`. On `:fork` the source output is the frozen checkpoint value, so the branch decision is identical — no new non-determinism. The condition was already evaluated (for input contribution) on the same path; in-flight runs replay from recorded node states and are unaffected.

## What this does NOT do (deferred, with reasons)

- **The loop primitive** (batch iteration via `split-in-batches` loop-back) remains deferred — the scheduler is forward-DAG-only (only `core.dispatch`/`core.orchestrator.supervisor` back-edges are inert). Bounded iteration is already reachable via the existing `core.dispatch` supervisor loop (RFC 0022); a *new* executor cycle-primitive is not required, so the honest follow-up is a dispatch-based batch template, not new executor cycle support.

## Test coverage

- `scheduler.test.ts` — "edge conditions are control-flow, not just data-flow": matching branch `ready` / other `skipped`, the reverse routing, and a merge-after-route firing on the taken branch (the it-support merge shape). All five trigger-rule tests still green (they use unconditioned edges, so effective state = actual state).
- `edge-condition-mapping.test.ts` — the shared ingest mapper (ADR 0207 §Phase 2).
- `workflow-chain-it-support.test.ts` — the rewritten chain expands, wires `classify.data→route.value`, maps the branch conditions, and gates via the real `evaluateCondition`.

## Phase → commit/test table

| Piece | File | Test |
|---|---|---|
| Executor control-flow fix | `executor/scheduler.ts` `evaluateTrigger` | `scheduler.test.ts` (control-flow block) |
| it-support structured routing | `examples/workflow-chain-packs/it-support/pack.json` (1.2.0) | `workflow-chain-it-support.test.ts` |
| Shared ingest mapper (ADR 0207 §Phase 2) | `host/edgeConditionMapping.ts`, `workflowDefinitionValidation.ts` | `edge-condition-mapping.test.ts` |
