# ADR 0968 — Tracegate: boot and lockfile selectivity (the `pack.json` question, measured)

Status: Accepted — P1 (replay) implemented 2026-10-23; P2 (shadow measurement) in progress; nothing changes what a gate runs until the P2 data goes back to the user

Relates to: ADR 0880 (Tracegate) — closes its open question "Narrow the boot-time
`pack.json` reads", and replaces it with the question the data actually raises.

## Context

ADR 0880's 2026-10-15 selectivity study found that a description-only `pack.json`
edit selects 1,170–1,220 backend files, because app boot reads every manifest and
runs it through every loader. It left the fix open ("needs a 'boot outcome
unchanged' design, not a diff rule") and deferred the design until a week of
`reasons-<host>.tsv` rows existed. That week is now in (2026-10-16 → 2026-10-23,
both machines, 119 distinct backend gate heads).

### What the week of reasons says (attribution)

Each `reasons` row lists the top reasons a gate had to run files. Over 119 backend
gates the lane ran **112,680 of 315,449 file-runs (35.7 %)**, and the distribution
is bimodal: the 25th percentile gate ran 0.7 % of files, the median 47 %, the 90th
92 %. Classifying each gate's TOP reason:

| Top reason class | Gates where it is the top reason | Files it is credited with (lower bound) |
|---|---:|---:|
| Boot wiring (`features/index.ts`, `features/*/feature.ts`, `bootstrap/`, registries) | 31 | 36,064 |
| Global input (`package-lock.json`, `package.json`) | 22 | 42,707 |
| Module top-level (`constant in` / `top-level change in`, elsewhere) | 11 | 17,916 |
| Executed function | 6 | 9,800 |
| Read / loaded input | 6 | 3,377 |
| No footprint (live/Docker tests that skip locally, plus new files) | 43 | 1,646 |
| **`pack.json`** | **0** | **411** |

`pack.json` was never the top reason in any gate. It appeared in 11 gates' top
lists at all, each time beside a code change in the same pack's feature.

### Attribution is not savings: a counterfactual replay

`decide()` returns a file's **first** invalidating reason only, so the counts above
say what was noticed first, not what removing a cause would save. To measure
savings, a gate was replayed offline: a copy of `scripts/tracegate.mjs` with three
seams (drop changed paths matching a regex; ignore the lock key; evaluate at the
gate's own clock and only with footprints recorded before it), run per test file
with `decide()` at the gate's head. **The replay is exact**: on `5d1e26eeb` it
selects 1,360 of 2,697 files, the logged number. Replays must be close to the gate:
`KEEP_PER_TEST = 6` and the 72 h age limit had already evicted the footprints of
every gate older than about a day, so only the most recent gates replay faithfully
(older ones replay as "no footprint" and were discarded).

| Gate head (2026-10-22/23) | Logged | Replayed | Without `pack.json` changes | Without boot-wiring changes (oracle) |
|---|---:|---:|---:|---:|
| `183158562` (bootstrap/nodes.ts) | 1,347 | 1,371 | 1,371 | 837 |
| `b9b21cde3` (features/index.ts) | 1,365 | 1,365 | 1,365 | 533 |
| `42e6d1dcd` (bootstrap/nodes.ts) | 1,332 | 1,333 | 1,333 | 128 |
| `5d1e26eeb` (features/index.ts) | 1,360 | 1,360 | 1,360 | 482 |
| `ba9006461` (deleted boot modules) | 1,373 | 1,373 | 1,373 | 1,373 ¹ |
| `528627bf6` (lockfile: conformance pin 2.46.18 → .19) | 2,694 | 2,694 | 2,694 | — ² |

¹ Peeling one cause exposes the next: removing the feature-wiring paths surfaced
"loaded module deleted `host/chainInstantiation.ts`" for the same 933 files. A
deleted module is a real dependence; this gate is not narrowable by any boot rule.

² With BOTH the lock key and `package(-lock).json` ignored, `528627bf6` still
selects **2,311** files: the pin bump ships new vendored schemas and fixtures
(`schemas/v2/capabilities.schema.json` is read by 832 tests, the new conformance
fixture by 784). A per-package lock key could save at most ~14 % of that gate.

**Findings.**
1. **Narrowing `pack.json` saves nothing measurable.** In every replayable gate the
   selection was unchanged without it. A pack edit lands with the feature code that
   boots it, and that code invalidates the same files first.
2. **Boot wiring is the lever.** With a perfect oracle for "this boot-wiring change
   did not alter what boot produced", four of five boot-dominated gates drop by
   39–90 % (1,371→837, 1,365→533, 1,333→128, 1,360→482). The oracle is an UPPER
   bound: a change that really adds a route, tool or job changes the boot outcome,
   and every booting test must then run.
3. **The lockfile is a small lever on this repo.** The dominant lockfile change is a
   conformance pin bump, which carries schema and fixture reads that are real
   dependences. The recorder skips `node_modules`, so a per-package key cannot be
   measured from today's footprints at all.

## Decision

### D1 — Do not narrow `pack.json` reads

Closed as measured-not-worth-it. ADR 0880's open question is answered here and
corrected in place.

### D2 — Make "boot outcome unchanged" measurable before making it a rule (Proposed)

The soundness argument for skipping a booting test after a boot-wiring change is:
the test depends on boot code only through the state boot leaves behind, so if
that state is identical, the test cannot observe the change. That rests on two
things today's footprints do not have, so they come first, in shadow only:

- **Phase-split footprints.** The recorder marks the keys executed inside app boot
  (`createApp` / feature registration) separately from those executed by the test
  body. A boot-phase-only dependence on a changed file becomes a dependence on the
  boot digest instead; a test-phase execution of the same function still selects
  the file as today.
- **A boot-outcome digest.** One boot at the gate head serialises what boot
  produced: route table (method, path, handler source hash), agent/chat tools,
  node types, installed packs (content digest), chains, migrations,
  `BACKGROUND_APP_JOBS`, feature toggles and seeded rows. Functions are compared
  by source-text hash, never by identity.

The soundness hazards are explicit, and they are why this stays shadow-only until
measured: boot side effects outside the digest (module-level caches, timers,
env mutation, closures over boot-computed values). Backstops are unchanged from ADR
0880: the 20 % / 5 % audit, the 24 h full lane, and suspension on any miss.

### D3 — Lockfile: record the data, defer the rule

The recorder additionally records the set of `node_modules` packages each test
loads (data only, no decision uses it). The test toolchain (`vitest`, `@vitest/*`,
`vite`, `esbuild`, `typescript`, the recorder itself) stays a whole-lane input
regardless. Revisit once a week of footprints carries the package set and a replay
can bound a per-package key honestly.

### D4 — Size every Tracegate fix by replay, not attribution

A `reasons` count is first-reason attribution. Before proposing a narrowing rule,
replay recent gates with the cause removed (the method above). Because footprints
are evicted after ~a day of gates, a replay study must run within a day of the
gates it measures, or the gate must keep the footprints its selection used.

## Alternatives considered

- **Narrow `pack.json` with a diff rule (the original plan).** Rejected: measured
  zero savings (D1), and it was already known to be unsound (boot runs every
  loader on every manifest).
- **Treat feature registration files as non-global constants.** Rejected: adding a
  feature, route or job genuinely changes what every booting test executes (ADR 0880
  2026-10-15 addendum). Only an outcome comparison can tell "no effect" apart.
- **Per-package lock key now.** Rejected for now: unmeasurable today and bounded at
  ~14 % in the one replayable lockfile gate (D3).
- **Do nothing.** Viable: the lane is correct and in enforce with 0 misses. The
  cost is ~half of backend gates running ~50 % of files. D2 is worth it only if the
  digest is unchanged often enough, which P2 measures.

## Phases

| Phase | Work | Exit |
|---|---|---|
| P0 | This ADR; ADR 0880 open question corrected | merged |
| P1 | `tracegate.mjs replay <head> [--drop <re>] [--ignore-lock]` — the counterfactual harness, committed, with a test that it reproduces a recorded selection | replay of a fresh gate equals its logged must-run |
| P2 | Recorder: boot-phase key split + `node_modules` package set (data only); gate computes the boot digest at the head and logs "would skip N" in shadow | one week of shadow rows |
| P3 | Decide on D2 from P2's numbers: how often the digest is unchanged on boot-wiring gates, and the would-skip total. Enforce only behind the ADR 0880 entry bar, with any miss suspending | decision recorded here |

> **P1 implementation note (2026-10-23).** `tracegate.mjs replay --lane <l> --head <c> --at <iso>
> [--drop <re>] [--ignore-lock] [--node <v>] [--out <json>]` is committed with self-test rows in
> `scripts/test-tracegate.mjs` (reproduces `decide()`; dropping one cause still runs, dropping both
> skips; a clock before every footprint sees none; the live decision is untouched afterwards).
> All three were sabotage-witnessed: removing the drop filter, the clock filter, or the lock
> override turns them red. **The exit row above is CORRECTED: "equals its logged must-run" is
> not reachable.** MEASURED on four gates from the same day: replay read +1 to +2 files high
> (20 vs 14, of which 4 were replaced footprints; 118 vs 116; 121 vs 119; 22 vs 20). A footprint
> that was REPLACED since the gate is counted (`evicted`), but one DROPPED after a later failure
> leaves no trace. A replay is therefore an upper bound, and it is good for comparing scenarios
> with each other. It decays fast: `5d1e26eeb` replayed exactly (1,360) at 01:4xZ and at
> 1,383 with 256 replaced eight gates later. The Node version is inferred from the newest
> earlier footprint, because local Node moved v22.22.3 → v22.23.4 on 2026-10-22 and replaying
> under the current one invalidates every footprint.
>
> > **CORRECTED (P2 PR): the date above is wrong.** The Node v22.23.4 `.pkg` was installed
> > 2026-10-23 02:05Z (`pkgutil --pkg-info org.nodejs.node.pkg`). The binary's 10-20 mtime is
> > its build date, which the installer preserves. The first gate after the install
> > (`a5c8647dd`, 02:14Z) ran the whole backend lane once, reason `node v22.22.3 → v22.23.4`
> > on 2,567 files: correct behaviour.

> **P2 implementation note (2026-10-23) — SHADOW ONLY: nothing reads this to select or skip.**
> "P2" here is still the user-approved measurement phase (relayed 2026-10-23 10:3xZ: "shadow-only
> measurement; anything that changes what a gate runs stays out of scope until the data is read
> and taken back to the user"). No selection reads boot-shadow data; P3 is that decision.
> - **Boot marks.** `createApp` calls `globalThis.__tracegateBoot?.('start')` on entry and
>   `('end', app)` before it returns. Only the recorder defines the hook, so in production each
>   mark is one property read that short-circuits. `test/adr0968-tracegate-boot-marks.test.ts`
>   pins the call order and that the route table is identical with and without a hook.
> - **Recorder.** Each mark takes coverage (MEASURED: an un-awaited take snapshots and resets at
>   the call) and moves the reads seen so far. `loaded`, `exec` and `reads` are the UNION of the
>   windows, so they are unchanged. A new `boot` field carries the per-phase executed functions,
>   the reads, and one digest per boot from `test/support/tracegateBootDigest.ts`. That digest
>   covers the route table (handlers by source hash) and the ~22 registries with a list
>   accessor, and names the ones it cannot see.
> - **What the vitest runs found (2026-10-23), and the design they forced.** Three defects, each
>   caught by an old-vs-new footprint comparison before any shadow row existed:
>   1. **Binary coverage cannot split phases.** The recorder ran V8 coverage with
>      `callCount:false`, which reports a function only in the FIRST window it runs in, never
>      again (MEASURED in plain node). With one take per file that is harmless. With the boot
>      marks, every function that ran in boot AND in the test was invisible to the test phase,
>      so the shadow would have called an edit to it boot-only and skippable: the data would
>      have been biased toward skipping. The recorder now uses `callCount:true` (still function
>      granularity), which reports a function in every window it runs in; a footprint keeps
>      only count > 0, so the union is the same set. MEASURED: union footprints old vs new
>      identical on 126/126 backend files (20 booting, 7 non-booting, 100 seeded-random) and
>      30/30 frontend files, twice. **Cost: under review** (see the overhead table in #5155).
>      This is the one change here that every gate pays, so it is not merged on a contended
>      number.
>   2. **A script's length is only in the window that loaded it.** After a reset V8 omits a
>      script's top-level function, which is what matched a script to its source, so modules
>      from before a mark came out "unmapped". Windows are now folded by `scriptId` and
>      resolved at `afterAll`.
>   3. **The digest has to be read at `end`, synchronously, and load nothing.** Read at
>      `afterAll` it differed between two runs of one commit in 3 of 20 files (tests that
>      register workflows under random ids). Awaiting it inside `createApp` changed boot's
>      scheduling (a background job ran in one test that never ran before); preloading it at
>      `start` was not ready at `end` in 60 of 67 files. So the digest reads each registry from
>      the modules the test file already evaluated (vitest's module-runner state, verified on
>      vitest 4.1.11 and pinned: another version makes every registry part an error), runs
>      inside the `end` mark, and its coverage window and reads are discarded. No other code
>      can run inside a synchronous call, so exactly its own work is dropped. `createApp` keeps
>      two plain marks: no await, timer or import. MEASURED: digest present and identical
>      across two runs in 67/67 booting files.
> - **Ingest.** It stores `fp.boot = { n, digest, only }`, an additive field. `FP_VERSION` is
>   unchanged and `decide()` never reads it. For each booting file that ran, ingest judges it
>   against the footprints that existed BEFORE the run, and before a red drops them, with
>   `invalidatesBoot()`. That is `invalidates()` except that a change seen only through boot is
>   absorbed if the boot digest is unchanged. One row per ingest goes to
>   `boot-shadow-<host>.tsv`, rotated past 10,000 rows. Its `would_skip_failed` column is the
>   soundness signal.
> - **Proof that selection is unchanged.** The diff to `scripts/tracegate.mjs` only adds lines.
>   Every `decide()` self-test case is run through the shadow function too and must match it.
>   A replay of recent gates with the old and new code selects identical files (the table is in
>   the PR).
> - **Exit.** A week of rows, then a recommendation to the user. The next questions are how
>   often the digest is unchanged on boot-wiring gates, the would-skip total, and whether any
>   would-skip failed.
>
> > **CORRECTED 2026-10-24 (user decision) — the boot split is recorded by the daemon ONLY;
> > gates record exactly what they did before this ADR.** Defect 1's "cost: under review" was
> > measured on a quiet box under the suite claim (127 backend files, 2 workers, one discarded
> > warm-up per mode, three alternations): binary 130.3 s (129–131) vs count + boot split +
> > digest 146.7 s (146–147), **+12.5%**, ranges disjoint, footprints identical 126/126 in all
> > three pairs. That is over the 5% line, so it went back to the user with two options: every
> > gate pays ~2–2.5 min on a full backend lane, or no gate pays and only the daemon records.
> > The user chose the second. `OPENWOP_TRACEGATE_BOOT=1` turns the boot split on (count-mode
> > coverage, the `__tracegateBoot` hook, the digest module); only `tracegate-daemon.sh` sets
> > it, on the backend lane. Unset, the recorder starts binary coverage, defines no hook (so
> > `createApp`'s marks are a no-op property read in a gate too), and the setup file never
> > loads the digest module. **Consequence for the exit:** shadow rows come only from daemon
> > runs (the nightly full lane and PR-head pre-gates), so a week holds fewer rows than gates
> > would have produced, and "a week" is judged by rows, not by days.

> **CORRECTION 2026-10-27 (user go: "proceed" on fixing the boot coupling) — the first
> week of shadow data could not have shown a saving, because two rules made "boot-only"
> unreachable.** `boot-shadow-<host>.tsv` (126 daemon rows, 10-24 → 10-27): **2,752 booting
> file-runs invalidated, 0 boot-absorbable, 0 would-skip.** Not a verdict on D2:
> 1. **The import window was filed as test phase.** The recorder put everything before the
>    first `start` mark into the test bucket. This app registers its features as their modules
>    EVALUATE, on import, before `createApp`. MEASURED on four booting files: 2,186 source
>    files execute in that window, against 105–325 in the real test phase. So every feature
>    module looked test-used. The recorder now keeps that window apart (`impExec`,
>    `impReads`). Ingest files app source evaluated on import as boot, and test files,
>    helpers and fixtures as test. A footprint recorded before this keeps the old reading.
> 2. **The constant rule counted any loaded file**, the defining module included, so every
>    module with a constant was test-used. A constant is now test-used when a function the
>    test phase ran names it, or a loaded test file or helper does. App source naming it from
>    boot or import code is boot wiring, which the digest stands for.
>
> Safety: the footprint is still the UNION of every window. MEASURED: identical `loaded`,
> `exec` and `reads`, with the split on and off, on 4/4 booting files. So no gate's selection
> changes, and the split still runs only in the daemon (`OPENWOP_TRACEGATE_BOOT=1`).
> Self-test: 112 passed, with new rows for both rules: an import-only top-level edit absorbs,
> a constant a test-phase function names still runs, an import-only one absorbs, and the old
> footprint format still runs. The constant-rule sabotage is red. The import-window ingest
> sabotage is NOT red in the unit fixture, because there the effect comes from the recorder
> format (old vs new raw), which the paired old- and new-format rows cover. **P3 restarts
> its week from this merge.**

## Open questions

- [ ] Which boot side effects escape a registry digest in this codebase (module
      caches, timers, env)? P2 should list them before P3 relies on the digest.
- [ ] Should the gate keep the footprints its selection used (for later replay)
      instead of relying on `KEEP_PER_TEST` eviction?
- [ ] Does the frontend lane have an analogue? Its large selections this week were
      `vite.config.ts` (a real global) and i18n, already per-key since 2026-10-14.
