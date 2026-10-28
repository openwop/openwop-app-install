# ADR 0973 — RFC 0250 host-event replay, the host half

Status: implemented (2026-10-25: P2 `f94471e98` live on rev `01034-r5h`, certified by cut 217c, RFC 0250 Accepted flip opened as openwop #2039). Accepted 2026-10-24 after the design review with /architect; seven findings folded in. The user approved trains and deploys for RFC 0250 on the RFC 0249
terms, confirmed to the release manager on 2026-10-24. The wire shape was locked by
openwop-7a's /architect pass, 2026-10-24. Nothing is advertised until 7a says the RFC
is Active and the suite release carrying the `0250.*` legs is pinned.

Builds on ADR 0825 (RFC 0236 `hostEvents`, RFC 0241 test trigger). Closes EVENT-01.
It is wire-facing, and the RFC is locked, so no new RFC is needed.

> **CORRECTION (2026-10-26, ADR 0988):** "Closes EVENT-01" overstated. Measured
> against the gap-closure plan's closure contract (section 04), this ADR delivered
> the following for `replay=required`:
> - the durable tenant-scoped log;
> - reference-not-body pub/sub for oversized events;
> - the gapless, `eventId`-deduplicated backlog/live hand-off;
> - ephemeral exclusion;
> - retention, teardown and legal-hold handling.
>
> It did NOT deliver:
> - **legacy resume** (no `replay=required`) from the durable log. That stays
>   ring-only per process (D7), so a cursor that is in the log but not in this
>   process's ring resumes live;
> - **a path other than local-only for an oversized event whose log append
>   fails.** It falls back to local-only delivery and is not replayable;
> - **publication retry**;
> - **proof at the plan's scope.** The S04-T1/S04-T2 witnesses (two real
>   processes on real Postgres, a real restart) never ran. This ADR's tests boot
>   one process on `memory://`, and the certified cut proves the wire legs against
>   one endpoint.
>
> CAS head contention under load is unmeasured. **EVENT-01 stays Open** until the
> remainder ADR 0988 proposes is decided and delivered, and until S04-R4 (client
> reconnect, deduplication and resync state) and the parts of S04-R5 this ADR did
> not cover (volume and size limits, subject erasure) are done. ADR 0988 tracks it.
> The RFC 0250 wire legs this ADR certified (cut 217c) are unaffected.

## Context

RFC 0250 adds an opt-in replay contract to `GET /host/events`. A consumer that sends
`?replay=required` and a `Last-Event-ID` naming a durable event gets every visible
durable event after it, exactly once and in commit order, then the live stream with
no gap. A cursor the host cannot honour gets a uniform `409
host_event_resync_required` before any SSE byte. The capability is advertised as
`hostEvents.replay = {minRetentionSeconds}`. Without `replay=required`, behaviour is
unchanged.

Measured on `origin/main` (`e0f1c7d5b`), `host/hostEventStream.ts`:

- Durable events are retained in a **per-process ring of 1,000 frames**. An instance
  started after an event cannot replay it, and a revision rollout loses everything.
- Cross-instance fan-out rides Postgres LISTEN/NOTIFY. A payload over 7,900 bytes is
  **delivered only on the emitting instance** (`host_event_stream_payload_too_large`),
  so subscribers on other instances never see it, live or replayed.
- An unknown `Last-Event-ID` silently resumes from live. That is today's legacy
  behaviour, and RFC 0250 requires it to stay unchanged without `replay=required`.
- One emitter feeds the stream: `fanOutHostEvent` (`routes/webhooks.ts`), reached
  by every CRM/CMS event and by `POST /host/events/test`. The trigger is served
  whenever `host-test.*` types are listed, independent of the test-seam flag, so the
  legs run in production.

Each of the first two facts alone breaks RESUME.

## Decision

### D1 — A durable, tenant-scoped host-event log

The log is a new `DurableCollection` named `host-event-log`. It holds three kinds of
row, all under the tenant's key prefix:

| key | row | purpose |
|---|---|---|
| `${tenant}::h` | `{tenant, seq}` | the tenant's head sequence (CAS) |
| `${tenant}::s::${seq:016}` | `{tenant, seq, eventId, committedAt, event}` | the event, in commit order |
| `${tenant}::i::${eventId}` | `{tenant, seq, committedAt}` | cursor lookup by opaque id |

Only durable events are written. An ephemeral event never reaches the log, so its id
can never resolve as a cursor (MUST 2, and the ephemeral-id refusal in MUST 3).

The collection has **no tenant resolver**. Every key is already tenant-prefixed, so
teardown is a prefix delete registered through `registerTenantPurgeHook`. A
resolver would pre-write a `hostextidx:` marker on every `put` and
`compareAndSwap`, doubling an emit from three writes to six on every CRM/CMS
mutation. Its `purgeTenantRows` would also scan every tenant's rows. Tenant ids are
`ws:<uuid>`, `user:<hash>` or `anon:<sid>` and never contain `::`, and `appendHostEvent`
asserts that, so one tenant's prefix cannot match another's. (Architect review
findings 3 and 6.)

### D2 — Commit order is a per-tenant sequence assigned by CAS

`appendHostEvent(tenant, event)` advances the head with `compareAndSwap` (retrying on
a lost race), then writes the `s` row and the `i` row. The sequence is the commit
order. It is cross-instance on Postgres (`kvCompareAndSwap`) and in-process on
sqlite/memory.

- A crash after the head advances but before the row is written leaves a hole. Replay
  skips holes, and the event was never published, so nothing a consumer saw is lost.
- Sequential emits get increasing sequences, so they replay in emit order, which the
  resume-backlog leg witnesses. Concurrent emits are ordered by whichever CAS won.
- The sequence never reaches the wire. Ids stay the opaque `eventId` (MUST 5).
- The CAS retry loop is bounded (8 attempts). On exhaustion, the event is published
  live without a log row and `host_event_log_append_failed` is logged, the same
  posture as any other append failure.
- The head row carries `committedAt` (the time of its last advance), so the age-out
  lane reads it like any other row rather than skipping it on every tick.

`fanOutHostEvent` appends before publishing. If the append fails, the event is still
published live, as today, and logged (`host_event_log_append_failed`). A failed
append must not fail the emitting write, the same posture as the stream publish.

### D3 — Publication carries the sequence, not necessarily the body

The NOTIFY payload becomes `{tenantId, seq, eventId, event?}`. `event` is omitted when
the whole payload would exceed the NOTIFY limit. A receiving instance then reads the
`s` row from the log. Every instance therefore delivers oversized events, which closes
EVENT-01's local-only path. The sequence is host-private (the channel name is
host-private already).

Two consequences, stated because they are easy to miss (architect review finding 4):

- Before the pin the log is not written (D8), so an oversized event stays local-only,
  exactly as today. The read-from-log path exists only once the wire is on.
- A fetch is asynchronous, so a smaller event published later could overtake an
  oversized one on a receiving instance. Each instance therefore delivers live
  frames through a per-tenant serial queue in arrival order. Sequential emits stay
  in order; concurrent ones have no defined order (7a's ruling, below).

### D4 — The gapless hand-off

On `replay=required` with a resolvable cursor:

1. **An unauthenticated caller is refused (D5) before any lookup.** `tenantOf(req)`
   answers `'default'` when there is no subject, and today's route returns only
   after opening the channel, so without this step an anonymous `replay=required`
   would read the `default` tenant's log (architect review finding 1, blocking).
2. Resolve the cursor **before opening the SSE channel**: the `i` row under the
   caller's tenant. Absent (unknown, foreign or ephemeral id), or older than the
   retention bound (D6) → refuse (D5).
3. Attach a live subscriber in **buffering** mode. Live frames are held.
4. Page through the log with `kvListPage(after: s::<cursorSeq>)`, write each row's
   frame, and record the **set of `eventId`s written**. The cursor itself is never
   re-emitted, because the page starts strictly after it.
5. Flush the buffer, then switch to direct writes. **Every** live frame, during the
   flush and after it, is dropped if its `eventId` is in the written set.

Deduplication is by `eventId`, not by a sequence high-water mark (architect review
finding 2, blocking). A mark loses events and duplicates others:

- **Lost:** A takes sequence 5 and B takes 6. B commits first, so the page reads 6
  and sees a hole at 5. A's live frame then arrives below the mark and would be
  dropped.
- **Duplicated:** an event the page read whose live frame arrives after the switch
  to direct writes would be written twice.

The set is released once no hole at or below the backlog's last sequence remains
unfilled or unaged. Each event is written once, either from the backlog or from
live, never both and never neither. A live frame with no sequence (an ephemeral event) is written in
arrival order, which is the existing behaviour.

### D5 — One refusal, byte-identical

Every refusal is the same constant: status `409`, the v2 flat envelope `{error:
"host_event_resync_required", message: "The event stream cannot resume from that
position; reconnect without replay and resynchronise."}`. It never echoes the
cursor, never carries `details`, and is written before `openSseChannel`, so no
`text/event-stream` byte precedes it. Unauthenticated callers and unknown,
foreign-tenant, ephemeral-id, expired and removed cursors all take one code path, so no branch can differ (the
refusal-uniform leg). Until the pin registers the code, `v2ErrorCode`
vendor-prefixes it, as with RFC 0249.

### D6 — Retention: `minRetentionSeconds` = 86,400

The host advertises a 24-hour minimum. The log registers with `registerKvAgeOut` at
`ttlDays: 2` on `committedAt` (7a confirmed 86,400 s and two-day aging, 2026-10-24), so rows outlive the advertised bound with margin. The
age-out deletes through the collection (marker-aware) and respects tenant legal
holds. A cursor whose `committedAt` is older than the advertised bound is refused,
even if its row still exists. That keeps the refusal independent of sweep timing.

Exceptions (MUST 4):

- **Tenant removal:** the tenant resolver puts the log on the teardown path. A
  removed tenant's cursors are unknown, and so refused.
- **Revoked visibility:** visibility is tenant-wide on this host (ADR 0825 decision
  3), and the subscriber's tenant is resolved at connect, so an event is visible
  exactly when it belongs to the caller's tenant.
- **Lawful deletion:** this host has no per-event deletion today. If one is added, it
  must delete the `s` and `i` rows together. A removed cursor is then unknown and
  refused, and a removed event in the backlog is a hole, which replay already skips.

### D7 — Without `replay=required`, nothing changes

The legacy path keeps the per-process ring and its unknown-cursor behaviour
(silently resume from live) byte for byte (the legacy-unchanged leg). The ring is not
removed in this ADR. It is cheap, and deleting it would change legacy timing.

### D8 — Dormant until the pin, the RFC 0249 D9 pattern

`rfc0250WireAvailable()` is true when the vendored v2 schemas carry `hostEvents.replay`
(the capabilities schema defines `replay` under `hostEvents`). Until then:

- the log is not written;
- `replay=required` is ignored (RFC 0250 lets a host that does not advertise replay
  ignore it), so behaviour is today's;
- the facet is absent.

Production already runs `OPENWOP_HOST_EVENTS_V2=true`, so the pin-bump PR is the
switch-on and needs no env change. The first 24 hours after the switch-on have a
partial backlog. That is honest, because a cursor older than the log does not
resolve and is refused.

## Alternatives considered

- **Reuse the run-event table (`appendEvent` on a pseudo run `hostevents:<tenant>`).**
  It already has atomic per-key sequences. Rejected: its rows are pruned with terminal
  runs and governed by the run contract, so host-event rows would be orphans no
  retention lane reaches.
- **A global sequence instead of per-tenant.** Rejected: one hot CAS row for every
  tenant, and a global position is a cross-tenant oracle if it ever leaked.
- **Keep the ring and add a durable fallback only for misses.** Rejected: two sources
  of truth for one cursor, and RESUME across process replacement would depend on
  which instance answered.
- **Distinct refusal messages per cause.** Rejected: RFC 0250 requires byte-identical
  refusals, and distinct messages would be a foreign-id oracle.

## Rulings from the spec owner (7a, 2026-10-24)

- **Order:** commit order binds only commits that are ordered, meaning one committed
  before the next was emitted. Concurrent commits have no defined order, live or
  replayed. Sequential emits must arrive in order (the suite emits D2, D3 and D4
  each after the previous `202`).
- **Expiry:** `minRetentionSeconds` is a floor. Inside it a cursor MUST resume;
  older, it MAY be resumed or refused. Refusing at the bound regardless of sweep
  timing is permitted, provided the refusal is byte-identical.
- **Suite:** the legs and the `hostEvents.replay` schema change ship in 2.46.23.

## Open questions

- [ ] The CAS head is one row per tenant. A high-rate tenant would contend on it.
  Measure emit rates before declaring this bounded (the CRM import path is the
  likely peak).

## Plan and checklist

- [x] P1 — dormant implementation, D1–D7 behind D8:
  `src/host/hostEventLog.ts` (new), plus changes to `host/hostEventStream.ts`,
  `routes/hostEventStream.ts`, `routes/webhooks.ts` (`fanOutHostEvent` appends
  before publishing) and `routes/discovery.ts`.

  `test/adr0973-rfc0250-host-event-replay.test.ts` has 13 cases:
  - the wire is off on the vendored schemas, and with it off `replay=required` is
    ignored and nothing is logged;
  - resume-backlog (D1, D2, E, D3, cursor D1, D4 live → exactly D2, D3, D4);
  - replay from the log for events no ring ever held;
  - no cursor → live;
  - one byte-identical 409 for unknown, foreign, ephemeral and out-of-grammar
    cursors;
  - the log refuses an ephemeral event itself;
  - an expired cursor resolves to null;
  - legacy unchanged;
  - the hole race and the late duplicate;
  - oversized events, live and replayed;
  - teardown;
  - the advertisement.

  Nine sabotages were each witnessed red:
  - no dedupe;
  - high-water-mark dedupe;
  - the oversized fetch lost;
  - an ephemeral event logged;
  - no expiry;
  - the cursor re-emitted;
  - a refusal that echoes the cursor;
  - the route's wire gate removed;
  - the append not gated on the wire.

  On this host an unauthenticated request is already answered `401` by the
  `runs:read` scope check before the route runs. RFC 0250 §C keeps an auth
  failure's own answer, and 7a's leg accepts it. The in-route refusal for an
  unauthenticated caller (D4 step 1) is therefore defence in depth, not reachable
  in the tested configuration. That was measured, not assumed, which is why the
  test accepts 401 or the uniform 409 and asserts only that no stream opens.
  Follow-up from 7a's ruling: an absent or empty `Last-Event-ID` with
  `replay=required` opens live and replays nothing.
- [x] P2 — suite 2.46.23 (tag `v2.46.23`, `cff9ff17`; RFC 0250 Active and locked,
  openwop #2038): both packages pinned `^2.46.23`, schemas and fixtures synced at the
  tag (the capabilities schema defines `hostEvents.replay`; the error envelope
  registers `host_event_resync_required`). The wire test flips to true, the refusal
  code is asserted bare, and the facet is validated against the vendored schema.
  `/host/events` was already routed, so no `firebase.json` change. Production
  already runs `OPENWOP_HOST_EVENTS_V2=true`, so this PR's deploy is the switch-on.
- [x] Deploy, then a certify cut; `0250.*` rows `executed-pass`. P2 merged as
  `f94471e98` (#5187, train 217). Deploy 217b took it live on rev `01034-r5h` at
  02:07Z on 2026-10-25.

  Verified live:
  - discovery's only change is `hostEvents.replay = {"minRetentionSeconds":86400}`;
  - `GET /host/events?replay=required` with an unknown `Last-Event-ID` answers
    `409 host_event_resync_required` as `application/json`, with no SSE byte
    first.

  **Cut 217c** came in at 487/0/11/373 = 871, matching the prediction exactly.
  Bundle sha256 `9b82a7be9b34`, witness `22641f5ac922`, signed by
  `openwop-app-bundle-2`, suite 2.46.23. Against cut 209c there are seven new ids,
  all `executed-pass`: the six `0250.*` legs plus
  `scenario.v2-host-event-strict-replay`. Nothing was removed or moved, and
  `claimedProfiles` is unchanged.
- [x] ec checks in the bundle; RFC 0250 → Accepted. openwop-7a verified cut 217c
  independently (signature, served bytes equal the bucket, build `f94471e98`, the
  seven-id diff) and opened the Accepted flip as openwop #2039, pinned to
  openwop-app `f94471e98` and corpus tag `v2.46.23`. It releases 2.46.24.
