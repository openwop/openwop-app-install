# ADR 0618 — The Layer-2 effect guard becomes an atomic claim

Status: implemented

## Context

`spec/v1/idempotency.md` §"Concurrent duplicates (Layer 2)" is **Stable (v1.7,
2026-08-21)** and unconditional:

> Two executors can produce the same `logicalInvocationId` **concurrently** — the
> canonical at-least-once hazard: **an orphaned-run sweep re-dispatches a run
> whose previous owner is stalled but still alive** … The engine **MUST** ensure
> at most one of them performs the external effect. Concretely, the persist that
> guards the effect **MUST** be an atomic claim: exactly one executor wins the
> compare-and-set / insert-if-absent and fires, and the other observes the hit …
> **A non-atomic read-then-write does NOT satisfy the exactly-once guarantee** …
> and it **MUST** hold **within a single-instance deployment**.

There is no capability gate on it. `replay.sideEffectSuppression: none` does not
exempt a host — the schema calls that field *"an ASSURANCE ADVERTISEMENT of the
mechanism, **NOT a gate on the obligation, which is unconditional**"*, and it is
a different axis (replay/fork, not concurrent delivery).

### What this host had

A read-then-write. `notifications/emitter.ts`: `latest()` → if empty, **deliver**
→ `put()`. And the persist could not have been a claim, for two independent
reasons visible in the SQL:

```sql
INSERT OR REPLACE INTO invocation_log (run_id, node_id, attempt, invocation_id, …)
```

- **`INSERT OR REPLACE` always wins**, so it can never report the conflict a claim
  exists to report; and
- its key carries **`attempt`**, while the identity RFC 0150 §B made retry-stable
  deliberately does not — so two attempts at one identity would mint two rows.

The emitter's own docblock had already named both the defect and the fix:
*"That needs two processes … Closing that needs a real CAS claim (an `ON CONFLICT
DO NOTHING` insert used as a lock), not a longer read."* Twelve lines below, ADR
0591's escape ledger is commented *"plain INSERT, never INSERT OR REPLACE"* — the
codebase already held the distinction; the invocation log was simply built to
overwrite conflicts rather than preserve them.

### How this surfaced, and the citation that was wrong

ADR 0585 P1 (shorten the orphan-reclaim threshold) was blocked on *"effect fencing
(RFC 0150 §D)"*. That citation does not bind this host: §D is headed **"Fenced
multi-region effect ownership"**, its MUST binds *"a host claiming multi-region
effect safety"*, and this host advertises nothing — `crossRegion` appears zero
times in `routes/discovery.ts` and the `idempotency` block is absent from the live
discovery document.

Raised with the corpus rather than self-served, which is how the **applicable**
clause was found. openwop#1162 has since added a §D → §B pointer; the corpus owner
recorded the navigation gap as theirs.

**So P1 was blocked on a weaker reason than the real one.** The real constraint is
that this obligation is owed regardless of P1 — and P1 removes the 12-minute lease
that has been masking it.

### Scoping the exposure honestly

Today the orphan-race path is **masked**: `RUN_DISPATCH_LEASE_MS` (12 min) exceeds
the maximum legal run (10 min), so a live run is never reclaimed. The outcome was
protected — **by a lease, not by the mechanism the MUST names**. Same latent shape
as the P0 steal-back defect P0b fixed.

**Not measured, and not asserted either way:** whether `duplicate-delivery` (the
same accepted work delivered twice, no sweep involved) is reachable here. That is
RFC 0158's other conformance row and it does not depend on the lease.

## Decision

Add `Storage.claimInvocation(key, { nowMs, staleAfterMs })` returning `true` iff
**this** caller now holds the claim, backed by a new `invocation_claim` table
keyed on the **retry-stable** identity `(runId, nodeId, invocationId)` — no
`attempt`.

**A separate table, not a new index on `invocation_log`.** The log's PK carries
`attempt` and its writer is an upsert; changing either would be a migration on
live rows to make one table serve two purposes that RFC 0150 §B keeps apart —
the memo records *what happened*, the claim decides *who may act*.

**One statement, so the two arms cannot interleave:**

```sql
INSERT INTO invocation_claim (…) VALUES (…)
ON CONFLICT(run_id, node_id, invocation_id) DO UPDATE SET claimed_at = @now
  WHERE invocation_claim.claimed_at < @staleBefore
```

**Takeover is not optional.** A pure insert-if-absent converts a duplicate into a
**lost** effect: the winner dies between claiming and firing, the row persists,
and every later executor declines forever. Layer 1 already answers this — v1.5
defines *"atomic reclaim of an expired pending owner"* — so Layer 2 takes the same
shape.

**Seam order: memo → claim → fire → memo.** The memo read stays first and
unchanged (it is the retry-stable fast path and must not start costing a write);
the claim is what concurrent executors contend on; a loser **re-reads the memo**,
because the winner may have finished between our miss and our claim.

**Fails open on a storage error**, symmetrically with the existing memo read, and
logged at `error`. A claim backend that always denied would be a silent
notification outage; a missing dedup is a duplicate. Both are bad, and a host
running without Layer-2 must not *look* like one that has it.

## Alternatives weighed

- **Unique index on `invocation_log(run_id, node_id, provider_key)`.** Rejected:
  a migration on live rows, and it would force the memo to stop recording
  per-attempt outcomes, which ADR 0326 P3a's replay fidelity needs.
- **Claim without takeover.** Rejected — see above; it trades a duplicate for a
  lost effect and calls it exactly-once.
- **Convert the AI-provider seam in this ADR too.** Deferred. It is the same gap
  (`aiProvidersHost.ts` reads then fires), but its read order is load-bearing for
  `config.retry` — an exact read, a v1 dual-read, and a deliberate decision that
  a recorded *failure* must not short-circuit a live retry. Converting it needs
  its own analysis, not a ride-along. **Named as a follow-up rather than left
  silent.**

## Implementation record

| Piece | Where |
|---|---|
| Interface | `src/storage/storage.ts` |
| sqlite + migration 43 | `src/storage/sqlite/{index,schema}.ts` |
| postgres | `src/storage/postgres/{index,schema}.ts` |
| Wrapper (`claim` / `release`) | `src/executor/invocationLog.ts` |
| Seam | `src/notifications/emitter.ts` |
| Tests (13, incl. the G17 race witness) | `test/adr0618-layer2-atomic-claim.test.ts` |
| Teardown cascade (both backends) + guard set | `deleteAllTenantData`, `test/teardown-child-drift-guard.test.ts` |
| Migration-head pin bumped 42 → 43 | `test/dispatch-outbox.test.ts` |

**Sabotage-verified:**

| sabotage | result |
|---|---|
| claim always wins (the old read-then-write posture) | 6 red |
| stale takeover removed (pure insert-if-absent) | 1 red |
| takeover made unconditional (steals a LIVE claim) | 6 red |
| the SEAM bypasses the claim | **1 red** |
| **seam bypassed, RACE test** | **`expected 2 to be 1` — a real duplicate** |
| all restored | **13 green** |

### The race itself, added after review — corpus gap G17's missing witness

The suite as first merged staged the loser's **condition** (pre-claim the
identity, then emit). Deterministic, and not the race. The corpus owner named the
check it was missing:

> *two executors driven concurrently against one seam with the claim reverted to
> `INSERT OR REPLACE` — **if that does not produce a duplicate, the harness is not
> reproducing the race and a green result would mean nothing**.*

That check had not been run. **It has now, and the harness does reproduce it:**

| | delivered |
|---|---|
| pre-ADR-0618 (no claim, memo read-then-write only) | **2** |
| with the claim | **1** |

So the duplicate is **real and reproducible here**, not theoretical, and a green
on this test means the claim suppressed a duplicate the same harness demonstrably
produces without it.

**How two executors get the same identity in one process** — the thing that had
made this "not reproducible single-instance" and kept it unwitnessed. The ordinal
counter is module-level and monotonic, so a second emit normally mints a
*different* identity. A reset between two **un-awaited** calls models what a real
re-dispatch does: each executor re-executes the node from the start, so each
begins its ordinal sequence at 0. `mintEffectIdentity` runs synchronously before
the first `await` inside `emit`, so both calls mint before either yields.

This is the witness openwop-1 asked for against **G17** (`layer2-invocation-claim-atomic`,
registered reference-impl tier with an empty `tests` list precisely because no
scenario existed). Offered to the corpus rather than kept local.

### The seam test could not fail, in its first version

It emitted **sequentially** twice and asserted one notification — which passes
with the claim bypassed, because ADR 0591's memo suppresses the second emit on its
own. **MEASURED: stubbing the claim to always win left it fully green.**

The claim only matters when *both* executors miss the memo. So the loser's
condition is now staged directly: pre-claim the identity the emit is about to
mint, then emit, and assert **zero** notifications — with a winner-side positive
control asserting one when the claim is free.

This is the third test in this program whose name promised more than its body
checked, each found by sabotage rather than by review.

A second instrument error rode along: the test filtered `listNotifications` on
`userId`, which is not a field — vitest does not typecheck, so it passed while the
filter was silently ignored. The gate's `tsc` caught it; the sabotage was re-run
after correcting it, because changing what is counted can hollow out a test that
was previously biting.

### Two structural guards caught real work the isolated suite could not

Both fired on the first full gate, and neither was a load flake:

**`teardown-child-drift-guard` — a REAL defect in this change.** `invocation_claim`
is keyed on `run_id` with no `tenant_id`, so tenant teardown's introspection arm
(every table with a `tenant_id`) cannot see it, and it was in neither backend's
hand-kept child cascade. Claim rows would have survived tenant deletion — an
orphan on account-delete, i.e. a DSAR problem, in a table added by an ADR about
correctness. Wired into `deleteAllTenantData` in **both** adapters plus the
per-run cascade, and into the guard's own lockstep set.

That guard exists for exactly this and it worked: a new run-keyed table cannot be
added without an author either cascading it or writing down why not.

**`dispatch-outbox` migration-head pin — maintenance, not breakage.** It asserts
`LATEST_SCHEMA_VERSION` as a literal, deliberately: its comment explains that
`>= 41` would go permanently green and stop detecting the drift class it exists
for (a migration defined *past* the head never runs). So the literal moves with
each migration; bumped 42 → 43 with the reason recorded, as ADR 0591 did before.

## Consequences

- The `MUST` is satisfied for the notification seam. A concurrent duplicate now
  loses a compare-and-set instead of firing.
- **A behaviour change in the winner-crash window**: an executor that claims and
  then dies before delivering blocks contenders for `staleAfterMs` (10 min). That
  is a bounded delay, not a permanent loss, and it is the trade the takeover arm
  exists to bound.
- No wire change, **no RFC**: this implements an existing Stable MUST.
- **ADR 0585 P1 is not unblocked by this alone.** The claim closes the
  notification seam; P1's safety argument needs every seam that escapes an effect
  to be claim-guarded, and the AI-provider seam is not yet. P1 stays blocked, now
  on an accurate and much narrower reason.

## Follow-ups

- `aiProvidersHost.ts` — same gap, needs its own pass (see Alternatives).
- A conformance-visible witness for `duplicate-delivery`, which this ADR
  deliberately did not measure.
