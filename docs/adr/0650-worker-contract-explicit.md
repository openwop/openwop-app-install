# ADR 0650 — background workers enter the event seat under a named contract

Status: Accepted (implemented; see § Implementation record)

## Context

ADR 0642 named `storage/eventEraAdapter.ts currentContract()` — *"the ambient
contract, or `1` — the v1 wire and every background worker"* — as one of the
four structural layers of this host's major-1 reliance. The request side of it
is deliberate: the negotiator enters every request under its negotiated major
(`runUnderContract(major, next)`). The worker side was not: every daemon,
sweeper, the webhook delivery worker, and the executor when it resumes a run
from a timer reached the seat by falling through `?? 1` — an ambient default
no worker chose, and one a test cannot tell apart from a request that forgot to
negotiate. Ten interval workers touch storage (six in `src/host`, four in
`src/features`), measured by walking every `setInterval(` owner.

Nothing was wrong today. What was wrong was the December shape: flipping the
default would have changed the vocabulary every worker reads under, silently,
with no enumeration of which readers were affected.

## Decision

1. **`WORKER_CONTRACT`** is exported from `eventEraAdapter.ts` — `1` today,
   documented as a decision about the workers' readers, not about the wire
   (ADR 0642 § atomicity does not bind it).
2. **`runUnderWorkerContract(fn)`** is the only intended non-request entry to
   the seat. Each of the ten workers wraps its interval tick in it. Explicit
   beats ambient: a worker entered from inside a major-2 request context still
   reads as a worker (pinned by test).
3. **`currentContract()`'s `?? 1` stays, and is now documented as a fallback
   that should be unreachable** — the negotiator covers requests, the ratchet
   covers workers.
4. **A ratchet enumerates the readers.** `test/worker-contract-explicit.test.ts`
   fails, naming the file, on any file under `src/host`, `src/features`,
   `src/executor` that schedules a `setInterval` and touches storage without
   entering the seat explicitly. It floors its candidate count at 10 so it
   cannot pass by finding nothing.

No behaviour changes: `WORKER_CONTRACT` is the value the fallback already
produced.

## Alternatives

- **Flip the default to 2 now.** Rejected: that changes what every worker reads
  before anyone has verified the readers against the v2 vocabulary — the
  silent-data-defect class a peer host hit this week when a major-2 create
  flipped a run's era under readers matching vendor event names by literal.
- **Wrap only the two workers that name run-event calls.** Rejected: the
  executor's resume path reads events from inside `timerSweepDaemon` and
  `runDispatchSweeper` without the daemon file mentioning them; the seat is
  entered by the tick, so the tick is what must declare.
- **Leave it for December.** Rejected: an enumeration is worth more before the
  deadline than during it.

## Implementation record

| what | where |
|---|---|
| `WORKER_CONTRACT`, `runUnderWorkerContract` | `backend/typescript/src/storage/eventEraAdapter.ts` |
| 6 host workers | `src/host/{timerSweepDaemon,runDispatchSweeper,webhookDeliveryWorker,retentionSweepDaemon,heartbeatService,scheduleDaemon}.ts` |
| 4 feature workers | `src/features/{cdp/segmentEntryDaemon,connections/refreshDaemon,ambient-work-graph/workGraphSweep,cms/publishSweep}.ts` |
| ratchet + units | `backend/typescript/test/worker-contract-explicit.test.ts` |

`tsc` clean; ratchet 3/3; sabotage (unwrapping `scheduleDaemon`) reddens it
naming `src/host/scheduleDaemon.ts`; daemon regression 7 files / 38 tests green.
