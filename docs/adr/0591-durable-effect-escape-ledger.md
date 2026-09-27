# ADR 0591 — durable effect escape ledger

Status: **implemented** (verified 2026-09-17, #3422)

## Context

RFC 0158 §C.7 (`durability/duplicate-delivery`) requires a host to witness that
the same accepted work delivered twice fires each effect **exactly once, per
effect identity** — §180-181 words it as "invocation counts per identity". RFC
0158 §Conformance:160 (`durability/kill-during-execution`) separately requires
"resumed within the declared bound **and no duplicate external effect**".

Neither clause is witnessable on this host today. We have two instruments and
**both are structurally incapable** of the measurement — not weak, incapable.

### Instrument 1: the per-run effect counter is process-local and a scalar

`host/runEffectContext.ts:280` — `const effectCounts = new Map<string, number>()`,
read by `GET /v1/host/sample/replay/effect-count` (ADR 0533, `host-sample-test-
seams.md` §20) as `{ runId, effectCount }`.

- **Scalar, not per-identity.** It answers "how many effects escaped for this
  run", never "how many times did the effect for ordinal X escape". §C.7's
  language is per-identity; a scalar equals the per-identity count only when the
  graph has exactly one effect identity, which is a property of the fixture, not
  of the host.
- **Process-local.** The `Map` dies with the process, so it cannot compare a
  pre-kill tally against a post-resume one. `kill-during-execution`'s
  no-double-fire clause is not merely unmeasured — it is unmeasurable by this
  instrument, because the instrument does not survive the kill the row is about.

### Instrument 2: the invocation log cannot count, and this was MEASURED

`idempotency.md:259` makes a durable invocation log normative, and
`invocation_log` exists. It looked like the per-identity instrument. It is not.

```
executor.ts:990   // Sample tier doesn't track retries yet
                  // (ctx.attempt is the 1-based one-shot stub at line 302)
executor.ts:627   attempt: input.attempt ?? 1     // every call site, no incrementer
storage/sqlite/index.ts:566   INSERT OR REPLACE INTO invocation_log (…)
      PRIMARY KEY (run_id, node_id, attempt, invocation_id)
```

`attempt` is a **constant 1**, and the write is `INSERT OR **REPLACE**` over a
key containing it. Measured directly against the real schema:

```sql
INSERT OR REPLACE INTO invocation_log VALUES ('r1','effect',1,'ord0','first','t1');
INSERT OR REPLACE INTO invocation_log VALUES ('r1','effect',1,'ord0','second','t2');
→ rows for ord0: 1        -- two fires, one row
→ surviving result: second
```

So `SELECT invocation_id, COUNT(*) … GROUP BY invocation_id` returns **1
whether dedup works or is completely broken**. Wiring the conformance row to it
would produce a row that passes unconditionally — a certifiable disposition with
provably nothing under it, in the row whose entire purpose is catching
double-fires.

**This is the shape to name, because it recurs:** an instrument whose PASS is
ambiguous does not witness the property, it certifies the property's absence.
`COUNT(*) = 1` here is ambiguous between "dedup suppressed the second fire" and
"a double-fire happened and REPLACE overwrote the evidence". A guard built on it
bites on the wrong thing.

### What is NOT being claimed

Nothing here says this host double-fires. `getLatestInvocation` reads by
`(run_id, node_id, invocation_id)` ignoring attempt — the correct retry-stable
RFC 0150 §B read — so dedup very plausibly works. The established fact is only
that **we have no instrument that could tell us either way.**

## Decision

Add a **durable, append-only effect escape ledger**: one row per effect that
actually escaped the host, keyed so that a second escape is **structurally a new
row**, never an overwrite.

1. **Append-only, never `INSERT OR REPLACE`.** A monotonic `escape_seq`
   discriminates repeat escapes of the same identity. Correctness must not
   depend on `attempt` incrementing — the whole defect above is that it doesn't,
   and a design that re-acquires that dependency re-acquires the bug.

   > **CORRECTION (P1 implementation, commit `a639f8d3`).** `escape_seq` was
   > wrong, and it failed in exactly the scenario this ADR is written for. A
   > caller-supplied sequence is **process-local**: §C.7 is driven by killing
   > the host, so the resumed process restarts its counter at 0 and re-appends
   > the same identity onto the pre-kill row. Measured — `process A: seq 0 → 1
   > row; process B: seq 0 → UNIQUE constraint failed, count stays 1`. Both
   > outcomes disqualify it: unswallowed the throw lands on the ALLOW branch and
   > breaks production egress; swallowed, the count freezes at 1, which is the
   > `invocation_log` collapse of §Context rebuilt by its own replacement.
   > Deriving the sequence from the table (`max+1`) only trades it for a
   > read-then-write race.
   >
   > The paragraph above reasons correctly that the discriminator must not be
   > `attempt`, then picks a different value with the same defect — the property
   > that matters is not "not `attempt`", it is **not caller-supplied at all**.
   > The ledger now uses a store-generated `escape_id` (`INTEGER PRIMARY KEY
   > AUTOINCREMENT` / `BIGSERIAL`), with the identity columns as a non-unique
   > index; an append cannot address an existing row. This also answers the
   > third open question below.
2. **Written on the `assertEffectAllowed` ALLOW branch**, beside the four
   consumers already there (`recordEffectEscape`, `observedEffectKinds`,
   `recordEffectAllowed`, `recordAuthorityAction`). That co-location is a
   standing decision, and `runEffectContext.ts:226-230` states the reason: *"an
   effect counted by one and not the others is a divergence no test would
   notice."* §20 independently requires the counter to sit at the same seam as
   the default-deny guard. The ledger inherits both arguments; putting it
   anywhere else would let it describe an effect the guard refused.

   > **CORRECTION (P2 implementation).** The ledger does NOT ride the ALLOW
   > branch, and the paragraph above inherits an argument that does not transfer.
   > Two findings, both checked rather than reasoned:
   >
   > **(a) The guard is synchronous by contract.** Two of its 21 call sites are
   > undici dispatcher getters — `webhookEgressDispatcher(): Agent` and
   > `safeFetchDispatcher(): Agent` — whose return value is passed as undici's
   > `dispatcher:` option at ~20 sites; that option takes a Dispatcher, not a
   > Promise. `test/egress-pin.test.ts:50` identity-compares the returned Agent
   > and `test/run-effect-context.test.ts:371` asserts a *synchronous* throw. An
   > async guard breaks all of it. Fire-and-forget is the other way out and is
   > worse: the row is lost exactly when the process dies between the effect and
   > the flush, which is the window §C.7 manufactures on purpose, and this host
   > has shipped that bug before (CLAUDE.md's detached SPA-shell refresh, 16+
   > minutes stale with zero error logs).
   >
   > **(b) The guard seam is not an escape-EVENT seam at all of its sites.** The
   > two dispatcher getters hand out a capability; the packet leaves later, from
   > a cached singleton, through a fetch the guard never observes. For a
   > host-wide rate where any non-zero value is actionable that is tolerable
   > noise. For an instrument distinguishing count 1 from count 2 at one
   > identity it is not.
   >
   > The §20 argument and the `:226-230` quote are about the SCALAR counters that
   > genuinely share the guard's event. Transferring them to an instrument of a
   > different grain is how this defect family gets its next instance. The append
   > now sits at the async effect seams, and coverage is **per-seam and explicit**
   > — a real limitation, stated rather than implied. Seam-reach is enforced by a
   > property test, following the precedent at
   > `test/run-effect-context.test.ts:427-461`, which already tests the property
   > rather than the syntactic shape that used to stand in for it.
   >
   > **The identity also changed.** It is the RFC 0150 §B `logicalInvocationId`
   > (`tenantId ‖ runId ‖ nodeId ‖ logicalInvocationOrdinal ‖ providerKey`), not
   > `(runId, nodeId, invocationId)`. `host/effectIdentity.ts` is the single owner
   > of that composition, so the effect context carries the raw INPUTS and the
   > ledger calls the owner — a precomputed key would be a second recipe beside
   > it. The corpus session reached the same identity independently, via RFC 0150
   > §D box #4 leg (ii) ("the per-`logicalInvocationId` effect count stayed 1").
3. **Durable, so it survives SIGKILL** — which is what makes
   `kill-during-execution`'s second clause witnessable at all: read the
   per-identity count before the kill and after resume; the ordinal's count must
   remain 1.
4. **`invocation_log` is NOT changed.** It is the dedup/replay memo, and
   REPLACE semantics are *correct* for that job. Conflating "memoize the result"
   with "count the escapes" is precisely what made the count look usable. Two
   concerns, two tables.

### Alternatives weighed

- **Extend the scalar seam to `{identity, count}[]` over the existing tables** —
  rejected. It is the `COUNT(*)`-over-REPLACE path, sound only under a
  precondition (distinct attempts) that does not hold today and that the
  scenario would then have to police on every run. A contract that can silently
  stop holding is the shared-flag failure mode one layer down.
- **Make `attempt` a real retry counter** — larger, riskier, and it makes the
  witness depend on retry semantics that are orthogonal to "did the effect
  escape twice". Worth doing on its own merits; not the fix for this.
- **Operator attestation** — rejected for the same reason RFC 0158 rejects it
  generally: it cannot catch the defect it exists to catch.

## Consequences

- Unblocks **1.5 conformance rows**: `duplicate-delivery` gets an RFC-faithful
  per-identity instrument, and `kill-during-execution`'s no-double-fire clause
  becomes witnessable across a real crash.
- Requires a **schema migration** in both sqlite and postgres backends.
- **Known limitation, to be stated in the scenario docstring rather than
  discovered later:** the row is written when the escape is recorded, so an
  effect that escapes and then crashes before the write is not counted. The
  count is a **floor on escapes**, not an exact tally. This is the safe
  direction for a double-fire assertion — it can miss a fire, never invent one —
  so a FAIL (count ≥ 2) is always real, and only a PASS is weakened, in the
  crash-during-write window.

  > **CORRECTION (P2 implementation) — this is inverted. The count is a
  > CEILING.** The paragraph assumes a post-effect append, and a post-effect
  > append is not viable: the row would be lost precisely when the process dies
  > between the effect and the write, which is the window §C.7 manufactures on
  > purpose. A lost row makes a genuine double-fire read as `count = 1` — the
  > masking hazard this ADR exists to close, one layer down. So the append is
  > awaited BEFORE the effect fires, and the direction flips:
  >
  > - **Under-reporting is structurally impossible.** A real double-fire can
  >   never read as 1, so a PASS on "count stayed 1" is strong.
  > - **Over-reporting is possible**, in the crash-between-append-and-fire
  >   window.
  >
  > That is the right direction for a witness — the failure mode is a loud false
  > FAIL rather than a silent false PASS — but the last sentence above is now
  > exactly backwards: **`count ≥ 2` is no longer automatically a real
  > double-fire**, and a reader who kept the old sentence would draw the wrong
  > conclusion from a red. The corpus session was about to write "floor" into the
  > scenario docstring on my original advice and has been sent the correction.
- **Coverage is per-seam, not universal.** Following from the Decision-2
  correction: the ledger observes the async effect seams that call it, and
  `nextLogicalInvocationOrdinal` had exactly ONE caller before this work
  (`aiProviders/aiProvidersHost.ts:659`), so Layer-2 identity did not exist on
  the notification path the conformance fixture actually uses. Widening that
  coverage is the remaining work, and it is worth doing on its own merits —
  Layer-2 idempotency covering only AI provider calls is a finding independent
  of RFC 0158.

## Implementation plan

- **P1** — schema + storage API (append, read-by-run grouped by identity), both
  backends, with a test that two escapes at the same identity produce **two
  rows** (the direct regression for the measured defect above).
- **P2** — write on the ALLOW branch beside the existing four consumers.
- **P3** — expose per-identity counts on the test seam, gated on the existing
  `OPENWOP_TEST_SEAM_ENABLED` (no second flag — RFC 0158 item 12's shared-flag
  hazard).
- **P4** — hand the read shape to the corpus session; they author
  `durability/duplicate-delivery` against what it truly persists.

  > **P4 BECAME A HOST FIX, because handing over the seam exposed a real
  > §C.7 failure.** The corpus session asked the obvious question before
  > authoring — on a redelivery, does this host actually dedupe? Tracing it to
  > answer them honestly produced two findings:
  >
  > **(i) The outbox redrive lane cannot redeliver at all.**
  > `runDispatchSweeper.ts:275-279` discharges any run whose status is not
  > `pending`, so a redriven row for an already-started run is dropped. The node
  > never executes twice; that lane is not the scenario's mechanism.
  >
  > **(ii) The ORPHAN lane redelivers with NO dedup — a genuine §C.7
  > violation.** `runDispatchSweeper.ts:201` calls `executeRun` with no
  > `resumeSnapshot`/`resumeFromNodeIndex`, and `sourceOutcomes` (what makes the
  > ADR 0531 guard suppress a side effect) is populated ONLY for
  > `replayInvocationsFromRunId` (`executor.ts:1496-1505`). An orphaned run —
  > `status IN ('pending','running')` with an expired lease, and **no filter on
  > whether its nodes already completed** — restarts from the top with
  > `replaying: false`. The guard allows. A real person was notified twice.
  >
  > §C.7 is a MUST-dedupe on "an identity that survives redelivery", so the
  > conformance PASS is `count === 1` and this host produced 2. The root cause
  > is broader than notifications: the host HAS the identity
  > (`effectIdentity.ts`) and HAS the durable log (`executor/invocationLog.ts`)
  > but wired them to exactly ONE caller (`aiProvidersHost.ts:659,674`).
  >
  > Fixed for the notification seam by consulting the SAME invocation log,
  > keyed by the same RFC 0150 §B identity — no second dedup mechanism. Order
  > matters in both directions: the ledger row is appended AFTER the dedup miss
  > (so a correctly suppressed emit records no escape and cannot false-FAIL the
  > witness) and BEFORE the insert (so a crash between them cannot lose it).
  > Minting had to be split from appending — `nextLogicalInvocationOrdinal`
  > ALLOCATES, so the P2 mint-inside-append shape made a deduping seam
  > structurally impossible: the lookup and the row would name different
  > effects.
  >
  > **The dedup closes SEQUENTIAL redelivery, not CONCURRENT delivery** (code
  > review finding). The lookup and the write are not atomic, and
  > `putInvocation` is `INSERT OR REPLACE`, so it cannot serve as a
  > compare-and-set claim. Two INSTANCES executing the same identity at once
  > both mint it (each process has its own module-level ordinal counter, both
  > starting at 0), both miss, and both fire. It is not reproducible
  > single-instance — within one process the shared counter hands the second
  > emit a different identity. Real orphan recovery is sequential (the lane
  > re-dispatches a run whose owner is presumed crashed), which is the case
  > §C.7 describes and the case this closes; but the lane sets a lease WITHOUT
  > stopping the previous owner, so a late renewal under a GC pause or a slow
  > write can expire the lease while the original executor is alive. Closing
  > that needs a real CAS claim (an `ON CONFLICT DO NOTHING` insert used as a
  > lock), not a longer read. **§C.7 must not be described as fully closed.**
  >
  > **Deliberately NOT fixed here, and it should not be read as covered:**
  > `emitMany` (the ADR 0214 batch path) still has no dedup AND never appends to
  > the ledger at all, so a batch emit is invisible to the witness as well as
  > undeduped (now stated at its own call site, not only here). Neither do the
  > other guarded seams — SMTP, webhooks, brokered egress, sub-run dispatch.
  > That is the remaining Layer-2 coverage gap, worth its own work on its own
  > merits. Scope claim honesty: the notification seam was verified end-to-end;
  > "every other seam re-fires" is a strong inference from the single-consumer
  > grep, not six separate measurements.

## Open questions

- Retention: effect rows are per-run and unbounded; does this ride the existing
  retention sweeper, and with what horizon?
- ~~Does the postgres backend need the same `escape_seq` discriminator, or can
  it use a sequence/identity column?~~ **RESOLVED, and in the opposite
  direction to the way it was asked** (see the correction under Decision 1).
  The question assumed sqlite's caller-supplied sequence was the baseline and
  postgres the possible deviation. Neither backend can take the value from the
  caller: it is process-local, so it collides after the kill. Both now generate
  it — sqlite `AUTOINCREMENT`, postgres `BIGSERIAL` — which is the same
  behaviour by the same argument rather than by coincidence.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3422**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** P1 schema both backends (`storage/sqlite/schema.ts:1048`, `storage/postgres/schema.ts:944`); P2 seam `host/effectEscapeLedger.ts:137`, wired at `notifications/emitter.ts:286`; P3 route `routes/effectEscapeLedgerSeam.ts` (registered `registerAllRoutes.ts:226`); P4 §C.7 dedup `notifications/emitter.ts:267-289`.

**The §C.7 caveat is carried forward, not dropped.** This ADR's own text says §C.7 "must not be described as fully closed": concurrent (multi-instance) delivery and the other guarded seams (`emitMany`, SMTP, webhooks, brokered egress, sub-run dispatch) remain uncovered. Those are scope this record names as remaining, not phases it left undone.
