# ADR 0751 — Forking a run at a checkpoint inside a suspended run

Status: implemented

Phase WS6 of the 2026-09 RFC witness program. This is host work with no wire change: it removes a refusal that no spec text licensed.

## Context

`POST /runs/{runId}:fork` answered `501 fork_checkpoint_unsupported` whenever the copied prefix (`sequence < fromSeq`) ended on an open interrupt. `snapshotFromEventPrefix` (`executor/executor.ts`) returned `null` for any `node.suspended` / `conversation.opened` without a later terminal event, and the route turned that into the 501 (ADR 0326 P3b).

**No spec licenses the refusal.** `spec/v2/core/runs.md` §Fork and `replay.md` name the fork refusals exhaustively:
- `400` for a malformed or out-of-range `fromSeq`, or an overlay on a `replay`;
- `422 fork_point_invalid`;
- `404` for a source run the caller cannot see;
- `409` for `replay_diverged_at_refusal` and `replay_memory_snapshot_unavailable`.

`fork_checkpoint_unsupported` was a host-invented code.

The corpus leg `openwop.it.v2-a2ui-v09-surface.recorded-as-recorded` (suite 2.38.0, openwop#1538) exposed the gap:
1. It forks a `conformance-approval` run suspended at `waiting-approval`, with `mode: replay`, at a later seam-recorded event.
2. It requires `201` and the recorded surface carried byte-equal.

The file sat on `scripts/conformance-v2-known-red.txt` for this reason.

## Decision

**D1 — the fork inherits the gate as STATE; nothing in the prefix re-executes.** `snapshotFromEventPrefix` restores a node whose prefix ends on an open interrupt as `'suspended'`, with its interrupt kind in `suspendedKinds`, and no longer returns `null`. The gate node does not run again: its suspension is fixed history (`replay.md`, "events with `sequence < fromSeq` are fixed history").

**D2 — the fork's executor re-creates the live interrupt row** (`executor/forkInterrupts.ts`, `ensureForkInterrupts`). This runs on a fork-checkpoint resume, before the drain can report the run as waiting.
- **Source:** the row is re-created from the SOURCE row that the copied `node.suspended.payload.interruptId` names. A legacy prefix without an `interruptId` falls back to the parent's row for the node.
- **Fresh `interruptId` and token.** A token is a credential. The source's token keeps resolving the source, and only the fork's token resolves the fork.
- **Inherited `createdAt`.** The approval-timeout (`approvalGateTimeout.ts`) and timer (`timerResume.ts`) deadlines derive from it, and ADR 0262 ruling #2 makes a fork inherit the original deadline. A fresh `createdAt` would silently extend every deadline.
  - `suspendManager.createInterrupt` gained an optional `createdAt`.
  - The token's expiry is `min(now + TTL, inherited createdAt + timeoutMs)`.
- **Ownership by ancestry.** The named row must belong to a `parentRunId` ancestor in the fork's tenant. The whole chain is walked, bounded at 16 hops, because in a fork of a fork the copied event names the grandparent's interrupt.
  - A named row outside the ancestry does NOT fall back to the parent's row, which would let a forged id select a different gate.
  - A gate that cannot be recovered fails the fork closed with `fork_interrupt_unavailable`, rather than leaving it waiting on a gate nobody can resolve.
- **Idempotent.** A node that already has an open row on the fork is skipped, so an executor redelivery re-creates nothing.
- **No new event.** The fork's log is its prefix plus what re-executes. The live gate is discoverable the normal way: the snapshot's `interrupt` and the interrupt list, carrying the fork's own token.
- **Conversation gates keep the recorded `conversationId`.** It is taken from the copied `conversation.opened`, else `${sourceRunId}:${nodeId}:0`. Otherwise the exchange path derives the id from the fork's run id and orphans the copied transcript.

**D3 — the fork resumes through the NORMAL resolve path.** `POST /interrupts/{token}` → `resolveAndResume` → `executeRun`, using the fork's persisted snapshot. Two supporting changes:
- The fork route now stores the prefix snapshot as the fork's `schedulerSnapshot`. `...sourceRun` used to copy the source's CURRENT snapshot, which a resolve on the fork would hydrate before the fork's executor had persisted its own.
- Approver eligibility is checked live, because this is a new resolution, not replayed history.

**D4 — `suspendedKinds` is hydrated on every resume.** It was persisted with the snapshot and never read back, so a resume that left a second gate open ended the run as `waiting-input`, whatever that gate's kind was.

**D5 — replay divergence is compared only once the fork is terminal.** A fork that settles on an inherited gate has re-executed nothing yet. Comparing its empty tail against the source's continuation manufactured a `replay.diverged`.

## `/architect` verdict (before code)

**Proceed**, with three required changes, all adopted:
- **R1:** keep the source's `createdAt` (ADR 0262 ruling #2).
- **R2:** check ownership against the whole ancestry chain (fork-of-fork).
- **R3:** conversation gates keep the recorded `conversationId`.

Decided:
- **Q1 — a replay fork WAITS at the gate; it does not auto-apply the source's later resolution.**
  - Caveat 2 of `replay.md` binds a node that re-executes `ctx.interrupt`, and here no node re-executes.
  - The source's resolution at `sequence ≥ fromSeq` was input the caller gave to the source, not output of executing it.
  - Re-applying it would re-enter the quorum and reject paths of `resolveAndResume`.
  - It would also make it impossible to re-decide a gate on a replay fork.
- **Q3 — copying the interrupt data is safe.** The fork is created by the source's owner (`loadOwnedRun`) in the same tenant, the data is secret-stripped again on insert, the token is fresh, and eligibility is re-checked live.
- **Q4 — no RFC.** The refusal was never licensed. Removing it moves the host toward the spec and changes no wire shape.

## Alternatives weighed

- **Re-execute the gate node on the fork.** Rejected: its `node.started` / `node.suspended` are already in the prefix, so re-running would duplicate fixed history. That is the same defect class as the duplicate `run.started` fixed in ADR 0637.
- **Keep the 501 and document it.** Rejected: it is an unlicensed refusal, and the corpus now tests it.
- **Emit a fresh `interrupt.created` on the fork.** Rejected: this host never emits that type, and the gate is discoverable without a new event.

## Known limits

- The source and the fork share a conversation gate's `conversationId`, so exchange-idempotency claims (`conversationExchangeIdem.ts`, keyed `(tenant, conversationId, exchangeKey)`) share one key space across the two runs. A client reusing a source exchange key on the fork is deduplicated.
- Divergence is compared when the fork's first execution ends terminal. A fork that suspends and is later resolved to completion is not re-compared.
- **A `fromSeq` between a gate's `interrupt.resolved` and the `node.completed`
  that follows it** (two appends of one resume, milliseconds apart) restores the
  gate as open, so the fork asks for the decision again. Safe — nothing is
  re-fired and the fork's resolution is its own — but the recorded resolution is
  not re-applied. Found in `/code-review`; left as a documented limit because
  re-applying it would route a replayed decision through the live quorum path
  (the Q1 hazard).
- Re-creating a gate fans out a notification to the gate's audience, as the original did.

## Implementation record

| What | Where | Test |
|---|---|---|
| suspended checkpoint snapshot | `executor/executor.ts` `snapshotFromEventPrefix` | `test/adr0751-fork-suspended-checkpoint.test.ts` (pieces) |
| gate re-creation | `executor/forkInterrupts.ts`, `executor/suspendManager.ts` | same file: both modes, fork-of-fork, conversation, idempotency, foreign-id refusal |
| `suspendedKinds` hydration, fork snapshot, terminal-only divergence | `executor/executor.ts`, `routes/runs.ts` | same file |
| 501 retired | `routes/runs.ts`, `types.ts` | `executor-durability-adr0326.test.ts` (pin corrected) |

Sabotage-proven, one rule at a time:
- skipping re-creation reds six legs;
- a fresh `createdAt` reds three;
- dropping the ancestry check reds the foreign-id leg;
- comparing divergence on a suspended fork reds the divergence leg;
- restoring the 501 reds the corpus leg `recorded-as-recorded` at its own `201` assertion. The leg passes on this change combined with WS5's a2ui v0.9 host work (ADR 0749), which it needs in order to run at all.

The `v2-a2ui-v09-surface` known-red line is retired in this change.

## Follow-up (2026-09-26, ADR 0755 — END `/grade-code` pass)

- **A sub-run child was treated as a fork (WIT-FORK-1).** `ensureForkInterrupts`
  keyed "is a fork" on `parentRunId`, which sub-run children also carry, and
  `isForkCheckpointResume` is also true for `POST :resume` of a paused run
  (`resumeSnapshot` without `resumeNodeId`). A paused sub-run child with a
  suspended node and no open row was walked as a fork and failed
  `fork_interrupt_unavailable` against its own log. It now gates on `forkMode`,
  the discriminator the executor's ancestry walk and `compensationRuntime`
  already use (stamped only by `:fork`). `isForkCheckpointResume` itself is
  unchanged — narrowing it would also stop `prepareRunSecrets` on `:resume`.
  Witness: the "a sub-run CHILD is not a fork" leg (sabotage-proven).
- A re-created gate now logs `fork_gate_recreated` (`runId`, `parentRunId`,
  `gates`) — the success path was silent (WIT-FORK-5).
- Still open, by mechanism:
  - **WIT-FORK-2** — re-creation is check-then-insert: `listOpen` then
    `createInterrupt`, with only a plain index on `(run_id, node_id)`, so two
    concurrent executor deliveries of one fork could both mint a row. Needs a
    partial unique index `WHERE resolved_at IS NULL` (a migration), so ADR 0740's
    execution claim is the current guard.
  - **WIT-FORK-3** — `snapshotFromEventPrefix` does not clear an open kind on
    `interrupt.resolved`, so a `fromSeq` between it and `node.completed` re-opens
    a decided gate (the Known limit above; the Q1 quorum hazard blocks re-applying).
  - **WIT-FORK-4** — the fork's conversation gate reuses the source's
    `conversationId`, so `(tenant, conversationId, exchangeKey)` idempotency is
    shared (the Known limit above).
