# ADR 0532 — implement RFC 0053: the run-level dead-letter sink

Status: implemented (2026-08-08)

## Context

RFC 0053 (`Accepted`, 2026-05-25) defines a **run-level** dead-letter sink: a
run that dies terminally emits `run.dead_lettered { runId, nodeId?, reason,
attempts }`, lands in a durable inspectable sink, and stays **fork-eligible**
(RFC 0011) so it can be examined and re-run after the cause is fixed.

This host had not implemented it. We advertised only
`queueBus.deadLetterSupported` — which RFC 0053 §Summary explicitly
distinguishes ("dead-letters *queue messages*, not *runs*") — so a terminally
failed run produced a `run.failed` event and nothing else.

That is a reference-host credibility problem as much as a functional one: the
RFC reached `Accepted` on a **peer's** implementation (MyndHyve
workflow-runtime, 28/28 conformance across RFCs 0045–0053, curl-verified
2026-05-25). The reference application was behind an Accepted RFC that a
production peer already honored.

No RFC is needed for this work: RFC 0053 is already Accepted, and both schemas
(`run.dead_lettered` in `run-event-payloads.schema.json`, `deadLetter` in
`capabilities.schema.json`) are already vendored here. This is host work riding
an accepted wire (`CLAUDE.md` § "A spec change needs an RFC").

## Decision

Emit `run.dead_lettered` from `executor.emitTerminalFailure` and advertise the
capability.

`emitTerminalFailure` is the **single** terminal-failure choke — verified, not
assumed: `finalizeRun`'s `disposition.status === 'failed'` branch delegates to
it, as do the drain-loop stall path, the dispatch sweeper, and `runDispatch`.
So one insertion point covers every way a run can die, with no drift surface.

Three decisions are load-bearing.

### 1. Ordering — the sink row precedes the terminal event

`run.dead_lettered` is appended **between** `node.failed` and `run.failed`, not
after. `observability.md` §"Terminal events" requires the terminal event to be
the **last** event in the stream — the same constraint that already forces the
RFC 0004 memory write to precede `run.completed` in `finalizeRun`. Appending
after `run.failed` would have violated the contract and reddened
`executor-terminal-failure.test.ts`. Pinned by an explicit
`events[events.length - 1].type === 'run.failed'` assertion.

### 2. Emitted for EVERY terminal failure, not only retry-exhausted nodes

RFC 0053 §C.1 phrases the trigger as retry exhaustion, but ties the outcome to
terminal status ("the run's terminal `RunSnapshot.status` reflects failure"),
and its motivation is that *a poisoned run be inspectable and re-forkable*.
Restricting emission to nodes that happened to declare `config.retry` would
miss most real failures and make the capability near-useless — the sink would
be empty precisely when an operator went looking. `attempts` reports the truth:
`1` when no retry was configured, the real count when one was.

### 3. `reason` is the CLASSIFIED message, never `error.message`

RFC 0053 §C requires a redaction-safe reason. The raw provider string is not
safe: the executor's own pre-existing comment at this seam warns that
provider-side strings "occasionally echo BYOK keys", which is why the failure
*notification* already uses `classified.userMessage`. The dead-letter row makes
the same choice, and `dead-letter-rfc0053.test.ts` proves it by throwing an
error containing key-shaped material and asserting it does not reach the row.

### `retentionDays` is omitted, not fabricated

Run retention is operator opt-in (`OPENWOP_RUN_RETENTION_DAYS`) and **defaults
to disabled**, so by default nothing is ever purged and there is no deadline to
advertise. The advert is derived at runtime from `defaultRetentionDays()` — the
**same function the retention sweeper reads**, so advert and behavior cannot
drift (the `restTransport.contentEncodings` honest-witness precedent) — and the
field is omitted entirely when that returns 0. The schema's `minimum: 1` makes
omission the only honest encoding of "no purge deadline exists".

### A separate `deadLetterNodeId` parameter

`emitTerminalFailure` appends a `node.failed` when given `nodeId`. By the time
`finalizeRun` dead-letters a drained run, the failing node has *already* emitted
its own `node.failed`, so reusing `nodeId` to attribute the sink row would
duplicate that event. `deadLetterNodeId` attributes without re-appending.

## Alternatives weighed

- **Emit from `finalizeRun` only.** Rejected: misses the stall path, the
  dispatch sweeper, and `runDispatch`, all of which reach terminal failure
  without passing through it.
- **Emit only on retry exhaustion.** Rejected — see decision 2.
- **Advertise a default `retentionDays` (e.g. 30).** Rejected as a dishonest
  advert: nothing purges at 30 days when retention is disabled.

## Wire posture

No new wire. RFC 0053 is Accepted and both schemas are vendored. The capability
advert is `capabilities.deadLetter` — note the RFC's prose says
`host.deadLetter`, but that is the capability **family** name;
`capabilities.schema.json` places `deadLetter` and `queueBus` as top-level
properties. The tests assert the schema's actual shape rather than the RFC's
shorthand.

## Residue

- **No purge implementation for dead-lettered runs specifically.** RFC 0053 §C.3
  requires purge after `retentionDays`; today dead-lettered runs are purged by
  the generic terminal-run sweeper on the same schedule as any other terminal
  run, and only when the operator enables it. Because we omit `retentionDays`
  when retention is off, the advert stays honest — but a host that enables run
  retention gets RFC 0053 §C.3 behavior by coincidence rather than by a
  dead-letter-specific policy. A separate retention class for dead-lettered runs
  (keep them *longer* than ordinary terminal runs, which is what an operator
  actually wants) is the natural follow-up.
- No `GET` surface listing dead-lettered runs. The event log + the existing run
  list carry it; a dedicated sink view is a UI question, not a protocol one.

## Phase record

| Phase | Work | Test |
|---|---|---|
| A | `run.dead_lettered` from `emitTerminalFailure`, ordered before `run.failed` | `dead-letter-rfc0053.test.ts` §emission, §ordering |
| B | `attempts` threaded from the drain loop's `nodeAttempts` via `finalizeRun` | §"counts real attempts when the node declares config.retry" (asserts 3) |
| C | Redaction-safe `reason` | §"reason is redaction-safe" (key-shaped material must not appear) |
| D | Fork-eligibility (RFC 0053 §C.2) | §"stays FORK-ELIGIBLE" |
| E | Honest capability advert, `retentionDays` omitted when retention is off | §"the capability advert is honest" |
| F | Existing terminal-sequence contract updated for the new event | `executor-terminal-failure.test.ts` |

## Conformance witness (2026-08-08)

The suite already ships RFC 0053 scenarios, so this host's implementation has an
**external** witness, not only its own tests. Taken with the app's own harness —
`npm run test:conformance -- --filter deadletter` — against the **pinned
published artifact `@openwop/openwop-conformance@1.64.0`**, so the witness is
reproducible by anyone on the same pin rather than resting on a working-copy of
the spec repo (2 files / 4 tests, matching the two dead-letter scenario files
exactly):

| Scenario | Result |
|---|---|
| `deadletter-capability-shape.test.ts` — `capabilities.deadLetter` absent or well-formed | PASS |
| `deadletter-capability-shape.test.ts` — `retentionDays` is an integer ≥ 1 when present + supported | PASS |
| `deadletter-retry-exhaustion.test.ts` — a retry-exhausted run emits `run.dead_lettered` with `attempts` | PASS |
| `deadletter-retry-exhaustion.test.ts` — the dead-lettered run is fork-eligible (RFC 0011) | PASS |

**4 passed / 0 skipped / 0 failed** — non-vacuous, which matters here: before
this change the capability was absent, so all four would have skipped or passed
trivially. The second row is the one that would have caught a fabricated
`retentionDays`; we omit the field, and the scenario accepts omission.
