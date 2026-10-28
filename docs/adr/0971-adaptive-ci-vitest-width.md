# ADR 0971 — Adaptive Vitest width in the gate (shadow first)

Status: implemented (P1 shadow, #5172; P2 `on` by default, user decision 2026-10-24 — see § P2)

## Context

The user asked (2026-10-24) whether the CI process can adjust its workers and memory
to live system load, and noted that it runs on machines with different hardware.

Today it cannot:
- **Every Vitest lane runs at Vitest's default width,** `availableParallelism() − 1`
  (`vitest/dist/chunks/cli-api…js` `resolveMaxWorkers`, 4.1.11), whatever else the
  machine is doing.
- **The one exception is hand-written.** While a background lane runs, the frontend lane
  is capped at 4 workers (`OPENWOP_CI_FE_WORKERS_BESIDE_BG`, from slot 77: three async UI
  tests reddened at full width beside conformance-m2 and were each 3/3 green alone).
- **Contention is detected, not sized for.** `preflight-suite.sh` waits for other
  checkouts' suites, and `ci_load_note` explains a red after the fact, but nothing
  narrows a lane before it starts.
- **Memory is not considered at all.** MEASURED 2026-08-10: one backend fleet drove
  free RAM to 57 MB and grew the compressor by 4.46 GB.

The mechanism exists in tracegate-ci v0.3.0 (Phase 0.6, adaptive capacity), the
public extraction of this repo's Tracegate. Its sampler and policy are pure, tested
and sabotage-witnessed there.

## Decision

**D1. Before each Vitest lane, decide a width from measurement.** This covers backend,
frontend and the date-bomb sweep. `scripts/ci-width.mjs decide` takes two readings one
second apart:
- busy cores (`os.cpus()` tick deltas);
- available memory (`vm_stat` on macOS: free + inactive + speculative + purgeable,
  times the reported page size; on Linux, `MemAvailable` and the cgroup v2 limit);
- the kernel's memory pressure (`kern.memorystatus_vm_pressure_level`, or PSI);
- swap-ins in MB/s;
- a thermal CPU limit.

From these it computes:

```
width = clamp( min(default, gate cap, cores − busy, memory ÷ MB per worker),
               floor = min(2, default), default )
```

Memory pressure `warn` halves the cpu term, and `critical` takes the floor. A
background lane of the gate itself counts as busy, which generalises the slot-77 cap:
it is kept, and it is the "gate cap" in the formula.

**D2. Busy cores, not the load average.** MEASURED on this Mac on 2026-10-24: the load
average read 10.3 on 8 cores while the processes used 5.6 cores between them. The
macOS load average counts threads waiting to run. The load average is used only when
there is no second reading.

**D3. Every default derives from the machine.**
- The default width comes from the host's cores; a container's CPU quota counts.
- Memory per worker: the p90 of THIS host's measured peaks per worker for the lane
  (green runs, the last 20, at least 2). Before that, half of RAM per core, within
  256–2048 MB. `OPENWOP_CI_WORKER_MB` overrides it.
- Headroom: 10% of RAM, within 1–8 GB.
- Rows live in `<ledger>/ci-width-<host>.tsv`, so each machine learns its own numbers.
  The ledger sync copies only named log families, so these rows stay on their host.

**D4. P1 ships in shadow.** `OPENWOP_CI_ADAPTIVE=shadow` is the default. The lane runs
exactly as before, and the gate log carries one line per lane:

```
adaptive width (backend, shadow): would run 3 of 7 worker(s); runs 7 as before — 8 cores, 4.2 busy, 5100 MB available, pressure normal; ~1024 MB/worker (derived from RAM per core); …
```

During the lane, a watcher records the peak RSS of the lane's process tree. One row
per lane goes to the TSV: suggested, used, rc, seconds, peak MB, and why.
`node scripts/ci-width.mjs report` summarises it, including how often a lane was red
when the suggestion was narrower than what ran. That is the evidence for P2.

**Why shadow.** Changing a gate's width changes what a gate runs, and the user's
standing rule (ADR 0968) is that such a change comes to them with data first.

**D5. It can narrow a lane, never fail one.**
- Any error in the tool falls back to "leave the width alone", and the tool exits 0.
- An empty or non-numeric answer is never applied: only a positive integer is
  (sabotage-witnessed).
- The watcher exits with its lane. Its stdio is detached, so it cannot hold the gate's
  log pipe open.
- `OPENWOP_CI_ADAPTIVE=off` removes all of it.

**D6. Vendored, not depended on.** `scripts/lib/ci-capacity-{sampler,adapt}.mjs` are
byte copies of tracegate-ci v0.3.0's `src/broker/{sampler,adapt}.mjs` under a three-line
header. An npm or git dependency would add network to `npm ci` for two pure files.
Change them upstream and re-copy.

> **CORRECTION (2026-10-25, ADR 0974 P2):** the two copies are gone.
> `scripts/ci-width.mjs` imports `adapt.mjs` and `sampler.mjs` from
> `scripts/vendor/tracegate-ci/src/broker/`, the broker vendored by ADR 0974. That
> vendor dir is byte-identical to upstream and checked against a sha256 manifest by
> `scripts/test-broker-observe.mjs`. Both files were unchanged from v0.3.0 to v0.5.0,
> so nothing ci-width computes moved.

## Alternatives weighed

| Option | Why not (now) |
|---|---|
| Keep hand-tuned caps (`OPENWOP_CI_FE_WORKERS_BESIDE_BG`) | One rule per incident; blind to memory and to other checkouts; the same numbers on a 4-core and a 16-core machine |
| Size by the load average | Overstates on macOS (D2), so it would narrow quiet lanes |
| Resize during a run | Vitest fixes its pool at start; killing workers produces the false reds this exists to avoid |
| The full broker (tracegate-ci Phase 0.5b) | Retires eight coordination mechanisms and changes every gate script: a separate, larger decision. This ADR is the per-lane slice of it, and the rows it collects carry over. |
| Ship `on` directly | It changes what gates run without evidence, against the ADR 0968 rule |

## Phases

| Phase | Work | Exit |
|---|---|---|
| P1 | Shadow: decide, log, record, report (this PR) | `test-ci-width.mjs` in the gate's selftests; ≥ 1 week of rows on each machine that gates |
| P2 | `on`, if the report shows narrower suggestions with no rise in reds or lane time, and the user agrees | The user's decision |
| P3 | The daemon's fixed `--maxWorkers=1/2` uses the same decision | After P2 |

## Implementation record (P1)

| Item | Where |
|---|---|
| CLI: `decide`, `watch --parent`, `record`, `report` | `scripts/ci-width.mjs` |
| Sampler and policy (vendored, tracegate-ci; see the D6 correction) | `scripts/vendor/tracegate-ci/src/broker/{sampler,adapt}.mjs` |
| Wiring: `cw_begin` / `cw_watch` / `cw_end` around `tg_vitest` and the date-bomb sweep | `scripts/ci.sh` |
| Test: 13 cases, including the extracted `ci.sh` block run against a fake `npm` | `scripts/test-ci-width.mjs` (in `run_selftests`) |

**Sabotage probes (each red):**
- shadow applies the width;
- an empty width is applied;
- the gate cap wins over `on`;
- the lane's rc is swallowed;
- the floor is ignored;
- memory is ignored;
- red runs teach memory.

**Found while building it:**
- The CLI's "am I the entry point" check compared `argv[1]` with a resolved
  `import.meta.url`, so in a symlinked path (`/var` → `/private/var`) the tool silently
  did nothing. It now compares real paths.
- `sh -c 'echo $PPID'` inside `$(…)` names an intermediate fork under bash 3.2. The
  watcher uses its own parent PID instead (MEASURED).

## Open questions

- [x] P2: flip to `on`? **Yes, 2026-10-24** (§ P2): the user said "flip them now if it makes sense" rather than wait for a week of rows.
- [ ] Should the floor be higher for the backend lane (a 1-file selection needs 1 worker,
      a 2,700-file full lane at 2 workers is slow)? Read the rows first.
- [ ] Performance vs efficiency cores (Apple silicon reports both; widths count all).

## P2 — `on` by default (2026-10-24)

> **CORRECTION to D4 and the Phases table.** P2's exit was "the user's decision,
> with ≥ 1 week of rows". The user decided on 2026-10-24, the day P1 merged: "flip
> them now if it makes sense". This section records why it made sense with only
> three rows. The D4 reasoning above is kept as written.

**The evidence, measured.** Train 206 (2026-10-24) produced the first three rows:

| Lane | Default | Suggested | Ran | rc | Peak MB | Why |
|---|---|---|---|---|---|---|
| backend | 7 | 6 | 7 | 0 | 4,779 | memory, at the derived ~1,024 MB/worker |
| frontend | 7 | 4 | 4 | 0 | 983 | the gate's own cap (slot 77) |
| sweep | 7 | 6 | 7 | 0 | 1,592 | memory, at the derived ~1,024 MB/worker |

**Why turning it on was judged safe without a week of data.**
- **It can only narrow a lane,** never below 2 workers, never above the default or the
  gate's own cap.
- **It fails to the old width.** Tool errors and empty or non-integer answers apply
  nothing (sabotage-witnessed in P1).
- **Its CPU half generalises the slot-77 rule the gate already depends on.**
- **Its memory half corrects itself.** The two memory-bound rows used the RAM-derived
  default of ~1,024 MB per worker, but the measured peak per worker was 683 MB
  (backend: 4,779 ÷ 7) and 227 MB (sweep). After two green rows per lane per host, the
  learned p90 replaces the derived default. At the measured values, memory would not
  have narrowed either lane, so the worst case of being wrong is one gate per lane
  running at 6 workers instead of 7.
- **Reverting is one variable:** `OPENWOP_CI_ADAPTIVE=shadow` (the old behaviour, still
  recording) or `off`.

**What to watch.** `node scripts/ci-width.mjs report` on each gating machine.
- If lanes that ran narrower get slower without getting greener, raise
  `OPENWOP_CI_ADAPTIVE_MIN` or go back to `shadow`.
- A rise in reds on narrowed lanes would be surprising, because narrower means less
  contention. Read such a red's log before blaming the width.

**Not changed by P2:** ADR 0968 P3 (the boot rule) stays shadow. The same
2026-10-24 decision covered it, and it does not make sense yet: the daemon has written
one boot-shadow row, with 0 files the rule would have skipped. That rule would let a
gate skip files, and a wrong skip is a MISS (P0). It needs rows first.
