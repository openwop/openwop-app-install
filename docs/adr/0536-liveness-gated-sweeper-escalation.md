# ADR 0536 — liveness-gated sweeper escalation

Status: Rejected (2026-08-08) — the premise was falsified before implementation

## Context

While reviewing orchestration prior art (a local-agent job-application system whose
orchestrator recovers stuck agent cycles), one candidate lesson was its **intervention
ladder**: rather than one fixed timeout, the prior art
probes for proof-of-life and only escalates (check-in → skip → restart) once a run has
stayed *quiet* for a full budget, extending up to a whole-cycle cap while activity
continues.

The proposed port claimed this host has the failure that ladder prevents:

> `runDispatchSweeper`'s fixed `MAX_REDISPATCH_AGE_MS = 3_600_000` terminally fails a run
> one hour after creation regardless of activity, so a run that is demonstrably alive —
> emitting node events every couple of minutes — gets killed anyway.

## Decision

**Rejected. Do not build it.** The premise is false, and acting on it would make the host
*less* correct.

### Why the premise is false

Three facts, measured (not read from comments):

1. `executor/executor.ts:134` — `RUN_DURATION_CEILING_MS = 600_000` (10 minutes). This is
   not an internal knob: it is the **RFC 0058 advertised wire limit**
   `capabilities.limits.maxRunDurationMs` (`routes/discovery.ts`), and it is enforced as
   the upper bound when resolving `RunOptions.configurable.runTimeoutMs`
   (`executor/executor.ts:1436`). Advertise and enforce are pinned to the same constant by
   the comment at `executor.ts:130-133`.
2. `executor/executor.ts:139` — `RUN_DISPATCH_LEASE_MS = RUN_DURATION_CEILING_MS + 120_000`
   (12 minutes). The lease is stamped once at dispatch (`executor.ts:1175`).
3. `host/runDispatchSweeper.ts:61` — the sweeper acts **only** on
   `storage.claimOrphanedRuns(...)`, which by definition returns runs whose dispatch lease
   has **expired**.

Composing them: the lease is structurally longer than the longest *legal* run, so a live
run within the advertised ceiling **never becomes an orphan candidate**, and
`MAX_REDISPATCH_AGE_MS` never applies to it. The runs that reach the one-hour cutoff are
exclusively those whose owning instance died (the lease lapsed because no process was
alive to hold it) or those already violating an advertised ceiling. In both cases,
terminal failure after ~5 lease windows is the correct disposition, and a liveness probe
would be checking a condition that cannot arise.

### Why building it anyway would be harmful

The current bound is **derived from an advertised wire limit**. Replacing it with an
activity heuristic would substitute a local judgement for a value the host publishes at
`/.well-known/openwop` and promises to honor — precisely the advertise/enforce agreement
`OPENWOP_REQUIRE_BEHAVIOR=true` exists to police. A "more forgiving" sweeper would let a
run outlive the duration the host advertises.

### What is actually there is a strength worth naming

`RUN_DISPATCH_LEASE_MS = RUN_DURATION_CEILING_MS + 120_000` is **self-maintaining**: raise
the advertised ceiling and the orphan-detection window follows automatically, so the
"a live run is never swept" invariant cannot silently break. That relationship is the
design; it deserves a comment more than it deserves a redesign.

## Alternatives weighed

- **Build the ladder anyway, as defence in depth.** Rejected: it guards an unreachable
  state, and every unreachable guard is untestable code that later readers must re-derive.
- **Narrow it to "runs that exceed the advertised ceiling."** Rejected: those runs are
  already out of spec; extending their life is the wrong direction.
- **Keep the number reserved but unfilled.** Rejected — `CLAUDE.md` (DEBT-4): an unfilled
  reservation is worse than none. Recording the rejection is what makes the number safe.

## Consequences

- No code change. `host/runDispatchSweeper.ts` and `executor/executor.ts` stay as they are.
- **The number 0536 is spent.** Per the numbering rule, holes are never reused, so this
  file exists to stop a future session re-deriving the same false gap.
- The the prior art liveness lesson still has a live home: it applies to **work items** whose
  liveness is not already leased. See [ADR 0535](0535-work-item-lease-stranded-card-recovery.md).

## Method note (why this ADR exists at all)

This gap was asserted from reading a constant (`MAX_REDISPATCH_AGE_MS = 1h`) without
reading the constant that gates reaching it (`RUN_DISPATCH_LEASE_MS`). The correction cost
one grep. The rule it re-teaches: **before filing a gap, test the premise, not the
symptom** — measure what makes the bad state *reachable*, not just what happens once you
are in it. Two of five candidate ports in this batch died on that test; the survivors
([0534](0534-agenda-compiler-ranked-work-selection.md),
[0535](0535-work-item-lease-stranded-card-recovery.md)) were each confirmed by an
exhaustive grep showing the handling code is absent, not merely unread.
