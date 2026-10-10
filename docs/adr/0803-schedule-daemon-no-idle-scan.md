# ADR 0803 — The schedule daemon does not list every job on every tick

Status: Accepted

Date: 2026-10-03

## Context

The schedule daemon (`host/scheduleDaemon.ts`) runs every 30 s on every live
instance. Each pass called `listJobs()`: a full, ordered scan of every tenant's
scheduled jobs (`SELECT k, v FROM host_ext_kv WHERE k LIKE 'hostext:scheduler:job:%' ORDER BY k`).
The store has no cross-tenant "due" query (`SCTWF-20`).

MEASURED on production on 2026-10-02, recorded in `docs/steward/TODO.md` as
`EVID-4` / `EVID-5`:

- Postgres logged a `temporary file … size 4734976` sort spill about every 30 s
  per live instance, 4,683–5,571 a day.
- While the database was throttled (a `db-f1-micro` with two live instances), the
  statement cancelled by the statement timeout inside the schedule daemon's tick
  was that bare ordered list.
- One instance kept the micro at about 0.17 of its shared core all day; a second
  pushed it to about 0.24, where every query slowed.

The database has since moved to `db-custom-1-3840`, which absorbs two instances.
The scan still costs the same work 2,880 times a day per instance, and grows with
every tenant's jobs.

## Decision

The daemon re-lists the job set only when something can have changed or become due.

1. **A job-set change token.** One row in a separate collection,
   `scheduler:job-generation`, holds a random token. Every successful write
   through the job store (`put`, `putIfAbsent`, `compareAndSwap`, `delete`,
   `purgeTenantRows`) writes the job row FIRST and a new token SECOND. The
   write methods are wrapped on the store instance, so every existing caller
   (`mutateJob`, `registerJob`, `deleteJob`, the ADR 0789 fork repoint, erasure)
   is covered without being touched.
2. **A cached candidate list.** `listJobsForDaemon(now)` reads the token FIRST
   and lists SECOND, so a change can never be read as "unchanged". It returns
   the last full list while all of these hold:
   - the token is the one the list was taken under;
   - `now` is before the earliest `nextFireAt` of any enabled job with a
     workflow (stalled rows are not counted; their revival is itself a write);
   - the list is younger than `DAEMON_LIST_MAX_STALE_MS` (5 minutes).
   Otherwise it lists again.
3. **Firing stays fenced exactly as before.** The list was already only a
   candidate set: `claimDueSlot` re-reads the row and compare-and-swaps it before
   anything fires, and the per-(job, slot) claim and deterministic run id are
   unchanged. A stale list can therefore make a fire LATE, never wrong — it cannot
   fire a job that was deleted, disabled or rescheduled after it was read.

Steady state per instance: one point read every 30 s instead of a full scan; a
full scan when a job is written, when one comes due, and at least every 5 minutes.

## Alternatives considered

- **A due-time index** (a secondary keyspace ordered by `nextFireAt`). The real
  fix for `SCTWF-20`, and the right one if job counts grow by orders of magnitude.
  It needs a backfill, a completeness marker and index maintenance on every write
  path, including the ones that bypass the store. Not justified by today's numbers;
  this change does not preclude it.
- **A longer poll interval.** Cheaper to write, but it delays every fire by up to
  the interval. Schedules align to minute boundaries; 30 s polling is what keeps
  fire latency under one step.
- **A purely time-based cache** (re-list every N minutes). Misses a job created
  or re-armed in between for up to N minutes on every instance. The token makes
  the common case — a write through the store — visible on the next tick.

## Consequences

- **A writer that bypasses the store** (a raw `kvSet` on `hostext:scheduler:job:*`,
  or a second `DurableCollection` instance on the same prefix) moves no token. Its
  change is seen at the backstop, at most 5 minutes later. Nothing in `src/`
  does this today; two tests do, deliberately.
- **A token write that fails** is logged and does not fail the job write. The
  writing instance drops its own cache immediately; other instances see the change
  at their backstop.
- **The token row** holds a random uuid and a timestamp — no tenant, subject or
  job content. It is a reviewed exemption in the ADR 0464 erasure ratchet.
- **Tests** that drive `processDueSchedules` see the same results; the only new
  test seam is `__daemonFullListCount()`. (A second one, a cache reset for tests
  that write rows behind the store, was dropped: no test needed it — the
  backstop test exercises that case for real — and the ADR 0734 ratchet refuses
  a test-only export with no reader.)

## Verification

`test/adr0803-schedule-daemon-no-idle-scan.test.ts` (6 cases):

- idle ticks before the first due slot make no full scan;
- a job created after the list is seen on the next tick;
- a due time alone, with no write in between and well inside the backstop,
  re-lists and fires;
- a disable or delete after the list is honoured at the slot;
- the backstop re-lists an old list when nothing moved;
- a row written behind the store is fired at the backstop, not lost.

Sabotage, each run separately: the token never moving fails 1 case; ignoring
the due time fails 1; removing the backstop fails 2; always listing fails 3.
The 17 existing scheduler test files (166 tests) pass unchanged.

To confirm in production after deploy: the rate of `temporary file … size ~4.7 MB`
lines in the Cloud SQL log should fall. The heartbeat daemon's own full pass is a
separate source (openwop-app-7b, #4344), so the two are measured together.

## Open questions

- [ ] Whether `listJobs(tenantId)` (routes, erasure) should stop filtering a full
      scan in memory — it is per request, not per tick, and out of scope here.
- [ ] Whether the token helper should be shared with the heartbeat daemon's
      equivalent once both have merged.
