# ADR 0535 — a picked card's lifecycle is owned: stranded-work recovery

Status: implemented (P1–P4, 2026-08-08)

Composes: [ADR 0311](0311-agent-commitment-todos-conversation-approvals.md) (commitment
todos), [ADR 0313](0313-activate-the-autonomous-work-loop.md) (the work loop),
[ADR 0532](0532-run-level-dead-letter-rfc0053.md) (run-level dead letter).
Sibling: [ADR 0534](0534-agenda-compiler-ranked-work-selection.md) (which card gets picked).
See also [ADR 0536](0536-liveness-gated-sweeper-escalation.md) — the rejected third port,
and why the liveness lesson lands *here* rather than on the run sweeper.

## Context

The autonomous work loop picks a To Do card and moves it to Working:

- `host/heartbeatService.ts:202` — `if (working) await moveCard(card.id, working.id);`
- `host/approvalDecision.ts:545` — the same move on the approved-proposal path.

**Nothing ever moves it back out.** Measured, not assumed:

| Probe | Result |
|---|---|
| Any module reacting to `run.failed` / `run.dead_lettered` by touching a card | **none** — the only two consumers are `host/mcpServerRouter.ts:536` (MCP error surfacing) and `host/workforceHistory.ts:286` (history projection) |
| Any module reacting to `run.completed` by touching a card | **none** — every `run.completed` hit in `src/host/**` is a duration or projection read (`agentActivity.ts:85`, `runDiagnoseTool.ts:138`) |
| Modules importing `kanbanService` | 21 — none is a run-lifecycle reactor |

So the card's post-pick lifecycle is **unowned on every outcome**, not just on failure. The
implicit contract is "the workflow moves its own card" — reachable via the
`host.kanban` surface's `moveTask` (`host/kanbanSurface.ts:257-265`) — but nothing
enforces it, nothing supplies it, and it is unreachable by construction for the ADR 0313 D2
**bare-card agent-turn fallback**, which runs a generic turn workflow that knows nothing
about the card that summoned it.

Consequences today:

1. **Work is silently lost.** A card whose run dies terminally (including one the dispatch
   sweeper correctly abandoned, or ADR 0532 dead-lettered) sits in Working forever. The run
   recovers — `runDispatchSweeper` re-dispatches orphans idempotently and dead-letters the
   chronically stuck — but the *work item* never returns to the pick path. The agent will
   never look at it again.
2. **The board lies.** Working accumulates cards nothing is working on, and the To Do lane —
   the loop's entire input — under-reports real outstanding work.
3. **It is invisible.** There is no error, no event, and no metric. The failure mode is a
   board that quietly stops representing reality.

Prior art solves the same problem with an explicit claim lease: a claim
released `abandoned` rolls its job back `applying → approved`, and an expired claim returns
the work to the agenda (an explicit claim service).

## Decision

**Give the picked card an owner for its whole lifecycle, by observing the run's terminal
outcome — not by giving the card its own lease.**

### D1 — Observe, do not lease (the "port, not clone" correction)

That prior art needs a claim TTL because its worker is a **separate process on a user's laptop**
that can vanish without a trace; nothing else knows the work stopped. This host is not in
that position: the run already carries a dispatch lease
(`RUN_DISPATCH_LEASE_MS`, `executor/executor.ts:139`), an atomic multi-instance orphan claim
(`storage.claimOrphanedRuns`), a crash-recovery sweeper (`host/runDispatchSweeper.ts`), and
a terminal-failure choke (`emitTerminalFailure`).

Adding a second TTL lease on the card would stand up **a parallel liveness system for one
lifecycle**, which `ARCHITECTURE.md` names as the worst outcome ("two systems for one
concept: they drift and disagree"). The run owns liveness; the card **observes** it.

This is where the liveness lesson legitimately lands — see ADR 0536 for why it does
*not* land on the run sweeper.

### D1a — The seam already existed; extend it, and back it with a reconciling read

*(Added at P1, architecture review 2026-08-08.)* `executor/runLifecycle.ts` already owned
"a run reached terminal" — `onRunTerminal(runId, fn)` / `notifyRunTerminal(runId)` — and was
**already called on all three terminal paths**: `executor.ts:237` (failed, inside
`emitTerminalFailure`), `executor.ts:1768` (completed), and `routes/runs.ts:797/836/872`
(cancelled, including cascaded children). Standing up a `host/runTerminalLifecycle.ts` beside
it would have been a second owner of one concept. **P1 therefore extends that module** with a
global keyed subscription (`onAnyRunTerminal`) rather than adding a sibling seam, keeping the
existing per-run path synchronous because the rate limiter's slot release depends on it.

**The fan-out is in-process, so it is not a delivery guarantee.** A process that dies inside
the terminal-emit window fires nothing on any instance, and the card would strand exactly as
it does today. The backstop is deliberately *not* a new sweeper — that would cost the
cross-tenant `DurableCollection.list()` scan ADR 0534 D5 budgets against. Instead the
**heartbeat pass reconciles lazily**: `runHeartbeatOnce` already calls `listCards(board.id)`,
which returns the Working lane too, so the in-flight cards are already in hand at zero extra
scan cost. Restoring any whose `lastRunId` resolves to a terminal run turns the residue from a
permanent strand into a bounded lag of at most one heartbeat interval. This is folded into
**P2**, not a separate phase — it is the same handler reached from a second trigger, and
splitting it would let the event path ship claiming a guarantee this ADR states but does not
yet hold.

### D2 — One handler at the single terminal choke, keyed-registry style

ADR 0532 established (verified, not assumed) that `emitTerminalFailure` is the **single**
terminal-failure choke: `finalizeRun`'s failed branch, the drain-loop stall path, the
dispatch sweeper, and `runDispatch` all delegate to it. Terminal *success* funnels through
`finalizeRun` alongside it.

Register **one** handler for run-terminal transitions, following the keyed-registry
lifecycle-seam contract already used by `onProductDeleted` / `onCrmRecordDeleted` /
`onRosterMemberDeleted` (`ARCHITECTURE.md` § Existing extension seams): keyed registration
so repeat boots overwrite rather than accumulate, idempotent bounded handler, best-effort
fan-out fired **after** the run's own state is settled.

`executor/` already imports from `../host/` (21 sites), so no new indirection is needed for
layering — but the registry is still preferable to a direct `executor → kanbanService`
import, which would couple the executor to a product surface it should not know about.

Disposition taxonomy (ADR 0288 established PRUNE / DISABLE / TOLERATE-ON-READ); this adds a
fourth: **RESTORE** — return an unowned work item to the lane it was claimed from.

### D3 — The guard is `lastRunId`, not the column

Restore only when **both** hold:

```
card.columnId === <the Working column it was moved to>
  && card.lastRunId === <the run that just went terminal>
```

`card.lastRunId` is already stamped at pick time (`setCardLastRun`,
`host/heartbeatService.ts:197` and `host/approvalDecision.ts:542`), so no new field is
needed. This one guard buys four properties at once:

- **Idempotent.** A run that emits `run.failed` and then `run.dead_lettered` restores once;
  the second pass sees the card already back in To Do.
- **Race-safe.** A card manually moved on, or re-picked with a newer run, has a different
  `lastRunId` — a stale run's death cannot yank it.
- **Fork-safe.** A `:fork` gets a **new** `runId`, so a forked run's terminal event can never
  re-trigger the original card's restore. No run metadata and no replay stamp are required —
  the guard is inherently fork-correct. (Contrast ADR 0534, which *does* need a stamp.)
- **Non-adversarial.** A workflow that correctly moves its own card via `moveTask` has
  already changed `columnId`, so the handler no-ops. This fix **cannot** fight a
  well-behaved workflow — it only fills the gap the convention leaves.

### D4 — Restore with a reason, and fail safe

On a **failed / dead-lettered** run: move the card back to the column it was picked from
(To Do) and record why on the card — reuse the existing `blockerNote` field
(`host/kanbanService.ts:106`) rather than adding one. The note carries the run's error code
and runId so the board explains itself.

*Verified render (architecture review 2026-08-08):* `blockerNote` is user-visible at
`frontend/react/src/agents/AgentDrawer.tsx:201`, in the waiting-card display. An earlier
draft of this ADR said it was "already surfaced as a Blocked chip" — that phrasing came from
the field's own code comment, not from any render, and was not checked. The decision stands
(the field reaches a human), but P2 should confirm the restored card's note is visible on the
surface a board user actually looks at, and add the render if it is not.

On a **cancelled** run: restore the card, but **without** a `blockerNote`. *(Correction,
P1 architecture review 2026-08-08: this case was missing — D4 originally enumerated only
failed and completed. A user-cancelled run's work was never done, so the card must return to
the pick path; but writing a failure note would misreport a deliberate human action as a
fault.)* The seam carries the terminal status precisely so a consumer can tell the three
apart — `notifyRunTerminal(runId, status)`.

On a **completed** run: leave the card in Working and do nothing. Completion semantics are
the workflow's to declare — a run finishing does not mean the task is done — and
auto-advancing to a terminal lane would silently close work the human never accepted. What
this ADR fixes is *unowned* cards, not *unfinished* ones. Recorded as OQ-1.

The handler is **best-effort and fails safe**: if the restore throws, the card stays in
Working, which is exactly today's behavior — degraded, never worse. Log at `warn`; never let
it fault the terminal path (the ADR 0532 ordering rule: the run's own terminal state must
land regardless).

### D5 — No toggle

This is a correctness fix to a core seam, not a product feature. A toggle here would mean
"lose work in the OFF bucket," and there is no coherent reason a tenant would opt out of
getting its own cards back. No `src/features/` package, no `toggleDefault`, no bucket unit.

## Alternatives weighed

| Option | Verdict |
|---|---|
| **Card TTL lease + prune sweeper** (the literal the prior art port) | Rejected — D1. A second liveness system for one lifecycle; new field, new sweeper, new prune, and a migration to undo it. |
| **Fix inline at both `moveCard` call sites** | Rejected — two sites drift; a fix applied to `heartbeatService` and forgotten in `approvalDecision` is a bug that reads as fixed. One handler, one contract. |
| **Require every workflow to move its own card** | Rejected — unenforceable, and structurally impossible for the ADR 0313 D2 bare-card fallback, which is the exact path most likely to strand a card. |
| **Emit a notification instead of restoring** | Rejected as the primary fix — it converts silent loss into noisy loss. Worth composing later (OQ-2), but the board must first be true. |
| **Restore on a timer (card sitting in Working > N)** | Rejected — reintroduces a fixed timeout with no liveness signal, the exact mistake ADR 0536 documents. The run's terminal event *is* the signal. |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | Extend `executor/runLifecycle.ts` (the existing owner) with a global keyed `onAnyRunTerminal` + async best-effort fan-out; widen `notifyRunTerminal(runId, status)` across its 5 call sites. No consumers yet. | Unit: registration overwrite on repeat boot; a throwing handler cannot fault the terminal path. |
| **P2** | The kanban consumer: RESTORE on terminal failure, guarded per D3, with the `blockerNote` reason per D4. | Unit: restore happens; no-op when `lastRunId` differs; no-op when the workflow already moved the card; idempotent across `run.failed` → `run.dead_lettered`; a forked run does not restore the origin card. |
| **P3** | Cover the approval path (`approvalDecision.ts:545`) through the same handler, and a route-level test proving both entry points recover. | Route test: pick → kill the run → assert the card is back in To Do with a reason, for **both** the heartbeat and approved-proposal paths. |
| **P4** | A tripwire test asserting every `moveCard(→ working)` call site is covered by the handler, so a third entry point cannot be added silently. | The `subject-erasure-coverage` precedent: enumerate call sites, fail the build on an uncovered one. |

## Implementation record

| Phase | Commit | Verification |
|---|---|---|
| **P1** — extend `executor/runLifecycle.ts` with `onAnyRunTerminal`; widen `notifyRunTerminal(runId, status)` | `e75e3642e` | `test/run-terminal-lifecycle.test.ts` (7) |
| **P2** — `host/cardRunRecovery.ts` restore + lazy heartbeat reconcile | `a8aa6e99e` | `test/card-run-recovery.test.ts` (13) |
| **P3** — boot-wiring proof | `b95bb0d3a` | `test/card-run-recovery-boot.test.ts` (3) |
| **P4** — no-uncovered-pick-site ratchet | `b95bb0d3a` | `test/card-run-recovery-coverage.test.ts` (3), sabotage-verified |

**P3 found a real defect rather than confirming the design.** `registerCardRunRecovery`
was registered beside the daemons in `main()`, which runs only when the module is the
process **entry point** — so recovery was inert for every `createApp` embedder and every
test, while P2's unit tests stayed green. Moved into `createApp`. This is why the phase
exists: a handler test cannot see an unwired handler.

**P4 was sabotage-verified.** A probe file that imported `moveCard`, parked a card in
Working, and stamped no pointer turned both guard tests red; it was then deleted. A guard
nobody has made fail is not evidence it guards anything.

## RFC verdict

**Host work, no RFC.** No wire surface is touched: no run-event field, no capability flag,
no endpoint contract, no normative MUST. `run.dead_lettered` and `run.failed` are consumed
as already-Accepted events (RFC 0053, implemented by ADR 0532); kanban cards are a
host-extension concept under `/v1/host/openwop-app/kanban/*` and are not on the wire at all.

Nothing new is advertised at `/.well-known/openwop`, so the advertise/enforce honesty rule
is untouched.

## Open questions

- **OQ-1 — completion semantics.** D4 deliberately leaves a completed run's card in Working.
  Should a run that completes advance the card to the board's terminal lane when the
  workflow declares success, and if so, how does a workflow *declare* "the task is done" as
  distinct from "the run finished"? This is a real product decision, not a defaulting one.
- **OQ-2 — notify on restore.** Should a restored card ping the agent's escalation contacts
  (the ADR 0493 path already used for proposals in `host/heartbeatService.ts`)? Leaning yes
  for repeat restores of the same card (a card restored 3× is a workflow bug, not a blip),
  no for the first.
- **OQ-3 — restore-loop damping: RESOLVED by handoff (architecture review 2026-08-08).**
  A card whose workflow deterministically crashes will be restored, re-picked, and crash
  again. That is a **selection-policy** question, not a recovery one, so it is owned by
  [ADR 0534 OQ-4](0534-agenda-compiler-ranked-work-selection.md) — one owner, not two. This
  ADR restores unconditionally; whether a restored card is then *deprioritized* is 0534's
  call. Note the ordering consequence: until 0534 lands, damping is whatever the ADR 0313 run
  budget (`checkAutonomousRunBudget`) already provides. If that proves insufficient in
  practice before 0534 ships, the fix is to accelerate 0534, not to grow a second damper here.

## Port-vs-architecture corrections (what changed from the prior art original)

1. **Claim lease → run-terminal observation** (D1). Their orchestrator is a separate process
   that can vanish; ours is not. Porting the lease verbatim would have duplicated liveness.
2. **Agenda-version snapshot → nothing** — not needed here; see ADR 0534 D4 for why the same
   reasoning kills the snapshot on the selection side too.
3. **Explicit `abandoned` release outcome → the `lastRunId` guard** (D3). the prior art needs a
   typed release verb because the agent reports its own outcome. Here the run's terminal
   state is authoritative and already recorded, so the guard replaces the vocabulary.
