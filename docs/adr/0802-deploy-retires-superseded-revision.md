# ADR 0802 — a deploy retires the revision it supersedes, and does not boot at the top of an hour

Status: implemented — D1 CORRECTED to opt-in the same day (see § D1 correction); D2 as decided

- **Tracker:** `EVID-3`, `EVID-4` in `docs/steward/TODO.md`.
- **Wire:** untouched. `scripts/deploy.sh` and one helper. No RFC.
- **Decided with the user** (2026-10-02): both behaviours on by default.

## Context — what was measured on 2026-10-02

The 17:00Z deploy (`bb06d19c6`, revision `00830`) was watched by a probe sending
one run read and one run create every 10 seconds, and by the pool-wait log added
in #4328. The probe was the only traffic.

| When (Z) | Instances alive | Run read, median | Pool |
|---|---|---|---|
| 17:00–17:10 | new + superseded | 0.10 s | boot: 109 queued behind 4 connections |
| 17:10–17:50 | new + superseded | 0.5–1.3 s (spikes to 8 s) | a waiter in 26–40 % of samples |
| 17:47:50 | superseded instance logs `shutdown: draining` | | |
| 17:55 | new only | 0.10 s | ~1 % |
| 18:00–18:10 | new only | 0.43–0.50 s (spike 6.2 s) | 449 queued at 18:00 |
| 18:10 → | new only | 0.10 s | none |

App CPU was 3–4 % and database CPU about 25 % throughout; the database did LESS
work while slow (commits/s 76 → 21). So:

1. **A superseded revision keeps running.** Its instance stays alive for as long
   as a request holds it open — the hour-long notification stream does — and it
   keeps running every background daemon against the same `db-f1-micro`. Two
   copies of the daemons are more than that database sustains. `00829` lived 47
   minutes after traffic left it, and reads recovered within five minutes of its
   shutdown. The same shape is in the request logs after other recent deploys,
   and it is what the 2026-10-02 evidence cut ran into.
2. **The top of a wall-clock hour CAN be slow on one instance.** At 18:00Z the
   schedule daemon fired its hourly jobs together and the pool queued for about
   ten minutes, with one instance and no deploy in progress.

   > **CORRECTED 2026-10-02, before merge.** This first read "the top of every
   > wall-clock hour is slow on its own". The next hour falsified that: a probe
   > across 20:00Z, same single instance, showed no dip (run read 97–107 ms
   > median, 250 ms max). What IS reproduced, at 18:00, 19:00 and 20:00Z (pool
   > log, #4328): at the top of each hour the scheduled jobs queue 300–500
   > callers behind the 4 connections for a few seconds, gone within a minute.
   > What is NOT reproduced is the ten-minute slowdown: it followed once, at
   > 18:00Z, on a database that had recovered from the two-instance throttle 12
   > minutes earlier (the 04:00Z case in the evidence cut had two instances
   > alive). D2 is kept because a boot is such a moment and the hold costs at
   > most 25 minutes; its evidence is this, no more.

Why the two-instance slowdown starts ten minutes after boot and not at boot is
not explained; the database tier's burst accounting is not observable from here.

> **Tier note (2026-10-02 20:17Z).** The database moved from `db-f1-micro` to
> `db-custom-1-3840` after these measurements (the operator's decision; restart
> cost one failed probe sample and ~30 s of slow reads). D1 and D2 were measured
> on the old tier. Whether two live instances still throttle the new one is
> unmeasured — the first deploy after it is the test.

## Decision

### D1 — after verify, delete the revision this deploy superseded

`deploy.sh` reads the serving revision BEFORE the backend deploy, and after
`verify-deploy.sh` passes deletes that one revision by name — only if it then
holds no traffic and no tag. Deleting a revision ends its instance. The image is
kept, and the script prints the one-command rollback (`gcloud run deploy --image
<digest>`), so rollback costs a ~1 minute boot instead of an instant traffic
shift. `--keep-previous` opts out.

It never deletes on a guess: a traffic split, a tagged revision, or an
unreadable service document names nothing and deletes nothing.

> **CORRECTED 2026-10-02, after the first real retire — D1's premise was false.**
> The first deploy with this script (6de66ea16, 23:24Z) deleted the superseded
> revision `00830-6nl` at 23:28:54Z. Its instance did NOT stop: Cloud Monitoring
> kept it `active` every minute through 23:45Z, and the same instance id kept
> logging — the dispatch sweeper, the schedule daemon firing five jobs at 23:30,
> webhook fan-out, a pool-pressure line, a truncated response. Deleting a
> revision removes it from routing and from `revisions list`; the running
> instance lives until its open requests end. So D1 ended nothing, hid the
> overlap from the usual listing, and cost the instant rollback target.
>
> The same deploy answered the other open question: on `db-custom-1-3840` the
> two-instance overlap is harmless — with `00830`'s instance alive throughout,
> boot+10 and after showed request latency p50 0.026 s / p90 0.038 s and one
> pool-pressure line (maxWaiting 1). The 40-minute slowdown D1 was meant to
> prevent was a property of `db-f1-micro`.
>
> So D1 is now **opt-in** (`--retire-previous`), default off, and its output no
> longer claims to stop the instance. Ending an overlap for real needs the
> instance to learn it is superseded and stop its daemons (app-side, not a
> gcloud verb) — not needed on the current tier. My first report that the old
> instance went silent after the delete was also wrong: it queried logs by the
> deleted revision's name, which returns nothing; the instance id is the
> working filter.

### D2 — hold a backend build that would boot near the top of an hour

After certify and before the build, the script waits if the new instance would
boot from 10 minutes before to 15 minutes after the hour (boot is taken as 8
minutes after the build starts). `--ignore-hour-window` opts out. The hold sits
before the build because a revision built and left at 0 % keeps an instance of
its own.

## Alternatives weighed

- *Wait for the old instance to drain.* That is today's behaviour: up to an hour
  of slow reads for every user after every deploy.
- *Have the app notice it is superseded and stop its daemons.* The right
  long-term shape (it also covers a manual traffic shift), and more code on the
  request path of a host that is currently the thing misbehaving. Not excluded.
- *A bigger database tier.* The direct fix for both findings, and a cost
  decision for the operator. Independent of this ADR.
- *Stop the daemons' standing full-collection scans.* The real fix for the base
  load (`EVID-5`). Larger; tracked separately.
- *Refuse instead of hold in D2.* A refusal 12 minutes into a deploy (after
  certify) wastes the certify run; a hold of at most 25 minutes does not.

## Risks

| Risk | Mitigation |
|---|---|
| The new revision is bad and the instant rollback target is gone | Deleted only after verify passes; the image digest and rollback command are printed; `--keep-previous` for a deploy you want to compare |
| The wrong revision is deleted | One named revision, read before the deploy, re-checked for traffic and tags at delete time; exactly one `revisions delete` call exists (test-pinned) |
| Users on the old instance lose their stream | They do — an SSE client reconnects to the new revision. The alternative is slow reads for everyone |
| `revisions delete` is refused | Reported as FAILED with what to expect; the deploy itself stays verified |

## Implementation record

| Decision | What | Witness (`scripts/test-deploy-gates.sh` § ADR 0802) |
|---|---|---|
| D1 | `previousServingRevision` (`scripts/lib/deploy-timing.mjs`); the retire block in `deploy.sh`, OPT-IN since the correction | 6 naming cases; delete-after-verify order; exactly one delete call; retire defaults off; no "stops its instance" claim |
| D2 | `hourWindowWaitSeconds`; the hold in `deploy.sh` | 8 window cases incl. both edges and "a held build is not held again"; hold between certify and build |

**Not verified yet:** that `gcloud run revisions delete` terminates an instance
with an open stream at once. No superseded instance existed when this was
written. The first deploy that uses it checks `instance_count` for the deleted
revision and records the result here.

## Open questions

- [x] Record the first real retire — the delete did not stop the instance (see § D1 correction). It ran its daemons until it logged `shutdown: draining` at 00:16:04Z — 47 minutes after DeleteRevision completed (23:28:57Z), 51.5 minutes after traffic left it (23:24:30Z); three open streams were cut at that moment. Cloud Run reclaimed it on its own schedule.
- [ ] The hourly dip itself (D2 only avoids stacking a boot on it): spread or bound the hourly scheduled jobs.
- [ ] The app-side version of D1 (an instance that learns it is superseded stops its daemons).
- [x] Database tier — moved to `db-custom-1-3840` at 20:17Z (operator's decision); the overlap is harmless on it.
