# ADR 0637 — Mid-sequence replay fork: three defects behind one 501

Status: implemented

## Context

`POST /v1/runs/{runId}:fork` with `{ mode: 'replay', fromSeq: N }` answered
**501 `fork_from_seq_unsupported`** for any `N > 0`. Only `fromSeq = 0` (full
re-execution) was served.

The refusal was honest — a 501 is skip-equivalent, and the alternative was a
silently non-deterministic replay. But it was load-bearing well beyond its own
endpoint: `family.replay` could not be advertised on the v2 root, and the
`replay` family gates `v2-effect-seam-no-refire`, the only corpus leg that
exercises `fireEffectSeam`. So one refusal held down a capability advert, a
conformance profile floor, and the witness for an entire seam surface.

An earlier attempt in this arc removed the refusal and **had to retract it**:
`replay-fork-arbitrary.test.ts` went from skipped to RED, showing two replay
forks at the same `fromSeq` producing different post-fork tails. That retraction
drew the right conclusion — *disproving a stated reason is not disproving the
decision* — and the wrong **cause**: it read the red as evidence of genuine
non-determinism and stopped.

## What was actually wrong

The fixture is `conformance-multi-node`: three `core.noop` nodes. **Nothing in it
can diverge.** Dumping both event streams (one probe) showed the red was three
compounding host defects, none of them non-determinism:

| # | Defect | Site |
| --- | --- | --- |
| 1 | Replay derived **no snapshot**, so `executeRun` started at node index 0 and re-ran the whole workflow after the copied prefix — the tail began `node.started@a` where the source had `node.started@c`. | `routes/runs.ts` |
| 2 | Replay re-emitted **`run.started`** on top of a prefix that already carried one, so the log held two starts. | `executor/executor.ts` |
| 3 | Divergence detection read the **source from `fromSeq` but the replay from `0`**, comparing the prefix's first event against the source's fork-point event. | `executor/replayDivergence.ts` |

Each independently manufactured a `replay.diverged` event whose payload carries a
freshly generated `replayEventId`. **That UUID was the only field that differed
between two replays.** The observed "non-determinism" was a bug report the host
wrote about itself, in an event whose identifier could not be stable.

Defect 3 is the instructive one. `compareObservableSequences` — the pure function
— was correct, and `replay-divergence.test.ts` covered it thoroughly. The
misalignment was in the caller's cursors, so every test of the mechanism passed
while the wiring was wrong. The comment directly above the defect records fixing
this same off-by-one on the *source* side; the replay side was left alone, and a
half-applied fix reads as a considered asymmetry.

Defect 2's asymmetry is worth naming: a **branch** fork passes `resumeSnapshot`,
so `isResume` was already true and it skipped the start path. Replay passed only
`replayInvocationsFromRunId`. The two fork modes disagreed about whether a copied
prefix means the run has started.

## Decision

Fix all three; keep the refusal only if determinism cannot be restored.

1. **Both fork modes resume from the prefix projection.** `snapshotFromEventPrefix`
   is a pure function branch already used; replay now derives it too. What still
   differs between the modes is everything else — replay takes no
   `runOptionsOverlay` and reads the source's Layer-2 invocations, branch takes
   the overlay and mints its own. The suspended-checkpoint refusal
   (`fork_checkpoint_unsupported`) applies identically to both.
   *(Corrected 2026-09-25: the refusal is retired by ADR 0751 — both modes now
   inherit an open gate as state.)*
2. **A prefix-inheriting replay emits neither `run.started` nor `run.resumed`.**
   The prefix carries the start; the source has no lifecycle event at `fromSeq`,
   so anything appended there is an event the source lacks at that position —
   precisely what §"Byte-equivalence of the prefix" forbids. A replay is a
   re-execution, not a resume. Run *state* still moves to `running`.
   Derived from persisted run state (`forkMode`, `parentRunId`, `parentSeq > 0`),
   not a caller-supplied flag, so a future fork-like path cannot forget it.
   Scoped to `replay`: branch is "an independent run … NOT deterministic by
   design" (replay.md §Modes) and is left exactly as it was.
3. **Symmetric cursors** in `detectAndRecordReplayDivergence`.
4. **Remove the 501.**

## Alternatives weighed

- **Keep the refusal.** Rejected once the cause was known: it suppressed a
  capability advert and an entire seam's witness to hide three fixable bugs.
- **Suppress the spurious `replay.diverged` event.** Rejected — it treats the
  symptom. The comparison would still be misaligned, and divergence detection
  would be vacuous for every mid-sequence replay.
- **Make `replayEventId` deterministic.** Would have turned the corpus red green
  while leaving all three defects in place. The most dangerous option, because it
  targets exactly the field the failure output points at.

## Consequences

- Mid-sequence replay forks are served and deterministic;
  `replay-fork-arbitrary.test.ts` passes all three legs.
- `family.replay` becomes advertisable. That is a **separate change** with its own
  blast radius (it un-skips a large set of scenarios under
  `OPENWOP_REQUIRE_BEHAVIOR`) and its own ledger row to remove — the
  advertise-and-opt-out cross-check added alongside the 2.0.3 pin requires both to
  move in one commit.

## CORRECTION 2026-09-06 — the "known gap" recorded here was FALSE

This section originally claimed:

> replay.md §"Determinism caveats" 5 requires a replay to re-emit recorded-fact
> events such as `memory.written` verbatim from the source log. This host *skips*
> them (`executor.ts`, the `forkMode !== 'replay'` gate).

**That is wrong, and the error was mine.** This host re-emits them verbatim, and
has since #196 (2026-05-25). `executor/executor.ts` reads the parent's log on a
replay fork and appends each session-end `memory.written` payload unchanged,
citing RFC 0041 §C in its own comment; node-attributed writes replay with their
node.

**How the error was made, since the shape is more useful than the fact.** I found
a `forkMode !== 'replay'` gate around the memory *write* and concluded the *event*
was dropped. Both exist and they are different things: the gate suppresses the
re-mint (no new `memoryId`, no row — regenerating would embed the fork's runId and
break byte-equivalence), while a few lines further on the recorded fact is
replayed verbatim. I read the mechanism and inferred the behaviour instead of
measuring it.

**Measured**: `memory-attribution-replay-stable.test.ts` — which asserts both
halves, that every replayed id is a recorded id AND that the source's recorded ids
all reappear — runs `executed-pass` against this host, non-vacuously (no
soft-skip recorded in the RFC 0148 §A dispositions).

The claim was reported on the corpus bus and read there as a possible regression
in the new mid-sequence replay path. It is neither a regression nor a gap: the
gate predates that work by three and a half months, and the behaviour is correct.
Corrected on the bus in the same pass.

The transferable lesson is one this repo already carries and I re-learned anyway:
**grep the mechanism, then measure it — a gate you found is not the whole path.**

## Implementation record

| Change | Site |
| --- | --- |
| Snapshot for both modes; 501 removed | `src/routes/runs.ts` |
| No lifecycle event on a prefix-inheriting replay | `src/executor/executor.ts` |
| Symmetric read cursors | `src/executor/replayDivergence.ts` |
| Seam-level regression tests (4) | `test/replay-mid-sequence-determinism.test.ts` |

Witness: `replay-fork-arbitrary.test.ts` — 3 passed (was 1 failed / 2 passed).
The new tests were sabotage-checked: reverting the cursor fix turns 2 of the 4 red.
