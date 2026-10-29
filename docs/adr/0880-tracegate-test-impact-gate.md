# ADR 0880 — Tracegate: a gate that runs only what a change can affect

Status: **Accepted — implemented (P0–P4).** Every lane runs in **shadow** mode
until it clears the entry bar (§P2); enforcement then switches on per lane by
itself, and switches back off by itself on any miss. P0's TypeScript 7 swap is
measured and deferred (§P0).

Research and measurements behind this decision:
<https://claude.ai/artifact/QmeiHC4FN7KRTGU1XmaTXV>.

## Context

The local gate (`npm run ci`, ADR 0863) is the merge gate, and it is slow in
the way that hurts most. MEASURED on train 52 (2026-10-13, one PR): 1,930 s, of
which backend vitest is 1,177 s. Inside that lane, workers spent **5,734 s
re-importing the app and 1,953 s running tests**. Gates are serialized per
machine, and with several sessions each one has queued **1–2 h** behind the
others (ADR 0863). And train 52 then merged nothing, because `main` moved while
it ran. Every gate runs every test file (2,545 backend, 999 frontend), whatever
the diff.

Already ruled out, and not re-opened here: `--no-isolate` (27% of files fail on
leaked state, the failing set never converges), a Cloud Build gate (~$2.25 per
gate for 15–20%), lazy feature imports (~190 ms, invisible in vitest).

The industry answers (Google TAP, Meta PTS, Datadog TIA, Nx/Turbo, Bazel, Uber
SubmitQueue, Mergify) all do some form of **selection**, and none of them trusts
selection without a **backstop**. The finer the selection, the bigger the
saving, provided the inputs are **observed** rather than declared.

### What a replay of our own history said (2026-10-12)

19 randomly sampled backend test files were run with V8 function coverage and a
file-read tracer, and the last 300 commits and 200 merged PRs were replayed
against those footprints:

| | Share of backend test work invalidated |
|---|---|
| Today | 100% |
| Module-level selection (`vitest --changed` style) | 49.3% per backend PR |
| Function-level, type-aware footprint | 37.1% per backend PR; **39.5% runtime-weighted over all 200 PRs** |
| 2-PR train, per-PR results already recorded | **20.2%** (vs 58.7% re-running everything either PR touched) |

Four findings shaped the design: 73% of top-level edits are imports and types
(they never execute); constants need a reference closure; **declared inputs
would have been wrong** (app tests read ~857 repo files outside `src/`); and the
backend clock is read by every app boot, so clock reads cannot narrow anything.

## Decision

Build **Tracegate**: every recorded vitest run deposits, per test file, a
**footprint**. A file's last green verdict is still valid on a later tree if
nothing in its footprint changed in between.

### D1 — The recorder (`scripts/lib/tracegate-recorder.mjs`)

A setup file, FIRST in each lane's `setupFiles`, loaded only when
`OPENWOP_TRACEGATE_RECORD=<dir>` is set. Per test file it records:

- **executed functions**: V8 precise coverage in its cheapest mode
  (`callCount:false, detailed:false`), one take per file;
- **loaded modules**: every repo module the file evaluated;
- **reads**: every repo path read, listed or stat'ed (`fs` + `fs/promises`
  wrapped, `syncBuiltinESMExports()` so named imports see it, symlinks resolved).

Coverage offsets are mapped to source lines through vitest's own seam:
`vm.runInThisContext(wrappedCode, { filename })` on its default `vm` import. The
worker writes each module's compiled text once per run (by hash) and records
raw offsets; `ingest` maps them afterwards, once per module.

> **How this got here (MEASURED, 39-file A/B):** the first recorder used
> `Debugger.enable` + `getScriptSource`: **+90%** wall time. Capturing the
> transform cache's `readFileSync` saw nothing (vitest's bundle binds it before
> any setup file runs). Mapping inside the worker cost 0.7–0.9 s per app file,
> and a reset take per file another ~0.4 s. The shipped design paired-A/B'd at
> **+5% mean** (−15% to +25% per round at load 16–24). That is inside the noise
> at this load and does NOT prove the <15% bar; the shadow gates' timings do.

Nothing the recorder does is assumed: a module whose text was not captured, or
whose length does not match V8's script, is `unmapped`, and any change to an
unmapped module the file loaded means "run". A vitest upgrade that moves the
seam degrades to safe, and `ingest` prints the unmapped share (>5% warns).

### D2 — Footprint keys (`scripts/tracegate.mjs`, `model()`)

TypeScript-aware, computed from the source with the compiler API:

- **functions** are keyed by their named-ancestor chain; anonymous callbacks by
  callee + first string argument (`router.get(/x)`), so one route handler is one key;
- **imports, interfaces and type aliases** are `<import>`: erased, never an input;
- a top-level `const X = <literal|object|array|arrow>` is `<const:X>`: an input
  only for files whose executed code (or test-side code, or a top-level statement
  of a loaded module) names `X`, transitively through other constants;
- **any other top-level statement** is `<top>`: an input to every file that loaded it.

A changed line is attributed **character by character** to its owners (the
innermost function, or the statement class), narrowed to the columns that
actually changed (common prefix/suffix of the paired lines). Two soundness bugs
were caught this way by the self-test before anything shipped: attributing a
line to its innermost function alone mis-attributes `items` in
`items.map((x) => …)`, and a new top-level `router.get('/new', () => 1)`.

### D3 — The ledger

`$(git rev-parse --git-common-dir)/tracegate/`, shared by every worktree on the
machine: `fp/<lane>/<sha(test file)>/<commit>.json.gz` (up to **6 per file**),
content-addressed `blobs/` for the large shared lists, and per-host logs
`shadow-<host>.tsv` / `misses-<host>.tsv`. `fp/` and `blobs/` are a cache:
deleting them only costs predictions. The logs are the evidence the entry bar reads.

A footprint is valid on tree `H` iff: same footprint format, same Node, same
lockfile, the footprint's commit still exists, and no change between its commit
and `H` touches a global input of the lane, the test file, a loaded non-source
module, an executed function key, a referenced constant, a `<top>` of a loaded
module, an unmapped loaded module, or a path it read (or a directory it listed).

The test-file list comes from **`vitest list --filesOnly`** — the hand-written
patterns first used missed `frontend/react/scripts/__tests__/` and all of
`backend/typescript/test/steward/`, and under enforce a file the selector does
not know about would never run.

### D4 — Modes, the audit and the entry bar

`OPENWOP_TRACEGATE=off|shadow|enforce|auto` (default `auto`; per lane
`OPENWOP_TRACEGATE_BACKEND` / `_FRONTEND`).

- **shadow**: run everything; print what could have been reused; log any file
  predicted reusable that FAILED as a **miss**.
- **enforce**: run only what must run plus a random **5% audit** of reusable
  files. An audited file that fails is a miss.
- **auto**: enforce iff the lane's **entry bar** is met — ≥ 20 observations
  spanning ≥ 14 days with **no miss in the last 14 days** — else shadow. It is
  re-checked on every gate, so a miss suspends enforcement for that lane by
  itself; nobody has to notice. A miss also drops the footprint that lied.

  > **CORRECTED 2026-10-13 (user decision) — the BACKEND lane enters early.**
  > Its bar is ≥ 20 observations over ≥ **1** day, no miss in the last 14 days.
  > Until the default 14-day bar would have been met it audits **20%** of reused
  > verdicts, not 5%, and the nightly full run stays the backstop. The frontend
  > keeps the 14-day bar. The evidence it was decided on: 12 clean shadow gates
  > per lane, and two deliberate real-change probes that caught every failure (see
  > Validation). A miss still suspends either lane for 14 days. Code:
  > `LANE_ENTRY` / `barFor` in `scripts/tracegate.mjs`.
  >
  > > **CORRECTED 2026-10-18 (user decision, ADR 0918) — the FRONTEND lane enters
  > > early too, on the same terms** (≥ 1 day, 20% audit until day 14). "The
  > > frontend keeps the 14-day bar" above is no longer true. It rests on 102
  > > observations over 5.4 days with 0 misses.

Tracegate can never turn a red lane green: if `select` fails the lane runs
whole and records nothing; `report` drops the footprints of every file that
failed; `ingest` refuses a tree that moved during the run (H101).

### D5 — Gate integration (`scripts/ci.sh`)

`tg_begin <lane>` → `select`; the lane runs (`tg_vitest`, with the selection
under enforce); `tg_end` → `report` inline, `ingest` in a background lane joined
at the end of the gate (55 s for the frontend's 999 files; never on the critical
path, never fails the gate).

> **CORRECTED 2026-10-13 (slot 56, the first gate with #4746) — "never on the
> critical path" was false for the backend.** Backend ingest took **~16 min** on
> one core (2,538 footprints): it re-read, re-hashed and re-scanned every loaded
> file (~1,700) for every test file. It overlapped the frontend lanes, so the
> gate's end waited only briefly, but a quicker frontend would have exposed it.
> Fixed in the follow-up (`perf/tracegate-ingest`): per-file facts
> are computed once per ingest and the constant check is an indexed lookup —
> MEASURED 85 s → 22 s (frontend, 999) and 125 s → 19 s (backend, 300 files;
> ~2.7 min projected for 2,538), with **byte-identical footprints** (1,299/1,299)
> against the old algorithm on the same tree. Ingest also gets a hard budget
> (`OPENWOP_TRACEGATE_INGEST_BUDGET_S`, default 300 s): files past it are simply
> not recorded and run next time. The self-test's scenario output ("1 MISS")
> read like a real miss in that gate log and now prints only ✓/✗ lines.

Interactions handled explicitly:

- the **live-fetch stale-entry check** (ADR 0661) needs a FULL frontend run. Under
  enforce it is skipped in the gate and run by the nightly full run instead;
- the **event-payload ratchet** (ADR 0702) is shrink-only by violation type, so a
  subset cannot invent a red; it can only miss code no selected file runs,
  which is unchanged code;
- the **date-bomb sweep** stays a full run (selection must not narrow it: that
  scope-miss is what it exists to catch).

  > **SUPERSEDED 2026-10-18 by ADR 0918 D2.** Under enforce the sweep runs the
  > frontend lane's selection. It runs whole in every FULL lane, which happens
  > in a gate at least once every 24 h. The case this line raised is a bomb in
  > an unchanged file entering the 365-day window. It is still caught, at most
  > 24 h later and ~364 days before it goes off, and it reds an unrelated gate
  > either way. A frontend `full-done` is now written only after the whole
  > sweep passes (ADR 0918 D3).

> **CORRECTED 2026-10-14 — two of these three were wrong, and the gate found it.**
> (1) The payload ratchet *can* invent a red under a subset: its **stale** check.
> A type sampled valid by a file that ran, whose only violating emitter was
> reused, reads as fixed. Slot 71 (#4780) went red that way on
> `runOrchestrator.decided`, whose admitted `noop` only
> `dispatch-iteration-counter.test.ts` emits. #4781 (38) passes `--no-stale` under
> enforce. (2) "Run by the nightly full run instead" was true of the code and
> false of the machine: **the nightly had never completed.** No `nightly.last`
> existed. Its one attempt (10-13 08:27Z) yielded at once, and every tick in its
> 01:00–05:59 local window since logged "machine busy", because gates run
> through the night. So both stale checks and the full miss sweep were handed
> to a run that did not happen. The effect was silent: an admission can only go
> stale, which widens the ratchet without reddening anything.
>
> **The backstop now lives in the gate.** `modeDecision()` runs a lane FULL
> (shadow) when its last *complete* full run is ≥ `FULL_RUN_MAX_HOURS` (24) old,
> and prints why ("last complete full run 31h ago"), so a slow gate is not
> misread as contention. A full run counts only after its stale check passes:
> `tracegate.mjs full-done --lane <l>` appends to `full-<host>.tsv`, from `ci.sh`
> and from the daemon nightly alike. A stale entry therefore keeps the lane full,
> and red, until it is fixed. That is the pre-Tracegate behaviour, which is the
> point. The nightly stays, as an opportunistic way to save a gate that cost.
> Cost: about one full lane per day inside a gate that runs anyway.

> **CORRECTED 2026-10-14 (slot 77) — a load flake counted as a MISS.** A MISS
> suspends a lane for 14 days, and it was declared the moment a predicted-reusable
> file failed. `ConnectionRequiredCard.test.tsx` failed with "Failed to fetch
> dynamically imported module" at load 11.8, while another suite was running, and
> passed 3/3 alone at the same tree. So one flake cost the frontend lane two
> weeks. (It was triaged a flake by hand: re-run alone at `2a11c1152`, 3/3 green.)
> **Now the gate re-runs each miss ONCE, alone, at the same tree, before it
> exits** (`tg_recheck_misses` in `ci.sh`; `report` writes `<run>/misses.txt`). A
> footprint hole is a deterministic function of the tree, so it fails again and
> stays a MISS. A file that passes is triaged `flake` against that head. The gate
> stays RED either way, because the file did fail. What this cannot tell apart:
> a hole that ALSO depends on load or on test order. That is accepted: the audit
> and the daily full run still sample those files.

### D6 — The daemon (`scripts/tracegate-daemon.sh`, P3)

A LaunchAgent (`install`/`uninstall`/`status`) runs `tick` every 20 min from a
tools worktree fast-forwarded to `origin/main` before bash reads the script. One
unit of work per tick:

1. **nightly** (01:00–05:59 local, once per 20 h): a full shadow run of both
   lanes on `origin/main` — refreshes every footprint, checks every reusable
   verdict, and runs the stale-entry check enforce-mode gates hand to it;
   (*corrected 2026-10-14: it had never completed; see the D5 correction.
   The gate now runs the backstop itself when this has not happened in 24 h.*)
2. **pre-gate** the most recently updated open PR head not yet done: only the
   files it can affect, at that head. A train holding that PR later reuses
   them (the **composition** property, D7);
3. **sync** with the other machine, if `config.json` names one (P4).

It **always yields**: it starts nothing while a gate, waiting gate, train or
foreign suite is live, polls every 5 s during its own batch and kills that batch
(its own pid tree only) the moment one appears. WITNESSED 2026-10-13 04:04Z: a
tick during slot 55's live gate logged "machine busy" and started nothing. Its
vitest runs under `taskpolicy -c utility` + `nice`, two workers, batches of 60,
each ingested alone.

> **Not `taskpolicy -b`.** MEASURED at load ~70: a backend `npm ci` under
> background QoS (which also throttles I/O) made no progress in 17 minutes; at
> normal priority it took 16 s. Background QoS starves work rather than
> deprioritising it.

### D7 — Train composition and self-bisection (`scripts/merge-train.sh`, P0/P3)

Keeping several footprints per file is what composes trains: a file
invalidated only by PR A has a footprint recorded at A's head, and the train
tree differs from A's head only by the other PRs. The self-test proves this on
a real three-commit history (A+B reuses A's footprint; without it, RUN).

A **red train bisects itself**: halves are re-gated on `origin/main`; a green
half merges (same tree check as a whole train); the culprit is named and left
open. A train whose `main` moved during the gate is **rebuilt and re-gated once**
(`OPENWOP_TRAIN_RETRIES`) instead of abandoned. `--no-bisect` restores the old
behaviour. `scripts/test-merge-train-bisect.sh` is a behaviour test with a fake
`gh` and a real throwaway origin; it was run against the previous
`merge-train.sh` and goes red there (5 of 12), so it is not vacuous.

#### Correction — pin PR heads at the merge boundary (2026-10-27)

The original train captured each head before its gate but checked only main
before requesting a merge. A push to a PR during the gate could therefore land
untested code; the final tree check detected the problem only after the merge.
No production occurrence is claimed here: the offline fixture demonstrates it.

Before requesting any merge, re-read every car's state and head. If any has
changed, stop so the current heads can be rebuilt and gated. Each GitHub merge
also supplies `--match-head-commit` with the recorded SHA, including through
the legacy helper, closing a push between that read and the API operation.
This does not remove the separate main-movement race; retain the final tree
comparison and existing rebuild/re-gate behavior.

The expanded real-local-origin behavior fixture passes 25 checks; the same
fixture against the previous production scripts fails six checks and shows
untested heads landing. It covers a later car changing during the gate, a
push at the API boundary, and forwarding through the isolated helper fixture.
Full application gate and merge evidence are still required for this repair.

### D8 — Sync between machines (P4)

`node scripts/tracegate.mjs sync --remote <[user@]host:/abs/.git/tracegate>`
(or `"sync"` in the ledger's `config.json`, run by the daemon). Footprints and
blobs are immutable and content-addressed, so the union is always correct;
each host owns its own log files.

## Soundness: what a footprint does NOT see (and what catches it)

| Input | Seen? | Backstop |
|---|---|---|
| Executed functions, loaded modules, file reads | yes | — |
| JSON imported by a module | statically (`jsonImports`) | — |
| i18n catalog values | per KEY looked up through the i18next store; direct table imports and whole reads keep the constant rule | audit + full run |
| Node version, lockfile | yes (global) | — |
| Environment variables | **no** — the gate's env is fixed by `ci.sh` | audit + nightly |
| Wall clock (a date bomb) | **no** | footprints older than **72 h** are never reused; nightly refresh; date-bomb sweep runs whole in each daily FULL lane, selection otherwise (ADR 0918) |
| Network, ports, other processes | **no** (tests are offline by guard) | audit + nightly |
| Flaky tests | n/a | a flaky audit failure counts as a miss; `tracegate.mjs triage <file> flake` records the human/agent verdict, and a triaged flake does not suspend enforcement |

## Alternatives considered

- **Bazel/Buck2/Nx caching** — content-addressed, but only as good as DECLARED
  inputs; our real inputs were invisible to declaration (~857 reads per app test).
  Migration cost prohibitive.
- **Datadog-style file coverage** — measured 49% vs 37% invalidated; blind to reads.
- **ML predictive selection** — needs volume and a postsubmit to catch misses.
- **More cores** (remote gate) — rejected on cost (ADR 0863 D1).

## Phases

| Phase | What | State |
|---|---|---|
| P0 | merge-train self-bisection + moved-main retry | implemented, behaviour-tested |
| P0 | `experimental.fsModuleCache` (frontend), keyed by config+lockfile hash | implemented — MEASURED −70% summed transform, −10% wall on 38 files |
| P0 | TypeScript 7 for the gate typecheck | **implemented 2026-10-16** for the backend `typecheck`/`lint` (see note below). Originally measured and deferred: backend `tsc --noEmit` **159 s → 13 s**, zero diagnostics in `src/`; blocked by 4 test files that use the TS compiler API (gone from the 7.x package) and 2 cross-`rootDir` test imports TS 7 rejects. Follow-up: pin `typescript5` as an alias for the API users, then switch. |
| P1 | recorder + ledger + shadow in every gate | implemented |
| P2 | enforce + audit + entry bar, automatic per lane | implemented; activates when the bar is met |
| P3 | daemon: nightly + PR pre-gating; frontend lane | implemented (`install` is a per-machine opt-in) |
| P4 | ledger sync between machines | implemented |

> **CORRECTION 2026-10-16 — P0's fsModuleCache could red a test with a false
> "Cannot find module".** Reported by a peer session and reproduced on
> `c828173fe` (vitest 4.1.11, vite 7.3.5). Frontend tests that import backend
> sources (`credentialRef.test.ts` → `backend/typescript/src/aiProviders/credentialRefLadder.ts`,
> and others) sit outside the vite root. Vite's `server.fs` check admits such a
> file only once import analysis of its importer has recorded it as safe. With
> the cache warm, the importer's transform is served from disk, so no import
> analysis runs. Any edit to the backend file, even an appended comment, then misses the
> cache, and the load is refused: `Failed to load url /@fs/… Does the file exist?`,
> surfaced as `Cannot find module '/@fs/…'`, "no tests". The failure is persistent.
> Reverting the file, or `OPENWOP_VITEST_FS_CACHE=0`, cleared it. The gate's train
> worktree keeps its cache between trains, so a PR editing such a backend file
> would have gone red for a reason unrelated to its diff. Fix: `server.fs.allow`
> = the repo root in `frontend/react/vitest.config.ts`. Witnessed both ways: on
> main's config, a warm cache plus an edit reds; with the fix, the same edit passes 17/17,
> and a real behaviour change to `refNamedProvider` reds the parity case with an
> AssertionError, not a module error.

> **ADDITION 2026-10-16 — every selection now says WHY.** Feature-PR gates select
> 1,200–2,200 of ~2,600 backend files (10-14 to 10-16 gate data), while small fixes
> select 10–90, and the gate logged only the count. `select` now prints the top 5
> reasons, with the per-test detail folded away: "executed function X in F" becomes
> "executed code in F", and "constant C in F" becomes "constant in F". It also
> appends one row per gate to `reasons-<host>.tsv` (top 10 as JSON), which `sync`
> shares like the other logs. This follows the "explain each selection" practice of
> predictive-selection tools. It also tells us which narrowing to do, if any, before we
> design one: the `pack.json` boot-outcome ADR waits on a week of these rows. First
> reading, a probe that adds one empty migration to `storage/postgres/schema.ts` at
> `aee0febbc`: 1,842 must run, 1,392 of them for "constant in …/schema.ts"
> (`MIGRATIONS`), and 343 for "executed code in routes/discovery.ts", a file the
> probe did not touch. Those 343 are footprint age: diffs on main since the footprint
> was recorded.

## Validation recorded at implementation

- `scripts/test-tracegate.mjs` — 29+ assertions in a throwaway repo, both
  directions on every rule (a predictor that always runs and one that always
  skips each fail), plus composition, audit-miss suspension, entry bar, sync.
- **Real-change probe (frontend):** `SYSTEM_SITE_ORG` changed on a temp commit.
  Tracegate selected **24 of 999** files; all 999 were then run: **4 failed, all 4
  were among the 24; the 975 reused verdicts all passed.**
- Full frontend lane with the recorder: 999/999 green, 0.4% unmapped.
- **Real-change probe (backend), 2026-10-13 on `6492530fc`:** the default of
  `commerceService.ts::currencyOf` changed `'USD'` → `'EUR'` on a throwaway
  commit. Tracegate selected **139 of 2,550** files (60 execute `currencyOf`, 68
  read the source file, 11 had no footprint). The full suite then ran: **2
  failed (`commerce-route`, `kicktodo-share-ledger`), both among the 139; the
  2,411 reused verdicts all passed.**
- **First gates on main (shadow):** slot 56 — 312/2,549 backend reusable (cold
  ledger), 0 misses; slot 58 — **14/2,550 backend files needed (1.9% of lane
  time), 0/1,001 frontend**, 0 misses; backend ingest 141 s after #4752.

## Evaluation after one day (2026-10-13)

MEASURED from the ledger logs (`shadow-*.tsv`, `daemon.log`) and four gate logs:

- **Selection is far better than projected.** Median backend gate would re-run
  **2.7%** of lane time (9 of 12 gates under 10%); the replay projected ~40%.
  Frontend 0–3% on 8 of 12 gates. **0 misses**, every gate.
- **No gate is faster yet.** Every gate still runs everything (shadow). Gates
  took 34–49 min: backend vitest 22–31 min of that, frontend vitest 4–6, e2e +
  CSP + audit ~3, the date-bomb sweep 3–5. Throughput was ~18 gates in 17.5 h,
  so the queue, not one gate, is the cost.
- **Whole-file data reads were the coarse spot.** Four frontend gates had to run
  all ~1,000 files because every test reads `test-live-fetch-allowlist.txt` and
  every grade-tests train edits it. Fixed with **projected reads** (D2 addendum
  below). On the backend, app boot reads every pack's `pack.json`, so one pack
  edit re-runs ~1,200 files (the 70% gate); pack edits are ~7% of commits. Not
  yet narrowed.
- **The daemon's pre-gating delivered nothing.** It ran PR heads as pushed: a
  head 75 commits behind main had another lockfile, so all 2,540 backend files
  had to run for a docs-only PR, and gates killed every attempt. It now merges
  onto the current main first (see the daemon header). Its log also doubled
  every line, and one `git fetch` failure aborted a tick; both fixed.
- **A soundness hole, found while testing these changes.** `changedKeys` and
  `fileInfo` caught ANY error as "file added / missing". Without a TypeScript
  install, `model()` threw, every changed file yielded no keys, and seven
  self-test RUN cases became SKIP. Gates were not exposed (they always have
  TypeScript), but the failure mode was fail-open. Only a missing file is now
  treated as one; a model error propagates and `select` runs the file.
- **Step 4, the next bottleneck, is instrumented, not yet measured.** Once the
  backend lane shrinks, the conformance-major-2 lane (~7 min, started after
  backend vitest) and the date-bomb sweep become the critical path. Every
  background lane now prints how long it ran and how long the gate waited for it
  at its join, so the first enforce gates will say which.

### D2 addendum — projected reads

A lane may declare `projected: { <path>: (testFile, before, after) => changed }`
for a data file whose effect on ONE test is a known function of its content. A
modified projected file invalidates a test only when that function says its
answer for the test changed. The only entry: the live-fetch allowlist, where the
answer is "is this test file listed?". The parse matches the guard's, and the
guard lives under `src/test/` (a global input), so a guard change still runs the
whole lane. An added or deleted projected file falls through to the normal rule.

### D2 addendum — key-level i18n reads (2026-10-14)

Every frontend test boots the whole English catalog, and each table is ONE
`export const messages = {…}`, so under the constant rule one string edit re-ran
the lane (988 of 1,003 footprints named `features/csm/i18n/en.ts::messages`).

- **Recorder** (`frontend/react/src/test/tracegate-i18n-recorder.ts`, record runs
  only, AFTER `i18n-setup.ts` so the setup's bulk load is not counted): wraps the
  i18next store, the one place `Translator` reads the catalog. It records each key
  looked up (`<lng>\0<ns>\0<dotted.path>`, misses included, so plural/context/
  fallback probes are there) and any read that can see more than one key (a
  bundle, a language's data, the raw `data`, `createInstance`/`cloneInstance`) as
  a WHOLE read. Presence checks and writes are not reads.
- **Ingest:** a test that loads a module importing `src/i18n/resources.ts` (other
  than the aggregators) records no key reads; a table that some loaded module
  imports DIRECTLY keeps the constant rule for that table.
- **Decide** (`scripts/lib/tracegate-i18n.mjs`): a MODIFIED catalog whose change is
  confined to the `messages` literal, and whose literal is plain data on both
  sides, invalidates a test only when a key whose value changed overlaps a key
  it looked up (prefix either way, for `returnObjects`) or it read that table
  whole. `en-XA` (the pseudo-locale, generated from `en`) counts as `en`. A
  comment or formatting edit changes no value and invalidates nothing. Anything
  else (an added/deleted table, a change outside the literal, a spread or
  identifier in it, a footprint without key reads) falls back to the constant rule.

**MEASURED at b97fda759** (full frontend lane, recorded): 1,007 of 1,008 footprints
carry key reads (the one exception is `i18n/__tests__/i18n.test.ts`, which imports
the aggregator); 393 read no key at all (they mock `react-i18next`); 2 read the
whole store; 55 import some table directly. 9,764 distinct keys were looked up,
median readers per key 1, max 156 (`common:loading`).

**Soundness witness:** a probe commit changed two asserted strings,
`kicktodo-admin:exceptionChainError` and `common:retry`. Tracegate selected **73
of 1,008** files (67 `common:retry` readers, 4 for the feature key or its direct
importers, 2 whole-store readers); the full lane at that commit then failed **49
files, all 49 inside the selection** (0 holes). The old rule would have selected
all 1,008. Self-test: 14 rows; sabotaging the hit test, the pseudo-locale mapping
or the direct-importer rule each turns its row red.

### D2 addendum — backend selectivity study; plain-data collections are constants (2026-10-15)

**MEASURED** by replaying 24 recent merged PRs onto the footprints of the
426f90bfb full backend run (2,581 files): median **155** files selected, but
**10 of 24 PRs selected over 1,000**. The causes, by PR:

| PR | Selected | Main cause |
|---|---|---|
| #4826 | 1,896 | `<top>` edit in `executor/sideEffectFloor.generated.ts` (1,794) |
| #4814 | 2,047 | a deleted boot module (1,223); `<top>` in `packs/packContentDigest.ts` (645) |
| #4817 | 1,863 | registration code in `kicktodo-commerce/routes.ts` (689); `<top>` in `host/approvalService.ts` (533) |
| #4798 | 1,389 | `<top>` in `features/billing/billingService.ts` (1,316) |
| #4795 | 1,295 | the `BACKGROUND_APP_JOBS` constant in `host/appMigrations.ts` (1,144) |

`pack.json` is the smaller problem: 15 of the last 150 merges touched one. A
description-only edit selects 1,170–1,220 files, because boot reads every
manifest and runs it through every loader (chain expansion and the rest).
That dependence is real, so plain diffing cannot narrow it. The open question
below stays open.

Two of the `<top>` causes were a module-level `new Set([...])` / `new Map()`:
the side-effect floor is three generated `new Set([...])` lists, read only via
`.has(typeId)`, and #4798's `<top>` was a new, empty `new Map()` cache. Neither
has a load-time side effect, and a test sees one only through code that names
it. So `isPureInit` now accepts `new Set|Map|WeakSet|WeakMap(<nothing | one pure
literal>)` as a constant, unless the file binds a local constructor of that
name. **`FP_VERSION` 2 → 3**: a footprint's constant list is computed at
ingest, and one ingested under the old rule never lists these. Reusing it would
SKIP an edit to one, so every lane runs full once after this lands.

Not narrowed, and why: `BACKGROUND_APP_JOBS` (boot runs every job, so adding one
changes what every booting test executes), route/tool registration functions
(boot executes them), and deleted boot modules.

### D2 addendum — a test file is never a global input (2026-10-16)

The first day of the reasons log (`reasons-<host>.tsv`, #4883) showed one
frontend gate (`22eddddc37e0`) selecting **1,037 of 1,037** files, 971 of them for
`global input frontend/react/src/test/__tests__/clockshift-armed.test.ts`. The
lane's `global` pattern names the whole `src/test/` directory (the setup files),
and that directory also holds two ordinary test files. A test file is not a setup
input: only its own run loads it, and if another test imports it, that test's
footprint lists it as a loaded module, which the next check already runs. So
`decide()` now skips the global rule for `*.test|spec.ts(x)` paths. Same rule in
both lanes (the backend's `test/setup/` has no test files today).

MEASURED by simulating that edit on `main` against the live ledger: **18 / 1,041**
must run with the rule, **1,041 / 1,041** without it. Self-test 66 → 68 (a setup
file still runs everything; a test file in the setup directory does not), and the
new case reds with the old rule.

Also read from the same log, and left alone: the 12 backend files that are always
"no footprint" are the live/Docker tests (`*-postgres-live`, `pgvector-live`,
`opensearch-live`, `wasi-sandbox`, …). They skip themselves locally, so they never
record a footprint and cost seconds to "run".

## Open questions

- [ ] The recorder's real overhead under a quiet machine — read it off the shadow gates.
- [x] Backend probe on a real change — sound (see Validation).
- [x] TS 7 adoption (P0 follow-up above) — backend typecheck, 2026-10-16.
> **ADDITION 2026-10-16 — the backend gate typecheck runs on TypeScript 7.0.2.** The
> blocker cleared upstream: 7.0 ships no compiler API until 7.1, and Microsoft's
> documented pattern is a side-by-side install under an npm alias. So
> `typescript` stays 5.9.3 for the four test files that use the API, and
> `@typescript/native` = `npm:typescript@7.0.2` runs `typecheck` and `lint`. The
> scripts call each compiler by path, because both packages declare a `tsc` bin
> and npm linked `.bin/tsc` to 7.0. `build:tsc` stays on 5.9. The two
> cross-`rootDir` test imports (TS6059) were TS 7's new `rootDir` default (the
> tsconfig's folder); `"rootDir": "../.."` states what 5.9 already inferred (the
> common root of every input, frontend files included), so 5.9's output layout
> is unchanged. MEASURED on one machine at `aee0febbc`: 51.6 s (5.9) → 5.4 s
> (7.0), both clean. A planted type error reds 7.0 in `src/` and in `test/`. The
> seven API/moved-import test files pass (233/233). Lockfile: +21 entries
> (`@typescript/native` plus its per-platform optional binaries, linux-x64
> included), 0 removed, and `@azure/core-rest-pipeline` is intact. The frontend's two tsc
> passes run in the background and are not converted here.
- [ ] Should conformance scenarios get footprints (their inputs are server-side)?
- [x] Narrow the boot-time `pack.json` reads (one pack edit re-runs ~1,200 backend files).
      MEASURED 2026-10-15: confirmed (1,170–1,220 per description-only edit), but only 10% of merges touch one, and the dependence is real (every loader runs on every manifest at boot). Needs a 'boot outcome unchanged' design, not a diff rule. See the 2026-10-15 addendum.
      > **CORRECTED 2026-10-23 (ADR 0968): answered NO — narrowing `pack.json` saves nothing.**
      > Over a week of gates (119 backend heads) it was never the top must-run reason, and an exact
      > counterfactual replay of the recent gates selected the same files with every `pack.json`
      > change removed: a pack edit lands with the feature code that boots it, and that code
      > invalidates the same files first. The real levers are boot wiring (`features/index.ts`,
      > `feature.ts`, `bootstrap/`; a perfect oracle cuts 39–90 % in 4 of 5 boot-dominated gates)
      > and, much less, the lockfile. ADR 0968 takes those up.
- [x] Narrow i18n tables: 988 of 1,003 frontend footprints name `features/csm/i18n/en.ts::messages`
      (the bundle merges every feature's table), so one English-string edit re-runs the lane.
      Done 2026-10-14: key-level reads (D2 addendum above); a two-string probe selected 73/1,008, 49/49 reds inside.
- [ ] Read the background-lane join waits off the first enforce gates (step 4).

## Soundness correction — opaque child processes (2026-10-25 recovery)

A real shadow MISS at candidateaf0ffc0ca reproduced alone:
`test/steward/adr-status-not-stale.test.ts` reads `git log` through
`execFileSync`. A newly merged implementing subject for ADR0970 changed its
answer without changing the ADR file or any recorded filesystem input. The
previous green at06d6726ca therefore was not reusable. The lane remains under
its existing14-day MISS suspension; this is not a flake.

Child-process stdout/stderr, Git history, environment and child file reads are
opaque to this in-process recorder. Record whether the test spawned a process,
and always run such a footprint, including on the same HEAD. Do not pretend the
parent's filesystem reads cover the child. Sync calls and async/promisified
calls must preserve their original return shapes. Bump the footprint format so
older receipts that never recorded this fact cannot grant reuse. Boot-shadow
prediction must obey the same conservative rule and cannot absorb it. Keep the
existing ledger/logs and MISS evidence. Runtime capture and an empty-tree Git
commit witness are required before relying on this repair.

Focused repair validation:94self-test checks passed, including actual synchronous
and promisified process capture, unchanged stdout/stderr, marker reset,
empty-tree history invalidation, filesystem-only reuse and boot-shadow refusal.
The reproduced ADR status file passed8cases and the Brand first-read file7cases.
Full canonical composition validation remains required; no MISS suspension or
historical ledger log was removed or reclassified.

### Correction — check global invalidation before per-file parsing (2026-10-27)

Train 247 on Davids-MacBook-Air spent 1,327.91 seconds (22 minutes 8 seconds)
in frontend selection before starting Vitest. This is the interval from the
prediction start timestamp to the completed prediction file's modification time,
not a measured speedup of the repair. Its recorder change already invalidated every
older footprint, but the selector encountered that path after frontend catalog
changes and performed per-file Git reads first. In two read-only measurements
against candidate `2d57948c9`, selection took 217 and 205 Git calls and 2.40 s
and 2.11 s respectively; checking the existing global-input predicate first
returned the same RUN reasons in 12 and 6 calls, taking 0.15 s and 0.07 s.
These are two sampled decisions, not a measured whole-lane speedup.

Apply the existing global-input rule before reading footprint blobs or parsing
per-file changes. Keep the existing exception for test files under setup
directories, the same-commit fast path, runtime/lock/age checks, and the search
through older footprints. This changes which invalidation reason wins when
several apply; it does not grant any new verdict reuse.

The real-Git regression includes an unused source edit before the recorder path
and requires RUN without per-file `git show` or hunk reads. The old implementation
fails that check with three unnecessary reads. The complete selector self-test
on base `9970a354d` passes 108 checks with the fix; reverting only the fix yields
one failure and 107 passes. Full merge-gate validation remains pending. The
running train was left untouched.

### Correction — incomplete results are not observations (2026-10-28)

Air release260-r0 was interrupted with exit 143 at 09:24:55Z when macOS memory
pressure reached warning level. Its backend prediction selected 2,927 files,
but Vitest never wrote `results.json`. `report` nevertheless printed that all
2,927 files ran, reported zero misses, and appended a `shadow-*.tsv` observation.
The gate did not pass; the reporting and enforcement-entry evidence was wrong.

Only append a prediction observation when every selected file has a terminal
`passed` or `failed` result. In shadow mode every predicted file is selected;
in enforce mode only required files and audits need results. A wholly reused
lane supplies no new observation. Missing, malformed, partial or nonterminal
results print the observed/expected denominator and do not claim zero misses.
Actual failures still invalidate their footprints, and a witnessed failed audit
still records a MISS and suspends enforcement even when its run is incomplete.
No existing ledger logs are deleted or rewritten by this correction.

The isolated CLI witness failed nine cases against the original implementation,
with two complete-run controls passing. All 11 pass with the correction, and
the existing selector self-test passes 113 checks. The interrupted real run's
prediction and missing-result observation are retained in the coordinator's
`tracegate-report-verification.json` evidence. Full merge-gate qualification is
still required; these focused results are not a release verdict.


### Correction — full observed coverage in enforce mode (2026-10-28)

Release260 selected and passed all 1,146 frontend files after a version-only
lockfile invalidation, but the live-fetch stale-entry step said a subset ran and
skipped its assertion. `enforce` describes the selection policy; it does not
prove that fewer than all files executed. The scheduled full backstop remained
in place, so this was a missed opportunity to run the existing assertion.

The report now emits a small coverage record from terminal results. A nonempty
lane qualifies only when every predicted file was selected and has a passing
result. `ci.sh` reads that record before ingest deletes the run directory, and
runs the existing stale checker for a qualifying enforce run. Missing, partial,
failed or reused-but-unobserved files do not qualify. Shadow/off behavior and the
24-hour full-run/date-sweep backstop are unchanged; this adds a check and grants
no extra cache reuse. After release260 completed, all 24 report/integration
checks passed. The extracted actual CI block invokes the real stale checker:
an unobserved entry fails after full coverage and is not judged on a subset.
Restoring the old mode-only condition separately makes that refusal test RED;
removing the passing-result condition makes the failed-file guard test RED.
Both source guards were restored and all 24 checks passed again. Full CI for
this follow-up remains queued separately from the release.


### Correction — imported bindings affect unchanged functions (2026-10-28)

PR #5360 invalidates new imports when the target module was not loaded, and
removed or replaced imports from their old spans. Loaded-module membership
does not prove binding neutrality: an insertion-only alias retarget can change
the imported function, and a newly imported name can shadow a global used by an
unchanged function. Both are valid programs. The self-test executes these
fixtures (3 -> 4 and 3 -> 103) and checks both live and boot-shadow decisions.

Changed value imports now invalidate every footprint that loaded the importer,
even when it already loaded the target. Type-only imports and unrelated cold
function changes retain their existing reuse behavior. This is a conservative
correctness repair; finer binding-aware reuse needs separate observed evidence.
No ledger history, audit policy or entry-bar threshold is changed.
