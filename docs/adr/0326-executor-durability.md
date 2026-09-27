# ADR 0326 — Executor durability: node retry, cross-instance SSE fan-out, fork re-execution

Status: Accepted (Phases 1–3 implemented; Phase 4 decided)

## Context

The conversation-stack audit (docs/steward/CODEBASE-ASSESSMENT.md, 2026-07-09) left three
workflow-engine Improvement gaps: **CS-WF-3** (no node-level retry — `attempt`
is a one-shot stub), **CS-WF-4** (SSE live fan-out is in-process only; a
client whose stream lands on a different Cloud Run instance than the appender
gets replay-then-silence and degrades to polling — prod runs
`--max-instances=5`), and **CS-WF-5** (fork `branch` mode copies events as-is;
the code's own comment says "Real impls re-execute pure nodes
deterministically"). **CS-WF-6** (the wire artifact endpoint stub) rode along.

Wire check: `spec/v1/observability.md` ALREADY defines the retry vocabulary
(`openwop.node_attempt` MUST span attribute; `attempt` on
`openwop.node.completed`; per-attempt spans) — retries are host behavior over
existing spec vocabulary. **No RFC is needed for any phase here.**

## Decision

1. **Phase 1 — node retry (CS-WF-3, implemented).** Bounded, **opt-in** retry
   at the scheduler's failure branch: a node whose `config.retry.maxAttempts`
   declares 2–5 attempts is re-queued (`nodeState → 'ready'`, the same
   mechanism resume uses) for retryable failures. Non-retryable classes:
   `envelope_refusal`, `validation_error`, `capability_unsupported`,
   `workflow_invalid`, `recursion_limit_exceeded`. Each attempt emits its own
   `node.started`/`node.failed` pair — the EVENT LOG is the attempt record
   (existing vocabulary; no new event type). Exponential backoff
   (250ms·2^n, cap 2s) is skipped on replay — a replay re-drives the same
   recorded event sequence through the same control flow, so observable
   events stay identical (replay-divergence-safe). The recursion cap still
   bounds total executions. Node `config` is host-side (not wire), so the
   `retry` key is a host-honored config extension, documented here.
   *Residue:* the OTel `node_attempt` span attribute still reads 1 — the
   span-per-attempt wiring is a follow-up; the event log carries the truth.
   **Correction (post-merge architect review, 2026-07-09):** the replay claim
   is scoped. The Layer-2 invocation log keys on `(runId, nodeId,
   request-hash)` and does not distinctly record FAILED attempts, so a `:fork`
   replay of a retried run may find the recorded success on its first attempt
   and COMPRESS the attempt sequence (fewer started/failed pairs than the
   original — visible to the divergence detector). Result-determinism holds
   (same final outputs); attempt-count fidelity on replay requires failure
   recording, folded into Phase 3's scope alongside fork re-execution.

2. **Phase 2 — cross-instance SSE fan-out (CS-WF-4, implemented).**
   `host/runEventBus.ts`: every durable event append publishes a coalesced
   (100ms trailing-edge; terminal-flush) `{seq}` TICK on the ONE host-ext
   pub/sub (the same bus chat frames ride — no parallel transport, the
   chat-frame pattern: ticks carry no payload, durable storage stays the
   source of truth). The run SSE route merges three sources — durable replay,
   in-proc fanout, tick-triggered gap fetches — through a single per-connection
   sequence WATERMARK, so events deliver at most once in order. Best-effort
   end-to-end: a bus hiccup degrades to today's behavior (in-proc + poll
   fallback).

3. **Phase 3a — retry attempt fidelity (implemented, 2026-07-10).** The
   node-level attempt now threads end-to-end: `runOneNode` receives the real
   attempt, the AI adapter keys the Layer-2 invocation log per attempt (the
   `attempt` column was always in the PK — it was hardcoded to 1), the OTel
   `openwop.node_attempt` span attribute derives from it (retiring the P1
   residue), and FAILED provider invocations are recorded as a tagged,
   secret-scrubbed envelope that RE-THROWS the identical `AiProviderError` on
   a cache hit — so a re-execution reproduces failure-then-success attempt
   sequences instead of compressing them. Scope (architect ruling): this
   covers PROVIDER-CALL nondeterminism (exactly Layer-2's contract);
   deterministic node-code failures replay by re-execution; nondeterministic
   NON-provider failures remain outside attempt fidelity. Test note: the
   deterministic round-trip is pinned at the `callAI` layer (record → replay →
   next-attempt-succeeds, mock-programmed failure); the full fork-replay
   event-sequence e2e lands with Phase 3b, which is when fork re-execution
   exists to drive it.

4. **Phase 3b — fork re-execution (CS-WF-5, implemented 2026-07-10).**
   - **Branch forks resume, never re-emit.** `snapshotFromEventPrefix`
     (executor.ts) folds the copied event prefix (`node.completed` /
     `node.failed`) into a `SerializedSnapshot`; the fork route validates the
     checkpoint BEFORE creating the fork run and passes the snapshot as
     `resumeSnapshot` — the prefix's events are copied verbatim and its nodes
     never re-execute (previously the whole definition re-ran, double-emitting
     the prefix). The executor re-derives readiness after a checkpoint
     hydration (`releaseDownstream` over every settled node — interrupt
     resumes carry `resumeNodeId` and were unaffected) and prepares run
     secrets for the fork's new run id (a checkpoint resume has no ephemeral
     secrets bundle).
   - **Honest refusal:** a `fromSeq` landing on a suspended checkpoint (an
     open interrupt / conversation gate) returns **501
     `fork_checkpoint_unsupported`** with no orphan run — a fork cannot
     re-create the suspended gate.
     > **CORRECTION 2026-09-25 (ADR 0751):** a fork CAN re-create the gate, and
     > no spec licensed this refusal. The fork now inherits the open gate as
     > state (fresh token, inherited deadline) and resumes through the normal
     > resolve path; `fork_checkpoint_unsupported` is retired.
   - **Replay forks read the SOURCE run's invocation log.** `AdapterScope.
     replayInvocationsFromRunId` (threaded route → `executeRun` →
     `runOneNode` → adapter) makes `callAI`'s cache lookup fall back to the
     parent run's records — including P3a's recorded failure envelopes — so a
     replay of a RETRIED run reproduces the exact
     started/failed/started/completed attempt sequence without any live
     dispatch. This closes the P3a correction note: forks of retried runs no
     longer compress attempts.
   - **Fallback is copy-on-read.** A parent-log hit is re-recorded under the
     fork's own key, so the fork's invocation log is self-contained — a
     fork-of-a-fork replays from its immediate parent (the fallback only
     reaches one level up; architect review finding).
   - **Recorded consequences (deliberate):** (a) branch-fork prefix outputs
     are rebuilt from PERSISTED `node.completed` payloads, which are
     secret-stripped at emit time — a suffix node sees the stripped form of
     any upstream output that carried a `__secret:*` ref (fail-safe: never
     resurrect secrets from the event log); (b) a node mid-flight at the
     checkpoint (`node.started`, no terminal, no open interrupt) stays
     pending and re-executes LIVE in the fork — its `node.started` appears
     twice (copied + re-run). That is correct branch semantics (the work was
     not done at the checkpoint), distinct from the prefix double-emit this
     phase fixed.
   - **Advert flip trigger:** discovery still lists `replay.modes:
     ['replay']`. Flip to include `'branch'` when a CLEAN branch-mode
     conformance witness exists (this checkout's conformance run carries
     pre-existing env/pack failures — verified byte-identical at the base
     commit, so P3b introduces no regression, but a dirty run is not a
     witness). Advertise only what conformance has proven.

     **FLIPPED 2026-08-08 (ADR 0531/0532 batch) — the witness now exists.**
     Advert is `replay: { supported: true, modes: ['replay','branch'], fork: true }`.
     Witness taken with the app's own in-process harness —
     `npm run test:conformance -- --filter replay` — against the **pinned
     published artifact `@openwop/openwop-conformance@1.64.0`**, not a
     working-copy of the spec repo. That distinction matters: a witness taken
     against unreleased suite source proves something no other host could
     reproduce. (The spec-repo source run agrees, with identical counts.) The
     harness boots via `createApp` rather than the module entry point, so
     `ensureLocalPacksMounted` never runs and the run is pack-clean **by
     construction** rather than by inspection — which is precisely what the
     earlier run lacked:

     | Scenario file | Result |
     |---|---|
     | `replay-fork-arbitrary.test.ts` | **branch mid-`fromSeq` fork → `completed`: PASS**; its 2 skips are the *replay*-mode mid-seq cases this host honestly 501s |
     | `replay-fork.test.ts` | 6/6 pass |
     | `replayDeterminism.test.ts` | 3/3 pass |
     | `replay-divergence-at-refusal.test.ts` | 3 skipped (Phase-4 env gate, unchanged) |
     | `replay-observable-sequence-determinism.test.ts` | 2 skipped (unchanged) |

     Totals: **10 passed / 7 skipped / 0 failed** across the replay-fork set.
     Checked specifically for *newly-woken* scenarios — raising an advert can
     ungate scenarios elsewhere, and a green run that merely proves "nothing new
     ran" is not a witness. The branch case is confirmed non-vacuous: verbose
     output shows it as an explicit `✓`, not a `↓`.

     Mid-sequence **`replay`** remains 501 (`fork_from_seq_unsupported`) and is
     deliberately still not claimed — `modes` advertises the mode, and the
     per-`fromSeq` limitation stays an honest runtime refusal.
   - Gate: the fork-replay attempt e2e + branch checkpoint + chained-fork
     tests live in `executor-durability-adr0326.test.ts`; the conformance
     fork scenarios stay green (replay mode still full re-execution from
     seq 0).

5. **Phase 4 — wire artifact endpoint (CS-WF-6, resolved by decision).** The
   honest-404-after-auth stub is spec-compliant for a host that does not
   advertise wire artifacts. The host HAS an artifact store (ADR 0083,
   `runArtifactStore`) served through host-ext surfaces. Promoting it to
   `/v1/runs/:runId/artifacts/:artifactId` is a capability-advertisement
   decision (advert + conformance artifact suite + tenant/authz mapping), not
   a stub-fill — planned as this ADR's Phase 4, triggered when a consumer
   needs wire-level artifact fetch (A2A/interop), not before.

   > **CORRECTION 2026-09-24 — triggered and implemented by ADR 0746.** The
   > consumer arrived: RFC 0205 gives `getArtifact` an A2A shape and a
   > conformance fixture to read back. The route now serves announced
   > artifacts from this same `runArtifactStore` (no second store), with the
   > tenant/authz mapping this phase named. No capability advert was needed —
   > `getArtifact` belongs to no family.

## Alternatives weighed

- **Retry as a global default (all nodes, transient classes)** — rejected for
  v1: double-executing a side-effecting node without the author opting in is a
  correctness hazard; opt-in via config keeps blast radius authored.
- **Publishing full events on the bus** — rejected: heavy frames, ordering
  duplication; ticks + durable fetch match the proven chat-frame pattern.
- **A second pub/sub for run events** — rejected outright (parallel-transport
  smell; ARCHITECTURE.md one-owner rule).

## Phase record

| Phase | Landed |
|---|---|
| P1 | executor retry branch + `nodeRetryMaxAttempts` + non-retryable set + backoff; `executor-durability-adr0326.test.ts` |
| P2 | `host/runEventBus.ts` (coalesced ticks) + eventLog append hook + streams watermark merge + teardown; tests |
| P3a | attempt threading + failure recording + replay re-throw; mock `errorCode` programming; callAI round-trip test |
| P3b | `snapshotFromEventPrefix` + fork-route checkpoint validation (`fork_checkpoint_unsupported` 501) + `replayInvocationsFromRunId` parent-log fallback + checkpoint-resume readiness/secrets fixes; branch/suspended/replay-attempt e2e tests |
| P3c | side-effect suppression on replay forks — see **ADR 0341** (flagged nodes reproduce the source outcome; `replay_source_missing` fail-closed) |
| P4 | — resolved-by-decision (trigger recorded above) |
