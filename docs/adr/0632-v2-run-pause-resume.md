# ADR 0632 — Run pause and resume (`runs.md` §Pause and resume)

Status: Accepted — implemented 2026-09-05 (this PR); corpus pin moved rc.45 → rc.51 in the same change

## Context — measured

`spec/v2/path-manifest.json` lists `POST /runs/{runId}:pause` and
`POST /runs/{runId}:resume`; `runs.md` §Pause and resume makes them MUSTs.
This host had **no route for either** — the corpus steward's rc.48 witness
answered `403 id_tenant_mismatch` on `:pause` for a bound id (crosstalk
`4f74`), which #3650 turned into the honest `404 not_found`. The event
vocabulary already exists: `run.paused` (payload `{ reason?, drainPolicy? }`)
and `run.resumed` are registered in `schemas/v2/run-event*.json`, and this
host already emits `run.resumed` (HITL resume re-enters through
`executeRun`). It has never emitted `run.paused`; `paused` today is only the
status a cancellation cascade assigns to a suspended child.

Two corpus facts found while designing, raised on the bus:
- `api/v2/openapi.yaml` spells `drainPolicy` as `immediate` |
  `drain-current-node`; the registered `run.paused` payload's enum is `drain`
  | `interrupt` (closed, `additionalProperties: false`). This host maps
  `drain-current-node → drain`, `immediate → interrupt` on the event so the
  emitted payload VALIDATES, and records the request's spelling on the run.
- `409 run_state_conflict` (second pause; resume of a non-paused run) is
  registered only from rc.49, so this PR carries the rc.50 pin.

## Decision

1. **A pause is a durable request, not a state flip.** `POST …:pause`
   validates `{ reason?, drainPolicy? = drain-current-node }`, refuses
   terminal runs (`409 run_terminal`) and already-paused runs
   (`409 run_state_conflict`, `details.runStatus`), then persists
   `metadata.pauseRequest = { reason, drainPolicy, requestedAt }` and answers
   `202 { runId, status: 'paused', pausedAt? }` — the REQUESTED state, as the
   contract says ("transition emits `run.paused` when complete").
2. **The scheduler honours the request at its dispatch point.** Before
   launching any ready node, `executeRun` re-reads the request; if present it
   launches nothing more and, once no node is in flight, transitions the run:
   status `paused`, `pausedNodeIds` = the ready set, `run.paused` appended,
   dispatch lease released. A run that is `pending` (never dispatched) or
   `waiting-*` (nothing in flight) transitions in the route itself.
3. **`immediate` = drain + the abort signal cancel already uses**
   (`armRunAbort`), without the terminal status: an aborted node is recorded
   as suspended-by-pause and re-executed on resume (idempotent per the
   Layer-2 invocation log, `replay.md`).
4. **Resume re-enters through `executeRun`**, the same path HITL resume
   uses: `POST …:resume` refuses a non-paused run (`409 run_state_conflict`),
   clears the request, and `executeRun` emits `run.resumed`, sets `running`,
   and drains from the ready set. `202 { runId, status: 'running', resumedAt? }`.
5. **Replay folds both events as no-ops** for projected state (§Pause: "A
   replay MUST fold `run.paused` and `run.resumed` as no-ops"), pinned by a
   test against the event-fold used by `:fork`.
6. Both routes ride the `:`-suffixed regex mount the host uses for `:fork` /
   `:diff`, are v2-mounted via the negotiator, and share the run authz seam
   (`loadOwnedRun`, scope `runs:cancel` per the openapi).

## Alternatives weighed
- *Pause as an interrupt kind* (reuse `suspendManager`): tempting, but an
  interrupt is workflow-driven and resolved with a value; pause is
  operator-driven and resumed by the scheduler. Conflating them would put
  operator state on the interrupt token surface. Rejected.
- *Pause = cancel + fork on resume*: loses run identity and the `paused`
  status the contract names. Rejected.

## Phases
| Phase | What | Witness |
|---|---|---|
| P1 | routes + request persistence + immediate transition for pending/waiting runs | route test: 202/409/409, `run.paused` in the log |
| P2 | scheduler drain point + abort-on-immediate + `pausedNodeIds` | slow-node fixture: drain lets the node finish; immediate aborts it |
| P3 | resume via `executeRun` | route test: `run.resumed`, status `running`, aborted node re-executes once |
| P4 | replay fold no-op + corpus pin (rc.51 — rc.50 and rc.51 were both installable by the time this landed) | a `mode:'replay'` fork of a paused+resumed run completes with no `run.paused`/`run.resumed` in the child |

## Open questions
- Whether `waiting-*` runs may be paused (the contract says "otherwise
  unpausable MUST 409"; this ADR pauses them — an interrupt can still be
  resolved later) — to be confirmed with the corpus.

## Implementation record (2026-09-05)

All four phases shipped in one PR (`v2-run-pause-resume`). Witness: `backend/typescript/test/v2-run-pause-resume.test.ts`
(7 legs: terminal → `409 run_terminal`; `immediate` → `202` + in-flight node aborted + `run.paused{drainPolicy:'interrupt'}`
+ **no `node.failed` in the history**; second pause → `409 run_state_conflict` + `details.runStatus`; `drain-current-node`
→ `run.paused` strictly after `node.completed` with `drainPolicy:'drain'`; resume of a running run → `409 run_state_conflict`;
resume of a paused run → `202 {status:'running'}` + `run.resumed` + the interrupted node re-executes + exactly one
`run.completed`; **replay fork** of a paused+resumed run → child completes, child log carries neither event). Every leg was
proven load-bearing by sabotage: (A) executor pause check removed → 4 red; (B) `ctx.signal` unwired → the `immediate` legs
red (immediate silently degrades to drain); (C) route state-conflict check removed → 1 red; (D) the `interrupted` outcome
removed → 3 red (immediate, resume, replay fork).

Three things the draft above did not know, found while building the witness — recorded here because each is the kind of
defect the next reader would otherwise re-discover:

1. **`ctx.signal` did not exist on the node context.** `executor.ts` handed the run abort signal only to the MCP client
   deps (`McpClientDeps.signal`, ADR 0553 P3); `NodeContext` had no `signal` at all, so no node body could ever observe a
   cancel or an immediate pause. `NodeContext.signal?: AbortSignal` is now set from `runAbortSignal(run.runId)` at the ctx
   literal, and `core.delay` races its timer against it (duck-typed — a harness ctx without the listener API falls back to
   the plain timer). Sabotage B is the witness that this wiring, not the route, is what makes `immediate` immediate.
2. **An attempt aborted by a pause is NOT a failure — and recording it as one is replay poison.** The first cut let the
   generic `outcome.status === 'failure'` path append `node.failed(run paused)` before the scheduler's pause branch ran.
   The run still paused and resumed correctly, so six legs were green; the seventh (a `mode:'replay'` fork) failed:
   the child folded `node.failed` at face value, dead-lettered and emitted `replay.diverged`. `runOneNode` now returns a
   distinct `{ kind: 'interrupted' }` (no event, no invocation record) when `runPauseRequest(runId).abortedAt` is set, and
   the scheduler moves the node back to `ready`. The resumed run emits its own `node.started`/`node.completed`.
   `runs.md` says a replay MUST fold `run.paused`/`run.resumed` as no-ops; the fold at `executor.ts` ~1331 is an if-chain
   over node-level types, so both fall through untouched — the fork leg pins that rather than trusting the reading.
3. **The witness first passed run inputs under the key `input`.** The host tolerates it (no 400) but does not feed the
   variable bag from it, so `conformance-cancellable` slept its 30 s default and every leg timed out with the delay node
   "never completing". The key is `inputs`. Two hours of the wrong hypothesis (the delay node, the abort key) came from this.

**Folded in from the bus (same PR):** `cea0` — under major 2 a bulk-cancel `ok:false` entry's `error` is the v2 ERROR
ENVELOPE (`{ error, message, details? }`, code through `v2ErrorCode`), and an already-terminal run is `ok:false` +
`run_terminal` + `details.status` (the bulk twin of #3650's single-cancel 409); v1 keeps `{ code, message }` and its
idempotent `ok:true`. `4024` — `events.md` §Stream modes: under major 2 a `values` stream is ONE synthesized `state.snapshot`
frame (the run GET's projection, ids bound) per `updates`-tier transition, never the raw event, and a `Last-Event-ID`
resumption emits a snapshot FIRST (id = the resumption point); writes are serialized and a terminal close waits for the
chain. v1 `values` is untouched (`test/v2-sse-values-snapshot.test.ts`, sabotage E: switch off → 2 red, v1 leg green).

**Corpus mismatch, still open upstream:** `api/v2/openapi.yaml` spells the REQUEST `drainPolicy` as
`immediate | drain-current-node`; the `run.paused` payload registry spells it `drain | interrupt`. This host accepts the
OpenAPI vocabulary on the wire and emits the registry vocabulary in the event (`drain-current-node → drain`,
`immediate → interrupt`). Raised on the `v2` bus; if the corpus unifies the two, only `pauseRun`'s mapping table changes.

> **CORRECTION 2026-09-05 (bus `b787`, rc.52):** the mismatch above was ruled upstream — the REQUEST vocabulary wins.
> The `run.paused` payload now ECHOES the accepted word (`immediate | drain-current-node`); the registry's
> `drain | interrupt` was an invented vocabulary with a false v1 citation and is removed at rc.52. This host's mapping
> table is gone. The same ruling confirmed the interrupted-attempt shape: no terminal node event for the cut attempt is
> the intended reading (a MUST NOT at rc.52), and the record of the interruption is `run.paused` itself, whose payload
> MAY carry `interruptedNodeId` — emitted here from the scheduler's `interrupted` branch.
