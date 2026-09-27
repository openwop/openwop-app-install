# ADR 0585 — Executor liveness heartbeat, and what the dispatch lease is actually for

Status: Accepted — decision recorded 2026-08-18; implementation phased below. Supersedes the "accept 12 minutes"
option recorded as D9 in `docs/DECISIONS-BLOCKING-A-PLUS.md`, and closes the stale-worker half of ADR 0551 P3
and ADR 0554 P4 by deciding it rather than by documenting it.

Date: 2026-08-18

## Context

When an instance dies mid-run, its runs are untouchable by any peer for **12 minutes**:

```
RUN_DISPATCH_LEASE_MS = RUN_DURATION_CEILING_MS (600s) + 120s
```

and `RUN_DURATION_CEILING_MS` is ADVERTISED as `capabilities.limits.maxRunDurationMs`, so it cannot be
shortened without changing a wire claim.

The decision was framed as a binary: **(A)** accept the 12 minutes and state it as a bound, closing both phases
on a documentation change, or **(B)** shorten the lease so recovery is fast.

**Both are wrong, and the measurement that shows it is this:**

```
grep -rn "setRunDispatchLease(" src/   ->  executor.ts:1355   (ONE call site, outside the adapters)
```

**The lease is set exactly once, at dispatch. It is never renewed.** So it is not a liveness signal at all — it
answers *"could this run still legitimately be running?"*, not *"is the worker alive?"* That is why it must be at
least as long as the longest legal run, and it is why crash detection currently takes as long as the maximum
run duration.

## Decision

**Add an executor liveness heartbeat, and keep the advertised duration ceiling. Do not shorten the lease
without one, and do not accept 12-minute crash detection as a posture.**

The two questions get two mechanisms:

| question | mechanism | order |
|---|---|---|
| is the worker alive? | **heartbeat** — the executor periodically extends its lease while the run is active | seconds |
| may this run still be running? | the advertised `maxRunDurationMs` ceiling | minutes |

This is the separation Temporal makes, and its documentation gives the exact failure we have: for
long-running work, *"using a long timeout would increase the delay before a stuck or crashed worker would be
identified"*. Temporal's server also cannot detect a worker that crashes or loses communication, and relies on
timeouts to force retries — which is why it recommends heartbeats with their **own** timeout rather than
leaning on the execution timeout.

**Why (B) alone would have been dangerous, and this is the part that matters.** Shortening the lease without a
heartbeat declares *live* long-running runs dead and re-dispatches them, and this host has **no effect
fencing** — `idempotency.crossRegion` is `single-region`, RFC 0150 §D's fenced-effect arm is not implemented.
So a shortened lease trades a 12-minute stall for **duplicate side effects**, in a system whose compensation
inverses are refunds. The long lease is currently standing in for fencing, and that is load-bearing.

**Why (A) alone was wrong.** "12 minutes is our declared bound" describes the absence of liveness detection as
though it were a design posture. It is honest, and it is not bulletproof: a crashed instance's in-flight runs
stall for as long as the longest run anyone is permitted to author.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| P0 | **IMPLEMENTED — #3381, `0425b3e71`.** Heartbeat renewal in the executor: extend the lease every `RUN_LEASE_HEARTBEAT_MS` (30s) while the run is active; ceiling and advert untouched | `test/adr0585-p0-lease-heartbeat.test.ts` (12) — see the implementation note below for why the gate is not the one proposed here |
| P0b | **IMPLEMENTED.** CAS lease renewal + an effect gate for a lost lease. Fixes a defect in P0 (see the correction below) and is P1's prerequisite | `test/adr0585-p0b-lease-ownership.test.ts` (11), incl. a steal-back positive control that fails against pre-P0b code |
| P1 | **BLOCKED — but for a NARROWER reason than this row long said; the precondition section is AMENDED 2026-09-01 (measurement 4 was falsified by our own P0b) and the RFC 0150 §D citation is QUERIED with the corpus.** Reduce the ORPHAN reclaim threshold to a small multiple of the heartbeat (proposed 5x), so a dead worker is reclaimed in ~2.5 min rather than 12 | The two-process outbox-handoff test (ADR 0551 P3's achievable half) |
| P2 | **IMPLEMENTED — but NOT as written here. "On the wire" was wrong; see the P2 correction below.** Publish the recovery bound as the per-class ARITHMETIC in the RFC 0148 evidence bundle, where a reader can recompute it | `test/adr0585-p2-recovery-bound-published.test.ts` (8), incl. a guard that the bound must NOT become a discovery field |

**P0 is safe on its own** and is the whole of the correctness win: with renewal, only a genuinely dead worker's
lease lapses, so P1's shorter threshold stops being a duplicate-execution risk. P1 without P0 is the dangerous
ordering and must not be taken.

## Trade-off accepted

A blocked event loop can delay a heartbeat and make a live worker look dead. Mitigated by a generous multiple
(5x) rather than a tight one, and by the existing CAS on `claimOrphanedRuns` — a reclaim is a compare-and-swap,
so two claimants cannot both win the row. The residual risk is a *slow* worker being reclaimed while still
executing, which is the same risk the 12-minute lease has today, only bounded differently.

## Falsifiability

If effect fencing (RFC 0150 §D) lands first, P1's threshold can be far more aggressive, because a re-dispatch
of a live run stops being able to duplicate an effect. Conversely, if the heartbeat proves unreliable under
load on Cloud Run's CPU throttling — where a suspended instance stops executing timers — P0 must be reconsidered
before P1: a throttled instance that stops heartbeating while its run is still live is exactly the false-dead
case, and this host has already been bitten by `cpu-throttling=true` suspending a detached continuation.

## Sources

- Temporal, *Detecting Activity failures* / *The four types of Activity timeouts* — heartbeat timeout is
  separate from execution timeout precisely so crash detection is not gated on the duration bound.

## Implementation record — P0 (2026-08-19, #3381 `0425b3e71`)

**The proposed P0 gate was not achievable as written, and the substitution is
recorded rather than quietly made.** "A test that a long-running run keeps its
lease past the old expiry" needs a run that outlives a 12-minute lease; a test
cannot do that, and a timing-dependent test for a timing bug is the thing this
program has already refused to ship once. So the renewal DECISION was extracted
as a pure predicate (`isLeaseRenewalDue`) and pinned there — the same seam as
`compensationTriggerFor` — with the safety invariants asserted directly: a
renewal never moves the expiry backward, the heartbeat is an order of magnitude
under the lease (so renewal is not decorative), and the lease still outlives the
advertised ceiling.

**Renewal rides the scheduling loop, not a `setInterval`** — a deliberate answer
to this ADR's own falsifiability clause. Under Cloud Run `cpu-throttling=true` a
suspended instance stops executing timers, so a timer-driven heartbeat would keep
claiming liveness for a process that has stopped. A renewal that happens where
work happens cannot claim liveness the process does not have. It is `await`ed for
the same reason.

**One finding that changes P1, discovered by reading the loop and not by any
test.** The scheduler's wait branch parks until an in-flight node settles, so a
SINGLE long-running node would starve renewal for up to the entire duration
ceiling. Harmless under P0 — which is purely additive, since a renewed expiry is
always ≥ the one it replaces — but it would have made P1's shorter threshold
declare a run with one slow node dead. The wait branch now wakes for the
heartbeat as well as the deadline. **No P0 test can fail on this**, precisely
because P0 cannot reclaim anything early, which is why it had to be found by
reading rather than by running.

**The test suite caught itself.** Its first version asserted only that the
renewal helper EXISTS, so deleting the call from the loop left every case green
while the executor renewed nothing — a guard that pins a definition and calls it
a call. Found by sabotaging before trusting; it now asserts the call site sits
inside the scheduling loop, and all three sabotages (remove the call, drop the
heartbeat from the race, make the predicate never fire) go red.

P1 and P2 remain open, in that order, and P1 must not precede P0.

## P1 precondition — measured 2026-08-19, and it FAILS

This ADR's own falsifiability clause reads:

> *"if the heartbeat proves unreliable under load on Cloud Run's CPU throttling —
> where a suspended instance stops executing timers — **P0 must be reconsidered
> before P1**: a throttled instance that stops heartbeating while its run is
> still live is exactly the false-dead case"*

**That condition was checked before starting P1 rather than after shipping it,
and every fact holds.** P1 does not ship.

### The four measurements

1. **`run.googleapis.com/cpu-throttling: 'true'`** on the live service
   (`gcloud run services describe openwop-app-backend`). CPU is throttled to
   near-zero when no request is in flight. `minScale: 1` keeps an *instance*
   warm; it does not keep *CPU* allocated.

2. **Runs execute DETACHED from any request.** `host/runDispatch.ts` dispatches
   via `setImmediate(() => executeRun(...))` — deliberately, so the HTTP
   response returns first. So the common case is a run executing on an instance
   with **no request in flight**, which is precisely the throttled state.

3. **The reclaim predicate is the LEASE EXPIRY, not a separate threshold.**
   `selectOrphanedRunIds` is
   `status IN ('pending','running') AND dispatch_lease_expires_at < nowMs`
   (`storage/sqlite/index.ts:191`). So "reduce the reclaim threshold" is
   necessarily "**write a shorter lease**" — P1 is a change to the value
   written at dispatch and renewal, not an argument passed to the sweeper.
   Worth stating because the phase table's wording suggests otherwise.

4. **Nothing re-checks lease ownership mid-run.** A grep for `dispatch_owner` /
   `dispatchOwner` outside the storage layer finds only the sweeper's logging.
   Once `executeRun` is running, **no code path asks whether this instance still
   owns the run.**

### Why they compose into a blocker

Today the lease (12 min) outlives the maximum legal run (10 min), so a live run
**cannot** be reclaimed while it is running. That is the sense in which the long
lease stands in for fencing.

Set the lease to 5 × 30s = 150s and that stops being true. A run whose instance
is CPU-throttled for more than 150 s — which requires no failure at all, only
the absence of concurrent requests — has its lease lapse **while the run is
alive**. The sweeper reclaims it and re-dispatches it. The original executor
then resumes when a request next arrives, and by (4) it never learns it lost
ownership.

**Two executors, one run, no effect fencing.** (See the citation correction
below — the conclusion holds, the evidence originally cited does not.) In a system
whose compensation inverses are refunds, that is a duplicate refund. P1 without
this precondition is the danger the ordering was designed to prevent, arriving
by a route the ordering did not anticipate — **P0 is present and correct, and
P1 is still unsafe.**

> **AMENDED 2026-09-01 — measurement (4) IS NOW FALSE, and it was falsified by
> this ADR's own P0b.** The section above still reads as written on 2026-08-19,
> and a reader reaching "P1 is BLOCKED" was being handed a fact about the host
> that stopped being true when P0b merged. That is the stale-precondition shape
> this ADR corrected in `host/recoveryBound.ts` — *a conclusion invites checking;
> a precondition terminates inquiry* — reproduced here, by the author, in the
> document that names it.
>
> **What (4) said:** *"Nothing re-checks lease ownership mid-run … no code path
> asks whether this instance still owns the run."* **What is true now:** the
> heartbeat renews by CAS on the owner (`renewRunDispatchLeaseIfOwner`), its
> `false` return IS the liveness signal, `assertEffectAllowed` refuses once the
> lease is known lost, and the losing executor writes nothing. P0b is exactly the
> "lease-ownership re-check" listed as unblocking option 2 below.
>
> **What that does and does not change.** The sentence *"by (4) it never learns it
> lost ownership"* is now wrong: it does learn, at its next renewal. But the
> **conclusion** survives in weakened form, and P1 stays blocked. A CPU-throttled
> instance executes nothing — heartbeat included — so on resume it continues
> mid-`module.execute` and can reach a seam before the next renewal proves the
> loss. **The window is BOUNDED to the effects of the one node already in flight
> at resume, not eliminated.** "Unbounded duplicate execution" became "at most one
> node's effects"; it did not become zero, and `replay.sideEffectSuppression`
> stays `none`.
>
> So the live question is no longer *"is there any fence?"* but **"is a
> bounded-to-one-node window a posture a single-region host may adopt in exchange
> for a shorter recovery bound?"** — which is a different question than the one
> this section was written to answer, and is raised with the corpus (below).

### What would unblock it, in preference order

1. **Effect fencing (RFC 0150 §D).** The ADR already says this: with fencing, a
   re-dispatch of a live run cannot duplicate an effect, and P1's threshold can
   be aggressive. This is the real fix and it makes the question moot.

   > **CITATION QUERIED 2026-09-01 — §D may not apply to this host at all.**
   > Measured: RFC 0150 is `Accepted`, but §D is headed *"Fenced **multi-region**
   > effect ownership"* and its MUST binds *"a host claiming **multi-region**
   > effect safety"*. Its strategy vocabulary is `single-region` /
   > `reconciled-records` / `fenced-effects` — cross-region recovery — and
   > `single-region` is an explicitly legitimate value meaning *"no cross-region
   > guarantee"*, which says nothing about **two instances of one service in one
   > region**, the hazard above.
   >
   > And this host **claims nothing**: `crossRegion` appears zero times in
   > `routes/discovery.ts` and the `idempotency` block is **absent** from the live
   > discovery document (verified against the canonical root
   > `/.well-known/openwop`, byte-identical to `/api`).
   >
   > So "blocked until §D lands" may be blocked on a clause that does not bind us
   > — §D is already `Accepted`, and it would still not require the intra-region
   > fence P1 needs. The *mechanism* §D mandates (a monotonic fencing token from a
   > linearizable ownership service, adapter rejects a stale token) would fix our
   > case; it simply is not what §D asks of a single-region host.
   >
   > **Raised with the corpus rather than resolved unilaterally**, because
   > "the spec does not cover us, so we may proceed" is exactly the reasoning that
   > should not be self-served. Three questions are open: whether §D is meant to
   > reach intra-region split-brain; whether intra-region fencing is a corpus
   > concern or host-internal; and whether §F's
   > `multi-region-stale-owner-no-effect` has an intended intra-region analogue.
   > **P1 remains blocked until that comes back**, on this citation or on a
   > better-founded one.

2. **A lease-ownership re-check in the executor** — cheap, local, and a genuine
   partial fence. Before each side-effecting step, verify this instance still
   owns the dispatch lease; if not, stop rather than continue. It converts the
   duplicate-execution window from "unbounded" to "one step", and unlike (1) it
   needs no wire change. It is not free: it adds a read per effect, and it
   cannot un-commit an effect already in flight when ownership was lost.

3. **`--no-cpu-throttling`** (always-allocated CPU). Removes the mechanism
   outright, and is the only option here that is purely operational. It changes
   the billing model, so it is the operator's call and not a decision this ADR
   should make. **Not recommended as the sole remedy**, because it makes P1's
   safety depend on a deploy flag that any future `gcloud run deploy` could drop
   — the same class as a wire claim resting on an env var.

4. **Do nothing, and keep the 12-minute bound as a declared posture.** This is
   option (A) from the original decision, which was rejected for good reasons —
   but it is honest, and it is strictly better than a P1 that trades a stall for
   a duplicate refund.

### What this does NOT change

**P0 stands and remains correct.** It was never justified by P1: it makes the
lease answer the question it claims to answer, and it is purely additive — a
renewed expiry is always ≥ the one it replaces, so nothing can be reclaimed
earlier than before P0. The measurements above say P1 needs more, not that P0
was wrong.

**P2 (advertise the recovery bound) is unaffected in principle**, and a later
merge sharpened what it would advertise — this paragraph is CORRECTED rather than
rewritten, because the first version made the mistake the correction names.

It originally read: *"the bound it would advertise is the current 12 minutes, not
the 2.5 minutes P1 was to produce."* **That is a single scalar, and there isn't
one.** `host/recoveryBound.ts` (#3388, RFC 0158 §B) derives TWO classes from the
mechanisms that actually cause the delay:

```
unleasedMs = GRACE_MS               + orphanSweepIntervalMs   (~2.5 min)
leasedMs   = RUN_DISPATCH_LEASE_MS  + orphanSweepIntervalMs   (~12.5 min)
```

A run killed **before** `executeRun` claimed a lease is already recovered in
~2.5 minutes; only the **leased** class waits out the full lease. Quoting a
single "12 minutes" is the lie by aggregation RFC 0158's UQ1 resolution forbids —
it overstates recovery for the faster class by 5x, **and it is wrong in the
safe-looking direction**, which is why it reads as conservative rather than as a
defect. My paragraph did exactly that.

**What P1 actually shortens is `leasedMs`, and only that** — which is the class
this ADR's blocker is about. The unleased class needs nothing from P1.

Advertising a *shortened* leased bound on the strength of an unshipped P1 would
still be the class of wire claim this program spent its length removing. Note
also that `recoveryBound.ts` is **computed but not yet advertised** — no caller
outside the module — so P2 remains open as stated.

## Citation correction — `idempotency.crossRegion` is not a field this host advertises

**MEASURED 2026-08-23, re-verifying the P1 blocker against a main that had moved
42 commits.** The conclusion "no effect fencing" **stands**. The evidence
originally cited for it does not, and it is cited in three places: this ADR's
Decision section, `executor.ts`'s P0 docblock, and the P1 blocker above.

All three say *"`idempotency.crossRegion` is `single-region`"*. On the live host:

```
GET /api/.well-known/openwop
  capabilities.idempotency   -> ABSENT   (no such block, under any spelling)
  crossRegion                -> ABSENT   (0 occurrences in the whole document)
```

`grep -rn crossRegion backend/typescript/src` returns **one hit, and it is the
comment itself** — no code reads or emits it.

**Asserting a VALUE for an absent field is a different claim from noting the
field is absent**, and it is the weaker position dressed as the stronger one. A
reader checking the wire finds nothing and cannot tell whether the host is
`single-region`, multi-region, or simply silent.

**The honest evidence, which is advertised and which says the same thing:**

```
capabilities.replay.sideEffectSuppression = "none"
```

The host declares it does **not** suppress side effects on replay — which is the
fencing question stated on the wire, in a field that exists. Corroborated in
source: no fencing module, and RFC 0150 §D's fenced-effect arm is unimplemented.

**ADR 0591 (`Proposed`, #3422) does not change this.** Its durable effect-escape
ledger makes a duplicate **witnessable per identity** — the instrument RFC 0158
§C.7 needs — and that is genuinely new. But witnessing a duplicate is not
preventing one. **P1's blocker is unchanged**; what 0591 adds is that if P1 ever
did fire a duplicate, we would now be able to prove it rather than infer it.

Left as a correction rather than a silent edit, per this repo's rule: the
original sentence and why it was wrong are both more useful than a clean text.

## P0b — the lease becomes a claim a former owner cannot retake

**Architect-reviewed before implementation** (three blocking findings, all
resolved below). P0b is the "lease-ownership re-check" this ADR listed as
unblocking option 2 for P1.

### A defect in P0, found while designing on top of it

`setRunDispatchLease` is `UPDATE runs SET dispatch_owner = ?,
dispatch_lease_expires_at = ? WHERE run_id = ?` — **no owner predicate**, in
both the sqlite and postgres adapters. As a DISPATCH-TIME stamp that is correct:
the caller is claiming the run. As P0's HEARTBEAT it is a defect.

A reclaimed instance that resumes would, on its next renewal, **take the run
back from the legitimate new owner** and extend the lease by a full
`RUN_DISPATCH_LEASE_MS`. The sweeper then sees a healthy lease and never
re-reclaims, so **the new owner is silently disowned and the zombie's ownership
is self-renewing**. That is worse than the duplicate execution P1 was already
blocked on.

Unreachable today only because the lease outlives the run ceiling. **P1 is
exactly what activates it** — which is why it was found by designing P1's
prerequisite rather than by running anything.

### What P0b adds

1. **`Storage.renewRunDispatchLeaseIfOwner(runId, owner, expiry) → boolean`** —
   the same UPDATE plus `AND dispatch_owner = ?`. Compare-and-swap on an owner
   token is the shape `kvCompareAndSwap` already established here; this is not a
   new concurrency primitive. The heartbeat uses it; the dispatch-time stamp
   keeps the unconditional form, because claiming is what it is for.
2. **The `false` return is the liveness signal.** A resumed instance learns it
   lost the run *on the write it was making anyway* — no extra read buys this.
3. **A bounded per-run `Set` in `runEffectContext.ts`**, beside `effectCounts`
   and with the same eviction discipline. It is deliberately NOT a field on
   `RunEffectContext`: that interface is entirely `readonly` and the executor
   builds a fresh one **per node**, while the heartbeat runs in the scheduling
   loop outside any node's ALS scope. A flag there would be written where it
   cannot be read.
4. **`assertEffectAllowed` refuses** with a typed `LeaseLostError` — the single
   synchronous chokepoint every effect seam already calls, so no seam changes.

### The losing executor writes NOTHING

Not `emitTerminalFailure`, not `unwindTerminatedRun`. A terminal event from a
former owner is a lost update on a row the new owner is also writing, and on the
failure path a `node.failed` is what **triggers compensation** — firing refund
inverses against effects the new owner is legitimately re-executing.

Three separate places had to agree for that to hold: the node error handler
re-throws `LeaseLostError` instead of recording a failure; the task wrapper
catches it so the rejection cannot escape into
`dispatchRunInBackground`'s catch (**which marks runs failed** — found by
tracing where the rejection actually lands, not by reading the happy path); and
the loop abandons via a helper that writes nothing.

**`abandonedLeaseLost` is an internal flag on `ExecuteRunResult`, not a new
`RunStatus`.** `RunStatus` is on the wire, and "the former owner stopped" is not
a state of the RUN — the new owner's run is still going. Inventing a status for
a host-internal fact would have been a wire change.

### What this is NOT

**Not effect fencing.** A CPU-throttled instance executes nothing at all —
heartbeat included — so on resume it continues mid-`module.execute` and can
reach a seam before the next renewal proves the loss. P0b converts **unbounded**
duplicate execution into **at most the effects of the one node already in flight
at resume**. RFC 0150 §D is what makes that window zero, and
`replay.sideEffectSuppression` stays `"none"` because a partial fence is not
suppression.

**No RFC needed** — no wire field, no capability, no event shape; it rides
`Storage`, the existing owner of durable state. If this is ever *advertised*,
that is a wire claim and needs one.

### Open, and deliberately so

**The lease is never released, only expired.** Nothing clears `dispatch_owner`
on completion, so a finished run holds ownership until expiry. Benign because
the orphan query filters `status IN ('pending','running')` — and left alone
rather than changed, because with CAS renewal it becomes load-bearing and a
change here deserves its own measurement. Recorded so P1 does not inherit it
unexamined.

**`getInstanceId()` is `hostname-pid`**, cached per process, so a throttled
instance that resumes keeps its identity and CAS discriminates correctly. A
collision needs the same hostname *and* pid reuse; on Cloud Run each instance is
a fresh container.

## P2 correction — "on the wire" was wrong, and the citation had moved

P2 was written as *"Declare the recovery bound **on the wire**, per RFC 0151's
amended acceptance criterion"*, with the test note *"advert derived from the
constant, not a literal"*. Implementing that literally would have **minted a
discovery field the governing RFC explicitly declined to mint**.

The citation trail, read rather than assumed:

1. `RFCS/0151:144` does give the criterion — *"a reference host demonstrates
   non-vacuous recovery from a mid-unwind crash within a host-declared bound, and
   that bound is advertised."* That is the sentence P2 was built on.
2. **`RFCS/0151:146`, the next line**, says: *"**This belongs in RFC 0158**
   (durable execution / DR qualification) rather than here, and **moves there when
   0158 is authored** ... It stays in this box until 0158 exists so nothing is
   dropped in transit."*
3. RFC 0158 now exists (`Active`, 2026-08-20). And it resolved the "advertised"
   half the other way: §E.10 **mints no capability field**, choosing bundle-first
   publication. §"`bound-is-derived` evidence" is explicit — the derivation *"is
   emitted into the host's RFC 0148 evidence bundle, where a reader can recompute
   it. It is **not** advertised as a discovery field."*

So P2's target was not "wire the advert to `discovery.ts`" but "emit the
derivation into the certification bundle". The phase description was written
before 0158 existed and was never revisited when it did — a citation that was
accurate on the day it was written and had silently relocated since.

**What shipped.** `certification-bundle-v2` gains an optional `recoveryBound`
carrying **both** `terms` (the inputs) and `classes` (the sums). Both, because
either alone defeats the requirement: sums without inputs cannot be recomputed,
and inputs without sums make every reader redo arithmetic this host has already
decided. The vendored schema is `additionalProperties: true`, so this needed no
corpus change — verified before writing any code, because if it had been `false`
this would have been blocked on a corpus PR rather than host work.

The emitter reads `recoveryBoundTerms()` / `declaredRecoveryBoundMs()` from the
live module at emit time. P2's original test note — *"derived from the constant,
not a literal"* — was the one part of the phase that survived intact, and it is
pinned: sabotaging the emitter into restating literals turns three tests red.

**A guard pins the negative half too.** `discovery.ts` must not import the
recovery-bound module. The realistic failure here is not malice but a later
reader "finishing" P2 as this table originally described it; that sabotage turns
the guard red, with the RFC citation in the failure message.

**Also corrected: a precondition that outlived its own satisfaction.**
`host/recoveryBound.ts` carried *"NOT YET PUBLISHED ... Until the durability
exercise measures which lane actually recovers an unleased run ... Measure first,
then declare."* **That measurement happened in #3461**, which established the
outbox lane always reaches an unleased run first and re-derived `unleasedMs` from
`OUTBOX_LEASE_MS + POLL_INTERVAL_MS` (150s → 65s). The commit that satisfied the
gate left the gate written down. A stale *precondition* is more expensive than a
stale conclusion — a stale conclusion invites checking, whereas a stale
precondition stops the next reader from looking at all.

**P1 remains blocked** and is untouched by this. P2 was never downstream of it
(§"P2 (advertise the recovery bound) is unaffected in principle"), which is why
it could land while P1 waits on effect fencing.
