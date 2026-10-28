# ADR 0935 — A parallel dispatch wave waits for children that stop at a gate

Status: Accepted (implemented in this PR)

## Context

My user approved this on 2026-10-19 ("proceed with your recommendations",
item 1: campaign orchestration waits while channels are at their approval gates).

RFC 0118 defines the parallel fan-out of `core.dispatch`:

> `'wait-all'` (default) — the dispatch node remains suspended until **every**
> dispatched child reaches a terminal state.

This host did not do that. In the parallel arm of `core.dispatch`
(`bootstrap/nodes.ts`), `dispatchChild` folded any child status that was not
`completed` or `cancelled` into `failed`:

```ts
const status = result.childStatus === 'completed' ? 'completed' : result.childStatus === 'cancelled' ? 'cancelled' : 'failed';
```

`dispatchSubWorkflow` returns as soon as a child suspends, so a child at its
approval gate came back as `waiting-approval` and was counted as failed. The
Campaign Studio orchestration chain (`examples/workflow-chain-packs/campaign-orchestration`)
fans out to five channel children, each with an approval gate. The wave therefore
joined `partial` straight away, the run went on to production planning and the
consistency check with no channel output, and approving a channel later changed
nothing in the parent.

This is a host conformance bug against an Accepted RFC, so no RFC change is needed.

## Decision

- **D1 — the node suspends while any child is not terminal.**
  - After the wave, a child whose own status is not terminal keeps the node
    suspended. The node raises an `external-event` interrupt through `ctx.suspend`
    (the re-invoke resume style). Its data is schema-legal
    `ExternalEventData`:
    - `eventType: "openwop-app.dispatch.children-terminal"`;
    - `correlation`: the wave (`fanOutEventId`, the index of the wave's decision,
      every child's run id, workflow id and status at the wave, and the ids
      already terminal in observed order).
  - The same correlation is kept in a run variable (`__dispatchWaitAll:<nodeId>`),
    so the re-invoked node knows which wave it is resuming.
  - No `core.dispatch.join` is recorded while the node waits.
  - The RFC 0061 iteration counter is persisted before suspending.
- **D2 — the host joins when the last child finishes** (`host/dispatchWaitAll.ts`).
  - An `onAnyRunTerminal` subscriber, registered at app construction, reads the
    finished run's parent.
  - For each open wait interrupt on that parent, it checks that every child named
    is terminal. If so, it resolves the wait through `resolveAndResume`.
  - The resume value is the terminal list in observed order:
    1. the children already settled at the wave, in their recorded order;
    2. then the late children, ordered by their run's `updatedAt` (ties broken by
       run id).
  - That value is recorded on `interrupt.resolved`, so a replay re-reads the
    order and never recomputes it from the clock. This is the same R1 rule the
    synchronous wave follows with `mergeOrder`.
- **D3 — the re-invoked node folds the join as the synchronous path does, then
  carries on.**
  - The node finds the marker, and `ctx.suspend` returns the recorded resolution.
  - Decisions before the wave are skipped: they were already processed and
    emitted.
  - The wave is folded through the shared `finishWave`:
    - `outputMapping` is applied in `mergeOrder`, from the children's persisted
      variable bags;
    - `core.dispatch.join` is recorded with its causation on the fan-out;
    - the `dispatched` and `children` outputs are filled.
  - The decisions after the wave then run. Campaign orchestration's plan is
    `[next-worker …, terminate]`, so this matters.
  - The node completes with its normal output ports, so an edge from
    `channel-dispatch.dispatched` still carries the children. A native
    mark-completed resume would have produced only `{output}` and broken that edge.
- **D4 — only the host resolves the wait.**
  - The resume value *is* the join. A caller who could post one could claim which
    children completed.
  - `resolveAndResume` refuses a dispatch wait with `403 forbidden` unless the
    caller passes `hostDispatchJoin: true`, which only `dispatchWaitAll` does. It
    also refuses that flag on any other interrupt.
  - The check runs before any claim, so a refused attempt does not consume the
    interrupt.
  - The route's own external-event correlation check is not enough on its own:
    the correlation is readable by anyone who can list the interrupt.

## Alternatives weighed

- **Fold a waiting child as its own status, `waiting`.** This would invent a join
  status RFC 0118 does not define, and the parent would still run on without the
  channel.
- **Block the node until the children finish**, polling inside `execute`. This
  holds an executor slot and an instance for as long as a human takes to approve
  something, which can be days, and nothing survives a restart.
- **A native resume (mark the node completed with the resume value).** The output
  would arrive as `{output: value}`, which breaks the chain's
  `channel-dispatch.dispatched` edge. It also cannot run the decisions after the
  wave.
- **Re-dispatch on resume.** That would create duplicate children. The children
  already exist and are recorded on `node.dispatched`.

## Trade-offs and limits

- **Delivery is best-effort, as for every `onAnyRunTerminal` consumer (ADR 0535).**
  If the process dies between a child's terminal write and the subscriber, that
  join is missed. `joinSettledWaves(storage, hostSuite, parentRunId)` is
  idempotent and safe to call again, so a reconciling sweep can drive it. That
  sweep is not built here; it is checklist item 3.
  **Correction, 2026-10-21 recovery:** the bounded reconciliation described
  below now repairs these missed hints; the original limitation explains why
  the subscriber alone was insufficient.
- **A replay fork of a parent taken mid-wait** inherits the wait as an open gate
  (ADR 0751). It joins only when the source children it names finish, and those
  children are the source run's. This ADR does not change fork semantics.
- **The single-child `core.subWorkflow` node has the same gap.** It suspends with
  the child's kind and is never resumed when the child finishes. It is not changed
  here (checklist item 4).
- A dispatch wait is not a human decision. It appears in the run's open
  interrupts with kind `external-event`, and resolving it by hand answers 403.

## Implementation

| Part | Where |
| --- | --- |
| D1, D3 | `backend/typescript/src/bootstrap/nodes.ts` (`core.dispatch` parallel arm, `finishWave`, resume probe) |
| D2 | `backend/typescript/src/host/dispatchWaitAll.ts`; `src/index.ts` (`registerDispatchWaitAll` in `createApp`) |
| D4 | `backend/typescript/src/routes/interrupts.ts` (`resolveAndResume`) |
| Tests | `backend/typescript/test/adr0935-dispatch-wait-all-suspended-children.test.ts` |

The tests are route-level, through the real executor:

- approve → `satisfied`, the late child is last in `mergeOrder`, two
  `orchestrator.decided` events (no re-emission), one fan-out, and the downstream
  node completes;
- a forged resolve that carries the full correlation → 403, and the run is still
  waiting;
- reject → `partial`, and the parent completes.

Each was checked by sabotage:

| Sabotage | Result |
| --- | --- |
| No suspension | Reds every case at "parent waits" |
| No boot registration | Reds at "parent completes" |
| No guard | Reds the forge case |

## Checklist

- [x] D1–D4 with tests
- [ ] Re-run Campaign Studio qualify-live: channel approvals now hold the orchestration
- [x] A bounded reconciling sweep authored for missed joins (execution validation pending)
- [ ] The same wait for the single-child `core.subWorkflow` node

## Recovery correction — 2026-10-21

Source review found two durable gaps: a child could finish before its parent's
wait was published, and a process could die after resolving the wait but before
recording history or queuing the parent. Earlier completed waves' outputs could
also disappear if the final variable-bag write was lost.

The repair uses the existing storage, event log, invocation claims and dispatch
sweeper. It adds no wire field, timer framework, queue, or protocol capability.

- The executor persists the waiting status and its suspended scheduler snapshot
  in one run-row write. Recovery only resumes a waiting row whose matching node
  remains suspended; paused, running, terminal and corrupt snapshots refuse.
- The existing five-second dispatch sweeper runs an independent recovery lane.
  Open waits use its bounded newest-plus-keyset scanner. Resolved waits are found
  through rotating waiting-status pages, bounded node windows, and durable
  suspension-event sequence rather than timestamps or the open-only interrupt
  getter. A permanently failing parent/node advances the cursor.
- A resolved wait's recorded terminal order is validated and reused. Recovery
  never recomputes it. A stable host-only resolution event ID, backed by the
  existing unique event key, prevents duplicate history after concurrent repair
  or a lost commit acknowledgement. Exact legacy resolution events are accepted.
- Parent resumes contend through the existing invocation-claim owner. The key
  identifies the scheduler snapshot and latest suspension event for every
  suspended node, so simultaneous host waits share one parent generation while
  a later wave on the same node gets a fresh generation even at the same
  timestamp. The queued callback re-reads the current row before execution.
  A crashed claimant retries after the existing dispatch lease expires.
- Durable wait correlation includes the prior dispatched children. Re-invocation
  restores their output mappings before folding the waiting wave, preserving
  later-wave collision precedence. The durable resolved interrupt supplies a
  missing variable marker. Malformed correlations, incomplete/duplicate joins,
  out-of-range decisions and mismatched worker populations refuse instead of
  silently completing or creating replacement children.

This is an at-least-once recovery mechanism, not a claim of exactly-once external
effects. The existing lease has no renewable owner token: an executor stalled
beyond the lease can overlap a retry. General human-gate cross-instance resume
serialization and single-child subworkflow waits remain outside this repair.
Tenant identity is checked when following child rows; no human route acquires
authority to submit a host join.

Authored witnesses cover publication-before-wakeup loss, resolution-before-queue
loss, a reopened file-backed database with missing cached/durable marker and
prefix writes, poison-row pagination, independent-connection generation claims,
equal timestamps, concurrent history append with a commit-then-throw fault,
atomic waiting snapshots, invalid decision identity, storage query parity and
an independently progressing sweeper lane. These new checks have **not run**;
the resource-bounded canonical gate for the preceding batch owns the sole test
slot. The original three route cases and historical sabotage table above are
not evidence that the recovery cases pass.
