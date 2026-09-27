# ADR 0243 — Journey depth: segment fan-out, engagement branching, frequency caps

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0222 §Deferred follow-on (verbs + recipes) |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0222 (journeys), ADR 0218/0242 (email engagement — opens/clicks), ADR 0217 (suppression), RFC 0118 / ADR 0154 (`core.dispatch` fan-out), RFC 0022 (per-worker projection) |

## Context

ADR 0222 shipped single-contact journeys as RFC 0013 chains and **deferred** three
depth items, each framed as "a verb + a recipe":
1. **Segment-wide sweeps** — need per-member fan-out, "expressible with
   `core.dispatch` once a per-member supervisor shape is designed."
2. **Behavioral branching on engagement** — "the engagement rows are queryable,
   but a read verb + edge-condition recipe is a follow-on."
3. **Frequency caps** — "a per-contact send-count verb over the send ledger."

All primitives already exist: chain edges carry `EdgeCondition` (scheduler
`evaluateCondition`), `core.dispatch` parallel fan-out is implemented + advertised
(RFC 0118), and PR-7 added opens beside clicks.

## Decision

Ship the **three read verbs** on the journey surface (`ctx.features['campaign-
journeys']`) + node pack, and DESIGN the three recipes. The verbs read THROUGH the
owning services (the established `checkEligibility` precedent — journey→crm/consent);
they are **LIVE reads by design** (a journey fork/replay re-evaluates against the
recipient's CURRENT state — a journey is a live marketing flow, not a
deterministic-replay artifact; the enroll-CAS is the idempotency guard). **A
verb result is never stamped into `run.metadata` as durable/authoritative.**

- **`checkEngagement(contactId, campaignId?) → {opened, clicked, openCount, clickCount}`**
  over `email:engagement`. Node `feature.campaign-journeys.nodes.engagement`.
  **Recipe (branching):** `send A → wait → engagement → EdgeCondition
  {path:'opened', op:'truthy'}` gates the follow-up send B (else a different/no send).
- **`checkFrequency(contactId, windowDays, maxSends) → {sentCount, withinCap}`**
  over the email send ledger (`emailService.contactSendCount` — email owns its
  ledger, the SSoT). Node `…nodes.frequency-gate`. **Recipe (cap):**
  `frequency-gate → EdgeCondition {path:'withinCap', op:'truthy'}` gates the send
  so a saturated contact is skipped.
- **`resolveSegment(segmentId) → {contactIds, total, truncated}`** over
  `resolveSegmentMembers`, **capped at 5000** (`truncated` surfaces the drop — no
  silent 50k fan-out). Node `…nodes.segment-members`.

### Segment fan-out supervisor shape (the ADR 0222 open design question)

A segment winback composes: `segment-members` (source) → a supervisor that
projects the `contactIds` into a per-worker dispatch plan → a **`core.dispatch`**
node fanning each member out to a child run of the **existing single-contact
`campaign-journeys.re-engage-contact` journey** (installed as a workflow):

```
core.dispatch config:
  workerDispatchModel: 'child-run'
  fanOutPolicy: 'parallel'
  maxConcurrency: 10-25            # rate-limit friendliness vs the email provider
  joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' }   # best-effort — one member's failure never aborts the sweep
  # per-worker input (RFC 0022): each contactId → the child run's inputs.contactId
```

The child's **enroll-CAS** makes a re-dispatched sweep duplicate-safe; each send
carries its own idempotency key. Concurrency is bounded (`maxConcurrency` +
`HOST_MAX_FAN_OUT`); the member list is bounded (`resolveSegment` cap). This is
the "per-member supervisor shape" ADR 0222 deferred — now designed and its
**source node shipped**; wiring a data-driven `core.dispatch` chain (vs the
static-child-list orchestration precedent) + a per-worker projection supervisor is
the one operator/next-PR composition step (the design is fixed here).

> **Correction (ADR 0255, 2026-07-04):** the "one composition step" claim is
> WRONG — verified against the executor. `core.dispatch` builds each child's
> inputs from `inputMapping` keyed by **childWorkflowId** (`bootstrap/nodes.ts`
> `dispatchChild`); the fan-out index is used only for terminal ordering, never
> for input selection. So N copies of `re-engage-contact` all receive the SAME
> contactId — **data-parallel fan-out (one workflow × N items, per-item input) is
> NOT implemented.** A segment sweep therefore needs a new data-parallel dispatch
> semantic (an RFC-gated ENGINE feature — amend RFC 0118/0022), not a chain-pack
> wiring step. Reclassified + deferred in **ADR 0255**; the `segment-members`
> source node stands.

## Alternatives considered

- **Serial per-member loop** for the sweep — REJECTED: it re-implements fan-out
  worse than the RFC 0118 primitive; `core.dispatch` with a bounded
  `maxConcurrency` already gives rate-limit friendliness + replay-deterministic
  join.
- **A per-contact send index now** — DEFERRED: `checkFrequency` scans the
  retention-bounded ledger at journey-step time (not a hot path); an index is
  premature infra for a deferred nice-to-have.

## Scope & wire

- No wire/RFC: the verbs are host-ext surface methods; `core.dispatch` rides the
  already-Accepted RFC 0118 (the host already advertises `dispatch.fanOutSupported`).
- Boundary: journey→email/crm reads go through the owning services (SSoT), the
  established `checkEligibility` pattern.

## Open items (deferred)

- **A shipped data-driven `core.dispatch` segment-winback chain** + its per-worker
  projection supervisor (the design is fixed above; the composition + a boot-safe
  example chain is the next step). **RECLASSIFIED — ADR 0255:** NOT a chain step —
  the engine has no data-parallel (one-workflow × N-item, per-item input) fan-out;
  it's an RFC-gated engine feature (amend RFC 0118/0022). Deferred to that track.
- **Per-contact send index** if `checkFrequency` becomes hot.
