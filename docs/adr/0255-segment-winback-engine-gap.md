# ADR 0255 — Segment-winback fan-out is an RFC-gated engine feature, not a chain step

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | accepted (2026-07-04) — corrects + reclassifies the ADR 0243 §"Open items" segment-winback follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0243 (journey depth — the over-claim this corrects), ADR 0222 (single-contact journeys), RFC 0118 (`core.dispatch` parallel fan-out), RFC 0022 (dispatch input/output mapping), ADR 0154/0165 (executor fan-out arm) |

## Context

ADR 0243 designed a segment winback — `segment-members` (source, shipped) → a
supervisor projecting `contactIds` into a per-worker plan → a `core.dispatch` node
fanning each member out to a child run of the single-contact
`campaign-journeys.re-engage-contact` journey — and asserted it was "the one
operator/next-PR composition step (the design is fixed here)."

Investigating the composition (OI-3 of the `/plan open items` batch) against the
actual executor **disproves that claim**. This ADR records the finding, corrects
ADR 0243, and reclassifies the work.

## Finding — the engine does not support data-parallel fan-out

The `core.dispatch` parallel arm (`backend/typescript/src/bootstrap/nodes.ts`,
`runParallelFanOut` in `host/dispatchFanOut.ts`) dispatches one child per entry of
a supervisor's `nextWorkerIds: string[]` (a list of **workflow ids**). Each child's
inputs are built here:

```js
dispatchChild: async (childWorkflowId, idx) => {
  const inputMapping = perWorkerInputMappings?.[childWorkflowId] ?? defaultInputMapping;
  await dispatchSubWorkflow({ childWorkflowId, inputMapping, ... });
}
```

- Child inputs come from `inputMapping` **keyed by `childWorkflowId`** (RFC 0022:
  `effectiveInputMapping = perWorkerInputMappings[workerId] ?? inputMapping`, where
  `workerId` is the **workflow id**).
- The fan-out **index `idx` is used only for terminal/merge ordering** — never for
  input selection.

So RFC 0022's per-worker mapping distinguishes **different worker workflows** (the
5-distinct-channel orchestration precedent, where each worker is its own workflow),
NOT **N instances of one workflow with per-item data**. Putting
`re-engage-contact` into `nextWorkerIds` N times gives every child the **same**
`inputMapping` → the **same contactId**. A segment sweep built on this today would
mail one contact N times and never touch the other N−1 — a silent, severe bug.

**Data-parallel fan-out (one child workflow × N items, each with a distinct
per-item input drawn from an upstream array) is an unimplemented capability.**

## Decision

**Do NOT ship a data-driven segment-winback chain on this host. Reclassify it as an
RFC-gated engine feature and defer.**

- The missing capability is a **new dispatch semantic** — a `core.dispatch` mode
  that expands one `childWorkflowId` over a runtime array, projecting
  `items[i] → child.inputs`. That is **wire-affecting** (a new `core.dispatch`
  config/behaviour the SDK types and conformance must cover), so it needs an **RFC
  in `../openwop`** (amend RFC 0118 + RFC 0022, or a new "data-parallel dispatch"
  RFC) reaching at least `Accepted` **before/with** the executor work — it is NOT
  host-only, and NOT a chain-pack composition.
- ADR 0243 is corrected in place (an inline note at the supervisor-shape section)
  per the CLAUDE.md "correct, don't rewrite history" rule; the `segment-members`
  source node it shipped stands (it is the future consumer's input).

## Alternatives weighed (and why they don't rescue an in-host ship)

- **N copies of `re-engage-contact` in `nextWorkerIds` + one shared inputMapping.**
  Broken — all children get the same contactId (the finding above).
- **A supervisor node that creates child runs directly** (bypassing `core.dispatch`,
  reaching into run-creation with per-contact inputs). Rejected — re-implements the
  RFC 0118 dispatch primitive worse and outside the engine boundary; the same
  "parallel path" anti-pattern ADR 0243 rejected for the serial loop.
- **A bounded serial per-member loop** inside a supervisor node. Rejected by ADR
  0243 already (re-implements fan-out worse than the primitive); and it still can't
  give each member an independent, joined, replay-deterministic child run.
- **Ship the projection supervisor node now** (contactIds → a dispatch-plan array).
  Rejected — a node whose output **nothing can consume** (no data-parallel executor
  path) is speculative dead weight; author it WITH the engine feature.

## Consequences

- The `/plan open items` OI-3 is **deferred**, not delivered — honestly, because
  the enabling engine capability is absent and RFC-gated.
- The next step is spec work in `../openwop` (the data-parallel dispatch RFC), then
  the executor arm + the supervisor node + the chain, as one RFC-gated track.
- No broken or misleading artifact ships. This is the architecture review doing its
  job: catching that a "fixed design" rested on a capability that does not exist.

## Open items (deferred to the RFC track)

- **Data-parallel `core.dispatch` RFC** in `../openwop` (amend RFC 0118/0022) —
  `items[i] → child.inputs` for one `childWorkflowId`; bounded by `HOST_MAX_FAN_OUT`
  + a member cap; replay-deterministic join (`mergeOrder`).
- **Then**: the executor arm, the projection supervisor node, and the
  `campaign-journeys.segment-winback` chain (source → supervisor → data-parallel
  dispatch → `re-engage-contact` child, enroll-CAS dedup).
- **Per-contact send index** (ADR 0243's other deferral) — still gated on
  `checkFrequency` becoming hot; unaffected by this finding.

## Delivery record — the RFC-gated track is now COMPLETE (2026-07-04)

The whole deferred track shipped, in RFC-gated order. The `Status` stays `accepted`;
this section records that the "deferred" open items above are now delivered.

| Step | What landed | Where |
|---|---|---|
| RFC | **RFC 0126** (data-parallel `core.dispatch` — per-item input fan-out) authored via `/prd`, driven to **`Accepted`** | `../openwop/RFCS/0126-*`; openwop **#826** (schema `nextWorkerInputs`, `capabilities.md §dispatch.perItemInput`, conformance) |
| Executor arm | `dispatchChild` projects `decision.nextWorkerInputs[idx]` over the RFC 0022 mapping; fail-closed gate; capability **honest-off** at first | openwop-app **#1278** (`bootstrap/nodes.ts`, `subWorkflowDispatcher.ts`, `host/dispatchFanOut.ts`) |
| Supervisor node | `feature.campaign-journeys.nodes.segment-winback-plan` — projects a resolved segment's `contactIds` into a `next-worker` decision (one child × N, per-contact `nextWorkerInputs`); shape mirrors `core.orchestrator.supervisor` | openwop-app **#1279** (`packs/feature.campaign-journeys.nodes`) |
| Capability flip | `perItemInputSupported()` → **honest-ON** now that RFC 0126 is `Accepted` (env is now a `=false` disable hatch); advertised at the live `/.well-known/openwop` discovery root | this PR (`host/dispatchFanOut.ts`) |
| Installable chain | **`campaign-journeys.segment-winback`** RFC 0013 chain (`segment-members` source → `segment-winback-plan` supervisor → parallel `core.dispatch` → `re-engage-contact` child) — pack `1.0.0 → 1.1.0` | this PR (`examples/workflow-chain-packs/campaign-journeys/pack.json`) |

Operational wiring: install `campaign-journeys.re-engage-contact` in **deferred mode**
(RFC 0124) so each fanned child binds its own `contactId` + shared params per run,
then pass that `workflowId` as the chain's `childWorkflowId`; `segmentId` rides the
run inputs. The child enroll-CAS keeps a re-swept segment idempotent (no double-send).
End-to-end proof: `test/workflow-chain-segment-winback-execution.test.ts` runs a real
3-contact segment → 3 children, each with a distinct `contactId`.
