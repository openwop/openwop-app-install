# ADR 0554 — Compensation saga and operator recovery runtime

Status: Accepted — P0–P2 + the wire advert implemented; P3/P4 open. P0 2026-08-12 (`595cb40e9`); P1 ledger half 2026-08-14 (`4c413d4c0`, #3214); **P2 reverse-completion unwind + retries + approval gate + DLQ parking 2026-08-16** (`800b6f0da`, #3274 — the §D events now EMIT, so P1's parked event half shipped); **the WIRE FLIP 2026-08-16** — `capabilities.compensation` is advertised, `compensationStatus` is projected onto every `RunSnapshot`, and `openwop-compensation` is gone from `OPTED_OUT_PROFILES`, all three from one constant (`host/compensationCapability.ts`); see "Wire flip — implemented 2026-08-16". **P2b (the CHAIN lane) SHIPPED 2026-08-16** (`1b2dd6fbb`, #3292 — RFC 0157 chain-carried compensation, end to end through `expandChain`, validation, registration and the builder round-trip; the `Status:` line said "blocked" for a day after it landed, corrected 2026-08-17 in § "Merged-tree provenance"). **P3 Operations recovery SHIPPED 2026-08-17** — three distinct RBAC scopes (`host:compensation:start|retry|waive`, the waive rung OWNER-only), the obligation-scoped recovery audit chain riding the existing per-tenant hash chain, audit-before-write ordering, an `expectedState` precondition (the state machine would NOT have caught a duplicate waive: `LEGAL.failed` includes `failed`), the high-risk waive approval + separation of duties extended to the operator who STARTED the compensation, and the run-detail obligation timeline; see "P3 — Operations recovery". The three triggers beyond `node-failure` remain P3 residue. **S36 `waiveRequiresApproval` honoured end-to-end 2026-08-17** (schema vendor + the six allowlists + an effective-value stamp at mint); **S37 DECIDED (A) escalate-only (`openwop#1064`)** — escalation is a floor: an explicit `waiveRequiresApproval: false` beats the node's own `requiresApproval` but never a workspace `approvalScope` escalation; the flip cost one line because the comparison was isolated. P4 (chaos qualification) open. See `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md` (2026-08-17)

Date: 2026-08-11

Composes: executor, `host/runEffectContext.ts`, idempotency/invocation log, core
approval/interrupts, ADR 0531 replay effect suppression, ADR 0532 run DLQ, ADR
0395 Operations. Protocol gates: RFC 0151 and RFC 0150 (Draft).

## Context

The app has retries, replay suppression, a run-level DLQ and a few
feature-local forward-repair routines. It has no generic orchestration contract
for undoing business effects after a later node fails. There is no compensation
declaration, reverse ordering, compensation idempotency, partial-compensation
state, event taxonomy, approval policy or operator recovery action.

Adding a second “saga engine” beside the executor would make correctness worse.
Compensation must be a mode of the existing run state machine and effect guard.

## Decision

> **CORRECTION 2026-08-14 — this section predates RFC 0151's resolution and
> disagrees with it in three places. THE RFC WINS.** Left in place rather than
> rewritten, because the disagreement is the useful record: an ADR written
> against a `Draft` RFC is a sketch, and reading it alone is how the sketch gets
> implemented.
>
> | this section says | RFC 0151 (`Accepted`) says |
> |---|---|
> | "the executor enters `compensating`" | **§D:** the run *keeps* its execution state and adds a separate `compensationStatus: none\|pending\|running\|completed\|partial\|failed\|manual`, explicitly "to avoid reinterpreting existing run-state enums" |
> | identity = forward effect identity + compensation version | **§C:** `(tenantId, runId, forwardLogicalInvocationId, compensationOrdinal, profileVersion)`, and MUST be retry-stable |
> | outcomes `compensated` / `compensation_failed` / `compensation_blocked` / `compensation_skipped` | **§D events:** `requested` / `started` / `completed` / `failed` / `paused` / `manual_intervention_required` |
>
> The first row is not a naming quibble. `RunStatus` is a **closed union exported
> by `@openwop/openwop`** — the wire package — so "enters `compensating`" was
> never host-local; it would have been a wire change requiring its own RFC. §D's
> separate field is what makes P1 implementable at all.
>
> I implemented this section's model first, before reading the RFC. That is the
> "guessing at a contract" failure ADR 0548 invariant 4 exists to prevent, except
> the contract had *stopped* being a guess and I had not looked.

After RFC 0151 is Accepted, extend workflow/node metadata and the executor with
a capability-gated compensation profile.

### Model

An effectful node may reference a compensation node/operation and a versioned
input mapping. When the forward effect commits, the executor durably appends a
compensation obligation containing the effect identity, recorded result digest,
compensation contract digest, order index and authorization requirements. The
obligation is part of the run record/event log, never process-local.

On a qualifying terminal failure or explicit authorized request, the executor
enters `compensating` and claims obligations in reverse committed order. Each
compensation has its own stable identity derived from the forward effect
identity plus compensation version—not from retry attempt. Retries use that
same identity. Completed compensation replays from its recorded outcome.

Outcomes are `compensated`, `compensation_failed`, `compensation_blocked` or
`compensation_skipped` with a reason. Partial failure parks in the existing DLQ
with the remaining obligation set. Operators may retry, waive with reason, or
escalate; destructive/high-risk compensation composes the existing approval
gate and separation-of-duties policy.

Forward and compensation effects both cross the same host effect broker. An
out-of-process worker receives a signed, short-lived run/effect context so ADR
0531 cannot silently disappear at a process boundary.

## Boundaries audit

| Concept | Owner |
|---|---|
| State transitions/order | existing executor |
| Effect identity/outcome | existing invocation/effect ledger, corrected by ADR 0549/RFC 0150 |
| Effect authorization | existing effect broker, Connections/BYOK and approval owners |
| Dead/partial recovery | existing ADR 0532 DLQ |
| Operator actions | existing Operations routes/UI |
| Feature-local repair | migrate or adapt; no independent saga coordinator remains |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core executor capability; features only declare adapters. |
| 2 | Toggle | No experiment toggle. Capability is absent until configured and qualified. |
| 3 | Workflow surface | Additive metadata/state on the one workflow engine after RFC acceptance. |
| 4 | Node pack | Core compensation metadata/handlers; feature packs may provide domain-specific compensators. |
| 5 | Envelopes | Existing events gain only RFC-defined compensation types. |
| 6 | Agent pack | None; agents cannot invent or auto-waive obligations. |
| 7 | Public surface | RFC-defined run states/events; operator actions remain host-ext unless standardized. |
| 8 | RBAC | Start/retry/waive are separate permissions; waives require reason and audit. |
| 9 | Replay/fork | Fork never re-fires forward/compensation effects; obligations/results are copied as recorded facts per RFC. |
| 10 | Frontend | Operations run detail adds obligation timeline and gated recovery actions. |

## Phases and verification

| Phase | Scope | Gate |
|---|---|---|
| P0 | Inventory feature-local repair flows and effect seams | Every compensable external effect classified; no hidden sender. |
| P1 | Durable obligation ledger and executor states | Wait for RFC 0151/0150 Accepted; state-machine/property tests. |
| P2 | Reverse unwind, retries, approval and DLQ | Payment/message adversarial fixtures prove no duplicate compensation. |
| **Wire flip** | Advertise `capabilities.compensation`, project `compensationStatus` onto every `RunSnapshot`, retire the `openwop-compensation` opt-out | Added 2026-08-16 as a phase ROW, not a footnote to P2, because `compensation.md` §D makes the three one atomic move and a bullet inside another phase's "did not ship" list is not a thing anyone schedules. Gate: `compensation-behavior` executes (not skips) under `OPENWOP_REQUIRE_BEHAVIOR=true`. **Shipped.** |
| P2b | **Chain lane** — carry `compensation` through `expandChain` + the builder surface | Added 2026-08-16 (P2 record). A chain-authored workflow declares an inverse action and unwinds. BLOCKED on an additive RFC 0013 revision (`FragmentNode.compensation`), routed to the spec worker — landed upstream as **RFC 0157** (`chain-compensation-expansion.test.ts` ships in conformance 1.130.0), so the block is now the HOST half. Sequenced BEFORE P3: an Operations recovery UI over a lane no workflow can reach grades itself against nothing. **SHIPPED 2026-08-16 — `1b2dd6fbb`, #3292** (correction recorded in § "Merged-tree provenance — reconciled 2026-08-17"); the host half is done and this row is closed. |
| P3 | Operations recovery | RBAC, SoD, audit-chain and partial-failure tests. |
| P4 | Distributed/chaos qualification | Crash at every state boundary, duplicate delivery, stale worker and replay/fork tests. |

> **RFC GATE SATISFIED — verified 2026-08-13 via `git show origin/main:RFCS/…`
> after a fetch**, NOT from the local `../openwop` working tree, which was 56
> commits behind and returned `Draft` for every one of these. See ADR 0552/0553
> for the full account of that near-miss.
>
> `0150` effect-identity-replay-and-split-brain-safety — `Accepted`
> `0151` compensation-and-partial-failure-profile — `Accepted`
> `0154` workload-identity-delegation-telemetry — `Accepted`

## Implementation record

### Merged-tree provenance — reconciled 2026-08-17 (H44)

Phase → PR → **merge commit on `origin/main`**, each verified with
`git show <sha> --stat`:

| Phase | PR | Merge commit | Merged | Witness tests |
|---|---|---|---|---|
| P0 — effect-sender inventory + compensability classification | — | `595cb40e9` | 2026-08-12 | `effect-sender-inventory.test.ts` |
| P1 — the obligation ledger (built to RFC 0151, not to the ADR that predates it) | [#3214](https://github.com/openwop/openwop-app/pull/3214) | `4c413d4c0` | 2026-08-14 | `compensation-seam.test.ts` |
| P2 — reverse-completion unwind, retries, approval gate, DLQ parking | [#3274](https://github.com/openwop/openwop-app/pull/3274) | `800b6f0da` | 2026-08-16 | `compensation-unwind.test.ts`, `compensation-policy.test.ts`, `compensation-approval-sod.test.ts`, `compensation-seam.test.ts` |
| **P2b — RFC 0157 chain-carried compensation** | [#3292](https://github.com/openwop/openwop-app/pull/3292) | `1b2dd6fbb` | 2026-08-16 | `chain-compensation-carry.test.ts` (21), `node-field-contract-parity.test.ts`, `frontend/react/src/builder/schema/__tests__/roundTripFidelity.test.ts` |
| Wire flip + the §21 recovery extension + RFC 0151 UQ4 | [#3294](https://github.com/openwop/openwop-app/pull/3294) | `d209d8009` | 2026-08-16 | `compensation-operator.test.ts` (new), `compensation-unwind.test.ts`, `compensation-policy.test.ts`, `compensation-seam.test.ts`, `agrade-wire-blocked-residue.test.ts` |
| **P3 — Operations recovery (RBAC, SoD, audit chain, `expectedState` CAS, partial failure, `RunCompensationPanel`)** | [#3322](https://github.com/openwop/openwop-app/pull/3322) | `76a684281` | 2026-08-17 | `compensation-recovery-rbac.test.ts`, `-audit.test.ts`, `-partial.test.ts`, `-route.test.ts`, `runCompensationPanel.test.tsx` — **row added 2026-08-18**; #3322 wrote the P3 implementation record but left this cell saying P3 was open |
| P4 (chaos qualification) | — | — | **open — but much closer than this row implies; see the P4 evidence map below** | — |

### P4 evidence map — measured 2026-08-18, because "open" was overstating the gap

P4 asks for "crash at every state boundary, duplicate delivery, stale worker and replay/fork tests". Mapped
against the suite that exists rather than assumed absent:

| P4 requirement | status | evidence |
|---|---|---|
| **duplicate delivery** | COVERED | `compensation-unwind.test.ts` ADVERSARY 2 delivers the whole plan CONCURRENTLY plus a third time after both settle, and asserts each inverse fired EXACTLY ONCE **per identity** — not an end-state check. ADVERSARY 2b: a duplicate FORWARD commit mints no second obligation. The test's own comment records the sabotage that justifies the per-identity form: removing the ledger claim left it green while every inverse ran twice — "two refunds, two identities, one passing test" |
| **replay** | COVERED | ADVERSARY 4 — replay of an already-unwound run fires NOTHING; plus a `forkMode: 'replay'` leg asserting a replay mints no irreversible row |
| **crash at a state boundary** | PARTIAL, and should not be claimed as more | ADVERSARY 1 covers a crash MID-UNWIND (resumes on the remainder, never re-refunding); the mint-failure boundary is covered by the irreversible-marker work. "EVERY boundary" is not demonstrated |
| **stale worker** | OPEN — needs a DECISION, not a test | Compensation runs inside the executor (`executor.ts` calls `unwindTerminatedRun`) and holds no lease of its own, so recovery after an executor death is gated by the 12-minute orphan lease. See ADR 0551's P3 scoping note: a mid-run crash test is either ~12 minutes or a race |
| **branch fork** | DELIBERATELY NOT PINNED | Only `forkMode: 'replay'` appears in the suite. Branch-fork no-refire is spec-undecided (RFC 0151 G4) and belongs there as a host INPUT — pinning this host's current behaviour would freeze a guess as contract |

**And the cross-instance conditional write this ADR said P4 needs now exists** — the obligation transition is a
real CAS (`DurableCollection.compareAndSwap`, backed by the storage `kvCompareAndSwap`), with the two approval-
pointer writes converted alongside it because last-writer-wins on a whole row could REVERT a concurrent
transition. The `:1000` scoping ("the ledger still has no conditional write") is superseded; what remains
unwitnessed is the cross-instance property itself, which needs two processes.

**So what P4 needs is not a chaos harness.** It needs the stale-worker decision, and an honest phase table —
which this is.

**Re-measured at `fb6cbbcba` (H44):** the seven compensation witness files are
**7 files / 113 tests green**.

> **CORRECTION 2026-08-17 (H44) — P2b SHIPPED, and this ADR said "BLOCKED" for a
> day after it did.** The `Status:` line and the P2b row in § "Phases and
> verification" both described P2b as blocked on an additive RFC 0013 revision
> with "the host half" outstanding. RFC 0157 landed upstream (`Accepted`
> 2026-08-16) and the host half merged the same day as `1b2dd6fbb` (#3292) —
> **before** the wire-flip commit whose own record repeated the block. The
> original text is left in place below; this note is the correction, and both
> the register and the `Status:` line now agree with the tree.
>
> What #3292 actually had to fix is worth keeping, because it is the fourth
> instance of one failure mode in this repo: **six node-rebuilding allowlists,
> and a field absent from an allowlist is not rejected — it is silently
> discarded.** A chain-authored compensator loaded, registered, ran, committed
> real effects, and then was not there; the unwind minted no obligation and
> reported a clean `none`, with every test green throughout. The builder half was
> worse: `BuilderNode` had no home for `compensation`, so the FIRST autosave — a
> rename alone triggers one, on a 1.5 s debounce — deleted it. And the parity
> ratchet could not see the field at all, because `fieldsIn` matched
> `...(x ? { field: … })` but not the **shorthand** `...(x ? { field } : {})`,
> which is how #3274 wrote the carry. Stated plainly because it belongs in the
> record: **#3274's `compensation` carry was unprotected by the ratchet from the
> moment it landed, and the builder was eating the field that whole time.**
> Sabotage: 17 breaks, 17 red.

### P0 — shipped 2026-08-12

`docs/steward/EFFECT-COMPENSATION-INVENTORY.md` enumerates all **8 effect
senders** across the 6 `EffectKind` values and classifies each by whether it can
be undone. `test/effect-sender-inventory.test.ts` (4) fails when a sender
appears without an inventory row.

**Three findings that should shape P1's model:**

1. **"Compensable" is not a boolean.** Three distinct shapes exist:
   reversible-by-forward-effect (payments — a refund is itself a payment effect
   that can fail), host-owned-and-withdrawable (in-app notifications), and
   **irreversible** (email; a delivered push). A single `compensate: true` flag
   in node metadata would flatten that and let an author believe an email can be
   unsent.
2. **Compensation is itself an effect** — every unwind step re-enters
   `assertEffectAllowed` and can fail, so partial-compensation state is
   unavoidable rather than an edge case to defer.
3. **Two senders' compensability is unknowable to the host** (`network-egress`
   via webhook and broker): the peer may expose no inverse. Those must be
   author-declared per workflow; inferring them is how a runtime silently no-ops
   an unwind the operator believes ran. Sub-runs additionally impose depth-first
   ordering on the reverse unwind.

**One defect surfaced:** `blob-write` is declared in `EffectKind` but has **no
sender**. Either it is dead, or a blob writer bypasses the guard — and P1 must
not treat the union as authoritative until that is resolved. Asserted in the
test rather than quietly tolerated.

**Scope note.** The existing forward-repair routines (ADR 0395 DLQ manual retry,
the webhook worker's attempt budget, the retention sweep's stale-claim recovery)
are NOT compensation — they push a stalled operation forward rather than undoing
a completed one. They are recorded in the inventory precisely so P1 does not
absorb them and grow the "second saga engine" this ADR warns against.

### P1 — the ledger shipped 2026-08-14; the wire half did not

**P0's precondition is discharged.** ADR 0563 resolved the `blob-write` marker —
it was a real guard bypass, not a dead kind — so the `EffectKind` union is
authoritative and the model has 6 real kinds rather than 5-plus-a-question-mark.

`host/compensationLedger.ts` + `test/compensation-ledger.test.ts` (21).

**Named `compensationLedger`, NOT reusing `host/obligationLedger.ts`.** That
module is also an "obligation ledger" and is a different machine entirely:
money — accrual/reversal rows in integer minor units, payee grouping,
CAS-claimed payout runs, operator-attested confirmation (ADR 0445/0447). A
compensation obligation has no currency, no payee, and different terminal
states. Reusing it would put money semantics on the unwind path and build the
parallel system this ADR warns against.

**What shipped:** the durable ledger and its state machine — RFC 0151 §C's
retry-stable identity (hashed from the tuple, not concatenated: the components
are caller-supplied and a delimiter collision would alias two obligations onto
one id, so one inverse silently never runs), `reverse-completion` ordering (§A),
the §D state vocabulary, and the run-level rollup derived rather than stored.

**What did NOT ship, and why it is not a gap:** the §A capability
advertisement, `compensationStatus` on the run's wire shape, and the six §D
`compensation.*` events. RFC 0151's own header records that while the text is
`Accepted`, "the entire compensation and partial-failure profile — schema,
prose, conformance, and host implementation" is **carried forward**. Measured:
the pinned `@openwop/openwop` has no `compensationStatus`; the pinned
conformance `capabilities.schema.json` has no `compensation` slot.

> The root schema is `additionalProperties: true`, so a `compensation` advert
> would **not** be rejected. Nothing mechanical would stop the lie — ADR 0548
> invariant 3 is the only guard, which is exactly why the advert was withheld
> rather than "tried to see if it validates". The a2a/mcp §A fields were the
> opposite case (`additionalProperties: false` caught them); relying on the
> schema to notice would have worked there and failed here.

**Design decisions worth their own line:**

- `failed` is **not terminal** (P0 finding 2 — compensation is itself an effect
  that can fail, so a transient refund failure must be retryable without minting
  a second obligation). `completed` is the only terminal state, because
  re-running a completed inverse is a double refund.
- **The reason rule**: every state except `completed` requires one. A bare
  `failed`/`paused`/`manual` is the success-with-empty shape — it looks resolved
  and says nothing about what was left undone. RFC 0151 §E requires recorded
  justification anyway.
- `irreversible` effects **still record** an obligation. Omitting them would make
  the ledger read fully compensated when an email went out; recording and
  resolving `failed` with a reason is the honest shape.
- `partial` is reported rather than rounded — collapsing it to `failed` erases
  that a refund did go through; to `completed`, claims an unwind that
  half-happened.

**Sabotage-proven, four ways:** `completed` made non-terminal → 3 red; `failed`
made terminal → 3 red; `partial` rounded to `completed` → 1 red; the identity
collapsed to `runId` → 4 red. Restored: 34 green across the three ledger suites.

### P2 — the reverse unwind, implemented 2026-08-16

> **The P2 block above expired on 2026-08-16.** It read "P2's reverse unwind,
> retries, approval gate and DLQ routing need the wire half above", where "the
> wire half" meant the unlanded schema + conformance. `openwop#1007` landed it:
> `spec/v1/compensation.md` (§A advert, §B declaration, §D events + the
> NORMATIVE fold table, §F replay), `compensationStatus` on `RunSnapshot` (UQ3
> resolved — `RunSnapshot` is the sole owner), the six `compensation.*` types in
> the closed `RunEventType` enum with payload variants, the `compensation` slot
> in `capabilities.schema.json`, the node `compensation` block in
> `workflow-definition.schema.json`, `host-sample-test-seams.md` §21, and
> `compensation-behavior.test.ts` (6 gated legs).
>
> The block that remains is NARROWER and different in kind: not "the shape is
> not landed" but "this host has not run the behavioural witness under the
> active deployment profile". That is an honesty pair, not a block — see
> "What P2 did NOT ship" below.

#### RFC § → host mapping

| RFC 0151 / `compensation.md` | Host |
|---|---|
| §A `reverse-completion` (mandatory ordering model) | `compensationLedger.obligationsForRunTree` — descending `compensationOrdinal`, ties on `committedAt`. `dependency-graph` is NOT implemented and is not claimed. |
| §B node declaration (closed block) | `executor/types.ts` `WorkflowDefinition.nodes[].compensation`, mirroring `workflow-definition.schema.json` field-for-field; read by `compensationRuntime.compensationDeclarationOf`. |
| §C plan persisted before the first inverse | `compensationUnwind.unwindRun` — the plan IS the durable ledger rows, frozen and emitted as `compensation.requested` strictly before any `compensation.started`. |
| §C retry-stable identity | P1's `inverseActionId` (hashed tuple), unchanged. The forward slot composes **RFC 0150 §B's `logicalInvocationId`** through `host/effectIdentity.ts` — the ONE owner of that composition (ADR 0549 P3, which landed on `main` while this branch was in flight), not a second recipe beside it. Attempt-independence is the property that carries: the input type has no field for an attempt, so a node that succeeded on its third try owes exactly ONE inverse. |
| §C depth-first through sub-runs | ONE ordinal counter per ROOT run (`nextCompensationOrdinal` + the new `rootRunId` column). A sub-run executes synchronously inside its parent node, so a single descending sort over the tree IS depth-first reverse order — measured, not approximated. |
| §D six events | `compensationUnwind` emits them as plain strings through `executor/eventLog.ts`; payloads are ids + digests + `attempt` + `orderingModel` + a closed `reason`. |
| §D `compensationStatus` fold | `compensationLedger.compensationStatusForRunTree`, derived not stored. **Not projected onto the wire** — see below. |
| §E approvals | `approvalService` kind `compensation-action` + `approvalDecision`'s own disposition + `compensationRuntime.registerCompensationApprovalEligibility` (separation of duties at the ONE decision choke). |
| §E dead-letter routing | The ADR 0532 sink the run already lands in (`run.dead_lettered` from `emitTerminalFailure`). NO second queue: the remaining obligation set is the ledger's own non-terminal rows. The compensation-lane marker is `compensation.failed { reason: 'dead-lettered' }`. |
| §F replay | Two independent fences, each pinned where it is the only one standing: a replay mints no obligations (`recordForwardObligation` early-returns on `forkMode: 'replay'`), and `unwindRun` invokes nothing when `replaying`. ADR 0531's guard is a third. |
| §21 seams | `routes/compensationSeam.ts` — `unwind` returns `runId` (so the rollup leg has a black-box path) and `replay` returns `refiredEffects`. Drives the REAL executor; §21 forbids a canned-event mock. |

#### Where the ordering lives, and why the ledger grew a column

`rootRunId` is new on the obligation row. The alternative — per-run ordinals plus
a rule for splicing a child's inverses into the parent's sequence — needs a
parent-node linkage the ledger does not carry, and would be a GUESS wherever it
was missing. Rooting the counter makes the interleaving a recorded fact.

#### `RunStatus` did not gain `compensating`

Stated again because the ADR's own Decision section says otherwise and reading it
alone is how the sketch gets implemented. §D keeps the forward `status`
untouched. A run ending `status: failed` with `compensationStatus: completed` is
the SUCCESSFUL outcome of an unwind. The conformance suite has a leg that fails
if `compensating` ever appears in the status enum.

#### The policy, and its attach point

> **CORRECTED 2026-08-16, same day.** This section shipped saying
> "`schemas/compensation-policy.schema.json` … is being authored concurrently and
> its attach point is undecided, so nothing here depends on it". The attach point
> was decided hours later in `openwop#1009` and the policy is now folded in, so
> the sentence is replaced rather than annotated — it described a state of the
> world, not a decision, and there is no reasoning trail to preserve.

**Attach point: `settings.compensation` on `WorkflowDefinition`** (`WorkflowSettings`,
beside `timeout`/`maxRetries`). AUTHORED, never per-run — the schema is explicit
that there is deliberately no run-options overlay, "because a per-run caller who
could lower approval scope or drop a trigger would be authorizing their own
unwind".

| Policy field | Host |
|---|---|
| `triggers` (REQUIRED, closed) | `policyAdmitsTrigger` gates `unwindTerminatedRun`. WHICH FAILURES QUALIFY is read from the policy, never a host heuristic. No policy ⇒ `COMPENSATION_FALLBACK_TRIGGERS = ['node-failure']`, stated explicitly because an unlisted trigger means *no unwind and `compensationStatus: none`* — so the no-policy answer has to be written down, not inferred. |
| `retry` / `timeoutMs` | `retryBudgetFor(declaration, policy)`. Precedence **node > policy > constant**, resolved per FIELD so a node that sets only `maxAttempts` still inherits the policy's `backoffMs`. `timeoutMs` is not yet enforced per attempt — named in "did NOT ship". |
| `approvalScope` | `requiresApproval(declaration, policy)` — ESCALATE-ONLY by construction: it can only turn `false` into `true`, so `declared` can never strip a node's own `requiresApproval`. |
| `orderingModel` / `profileVersion` | Validated at REGISTRATION against what the host advertises, "so an unwind never discovers at failure time that its ordering rule is unimplemented". |
| `exhaustedDisposition` / `onParentCancel` | Validated at registration (the manual arms require `manualIntervention: true`); the BEHAVIOUR is P3. |

`COMPENSATION_DEFAULT_RETRY` survives as the **fallback**, not the source: a
workflow may carry node declarations with no policy at all, and a host with no
default would have to invent one at failure time.

#### The refusal this phase is bound by — and a defect it exposed

A host that does NOT advertise `capabilities.compensation` **MUST refuse** a
workflow carrying `settings.compensation` with `capability_required`
(`details.requiredCapability: "compensation"`). This host does not advertise, so
it always refuses.

> **CORRECTION 2026-08-16 (wire flip).** "This host does not advertise, so it
> always refuses" is no longer true, and the sentence is left standing because
> the reasoning around it is what P2 was bound by. The host advertises now, so
> the SAME rule points the other way: the schema requires an advertising host to
> *validate* the policy and refuse only an `orderingModel` / `profileVersion` it
> does not advertise. Continuing to refuse everything would have been the
> identical dishonesty with the sign flipped twice — telling an author no unwind
> will happen when one will.
>
> The flip needed no new branch: `checkCompensationPolicy` was already written
> with the accept path below the gate, and the gate reads
> `resolveCapabilityFlag('compensation.supported')`. What it needed was the
> *value* — that key was absent from `capabilityOverlay.DEFAULTS`, so the lookup
> returned `undefined` and the refusal was unconditional in practice. Adding it,
> derived from `COMPENSATION_CAPABILITY`, is what makes advert and acceptance one
> fact. **This is the coupling most likely to be missed by a reader who thinks
> the flip is "add a block to discovery.ts":** the advert has a second consumer,
> and shipping only the first would advertise a family while refusing every
> policy that family invites.

`OpenwopErrorCode` gained `capability_required` for it — the
code was already in `capabilities.md`'s closed refusal set and this host had only
the broad `validation_error`, which cannot tell an author "your document is fine,
this host just does not do that yet".

The asymmetry is load-bearing: a NODE-level `compensation` declaration needs no
advert (it is a statement about the workflow — a host that never unwinds simply
never acts on it), while the workflow-level policy is a claim about the host.

**Writing that check found a defect that made this whole phase inert.**
`validateWorkflowDefinition` rebuilds each node from an ALLOWLIST of fields, and
`compensation` was not on it — so every workflow registered through the route
lost its declarations silently, the executor minted no obligations, and an unwind
would have reported a clean `none` for a run that committed real effects. The
seam suite could not see it: it builds definitions in-process and never crosses
the validator. Fixed, and pinned by `test/compensation-policy.test.ts`
(sabotage 17).

#### A spec inconsistency, reported rather than papered over

`compensation.md` §D says `compensation.paused` "carries a closed `reason`", but
the closed vocabulary is `retries-exhausted | approval-denied | authority-denied
| dead-lettered | operator-terminated` — every member asserts a decision or a
terminal outcome, and NONE names the ordinary case: paused because an approval is
OPEN and nobody has decided. `approval-denied` would claim a decision that has
not been made. The payload schema leaves `reason` optional, so this host emits
`compensation.paused` with no `reason` while an approval is pending and puts the
operator-legible detail on the LEDGER row's free-text `reason` — host-local,
which is the right home for an open string §D/§G forbid on the wire. The same
applies to `manual_intervention_required` for an unresolvable compensator.

#### Sabotage table

Every guard was broken, watched go red, and restored. Two rounds were needed,
and the first round is the more useful record:

| # | Sabotage | Result |
|---|---|---|
| 1 | reverse ordering flipped to ascending | 4 red |
| 2 | ledger CLAIM result ignored (no CAS) | **GREEN — the fixture only counted identities, not invocations per identity.** Strengthened; then 1 red |
| 2b | per-obligation lock removed (lost update) | 1 red — and this found a REAL DEFECT (below) |
| 3 | `completed` rows left in the plan | **GREEN first — two-fenced by the claim.** Added a fence-specific assertion; then 1 red |
| 4 | `replaying` guard removed | **GREEN first — the fixture's "reopen" hit `completed`'s terminality and left an EMPTY plan, so the early return was what kept it green.** Fixture rebuilt to leave real work owed; then 1 red |
| 5 | no-approval-gate fail-closed removed | 1 red |
| 6 | retry budget unbounded | 2 red |
| 7 | paused plan `break` → `continue` | **GREEN first — both obligations were gated, so the leg could not tell `stop` from `skip`.** Fixture made MIXED; then 1 red |
| 8 | executor stops recording obligations | 3 red |
| 9 | `finalizeRun` stops unwinding | 3 red |
| 10 | replay mints obligations | 1 red |
| 11 | self-approval permitted | 2 red |
| 12 | `isPersonalOwner` escape honoured | 1 red |
| 13 | `compensation-action` redactor unregistered | 2 red (incl. the APPR-5 completeness test) |
| 14 | a `providerResponse: { authorization: 'Bearer sk-…' }` field added to every §D payload | 2 red (the keyword leg AND the corpus-schema leg) |
| 15 | closed `reason` replaced with a raw provider error string | **GREEN first — a CLEAN unwind emits only requested/started/completed, none of which carry a `reason`, so the seam's schema leg never saw one.** Legs added for the failure/pause/denial/manual paths; then 2 red |
| 16 | the register row title reverted | 2 red (`agrade-wire-blocked-residue`) |
| 17 | node `compensation` dropped from the validator's allowlist again (the defect above) | 1 red |
| 18 | `settings.compensation` accepted without the advert | 2 red |
| 19 | `approvalScope: 'declared'` made to STRIP a node's own `requiresApproval` | 1 red |
| 20 | policy `retry` made to OVERRIDE the node's own bound | 1 red |

**Five of twenty were green on the first attempt.** Four of the five were fixture defects
(2, 4, 7, 15) and one was a genuine second fence (3). That ratio is the argument
for the round: a suite of 55 passing compensation tests would otherwise have
shipped with a duplicate-compensation fixture that could not see a duplicate
compensation, and a "content-free events" leg that could not see an open reason
string.

Sabotage 15 is the second time in this phase a keyword scan looked like coverage.
The fix both times was to make the fixture PRODUCE the shape being guarded — the
§D payloads are now validated against the corpus `run-event-payloads.schema.json`
(`additionalProperties: false`, closed `reason` enum) across all six `$defs`,
from the pinned `@openwop/openwop-conformance` package rather than the repo's
vendored copy, which has none of them.

**Sabotage 2b found a real defect, not just a weak test.** The ledger's state
machine forbids `started -> started`, which LOOKED like the compare-and-swap a
losing concurrent unwind detects. It is not: `resolveObligation` was a
read-check-write over a store with no CAS, so two concurrent passes each read
`requested` before either wrote, and both fired the inverse — two refunds, with
the machine in place. Fixed with the per-key promise chain
`approvalService.withApprovalLock` already uses for the same reason. Cross-
INSTANCE races still need a conditional write from a production adapter, and that
limit is stated at the seam.

#### What P2 did NOT ship

- **`capabilities.compensation`** and **`compensationStatus` on `RunSnapshot`.**
  `compensation.md` §D makes these a PAIR — a host that does not advertise MUST
  omit the field, one that advertises MUST carry it — so shipping either alone is
  a wire lie in one direction or the other. `test/agrade-wire-blocked-residue.test.ts`
  pins their joint absence alongside the `openwop-compensation` opt-out in
  `conformance/run.ts`, and `test/compensation-seam.test.ts` asserts both halves
  independently.
- **To flip the advert (one commit, three edits):** add the §A block to the
  discovery capabilities, project `compensationStatusForRunTree` onto
  `projectRunSnapshot` for every snapshot (`none` when idle), and delete BOTH the
  residue assertion here and the `openwop-compensation` entry from
  `OPTED_OUT_PROFILES`. The precondition is running
  `compensation-behavior.test.ts` green under the active deployment profile with
  `OPENWOP_TEST_SEAM_ENABLED=true` — the seam is already wired for exactly that.

> **SHIPPED 2026-08-16 — see "Wire flip — implemented 2026-08-16" below.** The
> two bullets above are P2's honest record of what it withheld and are left
> intact. Two things in the recipe turned out to be wrong, and both are worth
> keeping visible because they are the kind of error a plan makes about work it
> has not done:
>
> 1. **"three edits" was FIVE.** The recipe missed
>    `capabilityOverlay.DEFAULTS` (without it the host advertises and then
>    refuses every `settings.compensation` — see the correction in "The refusal
>    this phase is bound by") and it missed that the SSoT constants had to move
>    to a shared leaf so the advert could be derived rather than re-typed.
> 2. **`compensationStatusForRunTree` is the wrong function for the wire.** It
>    is per-run and does a full ledger scan; the snapshot LIST route maps the
>    projector over a whole page, so following the recipe literally would have
>    put N full-collection scans on the read path that already caused the
>    2026-07-14 O(tenant)-scan outage. The projection uses a batched
>    `compensationStatusForRuns` instead — one scan per page — and the tree fold
>    stays where it belongs, inside the unwind.
- **A CHAIN cannot declare compensation at all, and that is an RFC 0013 gap —
  not a host fix.** Measured: `workflow-chain-pack-manifest.schema.json`
  `$defs.FragmentNode` carries `['id','typeId','name','position','config','inputs']`
  and the manifest mentions `compensation` nowhere. `expandChain`
  (`host/workflowChainPackLoader.ts:1149`) builds each expanded node from that
  same allowlist, so there is nothing to carry through.

  This is the one that decides how much of P2 is reachable in practice.
  CLAUDE.md's doctrine is that a workflow is *never* a hard-coded in-tree
  definition — it is a chain pack or a kanban stack — so on a chain-authored
  workflow, which is most of them, no node can own an inverse action and no
  unwind can occur. P2 is reachable today through the direct registration route
  (`POST /v1/workflows`, now that the declaration survives it) and through
  in-process definitions; not through the gallery.

  Deliberately NOT worked around. Adding a host-private key to the chain node
  would be guessing at a contract that has an owner, and `settings.compensation`
  has just shown what happens when the guess and the decision differ. The fix is
  an additive RFC 0013 revision in `../openwop` — `FragmentNode.compensation`
  mirroring §B, and the chain's own `settings.compensation` surviving expansion.
  **Routed to the spec worker as its own task** (2026-08-16); do NOT add a
  host-private chain key while it is open.

  **The builder-gallery lane stays unreachable until BOTH land:** RFC 0013
  revision N in the corpus, and a HOST FOLLOW-UP that carries `compensation`
  through `expandChain` (`host/workflowChainPackLoader.ts:1149`) plus the
  builder surface that lets an author set it. The RFC alone does not close it —
  the expansion allowlist is host code and would silently drop the new field
  exactly as `validateWorkflowDefinition` did, which is the same defect twice.
  That host follow-up is a phase of this ADR, not part of P2; it belongs
  before P3, because an Operations recovery UI over a lane no workflow can
  reach would grade itself against nothing.
- **`settings.compensation.timeoutMs`** — validated at registration, not yet
  enforced as a per-attempt wall-clock ceiling. A timed-out attempt is supposed
  to count against `retry.maxAttempts` rather than be a distinct outcome; today
  an inverse action runs to whatever the node does. Named because the field is
  accepted on the accept path and an author would reasonably expect it honoured.
- **`exhaustedDisposition` / `onParentCancel` BEHAVIOUR.** Both are validated at
  registration (including the `manualIntervention` requirement) but the unwind
  always behaves as `record-outcome`, and a parent cancel does not reach the
  unwind at all. P3.
- **P3 Operations recovery** (RBAC'd retry/waive/substitute/terminate routes, the
  obligation timeline in the run detail, resuming a plan after an approval
  resolves) and **P4 chaos qualification**.
- **Cancellation-triggered unwind.** §C's "cancellation of the parent MUST NOT
  silently abandon an active compensation" is honoured only for the terminal-
  FAILURE path today; a cancelled run does not yet unwind. Named here rather than
  implied, because the `manualIntervention` advert would claim it.
- **Terminal failures that do not pass through `finalizeRun`.** The unwind hooks
  `finalizeRun`'s failed branch, NOT `emitTerminalFailure` — which ADR 0532
  correctly identifies as the single terminal choke, and which the drain-loop
  stall path, the dispatch sweeper and `runDispatch` also reach. Those paths kill
  a run without a `WorkflowDefinition` in hand, and the unwind needs one to read
  the §B declarations. So a run reaped by the sweeper leaves its obligations
  standing at `requested` rather than unwinding. That is the SAFE residue (the
  rows are durable and an operator can see them) but it is not the complete
  behaviour, and it is the first thing P3's recovery routes should close —
  resolving a definition from `run.metadata.definitionRevision` at those chokes
  rather than duplicating the unwind.

> **CROSS-REFERENCE, added 2026-08-17 (H53 / ADR 0553 P3).** The bullet above and
> H50's "finalizeRun-bypass choke" observation are **the same seam**, and a
> defect on it has now been fixed there rather than here — recorded so the two
> ADRs do not each grow their own half-answer to one problem.
>
> `finalizeRun` wrote its terminal status from the in-memory `RunRecord` captured
> at run START and never re-read the row, so an RFC 0094 cancel landing mid-drain
> was accepted, audited, cascaded to children — and then silently reverted the
> moment the last node finished. A terminal guard now sits at the TOP of
> `finalizeRun` (above the event appends, so a cancelled run cannot emit
> `run.completed` either): `src/executor/executor.ts`, witnessed by
> `test/run-abort-signal.test.ts` "a run cancelled mid-flight STAYS cancelled
> when its last node then finishes", sabotage-proven twice — guard disabled, and
> the guard reading the stale in-memory status instead of the row. The second
> sabotage is the one that proves the FRESH read is load-bearing.
>
> **This does NOT close the bullet above.** It is a read-then-write, and
> `Storage.updateRun` has no compare-and-swap, so a cancel landing between the
> read and the write still wins the write and loses the status — a
> legal-transition check is not a CAS. The window narrows from "the whole final
> node" to "between a read and a write". And the paths that never reach
> `finalizeRun` at all (the drain-loop stall, the dispatch sweeper, `runDispatch`)
> are untouched by it, which is exactly why the bullet's proposed fix — resolve a
> definition at `emitTerminalFailure`, the single choke ADR 0532 names — remains
> the right shape for P3 rather than another guard bolted onto `finalizeRun`.
>
> Relevant to §C's "cancellation-triggered unwind" residue two bullets up: a
> cancelled run whose status did not survive its own final node could not have
> driven an unwind even once that lands. The status surviving is a precondition
> for that feature, not the feature.

### Wire flip — implemented 2026-08-16

`capabilities.compensation`, `RunSnapshot.compensationStatus`, and the retirement
of the `openwop-compensation` conformance opt-out. One commit, because
`compensation.md` §D makes them one claim: *"a host that does not advertise MUST
omit the field; a host that advertises MUST include it on every snapshot, `none`
when no compensation was ever requested. Presence is therefore a wire witness of
the advert."*

They could not have shipped separately even by mistake. `behaviorGate` **throws**
on a profile that is simultaneously advertised and listed in
`OPENWOP_OPTED_OUT_PROFILES` — "contradictory claims, and neither can be trusted
while both stand" — so the advert and the opt-out are atomic by construction, and
the residue tripwire pins the third leg.

#### The design decision: ONE constant, not three literals

The advert has **three** consumers that must agree, and the recipe P2 wrote down
named only one of them.

| Reads it | For what | Failure if it disagreed |
|---|---|---|
| `routes/discovery.ts` | the advert a peer reads | — |
| `routes/runs.ts` | whether `compensationStatus` is projected | §D's pair breaks in one direction or the other |
| `host/capabilityOverlay.ts` → `workflowDefinitionValidation.checkCompensationPolicy` | whether `settings.compensation` is accepted or refused `capability_required` | the host advertises the family and then refuses every policy that family invites |

So `host/compensationCapability.ts` is a **leaf module with no imports** owning
`supported` / `profileVersion` / `orderingModels` / `manualIntervention` plus the
`advertisesCompensation()` predicate, and the two runtime constants MOVED into it
(`COMPENSATION_PROFILE_VERSION` from the ledger, `COMPENSATION_ORDERING_MODEL`
from the unwind), re-exported from their old homes so every existing call site
keeps reading the same value. A leaf with no imports cannot participate in a
cycle and cannot fail to load, which matters when a capability advert depends on
it.

The result is that the two claims most worth doubting are not expressible: an
advert naming an ordering model the unwind does not sort by, and an advert naming
a `profileVersion` other than the one the ledger mints identities under (§C puts
it inside the inverse-action id).

#### Phase → change table

| What | Where |
|---|---|
| §A advert, spread not re-typed | `routes/discovery.ts` — `compensation: { ...COMPENSATION_CAPABILITY }` |
| The SSoT + the §D pairing predicate | `host/compensationCapability.ts` (new, no imports) |
| §D rollup on every snapshot | `routes/runs.ts` `projectRunSnapshot` — the caller resolves the status and passes it, so the projector stays synchronous; all THREE call sites updated (single GET, list, `:diff`) |
| The batched fold behind it | `host/compensationLedger.ts` `compensationStatusForRuns` — ONE `rows.list()` per page |
| Registration gate | `host/capabilityOverlay.ts` `DEFAULTS` — `compensation.supported` / `compensation.manualIntervention`, DERIVED |
| Opt-out retired | `conformance/run.ts` — `'openwop-compensation'` removed from `OPTED_OUT_PROFILES` |
| Residue guard INVERTED | `test/agrade-wire-blocked-residue.test.ts` — the two negatives become four positive obligations |
| Register row retired | `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md` → "Rows retired" |

#### Why the list route got its own function

`compensationStatusForRunTree` does a full `rows.list()` per call, and
`GET /v1/runs` maps the projector over up to 200 runs. Following P2's recipe
literally would have put 200 full-collection scans on the read path whose
O(tenant) sibling scan blew the 30s statement timeout and 500ed **every**
snapshot read on 2026-07-14. `compensationStatusForRuns` does one scan and folds
per run.

It also fixes a correctness question the per-run function cannot answer. Ordinals
come from ONE counter per ROOT, so a sub-run's obligation carries the root's
`rootRunId`. A fold keyed only on the root reports `none` for the sub-run's own
snapshot — a run that committed a compensable effect claiming it owed nothing —
and a fold keyed only on `runId` reports `none` for the parent, which is exactly
what the tree fold exists to prevent. A row is therefore bucketed under **both**
its root and its own run, and a root's own rows (where the two are equal) are
bucketed once.

#### The refusal contract, both directions

`compensation-policy.schema.json` puts a normative MUST on each side of the
advert. The accept path is now the shipped default and is tested **without** the
capability overlay, so it exercises the real posture; the refusal is still a MUST
for any host that does not advertise, and is reached through the overlay — the
same seam the conformance harness flips, and the `host.aiEnvelope.supported`
precedent. Keeping it exercised is the point: a contract nobody runs is a
contract that rots, and it is the only test that pins the CODE
(`capability_required`, not the broad `validation_error`).

#### Evidence

`compensation-behavior.test.ts` **executes** rather than skipping, against the
real host under `OPENWOP_REQUIRE_BEHAVIOR=true` with the §21 seams:

```
✓ src/scenarios/compensation-profile.test.ts  (9 tests)  4ms
✓ src/scenarios/compensation-behavior.test.ts (5 tests) 71ms
[conformance] suite exited with code 0
```

Non-vacuity is visible in the host log rather than assumed: four runs created and
unwound through the real executor
(`compensation_obligation_recorded` → `resolved requested→started` →
`compensation_inverse_completed` → `resolved started→completed`), which is what
§21 means by "not a mock that returns a canned event list".

Backend suites: `compensation-unwind` (25, +6 for the batch fold),
`compensation-seam` (12), `compensation-approval-sod` (7),
`compensation-policy` (18), `agrade-wire-blocked-residue` (21).

#### Sabotage table

Every new guard was broken and watched go red. Five of the ten are the couplings
this flip could plausibly have shipped half of.

| # | Sabotage | Went red |
|---|---|---|
| 1 | Advert deleted from `discovery.ts` | residue §A leg; `compensation-seam` advert leg |
| 2 | `compensationStatus` dropped from `projectRunSnapshot` | residue §D legs (both); `compensation-seam` pair leg |
| 3 | Fold always returns `none` (rollup disagrees with events) | 9 tests across 3 files, incl. the residue fold leg |
| 4 | `'openwop-compensation'` restored to `OPTED_OUT_PROFILES` | residue opt-out leg |
| 5 | `orderingModels` widened to include unimplemented `dependency-graph` | residue §A leg; `compensation-seam` advert leg |
| 6 | Advert `profileVersion: '2'` while the ledger mints `'1'` | residue §A leg |
| 7 | `compensation.supported` removed from `capabilityOverlay.DEFAULTS` (advert ships, registration still refuses) | 7 tests — residue §A + §B legs, and 5 in `compensation-policy` |
| 8 | Field kept on the single GET, dropped from the LIST projection | residue "every snapshot" leg only — the list leg is not redundant |
| 9 | Sub-run bucket removed from the batch fold | the sub-run/root leg |
| 10a | In-memory tenant filter removed from the batch fold | **NOTHING — green.** The prefix scan already scopes; recorded rather than hidden, and the line is now labelled redundant in the source instead of counted as a guard |
| 10b | Prefix scan reverted to `list()` **and** the filter removed | the tenant-scoping leg |
| 11 | Row key shape changed (`idOf` no longer tenant-prefixed, so the bounded prefix would silently match nothing) | six ordering/adversary legs in `compensation-unwind` |
| 20 | The UQ4 JOIN removed (`recordForwardObligation` back to minting nothing for an irreversible node — the state main was actually in) | the minting leg + the end-to-end `partial` leg |
| 12 | §C identity NOT threaded into the compensator's `NodeContext` | the seam's retry-stability leg (the canary fires: keys go per-attempt distinct) |
| 13 | Replay reads its OWN empty tree instead of the source plan (§F) | **NOTHING at first — green.** The seam carried its own copy of the rule and kept reporting the source plan while the host had stopped resolving it. Fixed by giving the rule ONE owner (`compensationPlanRunId`); re-sabotaged → the §F leg goes red |
| 14 | `attempts` reverts to counting transitions | the true-attempt-count leg + the seam's §21 report leg |
| 15 | UQ4 cap removed from the fold | the irreversible-only leg + the "stays capped even if a later write marks it completed" leg. **Not** the `partial`-with-a-completed-sibling leg, which still passes for an unrelated reason — recorded so the cap is not credited with coverage it does not have |
| 16 | Irreversible entry IS invoked | the never-invoked leg + the irreversible-only rollup leg |
| 17 | Cross-tenant answers 403 instead of 404 | the neutralization leg |
| 18 | The 403 refusal is not audited | the refusal-audited leg |
| 19 | Tenant binding removed entirely | the neutralization leg + the no-audit-on-a-foreign-plan leg |

Sabotage 13 is the second guard in this change that was green when broken, and
the more instructive one: the seam had re-derived a rule the host owns, so the
report stayed right while the behaviour went wrong — which is exactly the shape
§21's non-vacuity rule exists to prevent, reproduced accidentally in my own code.
The fix was not a better assertion; it was deleting the second copy of the rule.

Sabotage 10a is the one worth reading. A guard that stays green when you break it
is indistinguishable from a guard that never ran, and the honest resolution was
to find what the tenant boundary actually rests on (the key shape + the prefix)
rather than to keep a line that looked like it was doing the work.

#### The scan the advert puts on the hot path

The rollup is a ledger read, and the advert makes it run on **every**
`GET /v1/runs/{runId}`. `compensationStatusForRuns` therefore uses
`listByPrefix(\`${tenantId}::\`)` — a storage-level scan bounded to the tenant's
slice, exact because the id separator is `::` — not `list()`, whose cost grows
with every tenant's obligations forever.

Deliberately **not** `listForTenantIndexed`. That reads marker rows, and a
missing marker is documented as "delayed, not lost": acceptable for retention,
wrong for a status. A dropped obligation makes `completed` true *by omission*,
which is the one incorrect answer that looks exactly like the correct one — the
same reasoning `eraseCompensationSubject` gives for redacting rather than
deleting. The prefix scan is index-free and complete.

`obligationsForRun` / `obligationsForRunTree` still use `list()`. They are on the
UNWIND path (once per terminal failure), not the read path, so they were left
alone rather than changed under a wire-flip commit; narrowing them the same way
is a safe follow-up.

### The §21 recovery extension — implemented 2026-08-16, with the flip

The flip was scoped as "advert + snapshot + opt-out". Retiring the opt-out made
`compensation-recovery.test.ts` (conformance 1.130.0) EXECUTE, and it failed 3/3.
The first reading was that this was a corpus defect —
`host-sample-test-seams.md` §21 says the three sub-features are "OPTIONAL and
independently `blocked`", while the suite routes them through `seamAbsent()`,
which throws under `OPENWOP_REQUIRE_BEHAVIOR=true`.

**That reading was withdrawn on the point that decides the work.** The SEAM is
optional; the three things it observes are not. RFC 0151 §C (retry-stable
identity), §E (operator authority bound to the plan's tenant) and §B/§F (inverse
inputs are recorded facts) are MUSTs for a host that advertises the family. Under
the strict gate the honest flip is both scenarios `executed-pass`, and the seam
failing is the gate doing its job.

Reading it that way immediately paid: the extension was NOT reporting work.

#### Three real defects it surfaced

| Defect | Why it mattered |
| --- | --- |
| **A compensator could not present its §C identity at all.** `invokeInverseAction` built a `NodeContext` with no `inverseActionId` and a hardcoded `attempt: 1`. | §C's rule is that a retry re-presents the SAME identity as its idempotency key. The host held the identity; the thing that must present it downstream is the compensator, and it had no way to reach it. Any idempotency key it derived instead would vary per attempt — one refund becoming three. The §C MUST was unmet, not merely unobservable. |
| **`attempts` counted TRANSITIONS, not attempts.** An inverse that failed twice and succeeded on the third try recorded `attempts: 2`. | An operator reads that number to decide whether a partial unwind needs a human. `2` says the retry budget was barely touched; the truth was one attempt from exhaustion. |
| **A replay resolved no plan at all.** `unwindTerminatedRun` read the REPLAY's own tree, and a replay mints no obligations, so the plan was empty. | §F says a replay uses the RECORDED outcomes of the run it reproduces. "Reported nothing because it correctly re-fired nothing" and "reported nothing because it had nothing" are indistinguishable until someone asks what it compensated. Now the plan is read from the SOURCE run; the §F fences (no minting, `replaying: true`, ADR 0531's effect guard) are unchanged and still independent. |

#### What landed

| Piece | Where |
| --- | --- |
| §C identity + real attempt to the compensator | `executor/types.ts` `NodeContext.compensation`, set in `compensationRuntime.invokeInverseAction`. **PACK-FACING** — documented for node authors in `ARCHITECTURE.md` § "`ctx.compensation`". Optional in the type, so every existing node compiles and runs unchanged; a node that never acts as a compensator never sees it. A compensator MUST present `inverseActionId` alone as its downstream idempotency key — §C keeps `attempt` outside the identity for exactly that reason, and composing the two is a second refund per retry |
| §B/§F recorded inverse input | `compensationInput` on the ledger row, stamped at MINT time so a workflow redefined before the unwind cannot rewrite what the inverse executes with |
| §21 `inverseActions[]` | `compensationUnwind.reportInverseActions` — a projection of the LEDGER, on every unwind, not only seam-driven ones |
| §E authority + audit | `host/compensationOperator.ts` — ONE decision function the seam and P3's Operations route share |
| §E resume | `compensationRuntime.resumeUnwindForOperator` |
| §F "which plan does a replay read" | `compensationRuntime.compensationPlanRunId` — ONE owner (see sabotage 13) |
| The seam | `routes/compensationSeam.ts` — `failFirstInverseAttempts` / `hold`, `downstreamKeys`, `source`/`replayed`, the new `operator` route |

**`downstreamKeys` is deliberately NOT host-reported.** The host knows the key it
INTENDED to present; only the thing on the receiving end can witness what was
actually presented, so the fake downstream records it and the host does not. A
host-supplied key would be the host marking its own homework. The seam's
`?? "UNTHREADED-attempt-N"` fallback is a canary, not a default: if the host ever
stops threading the identity, the recorded keys become per-attempt distinct and
the retry-stability leg fails loudly instead of the seam quietly substituting a
stable value the host never presented.

**The two refusals are different in kind, and only one is audited. Recorded here
so a later reader does not "fix" the asymmetry.**

*Cross-tenant → 404 `not_found`, and NO audit record on the plan.* RFC 0132 §A.2
says neutralize to the actor's tenant and do not reveal that another tenant's plan
exists. A 403 would confirm the run id is real, which is the one fact being
withheld. The un-audited half follows from the same rule and is the part that
looks like an omission: writing an `authorization.decided` record INTO the plan's
run would leak that existence right back out through the audit trail the refusal
just protected — an auditor for the plan's tenant would see a stranger's
principal id appear against a run they never touched, which is the disclosure
inverted. Worse, since the decision runs before any authority check can pass, it
would let an unauthenticated prober append one record per guess to another
tenant's event log: an unauthenticated durable write, dressed as an audit
control.

The refusal is not unrecorded — it is logged host-locally
(`compensation_operator_cross_tenant_neutralized`), where an operator of THIS
host can see it and the other tenant's event log cannot.

*Same-tenant without authority → 403 AND audited* (§21 makes this a MUST). The
actor is already inside the tenant, so the record discloses nothing they could
not already see, and a refused override attempt is exactly what an incident
review needs. `test/compensation-operator.test.ts` pins both directions,
including the negative — sabotage 19 (removing the tenant binding) fires the
no-audit-on-a-foreign-plan leg, not just the status-code leg.

### RFC 0151 UQ4 (the unwind half) — implemented 2026-08-16

> **THE JOIN BETWEEN THE TWO HALVES DID NOT EXIST, and both halves' tests were
> green.** #3292 carried `irreversibleEffect` through schema → validation →
> expansion → storage. This side implemented the fold. Neither side minted the
> ROW: `recordForwardObligation` returns early unless the node carries a §B
> `compensation` declaration, and `irreversibleEffect` is mutually exclusive with
> one by construction — so an irreversible node produced no obligation, nothing
> capped the rollup, and a run whose compensable siblings unwound cleanly
> reported `completed` for an effect that by definition was never undone. The
> exact wire lie UQ4 exists to close.
>
> It was invisible because the UQ4 tests here hand-build a `shape: 'irreversible'`
> row: they exercised the fold faithfully while the production path that produces
> such a row did not exist. Two correct halves, each with passing tests, and no
> test crossing the seam. Found on the rebase that put them in one tree, and
> pinned by the "MINTS its plan entry" legs — sabotage 20 restores the pre-fix
> behaviour and reds them.

`impl-h13` carried `irreversibleEffect` through chain → expansion → registration
→ storage. The LEDGER and ROLLUP half is here: an `irreversible` plan entry is
left in the plan, never invoked (there is no inverse to invoke), reported
`outcome: 'irreversible'`, and the §D fold caps at `partial`.

Two ordering decisions are load-bearing:

- **The cap is checked BEFORE the all-completed test.** An irreversible row sits
  non-completed forever, so `done === list.length` is already unreachable — until
  some future code marks it completed to tidy the plan up, at which point the run
  reports a FULL unwind for an effect that by definition was never undone.
  Checking the shape first makes that lie unreachable rather than merely
  unlikely.
- **`pending` is decided by the rows that CAN still move.** The first cut used
  "every row is `requested` ⇒ pending", which reported `pending` **forever** for
  an irreversible-only plan — a run parked at "about to start" that will never
  move, which is worse than either honest terminal value because an operator
  waits for a transition that cannot come. Found by the test asserting `failed`
  for that case, not by review.

#### What the flip did NOT ship, named rather than implied

- **`dependency-graph` ordering.** Optional in §A, unimplemented, not claimed —
  and sabotage 5 exists so a future widening of the constant cannot claim it
  silently.
- **The §21 RECOVERY extension.** The 1.130.0 `compensation-recovery.test.ts`
  drives `unwind` with `failFirstInverseAttempts` / `hold`, expects an
  `inverseActions[]` array with per-attempt `downstreamKeys`, and drives a
  `.../compensation/operator` seam for the §E tenant-authority legs. This host
  wires only the base `unwind` / `replay` seams. **This matters for the pin
  bump:** `seamAbsent()` throws under `OPENWOP_REQUIRE_BEHAVIOR=true`, so once
  the conformance pin moves past 1.106.0 the recovery scenario needs either the
  extension or an explicit decision. Sequenced with P3, which owns the operator
  surface anyway.
- **Triggers beyond `node-failure`.** `settings.compensation` now accepts
  `run-cancel` / `cap-breach` / `operator-request` at registration, and
  `unwindTerminatedRun` is only ever called with `node-failure`, so nothing fires
  them. Deliberately NOT narrowed at registration:
  `compensation-policy.schema.json` mandates a refusal only for an unadvertised
  `orderingModel` / `profileVersion`, and there is no advert surface for triggers
  — narrowing them here would refuse documents the spec says to accept, and
  invent a host-private contract in the same breath that
  `settings.compensation` just demonstrated is the wrong move. P3 residue.
- **RFC 0157 chain-carried compensation** (P2b) and P3/P4.

### P3 — Operations recovery, implemented 2026-08-17

Boundaries rows 8 and 10. Nothing new on the wire: RFC 0151 §21 recovery is
already advertised, `CompensationDeclaration` is untouched, and the operator
surface is host-ext under `/v1/host/openwop-app/operations/runs/:runId/
compensation[/actions]`.

#### The three permissions, and why a fourth was not added

`host:compensation:start` / `:retry` / `:waive` in `MANAGEMENT_SCOPES`.

**They are not `PROTOCOL_SCOPES`, and the reason is recorded in-tree twice.**
`features/insights-suite/routes.ts` states it directly — "adding to RFC 0049
PROTOCOL_SCOPES would be a wire change; see ADR 0078 §Phase-1 correction" — and
`host/workloadIdentity.ts` uses that set as the closed-world validator for RFC
0154 **delegated** workload credentials, so its members cross a hop boundary in
fact rather than merely by naming. `connections:use` (ADR 0024) looks like a
counter-precedent; ADR 0078's correction is later and rules the other way.

**The LADDER is the control, not the three ids.** A `host:` scope cannot be
minted onto a custom role, so the built-in role ladder is the only instrument
that can make the three distinct — and three ids granted to one role set would be
a naming convention wearing a control's clothes. So `:start`/`:retry` are
admin-tier and **`:waive` is owner-only**, the rung `host:org:manage` already
sits on. `compensation-recovery-rbac.test.ts` asserts an ADMIN principal resolves
`:retry` and does NOT resolve `:waive`; without that leg every other assertion in
the file would pass under a collapsed ladder (sabotage S4).

| action | scope | reason required |
|---|---|---|
| `start` (host-ext; the P2 sweeper residue) | `:start` | no |
| `retry` | `:retry` | no |
| `skip` / `terminate` | `:waive` | **yes** |
| `substitute` | **`:waive`** | **yes** |

**`substitute` is a waive, not a retry**, and that is the decision most likely to
be read as a filing error. A retry re-runs what the author declared; `substitute`
runs an **arbitrary registered `nodeTypeId`** under the obligation's §C identity,
presenting the same downstream idempotency key — an effect the author never
declared. It is therefore ≥ a waive in authority, and filing it under `:retry`
would have put that escalation on the admin rung. So `:waive` is defined by what
it authorizes rather than by its verb: it is the **authored-contract-override**
permission, covering both "decline to undo" and "undo by other means".
`requiresJustification` is DERIVED from the same map so the two cannot disagree.

#### The route inherits both of `requireTenantScope`'s escapes, deliberately

Called unmodified. Forking it to strip the wildcard-operator or personal-owner
short-circuit would create a second authorization predicate for one question —
the "five copies of one authorization-relevant string" drift generator
`accessControlService.ts` already records for `x-openwop-act-as`.

The consequence is stated rather than left to be discovered: **the three scopes
are vacuous in a solo personal workspace.** A personal owner passes the route.
The composition is still a control, because the SoD gate is what bites there —
`registerCompensationApprovalEligibility` refuses `isPersonalOwner` on purpose
("a personal workspace has exactly one human, so accepting it would make the rule
vacuous precisely where it is the only control"). Route-admits / SoD-refuses is
not an inconsistency: the two gates answer different questions, and the pair is
pinned by its own test.

#### The audit chain — what it proves, and what it does NOT

Rides the EXISTING per-tenant hash chain (`host/auditChainService.ts`, kind
`compensation.recovery`), inheriting its mutex, seq-claim CAS and `verifyChain`.
No second audit system.

**The per-obligation `prevSeq`/`prevEntryHash` pointers are NOT the tamper
guard, and claiming they were would be the dishonest half.** `verifyChain`
already recomputes every hash and every linkage, so a mutated or deleted
persisted entry is detected there whether or not this module exists. What the
pointers buy is **slice-local verifiability**: a reader who fetches one
obligation's timeline can check continuity without re-hashing the whole tenant
chain, and — concretely — it detects a **serving-side omission**, the read model
handing a client a slice with a hole while the store is perfectly intact. That
failure is structurally invisible to `verifyChain`, and it is exactly what a UI
panel is exposed to. Two guards, two separate sets of legs.

#### Ordering: audit first, and the entry is a REQUEST

The append happens before the ledger write and its seq is a **required input** to
that write, so a state change the chain does not record is unreachable.

The payload says **`requestedState`, never `nextState`**. Under the obvious
framing, a crash in the window would leave a record of a waive that never
happened — a *fabricated outcome*, which is strictly worse than the
over-recording it replaced. As written, it leaves a record of what was asked for.

`recoveryAuditSeqs` on the row is **a set, appended**, not a latest-seq. A
`applied = seq <= latest` join reports an entry that crashed mid-apply as applied
the moment any later action succeeds — a false positive on precisely the record
an incident review is reading. Membership is exact; sabotage S10 restores the
`<=` join and reds the leg that drives that exact sequence (apply → crash →
apply).

**Only the ordering test can tell the two orderings apart.** A leg that counted
entries after a *successful* action passes under either. So
`compensation-recovery-partial.test.ts` makes the append genuinely FAIL and
asserts the ledger did not move (sabotage S3).

#### Concurrency — and the fence the state machine would NOT have provided

A `expectedState` precondition, checked inside the per-obligation critical
section and **before any append**, so the loser fails before it writes.

> **MEASURED, not assumed: the state machine would not have caught this.**
> `LEGAL.failed` includes `failed`, so two concurrent waives are BOTH legal
> transitions and both would have applied. Leaning on the transition table would
> have made a concurrency guarantee depend on an unrelated table — and it would
> have evaporated silently the day someone widened it. The premise is pinned by
> its own test (`canTransition('failed','failed') === true`) alongside the
> conclusion, so the design note cannot quietly stop being true.
>
> **This is the "a state machine is not a CAS" lesson, hit a second time on the
> same ledger.** ADR 0554 P2's sabotage 2b recorded the first: `resolveObligation`
> forbade `started -> started`, which LOOKED like the compare-and-swap a losing
> concurrent unwind detects, and was not — two passes each read `requested`
> before either wrote, and both fired the inverse. The general shape is that a
> legal-transition table only rejects a write it SEES; it says nothing about how
> many writers reached the same read. P2 fixed the EXECUTOR's instance of it with
> the per-obligation lock. P3 is the OPERATOR's instance, and it needed a
> different instrument, because here the two writers are not racing inside one
> pass — they are two humans acting on a view each fetched separately, and only a
> precondition carrying the state they SAW can tell the loser apart. Serialization
> alone would have let the second waive apply cleanly after the first.

The loser gets **`version_conflict` (409)** in the flat S22 envelope. No new error
code was needed — the pre-implementation plan expected one, and reading the closed
`OpenwopErrorCode` union falsified that.

**The claim is scoped to WITHIN ONE INSTANCE.** The ledger still has no
store-level conditional write; that is P2's stated limit, neither narrowed nor
widened. The tests run in one process, which is exactly the scope of the claim.

Non-vacuity follows P2's sabotage-2 lesson directly (a duplicate-compensation
fixture that counted IDENTITIES stayed green when the CAS was removed): every
concurrency leg counts **side effects per obligation** — resumes fired, ledger
transitions witnessed, audit entries appended — never "how many obligations ended
up in the right state".

#### High risk is ONE authored fact; the heuristic was rejected

High-risk waive ⟺ **`obligation.requiresApproval === true`**. If the author said a
human must sign off before the inverse RUNS, then declaring it will never run
needs at least as much authority.

**`effectKind === 'payment'` was considered and rejected.** It is exactly the host
heuristic this ADR forbids elsewhere — P2's own rule is "WHICH FAILURES QUALIFY is
read from the policy, never a host heuristic", and "payments are high-risk" is
that move with a different noun. The residue is named rather than hidden: **a
payment obligation declared `requiresApproval: false` is owner-waivable with
scope + reason + audit and no approval.** The instrument that would close it is a
§B `waiveRequiresApproval` field — an **RFC 0151 revision in `../openwop`**,
recorded here as the ask and NOT invented in the host. A test pins the rejection
so a later reader does not "fix" the gap by adding the heuristic back
(sabotage S12 adds it and reds 11 tests).

The waive approval reuses `createCompensationApproval` with `compensationId`
suffixed `#waive`. Approving the inverse and approving its abandonment are
**opposite decisions**; one identity for both would let a decision on the first
read as a decision on the second.

SoD extends the ONE registered `compensation-action` eligibility check to reject
`decidedBy ∈ {requestedBy, startedBy}` — a sibling check would be a second
authorization owner that drifts. `startedBy` lives on the host-local ledger row,
not the approval (which is operator-visible and closer to the wire). It **fails
closed** when the row cannot be read: an unevaluable SoD that permits the decision
is vacuous in exactly the case where something has already gone wrong.

#### The frontend went to `runs/`, not the Operations hub

Boundary row 10 says "Operations run detail". The Operations **hub** is a
cross-tenant console whose every route is `requireSuperadmin` and which has no
run-detail surface at all; run detail is `runs/RunDetailPage.tsx`, already hosting
`RunOpsPanel` ("operations surface for a run"). Putting a **tenant**-scope-gated
control on a **superadmin** page would mix two authority models on one surface,
leaving a reader unable to tell which gate any button is under. So the PANEL is
`runs/RunCompensationPanel.tsx` with keys in the `runs` namespace, while the
ROUTES stay on the Operations feature per this ADR's own boundaries table.

(Side benefit, not the reason: zero collision with the concurrent ADR 0556 P2 SLO
work, which occupies `OperationsHubPage`'s import line, `load()` body and section
seam.)

The panel refuses three overstatements: a failed scope read is surfaced as
`scopeUnknown` rather than silently hiding the controls; an `applied: false` audit
entry renders as **recorded, not applied**; and an open waive approval says the
effect has **NOT** been waived yet. Error handling branches on the flat envelope's
**code**, never the message — `version_conflict` and `approval_required` share a
409 and mean opposite things (sabotage F8).

#### Phase → change table

| What | Where |
|---|---|
| Three scopes + the owner-only rung | `host/accessControlService.ts` |
| Action→scope map, critical section, audit-first ordering, waive gate | `host/compensationRecovery.ts` (new) |
| Obligation-scoped chain over the existing tenant chain + the read model | `host/compensationRecoveryAudit.ts` (new) |
| `startedBy`, `recoveryAuditSeqs`, `waiveApprovalId`, `expectedState`, `CompensationStaleViewError`, `getObligation`, `withObligationCriticalSection` | `host/compensationLedger.ts` |
| SoD extended to `startedBy`, failing closed; `resolveDefinitionForRun` | `host/compensationRuntime.ts` |
| The two host-ext routes | `features/operations/routes.ts` |
| Route-level authz proof (12, HTTP) | `test/compensation-recovery-route.test.ts` |
| `openwop.compensation.recovery` (labels `action`/`outcome`, both closed) | `observability/metrics.ts` + `metricSeams.ts` |
| Panel, client, 4-locale copy, wiring | `frontend/react/src/runs/RunCompensationPanel.tsx`, `client/operationsClient.ts`, `runs/i18n/{en,es,fr,pt-BR}.ts`, `runs/RunDetailPage.tsx` |

#### A defect the first round of tests did not catch

Found by `/code-review` after the suites were green, and worth recording because
the tests were thorough about the things they were designed for and blind to this:

`getObligation` keys on `(tenantId, obligationId)` alone, so nothing tied the row
to the run named in the route path. An operator could name **run B** — the run
the RFC 0049 `authorization.decided` record is written against — while actually
moving an obligation belonging to **run A**. Both runs are in the caller's own
tenant, so this is not a tenant-isolation break; it is an **attribution** break,
and an audit trail that attributes an act to the wrong run is worse than one that
is merely thin. Every guard in this phase was pointed at *whether* an action was
recorded; none asked *which run* it was recorded against.

Fixed by binding the obligation to the named run's TREE
(`row.runId === runId || row.rootRunId === runId`), answering 404 — identical to
a non-existent obligation, since which of the two it was is not a fact the caller
is entitled to.

**The binding is against the tree and NOT `row.runId` alone**, and that is not a
detail: a sub-run's obligation legitimately belongs to its ROOT's plan (ordinals
come from one counter per root, P2), and an operator acts on the root. Comparing
`row.runId` alone would refuse every sub-run inverse — a correctness bug dressed
as a security fix. Sabotaged in BOTH directions (S15 removes the binding, S16
narrows it to `row.runId`); both go red, so the check is neither too loose nor
too strict.

#### Sabotage table

Thirty-two breaks, thirty-two red (16 backend service-level, 9 frontend, 7 route-level). Each asserted its own diff before its
result; two produced no diff on the first attempt and were re-run rather than
counted (see below).

| # | Sabotage | Went red |
|---|---|---|
| S1 | `expectedState` precondition removed from the applier | 3 |
| S2 | both preconditions removed (applier + ledger) | 4 |
| S3 | audit seq no longer required by the write (ordering inverted) | 10 |
| S4 | `:waive` granted to admin (the ladder collapses) | 2 |
| S5 | `substitute` filed under `:retry` | 2 |
| S6 | the reason requirement dropped | 4 |
| S7 | `startedBy` dropped from the SoD exclusion | 1 |
| S8 | SoD fails OPEN on an unreadable row | **GREEN — see below** → 1 after the fix |
| S9 | the per-obligation prev pointer nulled | 3 |
| S10 | `applied` computed as `seq <= latest` instead of exact membership | 1 |
| S11 | `recoveryAuditSeqs` replaced instead of appended | 2 |
| S12 | the rejected `effectKind === 'payment'` heuristic added back | 11 |
| S13 | the `#waive` suffix dropped (waive shares the unwind gate's identity) | 3 |
| S14 | the per-obligation critical section removed | 13 |
| F1 | the client scope gate removed | 2 |
| F2 | waive gated on the retry scope (client ladder collapses) | 1 |
| F3 | blank reason made submittable | 1 |
| F4 | `expectedState` no longer sent | 1 |
| F5 | an unapplied audit entry rendered as applied | 1 |
| F6 | the `scopeUnknown` warning suppressed | 1 |
| F7 | 403 folded into the generic failure state | 1 |
| F8 | error branching by STATUS instead of CODE | 1 |
| F9 | the audit-chain warning suppressed | 1 |
| R1 | the ACTION route's scope check dropped entirely | 3 |
| R2 | every action gated on the WEAKEST scope | 2 |
| R3 | the READ route's tenant check removed | 2 |
| R4 | the `operations` toggle gate removed from both routes | **GREEN — see below** → 1 after the fix |
| R5 | `expectedState` no longer required by the route | 1 |
| R6 | `retriable` hoisted to the envelope's TOP level | 1 |
| R7 | the unknown-action validation dropped | 1 |
| S15 | the obligation→run binding removed (act on run A's obligation via run B) | 1 |
| S16 | that binding narrowed to `row.runId` only (sub-run inverses refused) | 1 |

**S8 stayed GREEN with its diff confirmed applied, and that was a defect in the
test.** Deleting the explicit missing-row guard makes the code dereference `null`;
the catch-all converts the TypeError into the OTHER 403, and the assertion matched
on `/cannot be evaluated/i` — a phrase BOTH fail-closed arms share. So the leg
could not tell a working guard from a crash that happened to land safely. Fixed by
pinning each arm's own words and adding a leg that reaches the catch-all
deliberately (a mocked throwing ledger read) instead of only by accident; S8 then
reds. This is the same shape as P2's sabotage 15 — a keyword match looking like
coverage — and it is the second time in this ADR that the fix was to make the
fixture produce the shape being guarded.

**R4 stayed GREEN for the same class of reason, one layer out.** Removing
`requireFeatureEnabled` from both routes broke nothing, because every test in the
route file turns the `operations` toggle ON in `beforeAll` — so the file asserted
the gate's absence as readily as its presence. Closed by a leg that toggles OFF,
asserts a uniform 404 on both routes, and toggles back ON (proving the 404 was
the toggle and not a broken fixture). R4 then reds. Two green sabotages in one
change, both of them mine, and both were tests that could not distinguish "wired"
from "safe".

**F5's first attempt produced no diff** (the substitution did not match) and is
recorded as re-run rather than as a result: a sabotage that never applied reports
"green" and proves nothing.

#### Route-level proof, and a stale limitation it retired

The three suites above are SERVICE-level, and that is not sufficient for this
change: a suite can assert `scopesForRoles('admin')` lacks `:waive` and still
ship a route that never checks it. Those are different claims, and only an HTTP
test says the WIRE refuses. `compensation-recovery-route.test.ts` (12) is that
test — the scope ladder as a real member of a real org resolves it, cross-tenant
neutralization, the flat envelope, and the toggle gate.

Getting a REFUSABLE member took three measured corrections, each of which had
first produced a green-but-meaningless leg:

1. members must sign up with **`sharedWorkspace: true`** — the seam otherwise
   collapses `personalTenant` onto the tenant, making `isOwnPersonalWorkspace`
   true and short-circuiting `requireTenantScope`;
2. they must join the **workspace-ROOT org** (`orgId === tenantId`) — 
   `isWorkspaceMember` matches on that, and membership in any other org leaves
   `middleware/auth.ts` bouncing the session to their personal tenant, where they
   resolve `basis: 'none'` and the route 404s before authority is consulted;
3. they must **re-login** afterwards — membership is evaluated at session MINT,
   so the first session predates the member row.

> **This retires a limitation recorded as open.**
> `test/kicktodo-authz-scope.test.ts` states that a full HTTP 403/200 proof is
> unreachable because "the `test/login` seam cannot mint that today … Closing
> that needs a session-model change, which is out of scope. GC-1 stays OPEN for
> the HTTP half." That header **predates the `sharedWorkspace` flag** and is now
> stale: the recipe above works today and no session-model change was needed.
> Left for its owner to update rather than edited from here, but recorded because
> the next person to need an RBAC route test will otherwise read it and stop.

#### Evidence

- `compensation-recovery-rbac.test.ts` (23), `compensation-recovery-audit.test.ts`
  (11), `compensation-recovery-partial.test.ts` (14), and
  `compensation-recovery-route.test.ts` (12, HTTP) — 63 backend.
- `runCompensationPanel.test.tsx` (17) frontend.
- Adjacent suites unchanged: `compensation-ledger`, `compensation-unwind`,
  `compensation-seam`, `compensation-approval-sod`, `compensation-policy`,
  `agrade-wire-blocked-residue`, `access-control`, `access-header-parity`,
  `kicktodo-authz-scope`, `kms-backend-preflight` — 155 passed.
- `node scripts/check-metric-labels.mjs` — 24 metrics, 44 labels, 0 forbidden.
- `frontend/react && npm run build` — exit 0 (tsc + 26 integrity gates + i18n
  4-locale parity + vite + built-CSS/bundle/CSP checks).

#### What P3 did NOT ship, named rather than implied

- **`waiveRequiresApproval`** — the §B field that would let an author gate a
  waive independently of `requiresApproval`. **ASKED, NOT INVENTED**: routed to
  the spec worker 2026-08-17 as **S36**, an RFC 0151 revision in `../openwop`.
  Recorded here with the exact semantics requested, so the corpus fix and this
  host's already-shipped behaviour cannot land in disagreement:

  | | |
  |---|---|
  | **Name / type** | `waiveRequiresApproval`, OPTIONAL boolean, added to §B's CLOSED `WorkflowNode.compensation` block (mirroring `requiresApproval`'s shape — not a richer type, which would put a second policy language inside the node block). |
  | **Scope** | Declared PER NODE, recorded onto the obligation at MINT time exactly as `requiresApproval` and `compensationInput` are — so a workflow redefined between the forward effect and the waive cannot retroactively change who had to authorize it. |
  | **Default** | **Inherits the EFFECTIVE `requiresApproval`** (i.e. after §E `approvalScope` escalation), NOT a bare `false`. |
  | **What it gates** | ABANDONMENT only — `skip` / `terminate` (RFC 0151 §E's "terminate as uncompensated"). Explicitly NOT `substitute`. |
  | **Policy interaction** | None of its own. Because the default inherits the EFFECTIVE value, a policy that escalates `approvalScope` escalates waives with it, and no second escalate-only rule is needed. |

  **Why the default inherits rather than defaulting `false`.** Inheriting is the
  only default under which the field is PURELY ADDITIVE: no existing document
  changes meaning, and this host — which already derives high-risk from
  `requiresApproval` — needs no behaviour change when the RFC lands. A `false`
  default would make the spec and this host disagree the day it shipped, and an
  author who never heard of the field would silently get the weaker rule. The
  substantive argument is the same one that put the derivation there: if a human
  must authorize RUNNING an inverse, a human must authorize DECIDING IT WILL
  NEVER RUN. `true` was rejected in the other direction — it would demand a
  second human for ordinary operator cleanup on obligations no author ever marked
  sensitive.

  **Why `substitute` is excluded, stated because the exclusion looks
  inconsistent with this host's scope map.** Two different gates: the SCOPE asks
  *who may request this*, the APPROVAL asks *does a second human sign it off*.
  `substitute` needs the high scope (`:waive`) because it executes an arbitrary
  registered node type under the obligation's §C identity — but it is still an
  ATTEMPT TO UNDO, and gating it on a waive approval would demand human sign-off
  to do MORE undoing, which inverts what the gate is for. If substitution should
  need its own second human, that is a DIFFERENT field and should be asked for
  separately rather than folded in here.
- **`exhaustedDisposition` / `onParentCancel` BEHAVIOUR**, and
  **`settings.compensation.timeoutMs`** enforcement — all still validated at
  registration only, carried forward from P2 unchanged.
- **Terminal failures that bypass `finalizeRun`.** P2 named closing this as
  "the first thing P3's recovery routes should close". The routes now give an
  operator a way to act on those stranded rows (`start`), which is the recovery
  half — but the CHOKE itself is untouched: a run reaped by the dispatch
  sweeper still leaves its obligations at `requested` without an automatic
  unwind. Recorded as still open rather than counted as closed.
- **Cross-instance "exactly one wins"**, per the scoping above.
- **Triggers beyond `node-failure`** — P2 residue, unchanged.

### S36 honoured — `waiveRequiresApproval`, implemented 2026-08-17

P3 shipped with the ask ("asked, not invented") and the corpus answered the same
day: `openwop-1` landed `waiveRequiresApproval` in RFC 0151 §B. This section is
the host side of that round trip.

#### The red that surfaced it was NOT this branch

`npm run ci` failed at `check-vendored-schemas`:
`schemas/workflow-chain-pack-manifest.schema.json [vendored BEHIND canonical]`.
Attributed by measurement before anything was touched: this branch changes
**zero** files under `schemas/`, its copy is byte-identical to `origin/main`'s,
and a **clean detached `origin/main` worktree reproduces the failure** against the
canonical GitHub raw URL. `origin/main` was red for everyone. The delta was
exactly the new field plus whitespace reformatting of a neighbouring `if/then`.

#### Vendoring WITHOUT honouring the field would have been the dishonest half

The field is OPTIONAL, so a stale host accepts a document it under-enforces: an
author setting `waiveRequiresApproval: true` on an obligation whose
`requiresApproval` is `false` gets **no gate at all** while believing they bought
one. That is the accept-then-under-enforce class this ADR already warns about,
which is why the vendor and the implementation land together rather than the
schema alone.

Scope was held to the two compensation schemas. `sync-schemas.sh` rewrites SIX
files — it would also have dragged in `capabilities.schema.json`,
`schemas/README.md`, and the new `compensation-policy.schema.json` /
`workload-identity.schema.json` (RFC 0154, a different lane). Those are H54's.

#### The explicit-`false` question: asked as S37, DECIDED (A)

`compensation.md` §B defined the DEFAULT as the effective `requiresApproval` but
never said whether an explicit value could LOWER it, and §E only ever referred to
"the obligation's EFFECTIVE `waiveRequiresApproval`". Two readings survived the
text:

| | |
|---|---|
| **(A) escalate-only parity** | an explicit value may RAISE but never LOWER — mirroring `approvalScope`, which "can only turn `false` into `true`" |
| **(B) declared-wins** | an explicit value is honoured in both directions |

Implemented (B) first — the plain reading of the text as written — and **routed
the ambiguity to openwop-1 as S37 rather than guessing at a contract that has an
owner** (ADR 0548 invariant 4, which applies even when the guess errs safe).

**S37 decided (A), merged as `openwop#1064`** (prose only, no suite bump). §B now
reads: *"Escalation is a floor. An explicit `waiveRequiresApproval: false` MUST
NOT lower a value that policy escalation has raised: the effective value is
`(declared ?? declared requiresApproval) OR (approvalScope === 'all')`."*

The two halves settle DIFFERENTLY, and both are pinned:

- an explicit `false` **still beats the node's own `requiresApproval`** — an
  author may legitimately say *sign-off to RUN the inverse, but declining is an
  ops call*. That half of (B) survived.
- an explicit `false` **never beats WORKSPACE escalation** — a node-level
  declaration must not strip a control the workspace imposed. That half of (B)
  was wrong, and is what #1064 closed.

> **The flip cost ONE line, which was the point of isolating it.**
> `effectiveWaiveRequiresApproval` is the single choke; changing it and two named
> expectations was the entire change. Had the comparison been inlined at its call
> sites, a corpus answer would have been a hunt through the validator, the mint,
> the gate and the chain carry — and the copy that got missed would have been
> found by an operator, not a test.
>
> **THE PARENTHESIZATION IS THE RULE, not a detail.** `requiresApproval(d)` is
> called with NO policy on purpose, so the escalation term stays a separate OR'd
> floor. Folding the policy into the `??` default —
> `d.waiveRequiresApproval ?? (requiresApproval(d) || approvalScope === 'all')` —
> reads as equivalent and reinstates exactly the defect #1064 closed, because an
> explicit `false` would once again shadow the escalation. Sabotage **S23b**
> exists for that specific misreading and reds it.

#### The mint needed the policy, and skipping that would have been silent under-enforcement

§B says the default is the **post-escalation** value, stamped at mint.
`recordForwardObligation` had no policy in scope, so stamping the RAW value would
have gated *running* an inverse under `approvalScope: 'all'` while leaving the
*waive* ungated — under-enforcement of a document the host accepted. `definition`
is already in scope at the only call site (`executor/executor.ts` declares it at
:1300; the call is at :1707), so it is a one-line pass-through.

Rows minted before this change carry no stamp ⇒ the gate falls back to
`requiresApproval === true`, the pre-S36 behaviour. The honest degradation, and
the same shape as `compensationInput`'s "absent ⇒ …".

#### The guard's list was incomplete, and the reason mattered more than the gap

`workflow-definition.schema.json` was absent from `check-vendored-schemas.mjs`'s
`FIXED` set. But that file's stated membership criterion is "if a RUNTIME loader
ever reads the vendored copy" — and **measured, nothing does**: only comments
reference it, and `workflowDefinitionValidation.ts` is a HAND-WRITTEN mirror. (The
chain manifest, which genuinely is `readFileSync` + ajv-compiled at
`workflowChainPackLoader.ts:232`, was guarded correctly.)

Added anyway, under a THIRD harm class stated explicitly rather than by
pretending it is runtime-read: **a stale reference copy for a hand-written mirror
validator** — which is precisely how #3274 lost the `compensation` carry. Adding
it under the existing rationale would have made the guard file assert something
untrue, the exact defect that file exists to catch.

#### Conformance skew — what is and is not witnessed today

MEASURED, not inferred from a version number: the pinned suite here is
**1.136.0** (`package.json` `^1.136.0`, installed 1.136.0) and
`grep -rn waiveRequiresApproval` across `@openwop/openwop-conformance` returns
**nothing**. The `compensation-profile.test.ts` shape legs (absent-valid /
boolean-valid / non-boolean-refused) become witnesses when the pin reaches
1.136.2 — folded into H54.

Stated plainly because it changes how the host-side legs should be read: **until
that pin moves, the tests below are the ONLY thing standing between an author's
`waiveRequiresApproval` and silent under-enforcement.** They are load-bearing,
not belt-and-braces, and the pin bump adds a second independent witness rather
than finally providing the first.

#### The six allowlists, and the one that turned out not to be one

A field absent from an allowlist is not rejected — it is silently discarded
(#3274, #3292). Carried through: the validator's closed-key set AND its rebuild
(`workflowDefinitionValidation.ts`), `carryCompensation` in `expandChain`
(`workflowChainPackLoader.ts`), `compensationDeclarationOf` and the mint carry
(`compensationRuntime.ts`), the node type (`executor/types.ts`), and the ledger
row.

**The frontend builder is NOT one of them, and that was verified rather than
assumed**: `builder/schema/workflow.ts` holds `compensation` as an opaque
`Record<string, unknown>` and round-trips it verbatim, so the field rides through
for free. Added to the `roundTripFidelity` fixture to PROVE it — an assumption
about a serializer is exactly what ate the field last time.

#### The sabotage round found the same seam-blindness this ADR already names

Twelve breaks. Four were GREEN on the first attempt — **S20** (the declaration
reader stops carrying the field), **S21** (the mint stamps the RAW declaration
instead of the effective value) and **S25** (the executor stops passing the
policy) — and all three are ONE hole: the S36 gate tests hand-build ledger rows,
so they exercised the GATE faithfully while the production path that PRODUCES the
row went untested. That is verbatim the UQ4 failure recorded above ("two correct
halves, each with passing tests, and no test crossing the seam"), reproduced by
me in the same file, two phases later.

Closed for S20/S21 by legs that drive the REAL `recordForwardObligation` — the
seam the executor calls — and assert the stamped value, including the
policy-escalation case a hand-built row can never reach.

**S25 IS NOW COVERED — the "known gap" was the wrong answer.** It was first
recorded here as an accepted gap, on the reasoning that the only discriminator
(`approvalScope: 'all'`) would gate every §21 seam inverse and break the
conformance witness. That reasoning was sound about the SEAM and wrong about the
conclusion: the seam is not the only way to reach the executor.
`test/compensation-executor-policy-stamp.test.ts` drives `executeRun` directly
with its own one-node workflow, a real guarded `payment` effect, and
`settings.compensation.approvalScope: 'all'` — then asserts the STAMP on the row
the executor minted. Nothing in it hands the policy to the mint; that is the
point. S25 now reds on the escalation assertion itself (not on a setup guard),
while both non-vacuity legs stay green.

Recorded because the near-miss is the lesson: **a third instance of this ADR's
own seam-blindness was about to ship as a documented gap.** UQ4 was the first,
S20/S21 the second, S25 the third — each time, two correct halves with passing
tests and nothing crossing between them. Writing the gap down would have made it
durable rather than fixed.

The node declares a BARE §B block, so every value the assertion turns on has to
arrive from the workflow's settings — which is what makes it a test of the
executor's pass-through rather than of the declaration.

| # | Sabotage | Went red |
|---|---|---|
| S17 | `carryCompensation` drops the field (chain expansion) | 2 |
| S18 | validator's closed-key set rejects it | 15 |
| S19 | validator's rebuild drops it (accepted, then discarded) | 4 |
| S20 | `compensationDeclarationOf` drops it | **GREEN** → 3 after the mint-seam legs |
| S21 | the mint stamps the RAW declaration | **GREEN** → 2 after the mint-seam legs |
| S22 | `isHighRiskWaive` ignores the stamp | 2 |
| S23a | S37 reverted to the rejected reading (B) | 2 |
| S23b | escalation FOLDED into the `??` default (the #1064 parenthesization trap) | 2 |
| S23c | the escalation floor removed entirely | 3 |
| S24 | pre-S36 fallback un-gates legacy rows (`?? false`) | 3 |
| S25 | the executor stops passing the policy | **GREEN → 1** after the executor-level test (reds the escalation assertion, not a setup guard) |

**The S23 family is the isolation, measured.** When S37 came back (A), the flip
was one line plus two expectations — and all three S23 variants (revert to (B),
fold the escalation into the default, drop the floor) red the escalation-floor
legs in BOTH the unit choke and the MINT. The mint half matters most: the stamp
is what the waive gate reads forever after, so a floor applied only in the unit
function would be lost the moment the row was written.

### P4 — still open

> The original note read: "All wait on **RFC 0151** (`Draft`; wire shape
> unlocked), per ADR 0548 invariant 4." That premise expired — 0151 is
> `Accepted`. The block is now the unlanded **schema/conformance**, which is a
> different and much more specific reason. Same decay as the residue register's
> stale `Draft` header: the label stayed right while the justification underneath
> it rotted.
>
> **Corrected again 2026-08-16:** that second reason has now expired too
> (`openwop#1007`). P3/P4 are simply unimplemented, which is the honest and
> final form of this note.
>
> **Narrowed 2026-08-17:** P3 shipped (above). P4 — crash at every state
> boundary, duplicate delivery, stale worker, replay/fork under chaos — remains
> unimplemented. P3 closed the two adversarial cases that its own surface owns
> (concurrent duplicate operator actions, and the crash between an action and
> its audit record) and scoped the concurrency claim to one instance; P4 is
> where the cross-INSTANCE half is qualified, and it needs the conditional write
> a production storage adapter provides.

## Alternatives weighed

- Database rollback for external effects: impossible; remote effects are not in
  the host transaction.
- Feature-local sagas only: rejected; each would reinvent ordering, idempotency,
  events and operator recovery.
- Automatic compensation for every failure: rejected; policy decides which
  failures qualify and some effects require human approval or are irreversible.

