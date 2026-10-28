# ADR 0804 — The heartbeat daemon lists the roster only when it changed

Status: implemented (2026-10-02)

Relates to: ADR 0803 (the schedule daemon's change-token fix, EVID-5's other
half; #4345 — merged in the same train as this ADR's #4344, so the branch-name
citation this line first carried is retired), EVID-5 in `docs/steward/TODO.md`, RFC 0086 (the standing
roster), ADR 0313 / ADR 0318 (heartbeat cadence and admin override).

## Context

EVID-5: Postgres spills a ~4.7 MB sort to a temp file about every 30 s per live
instance, all day — the standing load under every slow hour measured on
2026-10-02. One of the two named sources is the heartbeat daemon. Every 30 s, on
every instance, it ran `listRosterTenants()` (a full scan of the `roster`
collection) and then one `listRoster()` prefix scan per tenant, whether or not a
single roster row had changed.

Nothing about dueness needs that. `isHeartbeatDue` is a function of the entry
(interval, last heartbeat, enabled) and the clock; the clock is read every tick
anyway.

## Decision

> **CORRECTED 2026-10-19 (ADR 0963 D5).** The token this decision keys on moved on every
> heartbeat stamp (`recordHeartbeat` bumped it), so any tick that heartbeat a member forced the
> next tick to re-list every tenant: the cache only held while the loop did nothing. The stamp
> no longer moves the token; the pass corrects the cached listing itself (`note`).

1. **A one-row change token.** `rosterService` keeps a `roster-version`
   collection with a single row. Every successful roster write — create (CAS),
   update, `recordHeartbeat`, delete, and the ADR 0789 fork repoint — writes the
   roster row FIRST and a fresh random token SECOND. A delete that removed
   nothing does not move it.
2. **The daemon reads the token, then lists.** `cachedRosterEntries` keeps the
   last listing and re-lists only when the token moved or five minutes passed
   (a backstop for any writer that bypasses the service).
3. **It acts on the entry as stored now.** Before running a due candidate from
   the cached list, `processDueHeartbeats` re-reads it and re-checks dueness,
   so a member deleted, disabled or already run by another instance since the
   listing is skipped. The per-slot `claimOnce` fence is unchanged.

Net: an idle roster costs one point read per tick instead of a full scan plus
one prefix scan per tenant; a due member costs one extra point read.

## Alternatives weighed

- **Lengthen the tick.** Cheaper, but delays every heartbeat and still scans.
- **A tenant index instead of `roster.list()`.** Removes the full scan, keeps
  N prefix scans every 30 s; the change token removes both.
- **A shared helper with the schedule daemon's fix.** Worth doing once both land; done
  separately here so neither PR edits the other's files while both are in
  flight.

## Consequences

- A heartbeat can be late by at most the backstop if some code writes the
  roster around the service. It can never run twice or run a deleted member.
- `roster-version` is classified subject-free in the ADR 0464 erasure coverage
  (no tenant, user or content in it).

## Implementation record

| Change | Witness |
|---|---|
| token + bumps in `host/rosterService.ts`; `cachedRosterEntries` and the fresh re-read in `host/heartbeatService.ts` | `test/heartbeat-roster-cache.test.ts` (8 cases; three sabotages each turned the matching case red: no re-read, a writer that skips the token, a cache that ignores the token) |

## Open questions

- [x] Measure the temp-file rate after deploy (EVID-5), together with the
      schedule daemon's fix. **MEASURED 2026-10-03** on `062381a52`
      (revision 00833-ntv), after the superseded instance drained: the
      30 s spill is gone (58 per 30 min before → 7 in 27 min after). What
      remains is one ~4.9 MB sort every 5 min, which by timing is this ADR's
      own `ROSTER_RELIST_BACKSTOP_MS` re-list. Full numbers in EVID-5.
- [ ] Whether the backstop re-list should read a tenant index instead of
      `roster.list()`, to remove the residual 5-min spill. Not urgent at
      ~12 spills an hour.
