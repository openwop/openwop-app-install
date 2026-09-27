# ADR 0633 — A run's first event is sequence 0, and the "all events" cursor is −1

Status: Accepted — implemented 2026-09-05 (Phase 4 exit, Gap C)

## Context — measured

`schemas/v2/run-event.schema.json`: `sequence` is `"integer, minimum 0 — The one
ordering field; first event 0 (RFC 0171 §A.3)"`. `spec/v2/core/events.md` §Shape
repeats it and adds "strictly increasing per run. Persisted logs are never
renumbered." **The v1 schema says the same thing** — `"Monotonic per-run sequence.
First event is 0; assigned atomically by appendAtomic."` — so this was never a
v2-only rule.

This host numbered from 1 under **both** majors: `COALESCE(MAX(sequence), 0) + 1`
in the sqlite and Postgres adapters. The rc.56 origin bundle caught it as the only
executed failure on the wire (`v2-poll-cursor-v2`: *"omission of afterSequence
means from the first event: the first returned sequence MUST be 0 — expected 1 to
be 0"*), and it is the sole reason the Front-door cut gate fails for this host.

## Decision

New runs number from 0. Existing logs are **not** renumbered (the spec forbids it);
they continue from their own max, so a run that started at 1 stays 1-based forever.

The change that matters is not the numbering — it is the **cursor**. `listEvents`
is exclusive (`sequence > fromSeq`), so under 0-based numbering every reader that
passed `fromSeq: 0` to mean *"all events"* would silently drop event 0 **and still
answer 200**. The sentinel for "from the very beginning" is therefore **−1**, and
that is now the adapter default as well as the value at every "all events" site:

| Site | Was | Now |
| --- | --- | --- |
| adapter append (both) | `COALESCE(MAX(sequence), 0) + 1` | `… , -1) + 1` / `COALESCE(MAX(sequence) + 1, 0)` |
| `getMaxSequence` (both) | `0` for an empty log | **`-1`** for an empty log (0 is a real sequence and cannot double as the sentinel) |
| `listEvents` default | `fromSeq = 0` | `fromSeq = -1` |
| poll, debug bundle, diff, SSE catch-up, eval, diagnose, workflow debug | `fromSeq: 0` | `fromSeq: -1` |
| SSE connect cursor | `let fromSeq = 0` | `-1` |
| executor replay-invocation paging | `let fromSeq = 0` | `-1` |
| turn cache (`host/exchange/loadTurns.ts`) | `lastSeq: 0` | `-1` |
| poll `lastSequence` | `maxSequence > 0 ? maxSequence : -1` | `maxSequence` |
| v1 poll, no cursor given | `fromSeq = 0` | `-1` (absent ≠ a cursor at 0) |

## A second defect the numbering hid

`POST /runs/{id}:fork` copied its fixed-history prefix with
`listEvents({ fromSeq: 0, limit: fromSeq })`. Under 1-based numbering that returns
sequences `1..fromSeq` — i.e. `sequence <= fromSeq`, while `replay.md` §Endpoint
says events with **`sequence < fromSeq`** are fixed history and `>= fromSeq` are
re-executed. The host was off by one, and `test/executor-durability-adr0326.test.ts`
was written against it: it forked at `emitDone.sequence` and expected `emit` to be
history. Two errors cancelled.

Under 0-based, the same expression returns `0..fromSeq-1` — exactly the spec's
prefix — so the boundary is now correct and the test states its intent honestly by
forking at `emitDone.sequence + 1`. No production behaviour was traded away: the
prefix is one event smaller and the run re-executes from precisely `fromSeq`.

## Witness

`test/v2-event-sequence-zero-based.test.ts` — three legs, each pinning a reader
rather than the numbering alone, because a missed cursor site has **no symptom**:
the first event of a run is 0 with `lastSequence` the true max (major 2); major 1
numbers from 0 too and an *explicit* cursor of 0 still skips exactly event 0; and
every "all events" reader (poll, debug bundle, diff, SSE, fork prefix) returns the
log including event 0. Sabotages: 1-based numbering → 3 red; the "all events"
cursor back to 0 → the reader leg red; the SSE connect cursor back to 0 → the
reader leg red.

Two suites had pinned the old behaviour and were corrected, not deleted:
`append-events-batch` (literal 1-based expectations) and the ADR 0326 fork test
(the off-by-one above).

## A third defect, found by the FULL suite and not by the targeted sweep

The 60-file sweep that grepped for `sequence` missed four suites whose files never
say the word. The full gate caught them, and one was production code:
`detectAndRecordReplayDivergence` compared the source log from
`listEvents({ fromSeq })`. The comparison must cover what the replay
**re-executes** — `sequence >= fromSeq` — but the cursor is exclusive, so the
right cursor is `fromSeq - 1`. Passing `fromSeq` straight through dropped the
event AT the boundary; under 0-based numbering that is `run.started` on a full
replay, so **every deterministic full replay would have reported
`replay.diverged`**. The other three were test-side cursors meaning "all events".

**And a self-inflicted one worth recording.** The first repair was a blanket
`sed 's/fromSeq: 0/fromSeq: -1/'` across `test/*.ts`. Thirteen of the eighteen
lines it changed were **fork REQUEST bodies**, where `fromSeq` is a wire
parameter with `minimum: 0` and "omission means 0" — not a storage cursor. The
edit turned valid forks into `400`s. Two different things share one name:

| `fromSeq` | Meaning | "From the beginning" |
| --- | --- | --- |
| `Storage.listEvents` | exclusive cursor, `sequence > fromSeq` | `-1` |
| `POST /runs/{id}:fork` | inclusive boundary, `sequence < fromSeq` is history | `0` |

A scripted edit across a name that means two things needs a per-line review of
the diff, not a count of replacements.
