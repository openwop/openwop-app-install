# ADR 0207 — Chain edge conditions (content routing in workflow-chain packs)

**Status:** implemented
**Date:** 2026-07-03
**Depends on:** ADR 0200 (data-ops templates — this delivers the router canon it deferred), RFC 0013 (workflow-chain packs), the RFC 0013 safety-fix amendment (openwop#818)

## Why this exists

ADR 0200 §Scope deferred `core.flow.router`/`switch` content routing in chains because `expandChain` **dropped** the fragment edge's `condition` field, so a router's branch never gated — every branch fired. This ADR fixes that end-to-end so a chain can route a record to the matching branch (the Make "router" canon).

## The finding that shaped it: three condition shapes, host diverged from wire

- **Wire** `EdgeCondition` (`workflow-definition.schema.json §EdgeCondition`): `{ type: expression|equals|notEquals|contains|regex, left, right?, expression? }` — what RFC 0013 §edges ("same shape as a top-level workflow definition") normatively points to.
- **Host executor** `EdgeCondition` (`executor/scheduler.ts:61`, evaluated at `scheduler.ts:344`): `{ path, op: eq|neq|truthy|falsy|exists|contains, value? }`.
- **Chain manifest** `FragmentEdge.condition`: was typed `string` — contradicting its own description AND both shapes above.

The host executor **already evaluates** edge conditions but in its own `{path,op}` shape and never maps the wire shape. So the app was already non-conformant on edge-condition shape, and this change sits on that fault line.

## Decision

1. **Wire safety-fix (openwop#818, merged):** `FragmentEdge.condition` `string` → the inlined `EdgeCondition` object (identical to `workflow-definition.schema.json §EdgeCondition`). Classification **safety-fix** — no chain used the string form (hosts dropped it at expansion), so no conformant behavior depended on it; the schema now matches the normative prose it already committed to. Conformance gained a positive (object validates) + negative (string rejected) case.
2. **Host: map wire→host at the expansion seam** (`workflowChainPackLoader.ts`). `expandChain`'s `mappedEdges` now carries `e.condition`, translating the wire `EdgeCondition {type,left,right}` → the host `EdgeDef.condition {path,op,value}` (`equals→eq`, `notEquals→neq`, `contains→contains`; `left→path`, `right→value`). **`expression`/`regex` are rejected at EXPAND time** (`chain_edge_condition_unsupported`) — this host does not evaluate them, so a chain must not silently ship an edge that never fires (advertise only honored behavior). This is the single wire→host translation seam; the executor is untouched.
3. **Proof: `data-ops.content-router`** (data-ops pack 1.0.0→1.1.0) — `core.flow.router` predicates on a record field and emits matched `branches: [labels]`; the three branch edges gate on `{type:'contains', left:'branches', right:'<label>'}`. Only the matching branch fires. Tests assert the mapped shape, that the **real** `evaluateCondition` gates it, that unsupported types throw at expand, and that condition-free chains are byte-unchanged.

## What this does NOT do (deferred, with reasons)

- **The app-wide host/wire `EdgeCondition` divergence** (host `{path,op}` vs wire `{type,left,right}` for *every* workflow, not just chains) is a real pre-existing gap. Reconciling it — the executor consuming the wire shape everywhere — is a broader wire-conformance project on the executor hot path with its own blast radius. This ADR installs the mapper at the chain-expansion boundary **only** and flags the divergence for a separate ADR/RFC.
- **`it-support.incident-triage`'s both-branches-fire bug is NOT fixed here.** Its routing is LLM-freeform-text (the `route` node is a vestigial empty `core.flow.if`; the classification lives in the `classify` node's prose). Gating it cleanly needs a structured-classification refactor; a fragile text-`contains` condition would be worse than the current behavior. It is a real bug (same class as the people-hr ungated-write) but its honest fix is a separate, careful chain refactor — not something to force through on this mechanism's coattails.
- **The loop primitive** (batch-processing via `split-in-batches` loop-back) remains deferred — the scheduler is forward-DAG-only; a true loop needs executor cycle-support + replay implications. Out of scope.

## Replay/fork

Edge conditions evaluate against the **source node's output at schedule time**; on `:fork` that output is the frozen checkpoint value, so the branch decision is deterministic and stable. No new non-determinism.

## Consequences

- Chains can express content routing; the ADR 0200 router-canon gap is closed honestly (structured predicate, not fragile text).
- No OpenWOP wire change beyond the merged RFC 0013 safety-fix; the host change is the one expansion-seam mapper. No new RFC.

## Correction (2026-07-03) — "only the matching branch fires" was not yet true

The Decision §3 / Consequences claim that content-router's unmatched branches don't fire was **wrong at the time this ADR landed**. Mapping the condition to the host shape was necessary but **not sufficient**: the executor evaluated the condition only for *input contribution* (`buildNodeInputs`, `scheduler.ts:344`) while `evaluateTrigger` keyed purely on upstream *state* — so a false-conditioned branch node still became `ready` and **executed with empty inputs**. Edge conditions gated data-flow, not control-flow. Verified empirically: a router with three branch edges fired all three (unmatched ones with `undefined` input — a `notification-push` branch would send an empty notification). The wire spec (`workflow-chain-packs.md §edges`) actually mandates control-flow ("a branch that fires only when the condition holds"), so the host was **non-conformant**. The executor fix is **[ADR 0208](0208-edge-condition-control-flow.md)**; with it, content-router routes exclusively as this ADR claimed, and the reference `data-ops.content-router` is correct as shipped (no chain change needed).

## Phase 2 (2026-07-03) — the second ingest seam + one SSoT mapper

The "app-wide host/wire `EdgeCondition` divergence" deferred above is now closed at the **register route** too. The mapper was extracted to a shared module — **`host/edgeConditionMapping.ts`** — and both condition-ingest seams route through it:

- **Chain expansion** (`workflowChainPackLoader.ts`) imports `mapEdgeCondition` (unchanged behavior).
- **`validateWorkflowDefinition`** (the `POST /v1/host/openwop-app/workflows` register route + the workflow-author service) now calls **`normalizeEdgeCondition`** instead of casting any object straight through. A conformant client emits the WIRE shape `{type,left,right}` (that is what `workflow-definition.schema.json §EdgeCondition` defines); the old verbatim cast left the executor with `path`/`op` undefined, so the edge was silently **dropped** (fail-closed dead branch, no error). `normalizeEdgeCondition` discriminates: host-native `{path,op,value?}` → pass through (the first-party builder emits this); wire `{type,left,right?}` → map; anything else → reject fail-closed.

Normalization is **write-time only** (registration / authoring / expansion — none of `validateWorkflowDefinition`'s callers re-validate at run or fork time), so stored definitions are host-shaped at rest and this carries no replay hazard; a definition registered before the fix keeps its stored shape until re-registered. The `it-support.incident-triage` deferral above is also resolved — see ADR 0208.
