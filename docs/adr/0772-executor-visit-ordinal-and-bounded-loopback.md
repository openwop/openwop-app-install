# ADR 0772 — Runs, replay & fork: an honest deadline, a log-derived execution ordinal, and bounded loopback

Status: Accepted — P1 implemented (feature-loop 2026-10 row 3); P2–P4 open

Feature-loop 2026-10 row 3 (runs, replay & fork). Grade evidence:
`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Runs, replay & fork" (`RRWF-1..19`,
opening grade **C**). Composes ADR 0326 (executor durability, attempt threading),
0341 (replay side-effect suppression), 0531 (effect-seam backstop), 0551 (durable
dispatch), 0585 (dispatch lease), 0632 (pause/resume), 0637 (mid-sequence replay),
0751 (fork of a suspended checkpoint), 0755 (fork dispatch options), and RFC 0058
(run-duration bound).

## Context

The run half of the product is where OpenWOP's protocol guarantees are actually
kept or broken, and it was never graded as one unit. The opening pass found that
the orchestration structure is sound, but three of its guarantees do not hold:

| id | Guarantee broken | Where (re-read at `86c27e613`) |
|---|---|---|
| `RRWF-1` | A run that blows its deadline reports `run_timeout` (RFC 0058 §C) | `armRunAbort` (`executor.ts:2075`) fires at the same instant as the loop's deadline; `core.delay` rejects on abort and the node catch maps it to `internal_error` (`:1164`). If the node settles first, `isRunDurationBreached` is strictly `>` and still false on the boundary ms, so `finalizeRun` fails the run as the node's failure. `run-execution-bounds-shape` flakes red under load on exactly this. |
| `RRWF-2` | The abort signal means "this run should stop now" | `armRunAbort` returns the EXISTING controller (`runLifecycle.ts:86-89`). A suspend is not terminal, so the first segment's deadline timer survives into the approval wait, fires, and every resumed execution is handed an already-aborted signal: every `core.delay` and every MCP call after a long approval fails at once. |
| `RRWF-3` | Replay resolves a side-effecting node's outcome by `(sourceRunId, nodeId, n)` (replay.md §Suppression rule 2) | The outcome is looked up by the per-body retry attempt (`executor.ts:1036`) in a POSITIONAL list of terminal events (`sideEffects.ts:283`). `nodeAttempts` is per `executeRunBody` and not in the snapshot. Reachable with no loops: a node that retried, suspended on its credential gate and retried again folds to `[failed, failed, completed]`, so a replay serves `failed, failed` and fails a run the source completed. A mid-sequence fork also restarts attempts at 1 while the index spans the whole source log. |
| `RRWF-4` | A fork resumes from the state the source had at `fromSeq` | `snapshotFromEventPrefix` (`executor.ts:1455`) ignores `node.started`, so a node retried in the source is restored `failed` and never re-run. |
| `RRWF-19` | A replay fork never fires a side effect (replay.md §Suppression rule 1) | A replay fork that is RESUMED — an inherited gate resolved (ADR 0751), or `:resume` after a pause — re-enters `executeRun` WITHOUT `replayInvocationsFromRunId` (`routes/interrupts.ts:1229-1252`, `routes/runs.ts:1624`). `sourceOutcomes` is then null and `effectCtx.replaying` is false, so the fast path AND the ADR 0531 backstop both stand down, and every side-effecting node after the gate fires for real. Found while designing D2. |
| `RRWF-5` | A workflow in the canonical wire shape runs | `evaluateTrigger` sorts incoming edges with `a.edgeId.localeCompare` (`scheduler.ts:313`). The validator accepts the canonical `id` without copying it into `edgeId`, so any fan-in posted canonically throws a TypeError. |
| `RRWF-6` | A fork is a run like any other | `:fork` (`runs.ts:1638`) skips the run quota, the concurrent-slot binding, the capability-gated-typeId refusal and the audit record that `POST /v1/runs` applies. |
| `RRWF-7` | An accepted fork is complete | A throw in the prefix copy (`runs.ts:1891-1913`) answers 500 but leaves a `pending` row that the orphan sweeper runs 120 s later on a partial log. |
| `RRWF-8` | Pause is always resumable | The pause drain point ignores `pendingRetryTimers` (`executor.ts:2491`). A node waiting on its retry backoff is persisted `running` and never re-popped. |
| `RRWF-9` | Cancelling my run cancels only my run's children | The cascade walks `listRunsByParent` with no `forkMode` filter (`host/runCancel.ts:116`), so it cancels other users' in-flight forks too. |

The fourth item queued on this row, **bounded loopback** (`RRWF-10`), is a new
capability rather than a defect. It shares D2's machinery, so it is designed here
(D5). It turned out to have two prerequisites that the queue did not know about.

## Competitive frame

Durable-execution engines all have to answer "which recorded result belongs to this
call?" The reference answers converge:

- Temporal replays against the event **history position** of each command and
  refuses a replay whose command sequence diverges
  ([Temporal: Workflows](https://docs.temporal.io/workflows),
  [event history](https://docs.temporal.io/encyclopedia/event-history/event-history-typescript)).
- Inngest memoizes each step by **its id plus a counter that increments every time
  the same step id runs**, which is exactly what makes a step inside a loop replay
  its own result
  ([how functions execute](https://www.inngest.com/docs/learn/how-functions-are-executed),
  [loops](https://www.inngest.com/docs/guides/working-with-loops)). A rerun "from
  any step" reconstructs the earlier steps from memoized state
  ([rerun](https://www.inngest.com/docs/platform/manage/rerun-function-runs)).

D2's execution ordinal is the Inngest counter, derived from the event log the way
Temporal derives history position. Neither product keys on a per-process retry
counter, and that is the defect `RRWF-3` names.

## Boundaries audit

- **One owner of "a run should stop":** `runLifecycle.ts` calls itself the single
  owner of the run's abort signal. D1 changes it there and adds no sibling registry.
- **One owner of the replay source:** `forkDispatchOptions` (`forkInterrupts.ts:169`)
  already derives the fork's options from the persisted run, and it did so to fix
  exactly this class (FORKINT-2). Four resume call sites never call it, though. D6
  moves the derivation to the one place every run passes through, `executeRunBody`,
  so no dispatcher can forget it.
- **Source-outcome fold:** `indexSourceOutcomes` (`sideEffects.ts:283`) is the only
  fold. It is replaced, not paralleled, and `snapshotFromEventPrefix` is fixed in place.
- **Run-create guards:** `runQuotaMiddleware`, `reserveConcurrentSlot`
  (`middleware/rateLimit.ts`), `capabilityGatedTypeIdRefusal` (`runs.ts:2406`) and
  `hostSuite.auditSink` are reused by `:fork`, not re-implemented.
- **No feature package, no toggle.** This is core executor and run-route work (the
  `core:runs` surface). Nothing is advertised or withdrawn at `/.well-known/openwop`.

## Decision

### D1 — A deadline cut is a breach, and each segment arms its own deadline (`RRWF-1`, `RRWF-2`)

1. The deadline abort carries a typed reason, `RunDeadlineError`
   (`runLifecycle.ts`). `runAbortedByDeadline(runId)` answers whether the run's
   current signal fired for that reason.
2. In `runOneNode`, a node that ends in failure while its run's signal was aborted by
   the deadline returns a new outcome, `{ kind: 'deadline' }`. This mirrors ADR
   0632's `interrupted` arm for a pause cut. No `node.failed` is recorded: the breach
   is the run's fact, and `cap.breached` + `run.failed{run_timeout}` record it.
   This is the same record the loop-timer path already leaves for a node still in flight.
3. `launch` treats `deadline` as "the run breached". It sets `deadlineTripped`,
   records no node failure and schedules no retry. The loop's first check becomes
   `deadlineTripped || isRunDurationBreached(...)`. `breachRunDuration` already waits
   out the boundary, so the strict `observed > limit` invariant (#3222) is kept.
4. `armRunAbort` becomes per-segment. On every entry to `executeRunBody` it replaces
   any existing controller: it clears the old deadline timer and arms a fresh signal
   for this segment's deadline. The terminal listener only removes the entry if it
   still owns it. A signal aborted by an earlier segment's deadline can no longer
   reach a resumed node.

**Rejected alternative:** arming the abort 1 ms after the deadline. That orders the
common case but not the loaded one, which is the flake itself: timers may fire late,
and microtasks from the node failure can still beat the loop. Classification by
cause is exact, and ordering by time is not.

### D2 — One execution ordinal, derived from the log (`RRWF-3`, `RRWF-4`)

**The ordinal.** `n(nodeId)` is the number of the node's `node.started` events in
the run's own log, including a fork's copied prefix. There is one exception: a
`node.started` whose previous lifecycle event for that node was `node.suspended` is
a **re-invocation of the same execution**. That is the reinvoke resume of a
`ctx.suspend`/`ctx.interrupt` node or a credential gate. interrupt.md §Re-entry says
"a replay or recovery of the same execution MUST re-derive the same key", and a
replay-served node never suspends. So the continuation must not advance `n` on
either side, or every HITL side-effecting node would fail closed on replay.

An `immediate` pause cut DOES advance `n`: runs.md §Pause says the resumed
`node.started` "begins a fresh attempt". The cut execution has no terminal outcome,
so replay fails it closed under rule 3. That is spec-literal, and it is the safe
direction.

**One fold, two consumers.** `foldExecutionOrdinals(events)` in `sideEffects.ts`
walks a log once and tags each node lifecycle event with its ordinal:

- `indexSourceOutcomes` becomes `nodeId → (n → outcome)`. A started execution with
  no terminal event has no entry and fails closed (rule 3).
- `countExecutions` seeds the live counter from the run's own log (paged) when the
  run is replaying.

**Live counting.** `runOneNode` claims the ordinal at the moment it emits
`node.started`, not at launch. Paths that refuse before `node.started` (the model
capability gate) therefore never consume one, and the live count stays equal to
the fold by construction. The served-outcome lookup becomes
`sourceOutcomes.get(nodeId)?.get(n)`.

The effect identity (`effectCtx.attempt`, RFC 0150 §B inputs) and the LLM
invocation-log key are NOT changed by this ADR. They answer "the Nth attempt of
this execution" for their own purposes; D2 is the replay lookup only.

**Snapshot fold (`RRWF-4`).** `snapshotFromEventPrefix` treats a non-continuation
`node.started` as "in flight at the checkpoint": it clears that node's
state/outputs/error, so the fork re-executes it. A continuation start keeps
today's behaviour.

### D3 — `:fork` is run creation (`RRWF-6`, `RRWF-7`, `RRWF-9`)

1. The route carries `runQuotaMiddleware()`. After the insert it binds
   `reserveConcurrentSlot(req, newRunId)` and records
   `auditSink.record({ action: 'run.fork', … })`. Before insert it refuses a gated
   typeId with `capabilityGatedTypeIdRefusal(resolvedFork.definition.nodes)`, as
   create does.
2. The prefix copy is wrapped. On failure the fork row is marked `failed` with
   `error.code: 'fork_prefix_incomplete'` before the error propagates, so no sweeper
   will ever run a partial log. The code is host-namespaced on the wire by the
   existing v2 normaliser. It lives on the run row, which is the only thing a client
   of a failed `:fork` can read.

   > **CORRECTED at implementation:** the 500 names the fork in a `Location` header,
   > not in `details.runId` as the architect pass proposed. The error envelope's
   > entropy scrub redacts a UUID in `details` AND in `message` (row 2's lesson,
   > measured again here: `"runId":"<redacted:high-entropy>"`). The client-facing
   > message is generic; the storage error text is logged, never echoed.
3. The cancel cascade excludes forks (`!r.forkMode`), matching
   `compensationRuntime.ts:155`. A fork is a sibling history, not a child
   execution.

### D4 — Scheduler (`RRWF-5`, `RRWF-8`)

1. The trigger-rule sort keys on `edgeId ?? id ?? ''`, the same key `buildGraph`
   already uses.

   > **CORRECTED by grade-code (`RRCD-9`):** `RRWF-5` is LATENT, not live. The
   > validator DOES copy `id` into `edgeId` (`workflowDefinitionValidation.ts:577`),
   > so only ingest that bypasses it can reach the crash. Today that is the
   > conformance fixtures, and the one canonical-`id` fan-in there
   > (`conformance-approval-reject-loopback`) keeps a single incoming edge once the
   > back-edge is excluded. The guard stays, because D5 routes loopback targets
   > through exactly this comparator.
2. The pause drain point also requires `pendingRetryTimers === 0`. While a pause
   is requested, `slots` is 0, so a retry timer that fires simply flips its node to
   `ready`, and the next turn pauses with that node in the ready set.

### D5 — Bounded loopback (`RRWF-10`) — designed here, shipped as Phase 2

What the capability needs, in order:

1. **Prerequisite A: `interrupt.requested` for every interrupt kind.** The host
   emits it only for `credential` (`executor.ts:2386`). events.md says every kind
   uses the two registered types, and the v2 loopback leg filters on it. This is
   spec'd behaviour, so no RFC is needed. It is still a host behaviour change that
   touches every HITL event sequence and `replayDivergence`'s compared set, so it
   ships as its own phase with its own witness.
2. **Prerequisite B: an upstream fixture fix.** `conformance-replay-ordinal-loop`
   cannot PASS on a host that honours its own manifest. Its `wait` is `core.delay`,
   which `packs/core.openwop.flow/pack.json` declares `role:"side-effect"`, and
   replay.md rule 4 makes that binding. The fork therefore fails `wait` closed
   (the source was cancelled inside it) and never reaches `effect`'s second
   execution. Filed upstream as
   [openwop#1769](https://github.com/openwop/openwop/issues/1769). The fixture
   stays withheld here until either the fixture or the manifest changes.
3. **Admission.** A DFS back-edge whose endpoints are not dispatch types is
   admitted as a *loopback edge* only when the definition declares
   `settings.maxLoopbackIterations`. An undeclared cycle stays `cycle_detected`.
   The schema default of 5 describes the cap once a loop is admitted, and a host
   MAY refuse a graph it does not run. Refusing an accidental cycle is safer than
   running it five times.
4. **Execution.** Loopback edges are removed from the forward DAG, as dispatch
   back-edges already are. When a loopback edge's source settles and the edge's
   trigger rule and condition admit it, the scheduler re-arms the region: the
   target, plus every node on a forward path from the target to the source, is
   reset to `pending` with its outputs and errors cleared, and the target is made
   `ready`. Each re-arm counts one visit of the target. A re-arm that would exceed
   the cap emits `workflow.loopbackLimit {nodeId, iterations, limit}` and the edge
   is not taken.
5. **Per-visit interrupt key.** The key is `${nodeId}#${visit}`, where `visit` is
   the number of the node's interrupts whose resolution was consumed before this
   execution began. That count is folded from the log by D2's walk. `reinvokeResolutions`
   is consumed by the execution it resumes rather than living for the run, and
   `getInterruptByNode` selects the open interrupt of the current visit.
6. **Replay** re-derives both the ordinal (D2) and the visit key from the log, so a
   fork of a looped run resolves each visit on its own terms.
7. **Acceptance.** `conformance-approval-reject-loopback` becomes advertisable, the
   v2 leg "a rejected gate looped back to itself is asked again under a new key"
   RUNS and PASSES at `OPENWOP_TARGET_MAJOR=2`, and #4206's pinned withheld-set
   test is updated.

### D6 — The replay source is a property of the run (`RRWF-19`)

`executeRunBody` derives the replay source as
`options.replayInvocationsFromRunId ?? (run.forkMode === 'replay' ? run.parentRunId : undefined)`.
Every entry into a replay fork, whether initial dispatch, sweeper recovery, gate
resolution or `:resume`, then reads the same source, and the fast path and the ADR
0531 backstop cannot stand down on a resume. `forkDispatchOptions` keeps passing it
explicitly; the derivation is the floor under it, not a replacement.

### Architect pass (2026-09-28, before code): one Blocker and four Highs, all folded in

An adversarial `/architect` pass read the decision text against the code. Its
findings change D1, D2 and D6 as follows. The text above is kept as it was written
so the correction stays legible.

- **BLOCKER (D2): the ordinal rule was wrong.** Counting every `node.started`
  except a start that follows `node.suspended` fails a replay closed when the source
  COMPLETED, in three cases:
  - (a) a fork whose `fromSeq` falls inside an execution (`started(1) failed(1)
    started(2) | completed(2)`). Re-running the node makes it n=3, and the source
    has no n=3.
  - (b) a crashed replay fork that is recovered from an older snapshot.
  - (c) a source cut by an `immediate` pause or a lost lease (`started, started,
    completed`), which today's positional index serves correctly. This would have
    been a regression.

  **Corrected rule: an open-execution fold.** `n = 1 + the node's terminal outcomes
  (completed/failed) recorded so far`.
  - A `node.started` opens an execution only when none is open. A start while one
    is open, after a suspend, a cut or a fork boundary, continues that execution.
  - A terminal event closes the open execution. A terminal with no open execution
    (the three pre-start refusals, `executor.ts:524/546/629`) is an orphan and is
    ignored.

  ONE class, `ExecutionOrdinals`, implements the rule for both the fold and the
  live side, so the two cannot disagree. The live instance is seeded from the
  run's own log after the resume writes and before the first launch. It is updated
  only where `runOneNode` emits the start and the terminal. Consequence for the
  spec: a pause cut no longer advances `n`, and open question 1 widens to cover it.
- **HIGH (D2): the budget, not the ordinal, still failed `RRWF-3`'s own example.**
  The retry budget resets per body, so the fork (which never suspends) runs out of
  attempts where the source had not. **Fix:** on a replay fork, a SERVED failure
  retries exactly when the source recorded an outcome at `n+1`. The source's retry
  decisions are fixed history, not budget.

  > **CORRECTED by grade-code (`RRCD-8`):** the code retries when the source
  > STARTED execution `n+1` (`ExecutionOrdinals.highest`), not only when it
  > recorded an outcome there. That is the better rule: if the source started a
  > retry and was then cut, the fork replays that same retry, and the retry then
  > fails closed under rule 3. It no longer stops at execution `n`'s error.
- **HIGH (D1): the deadline must be read off the signal the node was given,** not
  looked up in the registry. The entry disappears on terminal, on a pause and on
  eviction, and a late rejection would append `node.failed` into a closed log.
  `runOneNode` captures its signal and tests `reason instanceof RunDeadlineError`.
  When the controller is replaced, each controller's terminal listener still aborts
  its OWN controller; only the map delete is ownership-conditional.
- **HIGH (D6): "no dispatcher can forget it" was too broad.** A replay fork's
  SUB-RUNS (`subWorkflowDispatcher.ts:260-306`, no `forkMode`, `executeRun(..., {})`)
  still run live, both before and after D6. This is recorded as `RRWF-20`, and the
  whole-class claim is withdrawn. The derived source also feeds `runOneNode`'s
  `replayInvocationsFromRunId`, so a resumed fork's LLM calls replay too.
- **MEDIUM:**
  - D6 is user-visible. After a resume, a replay fork's later side-effecting nodes
    now fail `replay_source_missing` where they used to fire. That is the correct
    (spec) behaviour, and it is recorded in the PR.
  - D1 leaves a timed-out source's cut node with no terminal, so a replay of it
    fails closed at that node. This joins `RRWF-14`.
  - D3 binds the concurrency slot only AFTER a successful copy. A failed copy marks
    the row failed, appends `run.failed` best-effort, and returns `details.runId`,
    so the client can find the row.
  - D4.1's rationale was misstated. `buildGraph` keys on the source/target pair; the
    sort key `edgeId ?? id` stands on its own.
  - A fork cut between a failure and its retry restores the node as `failed`. That
    needs the node's retry config at fold time and is deferred with `RRWF-4`'s
    residue.
- **Recovery of a crashed replay fork** (case (b)) now FAILS CLOSED on re-run of an
  already-served node, instead of silently re-serving it. That is the safe direction
  and it is deferred. The structural fix is to restore a replay fork from a fold of
  its OWN log rather than the stale snapshot.

### Grade-code pass on the implementation (2026-09-28): no Blocker, one High

- **`RRCD-1` (High):** `RRWF-4` fixed a fork cut INSIDE an execution, but not a fork
  cut BETWEEN a failure and its retry, which is the natural "fork from here" on
  attempt 2. The prefix ends `failed(1)`. **Fixed** in `executeRunBody` before the
  checkpoint's downstream release, using D2's fold:
  - a REPLAY re-opens the node when the source went on to start another execution;
  - a BRANCH applies the node's retry policy to the attempts the prefix consumed,
    and carries that count into the budget.

  This closes the residue the architect pass had deferred.
- **`RRCD-2`/`-3`:** D1.4 as first written cleared the previous segment's timer. On
  the unfenced resume path that segment can still have nodes in flight. The old
  controller now keeps its own deadline, and ONE terminal listener per run aborts
  every live controller (no per-segment listener growth). `abortRunForPause`
  reaches all of them.

## RFC verdict

**No new RFC.** Every behaviour here is already normative text:

- replay.md §Suppression rules 1–3 (openwop#1745/#1718, suite 2.43.2);
- interrupt.md §Re-entry and resume values;
- runs.md §Pause and resume;
- RFC 0058 §C;
- events.md (`interrupt.requested` for every kind).

This host's reading of rule 2's "counts the node's `node.started` events" treats a
reinvoke continuation as the same execution (D2). That rests on interrupt.md's
same-execution rule, and it is filed upstream as a clarification, not as a gate.
Nothing new is advertised.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P1 | D1, D2, D3, D4, D6 + the grade-ux / grade-code findings on the runs UI | **implemented** (this PR) |
| P2 | D5 prerequisite A: `interrupt.requested` for every interrupt kind. This is a **CONFORMANCE DEFECT, not a feature** — v2 interrupt.md §Events says "every kind uses two registered types", and §Re-entry's MUSTs (openwop#1697) presuppose it | **delivered by #4212** (merged `9ca915260`): adds `executor/interruptRequestedPayload.ts`; `interruptRequestKey` is the ONE key-derivation point (key `${runId}:${nodeId}:${visit\|resumeKey}`) that P3 swaps for the visit ordinal |
| P3 | D5 loopback execution + per-visit keys (via `interruptRequestKey`); re-advertise `conformance-approval-reject-loopback`; the v2 leg run at major 2. Spec gap `openwop.gap.0223.11` | open, after P2 |
| P4 | D5 prerequisite B → re-advertise `conformance-replay-ordinal-loop` | blocked on [openwop#1769](https://github.com/openwop/openwop/issues/1769) |

Deferred from the grade, each with a reason:

- ~~`RRWF-4` residue (a fork between a failure and its retry)~~: closed by `RRCD-1`.
- `RRWF-11` (a fork cut between `interrupt.resolved` and the gate's terminal event
  re-opens a decided gate): needs the recorded resolution to be served on the
  fork's re-invocation, which is D5's reinvoke-per-execution rework (P3).
- `RRWF-12` (fork-of-fork live LLM calls): needs the ancestry walk in the
  invocation fallback. P2 candidate.
- `RRWF-13` (recursion limit, retry budget and run clock restart per segment):
  needs persisted per-run counters, a snapshot schema change.
- `RRWF-14` (a breach does not wait for in-flight effects).
- `RRWF-15` (fork idempotency key, `runs:read`, compensation-tail 422, branch-overlay
  validation).
- `RRWF-16` (divergence check paging and recovery).
- `RRWF-17` (retry timer hygiene) and `RRWF-18` (terminal-failure classifier).

## Alternatives weighed

- **Persist `nodeAttempts` in the snapshot (D2).** This fixes the resume reset but
  not the mid-sequence fork, which has no snapshot of the source's counters. It
  would also add a second source of truth next to the log. Rejected; the log is the
  record replay already trusts.
- **Key replay on `(nodeId, attempt)` and forbid loops forever.** This is the
  spec's superseded rule, and the retry-across-suspend case is wrong under it even
  without loops.
- **Ship loopback in P1.** Rejected on the evidence. Without prerequisite A the v2
  leg would turn from `inapplicable` to red, and without prerequisite B the ordinal
  fixture cannot pass. Advertising a fixture whose scenario is known to fail is the
  dishonest direction.

## Open questions

1. Upstream: should rule 2's `n` exclude a reinvoke continuation's `node.started`
   (D2)? This host says yes, on interrupt.md's same-execution rule.
2. Upstream: is `core.delay` really side-effecting (D5 prerequisite B)? Its only
   observable effect is elapsed time, which rule 1 does not treat as external.
3. D5: does a capped loopback edge skip (proposed) or fail the run? The spec only
   says the event is emitted.

## Implementation record (P1)

| Decision | Change | Witness (real path; each sabotaged red) |
|---|---|---|
| D1 `RRWF-1` | `runOneNode` classifies a failure whose captured signal was aborted by `RunDeadlineError` as `{kind:'deadline'}`; `deadlineTripped` breaches | `adr0772-run-deadline-classification.test.ts` (fake timers through `executeRun` + real `core.delay`) |
| D1 `RRWF-2` | `armRunAbort` per segment; one terminal listener per run | same file + `run-abort-signal.test.ts` |
| D2 `RRWF-3` | `ExecutionOrdinals` (one open-execution rule for fold + live); served lookup keyed on `n`; served failure retries when the source did | `adr0772-replay-execution-ordinal.test.ts` (route: `POST /v1/runs` → `:fork`) |
| D2 `RRWF-4` + `RRCD-1` | `snapshotFromEventPrefix` restores in-flight nodes; a fork inside a retry re-opens the node | same file |
| D6 `RRWF-19` | replay source derived from `run.forkMode` in `executeRunBody` | same file (inherited gate resolved through `POST /v1/interrupts/{token}`) |
| D3 `RRWF-6/7/9` | `:fork` quota + budget + gated refusal + slot + audit; failed copy fails the fork (`Location`); cancel spares forks | `adr0772-fork-parity.test.ts` |
| D4 `RRWF-5/8` | edge sort key; pause waits for pending retry timers | `adr0772-scheduler.test.ts` |
| UI `RRUX-1..6`, `RRCD-5..7` | `RunDetailPage` keyed by `runId`; fork guard through navigation; cancel confirms (both screens); form writes the missing defaults; `cut` timeline status | `runDetailIntegrity.test.tsx`, `schemaInputFormGate.test.tsx`, `runTimelineCutSegment.test.tsx` |

**Upstream items for `openwop`:**
1. [openwop#1769](https://github.com/openwop/openwop/issues/1769):
   `conformance-replay-ordinal-loop` cannot pass on a host that honours
   `core.delay`'s `role:"side-effect"` (D5 prerequisite B). The fix is either a pure
   wait node in the fixture, or reclassifying `core.delay`.
2. Whether replay.md rule 2's `n` counts a start that continues an open execution
   (a reinvoke resume, a pause cut). This host says it does not (D2), resting on
   interrupt.md's same-execution rule. Raised in the same issue as a secondary
   question.
