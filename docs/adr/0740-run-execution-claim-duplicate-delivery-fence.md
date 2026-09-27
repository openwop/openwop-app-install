# ADR 0740 — The run execution claim: one accepted run delivered twice executes once (WHD-12)

Status: Accepted — P1 implemented (`b27f9b3d1`, `4e02c7be6`); P2 and P3 are sequenced below and NOT started

Closes `WHD-12` in `docs/steward/TODO.md`. Host-only: no wire change, no new
advertisement. `capabilities.replay.sideEffectSuppression` stays `"none"` — this
ADR fences DUPLICATE DELIVERY, it does not claim exactly-once effects (see §What
this is not).

## Context — measured, not inferred

RFC 0158 §C: *"the same accepted work delivered twice fires each effect exactly
once"*. Building the conformance seam for that row (ADR 0739) measured the
opposite on this host, deterministically, 3/3:

```
one run, handed to executeRun twice concurrently, first node = an HTTP POST
  arrivals at the suite's receiver   2
  node.completed@effect              2
  run.completed                      2      ← two terminal events on one log
```

Three facts produced it, each checkable:

1. **The dispatch lease was a stamp, not a claim.** `executeRun` called
   `storage.setRunDispatchLease(runId, owner, expiry)` — `UPDATE runs SET … WHERE
   run_id = ?`, no predicate — and its own comment said so: *"Lease is an
   availability optimization, not a correctness gate."*
2. **Two production paths deliver the same run.** `POST /runs` commits the run
   and its `dispatch_outbox` row together, then fires a `setImmediate` dispatch
   HINT; the outbox lane redelivers from the row. The outbox lane's guard is a
   read-then-decide (`run.status !== 'pending'`, lease live) that is not atomic
   against `executeRun` — both can pass before either stamps.
3. **The only duplicate-effect claim covered one seam.** ADR 0618's
   `claimInvocation` has exactly one production caller,
   `notifications/emitter.ts`. HTTP egress, brokered egress, webhook delivery,
   SMTP, Stripe and blob-put have replay suppression + an escape ledger and no
   per-identity claim. The notification fixture survived duplicate delivery only
   because delivery 2 was aborted inside `core.delay` by the terminal check — and
   it appended `node.failed` at seq 9 BEHIND `run.completed` at seq 8.

ADR 0585 had already named the gap (*"this host has no effect fencing … the long
lease is currently standing in for fencing, and that is load-bearing"*) and
listed "a lease-ownership re-check in the executor" as unblocking option 2.

## The options, and what the industry does

Evaluated with `/architect` (options mode) plus a survey of eight engines
(Temporal/Cadence, Restate, DBOS, Inngest, Azure Durable Task, AWS Step
Functions, Cloudflare Workflows, Cloud Tasks/Sidekiq). Sources are in the PR.

**The dominant pattern, without exception:** nobody promises exactly-once
EXTERNAL effects. They promise exactly-once RECORDING of a step result (a
conditional write to the journal) around at-least-once execution of the step
body, and tell users to send a stable idempotency key — `workflowRunId + stepId`
— that the REMOTE service enforces (Temporal: *"enforced by the service you are
calling… not by the Activity itself"*; Inngest: memoization *"can't reach back
and neutralize a side effect that already escaped"*). Engines that rely on
leases add a store-enforced epoch/range-id/ETag, because a lease alone is unsafe
(Kleppmann; Azure Durable Task #38 is the documented case of two workers both
believing they owned a partition for ~10 s).

| | (a) fence the EXECUTION | (b) fence each EFFECT | (c) both, sequenced |
|---|---|---|---|
| covers | every node, every seam, the double terminal event, the post-terminal append — in ONE place | only seams that adopt it (10 today, per-seam and explicit by ADR 0591) | everything (a) does, plus mid-execution split-brain |
| cost now | one storage primitive, one call site | 8 dial-adjacent seams + 2 **synchronous** undici dispatcher getters that cannot host an async claim without moving it to each request site (`effectEscapeLedger.ts:4–40`) | (a) now; (b) later, where it pays |
| debt | a zombie holder that lost its lease mid-node can still finish that ONE node (ADR 0585 P0b already bounds this to "the node in flight") | a **10-minute post-crash stall per in-flight effect** (`CLAIM_STALE_AFTER_MS`), accepted for notifications only | — |
| cannot distinguish | — | a concurrent duplicate from a legitimate post-crash re-execution: both mint the SAME `logicalInvocationId` (attempt is deliberately absent from the preimage) | — |
| reversibility | one function + one call; fails open | high — touches every egress path, some of them money | phased |

**Dominant force: single source of truth for "who may execute this run".** A
duplicate DELIVERY is a question about the run, not about any effect, and there
is exactly one place every delivery passes. Fencing per effect would answer a
run-level question N times, in N seams, two of which structurally cannot ask it.

## Decision

**(c), sequenced — and P1 is (a).**

### P1 — the execution claim (implemented)

`Storage.claimRunExecution(runId, owner, nowMs, leaseExpiresAt)` → `claimed |
held | not-runnable | missing`. ONE conditional `UPDATE`, identical predicate on
sqlite and Postgres, so it is atomic across processes on both:

```sql
UPDATE runs SET dispatch_owner = :owner, dispatch_lease_expires_at = :lease
 WHERE run_id = :runId
   AND status NOT IN ('completed','failed','cancelled')
   AND ( dispatch_owner IS NULL
      OR dispatch_lease_expires_at IS NULL
      OR dispatch_lease_expires_at < :nowMs
      OR status IN ('paused','waiting-approval','waiting-input','waiting-external') )
```

`executeRun` takes it **before it writes anything**. A fresh delivery that loses
returns `{ duplicateDelivery: true }` having appended no event, moved no status,
stamped no lease. No schema change, no migration.

Each disjunct exists for a hazard the design audit found, and each is
sabotage-proved in `test/adr0740-run-execution-claim.test.ts`:

| arm / rule | the hazard it answers |
|---|---|
| **no `OR dispatch_owner = :owner` arm** | the measured defect is two deliveries on ONE instance; an instance id is not a licence to re-enter. This was the tempting wrong design — sabotage A2 reddens 6 tests. |
| lease expired ⇒ claimable | crash recovery: the orphan lane's re-dispatch after a real SIGKILL (RFC 0158 `kill-during-execution`, 726.8 s) must keep working |
| suspended ⇒ claimable | **nothing clears `dispatch_owner` at suspend**, so a run waiting days on an approval still carries its first executor's 12-minute lease; a resume on any OTHER instance is legitimate — the previous execution RETURNED. A plain owner/expiry CAS would reject it intermittently and only in multi-instance deploys. |
| final ⇒ `not-runnable` | before this, a late delivery of a completed run whose lease had lapsed would RE-EXECUTE it |
| `executionPreclaimed` | `claimOrphanedRuns` is itself the atomic claim and stamps this instance with a live lease — exactly what a duplicate looks like. Without the hand-off, recovery refuses its own re-dispatch. **No test asserted a reclaimed orphan EXECUTES**: deleting the flag reddened nothing until one was added. |
| a RESUME that finds the run `held` WAITS (≤ 30 s), is never dropped | two gates resolved back to back are two legitimate `executeRun` calls; the second is a successor, not a duplicate, and dropping it strands a resolved interrupt |
| fails OPEN (no primitive / `missing` / throws) | 24 test files hand `executeRun` a partial `Storage` or a never-inserted run; and a storage blip must not become a fleet-wide stall on an at-least-once engine. Logged at error — a host without its fence must not look like one that has it. |

Consequence worth knowing: a run killed in the (microsecond) window between the
claim and `run.started` is now `pending` + LEASED, so it recovers on the leased
class (≤ 750 s) rather than the unleased one (≤ 65 s). The class is defined by
lease state, so `host/recoveryBound.ts` stays correct; the ADR 0739
`after-accept` exercise never dispatches and is unaffected.

### P2 — terminal closure as a status CAS (not started)

`finalizeRun`'s own docblock: *"This narrows the window; it does not close it …
`Storage.updateRun` has no compare-and-swap."* P1 makes the double terminal
unreachable by duplicate delivery; a status-conditional terminal write is still
owed for the cancel-vs-complete race and for a zombie holder. It is a lifecycle
change (it reorders "append terminal event" vs "write terminal status") and gets
its own PR. corpus: openwop#1445 asks whether a run's log is CLOSED by its first
terminal event — no v2 clause says so today.

> **MEASURED IN PRODUCTION 2026-09-21 — a third arm, and it is not duplicate
> delivery.** Run `2c4095e7` (`conformance-noop`, revision `00727-wtn` @
> `5f532663c`): `run.completed` at +1.27 s, then `node.failed` +16.28 s,
> `run.dead_lettered` +20.24 s, `run.failed` +26.76 s; the row now reads
> `failed / dispatch_failed: timeout exceeded when trying to connect`. The
> executor appended its terminal event, its STATUS write then failed on Cloud SQL
> pool starvation, the throw reached `dispatchRunInBackground`'s catch, and
> `failRunClosedOnDispatchError` — guarding on the row's status, which still said
> non-terminal — appended a second terminal. Fixed narrowly (WHD-22): that path now
> reads the tail of the durable log and, if it is already closed, repairs the row
> to match it instead of appending. This is the P2 ordering hazard with a new
> trigger; the status CAS is still owed for the cancel race and the zombie
> holder, and a status write that fails AFTER a terminal append with no dispatch
> catch above it (e.g. a resume path) would still leave the row stale.

> **PARTIAL, 2026-09-21 (suite 2.35.0 / RFC 0194 §A, now a MUST).** Suite
> 2.35.0's `v2-terminal-event-once` measured `run.cancelled` then `node.failed`
> (a cancel landing while a node was in flight). Closed in-process at the one
> append every event takes: `eventLog.append` refuses anything but
> `compensation.*` / `run.dead_lettered` after a live terminal append
> (`RunLogClosedError`). `executeRun` treats that as "the run already ended",
> and `cancelRunAndCascade` re-reads the row instead of trusting the caller's
> snapshot, restoring the row if its terminal append still loses.
>
> > **CLOSED IN THE STORE, 2026-09-22.** The owed cross-instance case was
> > MEASURED in production (rev 00733, suite 2.35.1): `run.started
> > run.cancelled node.started`. `appendEvent` now refuses a forward-execution
> > event when the run's log already holds a terminal event, INSIDE the per-run
> > serialization every append takes (Postgres `pg_advisory_xact_lock`, sqlite's
> > append transaction), so it holds across instances. One rule for both layers
> > lives in `storage/runLogClosure.ts`. Real Postgres 16: 60 cancel-vs-node
> > races over two storage instances, 0 violations. What this does NOT close is
> > the `runs.status` column itself: the event log is now the honest record, and
> > the status is still written without a CAS.

### P3 — a stable `Idempotency-Key` on outbound HTTP effects (not started)

The industry's uniform answer to "the holder died mid-request": send
`logicalInvocationId` — already stable across re-dispatch, attempt-free — as
`Idempotency-Key` on non-GET `ctx.http.safeFetch` calls when the pack set none.
This is the at-least-once story made honest. It changes what third parties
receive, so it needs a per-seam opt-out and its own review.

### What (b) is reserved for

Per-effect claims stay per-seam and explicit (ADR 0591), adopted where a
duplicate is expensive enough to justify a bounded post-crash stall — money
seams first. Not a blanket.

## What this is not

Not exactly-once effects, and nothing advertises it. After a REAL crash with a
request in flight, the effect may fire again on recovery: that is at-least-once,
it is what every engine surveyed does, and P3 is the mitigation. P1's claim is
exactly: **the same accepted work DELIVERED twice executes once.**

## Verification

- `test/adr0740-run-execution-claim.test.ts` — 20 tests: the predicate row by
  row, then each hazard above through the real executor and the real sweeper.
- `test/rfc0158-durability-seam.test.ts` — the pinned `WHD-12` residue test
  (`toBe(2)` arrivals, written to go RED when the fence landed) went red on the
  P1 commit and now asserts 1 arrival, 1 `run.completed`, nothing after it.
- **Sabotage, by direct edit, each restored from a commit:** A1 no fence (8 red),
  A2 same-owner arm (6), A3 no suspended arm (6), A4 no expired arm (1), A5 final
  runs runnable (3), E1 sweeper does not hand off (1, after the new test).
- Two existing tests modelled "the dispatch-time lease write" as
  `setRunDispatchLease`; each model was updated rather than the assertion
  weakened (`adr0585-p0-lease-heartbeat-behavioural`, `dispatch-outbox`).

## Open questions

- [ ] Cross-instance DOUBLE RESUME (two instances both resuming one suspended
      run) still passes the claim — both see `waiting-*`. Pre-existing; resume is
      serialised only in-process (`runResumeChains`). Closing it means the claim
      also moving status, which is P2's territory.
- [ ] `dispatch_owner` is still an instance id, so there is no monotonic epoch a
      store can check on every append (Kleppmann's full fence). ADR 0585 P0b's
      CAS renewal + lost-lease effect gate bound the zombie to one node; an epoch
      column is the next step if P1 (shorter reclaim) is ever unblocked.
- [x] RFC 0158 on this host — **MEASURED 2026-09-21 02:57–03:12Z**, supervised lane,
      PUBLISHED suite 2.32.0 (no vendored scenario), real `main()` child, 2 SIGKILLs
      counted by the supervisor: `duplicate-delivery` **`executed-pass`** (1 arrival
      at the suite's receiver — it was `executed-fail`, 2 arrivals, before P1);
      `kill-after-accept`, `bound-is-derived`, `poison-exhaustion` pass.
      **`kill-during-execution` recorded `executed-fail` — and it is a SUITE race,
      not this fence.** The row's own detail reads *"status completed with 2
      run.started"*: the run WAS re-executed after the kill (727.6 s, lease expiry +
      orphan lane, the same recovery that passed twice before P1). 2.32.0's
      `watchForResumption` reads the event log and THEN the run status in separate
      requests and latches `completedUnresumed` from the pair; a `conformance-noop`
      re-execution takes milliseconds, so it can land wholly between the two reads
      — events say 1 start, status says `completed`, the sticky latch sets, and the
      next iteration sees 2 starts. Reported to the corpus session with the fix
      (judge a `completed` status only against an event read taken AFTER it).
      **So the rung is NOT witnessed on this host yet: four rows pass and one is
      race-failed.** Re-run the lane after the suite fix; do not count it before.
