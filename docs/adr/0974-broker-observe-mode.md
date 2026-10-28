# ADR 0974 — The Tracegate broker, in observe mode, beside today's coordination

Status: Accepted (P1 observe; P2 daemon yield by the user's decision 2026-10-25). Retiring any further mechanism (P3+) is the user's decision, one at a time, with P1's data.

## Context

CI on this machine is coordinated by eight separate mechanisms, each deciding for
itself whom to respect:
1. the preflight claim directory;
2. the train lock;
3. the release freeze;
4. the daemon lock;
5. the PAUSE file;
6. `vlock`;
7. process-name detection (`preflight-suite.sh`);
8. the advisory `release-queue.md`.

Measured in one day (2026-10-24), coordination cost more wall-clock time than test
selection:
- a ~4 h quiet window lost to a missed "go";
- a 30-minute self-deadlock;
- a cross-wait deadlock between a measurement and the daemon;
- trains waiting 1–2 h for each other.

The same day, a sabotage sweep hung for four hours because nothing bounded it.

The tracegate-ci broker (Phase 0.5, v0.2.0+) is one queue for a machine's CI work:
- leases whose liveness is the holding connection;
- priorities, EASY backfill, fencing and preemption of preemptible work only;
- adaptive cpu and memory budgets (v0.3.0);
- an MCP surface for agents.

The user asked (2026-10-24) to proceed with adopting it here (tracegate-ci Phase 0.5b).

## Decision

**D1. Observe first.** Each of the four places that start heavy work registers it
with the broker in **observe** mode (tracegate-ci v0.4.0, invariant I10): the gate
(`ci.sh`), a merge train (`merge-train.sh`), a daemon tick (`tracegate-daemon.sh`) and
a deploy (`deploy.sh`).
- The broker grants an observed job at once, whatever its budgets say. It records
  whether the job **would have waited**, behind whom, and counts its tokens. It also
  measures the job's memory and logs minutes over the cpu budget.
- **Nothing waits, gates or changes:** the eight mechanisms stay in charge.

**D2. One line per site, which can never fail or block its caller.**
`scripts/lib/broker-observe.sh` `broker_observe <class> <tokens|gate> <label>` starts a
detached observer that watches `$$` and exits with it.
- Every site sources the helper only if it exists: a test fixture that copies a script
  without it (`test-merge-train-bisect.sh` does) keeps working.
- `OPENWOP_BROKER_OBSERVE=off` disables it.

**D3. A gate inside a train is registered once.** The train exports
`OPENWOP_BROKER_OBSERVED=1`; the gate it runs skips its own registration. Otherwise
every train's gate would read as "would have waited behind its own train".

**D4. Vendored, byte for byte.**
- `scripts/vendor/tracegate-ci/` holds `src/config.mjs` and `src/broker/*.mjs` from
  upstream `130edb8`, with LICENSE, NOTICE and a sha256 manifest in `VENDORED.md`.
  The broker-only entry `src/broker/main.mjs` loads nothing else.
- `scripts/test-broker-observe.mjs` fails if a vendored file differs from the manifest:
  change it upstream and re-vendor.
- The broker's state lives at `<git common dir>/tracegate/broker/<host>/` (per host).

## Operational notes (b7 review)

- **A `node …/scripts/vendor/tracegate-ci/src/broker/main.mjs serve` process lives for
  up to 30 minutes after each gate, train, daemon tick or deploy.** It is the broker,
  started by the first observer, and it idle-exits after 30 minutes with no
  connections and no jobs. It is not a leak and not a stuck suite. `main.mjs stop`
  ends it, and the next observer starts it again. Observers (`… observe …
  --watch-pid <pid>`) live only as long as the script they watch.
- **The broker's state is not synced to the other Mac.** The ledger sync
  (`scripts/tracegate.mjs` `sync`) copies only `fp/`, `blobs/` and the
  `shadow-`/`misses-`/`triage-`/`reasons-` TSVs, with `--exclude=*` for the rest.
  `broker/<host>/` is also per host.

## P2 — the daemon yields through the broker (2026-10-25)

**Decision (the user's, 2026-10-25: "proceed with all phases").** P1 had run for
about nine hours: 11 observed jobs (9 gates, 1 daemon tick, 1 deploy), 0 would have
waited, peak 6 of 8 tokens, 1.1 minutes over the cpu budget. That is less than the
week P1 asked for. The user chose to proceed, and P2 was built so that its failure
mode is the old behaviour rather than a gap.

**What changed.** Upstream tracegate-ci v0.5.0 (`450c2ac`) adds broker invariant
**I11 (yield)**: an observed job registered with `--yield` holds the floor against
preemptible leases across the priority gap. While it lives, running ones are asked to
yield and new ones wait. Here:
- `broker_observe` registers every class except `daemon` with `--yield`
  (`OPENWOP_BROKER_YIELD=off` drops it).
- `ci.sh` registers **before** the preflight wait. A waiting gate, which the daemon's
  `gate_live` used to catch with `pgrep --ci-exec`, therefore makes the daemon yield
  too. The `exec` keeps the PID the observer watches.
- `merge-train.sh` registers **before** `claim_train_lock`, as the daemon's
  `pgrep merge-train` did.
- The daemon runs each tick's work under a real lease:
  `main.mjs lease --class daemon --tokens 2 --deadline-min 2 -- tracegate-daemon.sh tick-work`.
  On preemption the wrapper SIGTERMs the tick's process group and exits 75. The
  tick's TERM trap removes its run directory, and a killed batch records nothing, as
  before. A tick held past two minutes because a gate registered first also exits 75.
  Under memory pressure the broker sheds the lease (I9), which the polling never did.

**Retired:** the daemon's 5-second mid-batch and mid-recheck `pgrep` polling.

**Kept, and why:**
- `busy()` before a tick. It also sees things the broker does not: a hand-run full
  suite in another checkout, and load above the core count.
- The `gate_live` check between batches. It is a backstop for a gate run with
  `OPENWOP_BROKER_OBSERVE=off`, so such a gate waits at most one batch.
- The daemon lock. It only stops two ticks of the daemon itself; it does not
  coordinate the daemon with other work.

**Fallbacks:**
- `OPENWOP_DAEMON_YIELD=legacy` restores the polling.
- A broker that cannot be reached (the lease exits 2) runs the tick with the polling,
  as before.

**Tests:** `scripts/test-broker-observe.mjs` covers:
- the yield flag by class;
- live: a daemon lease exits 75 when a gate registers;
- the order of registration in `ci.sh` and `merge-train.sh`;
- that every mid-run kill in the daemon goes through the legacy-only check.

Upstream, I11 is live-tested and sabotage-witnessed.

## Alternatives weighed

| Option | Why not (now) |
|---|---|
| Wrap each script in `tracegate lease -- …` (enforce) at once | Changes who waits for whom on every gate at once, with no data; re-execing `ci.sh` under a wrapper also changes the PID that the preflight claim records |
| Retire the mechanisms first, then adopt | Leaves a gap with no coordination at all |
| Keep the eight mechanisms | Their failure modes are measured above; each new one has been added after an incident |

## Phases

| Phase | Work | Exit |
|---|---|---|
| P1 | Observe at the four sites (this PR) | A week of `main.mjs observed`: would-have-waited grants, behind whom, minutes over budget, compared with what the queue and logs show actually happened |
| P2 | Enforce for ONE mechanism's job (proposal: the daemon, the most preemptible), retiring the daemon lock and PAUSE yielding | The user's decision with P1's data |

> **CORRECTION (2026-10-25): what P2 retired.** P2 retired the daemon's mid-run gate
> polling, not its lock or PAUSE (see § P2):
> - The daemon lock only serialises the daemon's own ticks, so it is not cross-job
>   coordination.
> - `tracegate-daemon.sh` never read PAUSE. PAUSE is the release manager's manual
>   control over sessions, not a script mechanism.
> - The broker now does the yielding that the polling did.
>
> **CORRECTION (2026-10-26): the mid-run polling is back, as a backstop.** On this
> machine the broker server had been started at 04:55Z from the stale shared
> checkout, whose vendored broker predates I11. That broker ignored `--yield`.
> - Train 234 registered at 17:50:56Z, and no preemption followed.
> - The daemon stopped only at its own between-batch check, 3.5 minutes later.
> - The gate's preflight waited 180 s on that batch.
>
> A broker server keeps the code it started with, and any client can start one
> from any tree. So:
> - the daemon again polls for gates every 5 s mid-batch, under a lease too;
> - `broker_stale` skips the lease, and logs why, when the running server's
>   `core.mjs` differs from this checkout's or changed on disk after it started.
>
> The broker still preempts, and sheds work under memory pressure, when it is
> current. The polling only stops this failure from costing a batch.
| P3+ | One mechanism at a time | Each its own decision |

## How to read it

```sh
node scripts/vendor/tracegate-ci/src/broker/main.mjs observed            # last 7 days
node scripts/vendor/tracegate-ci/src/broker/main.mjs queue               # live
node scripts/vendor/tracegate-ci/src/broker/main.mjs machine             # hardware + budgets
```

## Open questions

- [ ] Measurements (A/B runs) and the selftest lanes are not registered: add them in
      P1b if the first week shows gaps.
- [x] `scripts/lib/ci-capacity-{sampler,adapt}.mjs` (ADR 0971) duplicated two of the
      vendored files. Done with P2: `ci-width.mjs` imports the vendored broker copies
      and the duplicates are deleted.
