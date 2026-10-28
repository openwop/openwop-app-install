# ADR 0988 — Host-event internal repair: what ADR 0973 left (gap-closure B3)

Status: Accepted (2026-10-27, user; all recommendations). Originally: Proposed. Drafted 2026-10-26 at the user's request as the decision record that Wave B item B3 of [ADR 0970](0970-platform-competitive-gap-closure-program.md) waits on. It measures what [ADR 0973](0973-rfc0250-host-event-replay.md) (RFC 0250, implemented and live) already delivers against B3's witness and proposes decisions only for the remainder. Nothing here is accepted until the user accepts it. No code has changed.

Date: 2026-10-26. Plan: [section 04](../plans/platform-gap-closure-2026-10-24/04-host-event-durability-and-resync.prd.md), requirements **S04-R1–R3 (EVENT-01)**, witnesses **S04-T1** and **S04-T2**, planning question **S04-G2**. Source snapshot: `origin/main` at the time of drafting (ADR 0981 P3 merged, `9ff1b1e94`).

**RFC verdict: host-only, no RFC.** Every change proposed here sits behind the existing wire. RFC 0250 itself says "fixing storage and large-event fan-out is host work under the existing contract" (RFC 0250 §Motivation). Its one rule for requests without `replay=required` is "unchanged behaviour, including today's unknown-cursor answer" (§Examples and §Conformance, leg `0250.legacy-unchanged`). D1 below keeps that answer. Nothing here changes what RFC 0250 governs: the `hostEvents.replay` facet, the `replay=required` path, the `409 host_event_resync_required` refusal, or its retention floor. RFC 0250 and ADR 0973 belong to session 6a. This ADR proposes no edit to either.

## Context: B3's witness against what is live

B3, as the plan states it: "Existing host event storage/ref publication repair — large event A→B and fresh-process retained replay; ephemeral remains absent." Its witnesses are S04-T1 (a large durable event emitted on instance A arrives on instance B with the same `eventId`, no local-only fallback; "two routed processes", "actual production pubsub/storage") and S04-T2 (a fresh process replays the retained durable backlog without ephemeral frames; "real DB; restart cannot be inferred from a mock").

ADR 0973 went live as `f94471e98` on rev `01034-r5h` (2026-10-25). Cut 217c certified its six `0250.*` legs and `scenario.v2-host-event-strict-replay` as `executed-pass`. Measured in code:

| B3 element | Status | Evidence |
| --- | --- | --- |
| A durable, tenant-scoped log replaces the ring as the source for replay | **Done** for `replay=required` | `host/hostEventLog.ts` (`appendHostEvent` :106, `hostEventsAfter` :142, `loggedHostEvent` :154); ADR 0973 D1–D2 |
| Pub/sub carries a reference, not an oversized body | **Done**, live for every subscriber once the wire is on (it is) | `host/hostEventStream.ts:134–149`: an over-7,900-byte payload publishes `{tenantId, seq, eventId}` and each instance reads the row (`:112–114`). ADR 0973 D3 |
| Ephemeral events are never persisted or replayed | **Done** | `appendHostEvent` refuses an ephemeral event; test "the log refuses an ephemeral event itself" |
| Retention, teardown and legal holds | **Done** for the log | 86,400 s floor (`hostEventLog.ts:34`), `ttlDays: 2` age-out (`:36`, `:57`), tenant purge hook; ADR 0973 D6 |
| Gapless backlog/live hand-off, dedupe by `eventId` | **Done** for `replay=required` | `attachHostEventReplaySubscriber` (`hostEventStream.ts:188`); hole-race and late-duplicate tests; ADR 0973 D4 |
| **Legacy resume** (no `replay=required`) on a fresh or different process | **Not done** | `attachHostEventSubscriber` (`hostEventStream.ts:159`) resumes only from the per-process ring (`RETAINED = 1000`, `:43`; filled at `:64–65`). ADR 0973 D7 kept it deliberately. A legacy client whose `Last-Event-ID` IS in the durable log, but not in this process's ring, silently resumes from live and misses the backlog |
| **Oversized event when the log append fails** | **Not done** | `fanOutHostEvent` (`routes/webhooks.ts:565–572`) publishes with `seq = null` after a failed append; `publishHostEventToStream` then falls back to local-only delivery (`hostEventStream.ts:145–146`, `host_event_stream_payload_too_large`). The event is also not replayable. Causes: CAS head contention after 8 attempts (`hostEventLog.ts:38`, `:119`) or a storage error |
| **S04-T1 / S04-T2 proof scope** | **Not met** | `test/adr0973-rfc0250-host-event-replay.test.ts` boots one app on `memory://` (:59, :63, :151). "Process replacement" is simulated by appending without publishing (:170), and the oversized case runs in one process (:282). The production cut proves the wire legs against one endpoint; it cannot choose an instance or force a restart. No test runs two OS processes on one Postgres, or restarts one |
| Publication retry through durable work ownership (S04-R2) | **Not done** | A failed NOTIFY is logged and dropped (`hostEventStream.ts:147–149`); there is no retry |
| CAS head contention at high emit rates | **Unmeasured** | ADR 0973's own open question |

ADR 0973's header says it "Closes EVENT-01" (`0973…md:8`). Against the plan's closure contract that is a claim, not a closure: S04-T1 and S04-T2 have not run at their stated proof scope, and S04-R4/R5 are separate. This ADR records that for the reader. It does not edit ADR 0973, which belongs to its owner.

So B3 is **mostly delivered by ADR 0973**. Three repairs and one witness remain.

## Decision

### D1 — Legacy resume reads the durable log for a cursor it can find

Without `replay=required`, a `Last-Event-ID` that `resolveHostEventCursor` finds in the caller's tenant resumes from the durable log through the same gapless, `eventId`-deduplicated hand-off `replay=required` uses. Every other cursor keeps today's answer exactly: the stream opens live, with no refusal. That covers an unknown, foreign-tenant, ephemeral, expired or out-of-grammar cursor. The ring stays as the first lookup only until P2 shows the log path is no slower. It is then removed, so there is one source of truth for a cursor.

This is the RFC 0236 SHOULD ("replay within retention") honoured across processes, and it is what S04-R3 asks for ("fix retained-cursor replay … now while preserving legacy unknown-cursor behavior"). `0250.legacy-unchanged` tests an **unknown** cursor without the parameter. That case is untouched, and the leg keeps passing.

### D2 — An append failure no longer makes an oversized event local-only

When the append fails, the publisher retries it with jittered backoff, bounded at 3 more attempts (about 1 s in total), before it publishes. If that still fails, the event is published with its body as today when it fits NOTIFY. When it does not fit, it is written to a **dead-letter row** in the same `host-event-log` collection and the existing operations surface reports it, instead of being delivered on one instance only. A new counter, `host_event_log_append_failed_total`, makes the rate measurable. The emitting write still never fails because of the stream, the posture ADR 0973 D2 keeps.

### D3 — No new outbox for publication

S04-R2's "publication failure is retried through existing durable work ownership" is met by D1, not by a second retry queue. Once legacy and strict resume both read the log, a dropped NOTIFY costs a live subscriber the frame only until it reconnects, and the reconnect replays it. A durable publication queue would be a second event bus, which section 04 rules out ("do not add a second event bus").

### D4 — The witness runs two real processes on real Postgres

A new live-lane test, `test/adr0988-host-event-two-process-postgres-live.test.ts`, follows the `*-postgres-live` precedent: `OPENWOP_PG_TEST_DSN` or testcontainers, skipped in `npm run ci`, run in `npm run ci:full`. It spawns **two OS processes** of the built backend (`lib/index.js`, `OPENWOP_MOUNT_LOCAL_PACKS=false`) on one database. Two `createApp` calls in one process are not enough, because `hostEventStream.ts` keeps its subscriber set and pub/sub binding in module state. The test asserts:

- **S04-T1:** a durable event over 7,900 bytes emitted through `POST /host/events/test` on A arrives on a subscriber connected to B, with the same `eventId`. Repeated with the append forced to fail, it asserts D2's dead-letter row and no A-only delivery.
- **S04-T2:** after A emits a backlog and is killed, a **fresh** process C answers `Last-Event-ID` with the retained backlog, in commit order, with no ephemeral frame. This runs both with `replay=required` (the existing path) and without it (D1).
- **Legacy unchanged:** an unknown cursor without the parameter still opens live on C.

### D5 — Measure CAS contention before calling it bounded

A read-only production measurement of host-event emit rates per tenant over 7 days, counts only, closes ADR 0973's open question. If the 99th-percentile rate puts a tenant's head row under contention, a follow-up decision picks sharded heads. This ADR does not pre-commit to that design.

## Alternatives considered

- **Leave legacy resume ring-only and tell clients to send `replay=required`.** Rejected as the only answer. It closes nothing for existing clients. Sending `replay=required` stays the documented recommendation for clients that want an explicit resync signal, alongside D1.
- **Make the append part of the emitting write's transaction.** Rejected for now: `fanOutHostEvent` is called from many feature write paths, and threading one transaction through all of them is a large cross-cutting change for a failure whose rate D2's counter has not yet measured.
- **A durable publication outbox (S04-R2 read literally).** Rejected (D3): a second event bus.
- **Two `createApp` instances in one test process.** Rejected (D4): module-level state makes them one instance.
- **Use the production certify cut as the S04-T1/T2 witness.** Rejected: one public endpoint cannot choose an instance or force a restart, so it cannot cause the conditions.

## Witness and acceptance

| Witness | Case | Proves |
| --- | --- | --- |
| S04-T1 | Two processes, real Postgres, oversized event A→B | D3 of ADR 0973 across real instances |
| S04-T1 (fault) | Same, append forced to fail | D2: no local-only delivery; dead-letter row |
| S04-T2 | Kill A, fresh C, `replay=required` | ADR 0973's resume across a real restart |
| S04-T2 (legacy) | Kill A, fresh C, no parameter, known cursor | D1 |
| Legacy unchanged | Unknown cursor, no parameter, on C | RFC 0250's `0250.legacy-unchanged` rule still holds |
| Sabotage | D1 lookup removed; D2 fallback restored; dedupe removed | Each turns a case red |

The S04-R1/R2/R3 statuses record what ran. **EVENT-01 stays Open** until S04-T1 and S04-T2 have run at this scope, and S04-R4 (client reconnect and UI resync) and S04-R5 (erasure and diagnostics review) are separately decided. This ADR alone closes nothing.

## Phased implementation (after acceptance)

| Phase | Scope | Exit |
| --- | --- | --- |
| P1 | D4's two-process Postgres fixture with today's code: S04-T1, S04-T2 (`replay=required`), legacy unchanged | Those cases pass, or fail and are recorded as found |
| P2 | D1 legacy resume from the log; ring kept as the first lookup | Legacy S04-T2 case; existing ADR 0973 tests unchanged; sabotage |
| P3 | D2 append retry, dead-letter row, counter, operations reporting | Fault case; sabotage |
| P4 | Remove the ring once P2's latency matches | `0250.legacy-unchanged` still `executed-pass` on the next cut |
| P5 | D5 measurement (read-only, needs the user's approval for production access) | Rates recorded; follow-up decision only if needed |

## Decisions recorded (2026-10-27)

The user accepted the recommended answer to Q1–Q5 on 2026-10-27 ("proceed with your recommendations"), including Q5's read-only production measurement. Q6 was decided 2026-10-26. The original question text is kept.

- [x] **Q1 — Legacy resume from the log (D1).** *Recommended: yes.* It is the RFC 0236 SHOULD that ADR 0973 left process-local, and the unknown-cursor answer RFC 0250 pins stays the same. The alternative is to keep it ring-only and record cross-process legacy resume as an accepted limitation.
- [x] **Q2 — Append-failure handling (D2).** *Recommended: bounded retry plus dead-letter plus counter.* Alternatives: only the counter, deciding later from data; or the transactional append, a larger change.
- [x] **Q3 — No publication outbox (D3).** *Recommended: accept.* It reads S04-R2 as met by D1 rather than a second bus. The alternative is to build the outbox as the plan literally states it.
- [x] **Q4 — Two-process live-lane witness in `ci:full` (D4).** *Recommended: yes.* Docker or `OPENWOP_PG_TEST_DSN` is required, and it does not run in the ~45-minute `npm run ci` gate. The alternative, also running it in `npm run ci`, costs gate time and needs Docker on every machine that gates.
- [x] **Q5 — A read-only production measurement of emit rates (D5).** *Recommended: approve,* with counts per tenant-hour only and no tenant ids reported, the same terms as the 2026-10-25 currency audit.
- [x] **Q6 — ADR 0973's "Closes EVENT-01" line.** *Recommended: ask its owner (6a) to add a correction note* that EVENT-01 stays Open until S04-T1/T2 run at proof scope. This ADR does not edit it.
  **Decided 2026-10-26 by the user: yes.** 6a adds a dated inline correction under that line, keeping the original wording and citing this ADR, in #5287. 9c and 6a agreed the wording. The rest of this ADR stays Proposed.
