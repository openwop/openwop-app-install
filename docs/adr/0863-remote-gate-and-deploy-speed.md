# ADR 0863 — gate and deploy speed on the dev Macs

Status: implemented. D2–D8 are on main. D1 (a remote Cloud Build gate) was piloted and **rejected on cost** on 2026-10-08; the lazy-import experiment remains parked.

## Context

The gate (`npm run ci`) and the deploy (`scripts/deploy.sh`) run on the
developers' Macs, and several Claude Code sessions share each machine. MEASURED
2026-10-01 and 2026-10-08:

| | Measured |
|---|---|
| Waiting behind other sessions' gates | **1–2 h per gate**, the largest cost |
| Full gate, quiet M1 (8-core / 16 GB) | ~40–45 min |
| Full gate, loaded machine | 60–75 min. Backend vitest: 1,058 s at load 4, 1,432 s at load 11, 2,138 s at load 18 |
| Backend vitest | 2,486 files / 20k tests; **import ≈ 68% of worker time** |
| Cloud Run image build | 183 s with `--no-cache` (forced by `run deploy --source`) + 31 s push |
| Deploy, end to end | ~16 min |

The backend suite is mostly module loading (~1,031 files boot `createApp` in
isolation) and scales with cores. Running without isolation (`--no-isolate`), the
threads pool, and native loading were measured on 2026-10-01 and rejected, and
that still stands.

## D1 — Remote gate on Cloud Build: PILOTED, REJECTED (cost)

A pilot built `scripts/ci-remote.sh`. It ran the unchanged `ci.sh` on an
`e2-highcpu-32` Cloud Build VM, one VM per gate, so gates could run in parallel.
It reached a near-green run: every backend, conformance and frontend-unit lane
was green, and only the not-yet-committed `-linux` pixel baselines were left. It
was removed when the user ruled the cost out. **What it measured, for the next
person who asks:**

| | Measured |
|---|---|
| Backend vitest, 32 E2 vCPU | **635–715 s** (M1: 1,058–2,138 s) |
| Frontend vitest | 115–126 s |
| Whole remote gate | **35.6 min**: 64 s waiting for a VM, ~2 min setup, ~32 min `ci.sh` |
| Cost | **$0.0624 / build-minute** ([Cloud Build pricing](https://cloud.google.com/build/pricing)), so **~$2.25 per gate** and roughly $1,000/month at ~20 gates/day (2,500 free minutes/month, shared with deploy builds) |

**Why it is not worth that.** Per gate it beats a quiet M1 by only ~15–20%:
E2 vCPUs are hyperthreads and much slower per core than Apple silicon. The real
gain was concurrency (no queue), not speed. The cost estimate that justified it
("about a dollar or less") was wrong by more than 2×. Other findings from the pilot:

- Regional Cloud Build pools refuse `e2-highcpu-32` on a quota restriction; only
  the global pool runs it.
- The Compute Engine API is not enabled on `openwop-dev`. A spot c4d/c3d VM
  (faster per core, much cheaper per hour) is the cheaper cloud shape if this is
  ever revisited, as a separate decision.
- The pilot's GCS bucket, IAM grant and probe image were all deleted.

## D2 — Share the agent loader's meta-schema compile (#4616)

`SharedMetaAjv2020` validates schemas against ONE compiled 2020-12 meta-schema
per process. Before, every per-pack `Ajv2020` recompiled it. Per-pack `$id`
isolation, "invalid handoff schema → agent skipped" (RFC 0003 §D) and the error
text are unchanged.

> **CORRECTION, same day.** The first estimate (~1.3 s of a ~2 s boot) came
> from a profile at **load 23** and was inflated. At load ~7: `createApp` median
> **589 → 442 ms** (−25%), about 150 ms per boot, roughly 2–3 worker-minutes per
> gate. It is real and safe, and it also helps production cold start, but it is minor.

## D3 — Deploy: frontend built during certify; no `chown -R` layer (#4617)

- The frontend build starts in the background before certify and is **awaited
  before `gcloud run deploy`**. That saves ~3 min and is stricter: before, only
  the frontend's deps were proven before the backend shipped, so a failing build
  could half-deploy. `OPENWOP_DEPLOY_FRONTEND_PARALLEL=0` serialises it.
- The Dockerfile sets ownership as files land (`USER node` + `COPY --chown`)
  instead of a trailing `RUN chown -R`, which duplicated every file into a second
  layer. MEASURED: image **410 MB → 294 MB** compressed, same file ownership.
- **Rejected:** building the image in parallel with certify. Certify writes
  `build-meta/`, which the Dockerfile COPYs, and `test-deploy-gates.sh` pins
  that order.
- **Deferred:** a layer-cached image build (`builds submit` + `run deploy --image`).
  It changes deploy provenance and needs `/architect`.

> **CORRECTION, delivery reconciliation 2026-10-08.** The replacement deploy
> lane initially supervised only the frontend. A targeted SIGTERM to the Bash
> wrapper while certification ran in the foreground deferred its signal trap,
> leaving certification work alive until the command returned. Certification
> now runs through the same owned-process supervisor with a recorded PID and
> responsive background wait; the wrapper cancels only its frontend and
> certification supervisors. The certify command, backend cwd, origin-unset
> semantics, major-2 ratchet command and refusal-before-provider-write order
> are unchanged. Three additional executable wrapper witnesses cover
> certification cancellation and major-2 failure/cancellation, retaining the
> frontend metadata/origin checks. This restores the narrow reviewed repair
> from the earlier draft; it does not restore rejected D1 remote-gate tooling.

## D4 — Real defects the Linux pilot exposed, kept

A clean Linux machine sees what a long-lived Mac checkout hides:

- `code-exec-agent-tool.test.ts`: its WASI arm skips when the wasm asset is
  absent, which is every local checkout. So it never saw ADR 0820 §8.2's access
  gate, and it failed as soon as it ran. The fix registers the toggle default.
- `rfc0215-webhook-delivery-isolation.test.ts`: asserted `inFlight()===1` before
  the healthy attempt settled, a race. The fix waits for it to settle.
- `admin-governance.spec.ts`: a 60 s per-route wait inside the default 30 s test
  budget. The fix budgets the test for the waits it declares.
- `workflow-author-agent-pack.test.ts` (found by a parallel Codex review,
  `fedcda205`): the fixture walked five parents up from `backend/typescript/test`
  instead of three, so its explicit pack load pointed outside the repo. Local
  pack mounting masked it. With `OPENWOP_MOUNT_LOCAL_PACKS=false`, `main` fails
  2/2 and the fix passes 2/2. It now also asserts the loader returned the agent.
- `gate_kill_tree` (`scripts/lib/gate-ports.sh`): `pkill -P` leaked Vite when
  `npm run dev` adds an `sh -c` level. There is a grandchild test, checked by
  sabotage.
- GNU/Linux portability for any future hosted CI or adopter: `mktemp -t`
  (BSD-only) replaced at 5 sites, and `preflight-suite.sh` reads `/proc`/`nproc`
  where `sysctl`/`vm_stat` are absent.

## D5 — `ci.sh` step banners carry elapsed time

`▶ <step> [+Ns]`, so any gate log answers "where did the time go" without a re-run.

## D6 — Overlap the lanes that wait with the lanes that compute

MEASURED with the D5 banners on the full train gate (`f5cfe93a7`, 3,128 s,
EXIT 0): backend vitest 1,811 s; frontend lane ~790 s (lint 17, build 75,
types 48, vitest 219, e2e 138, CSP 37, date-bomb 249); conformance@major2
312 s; a 208 s preamble. On 8 cores, overlapping two CPU-bound lanes buys
little. Overlapping a lane that waits, or uses one core, is nearly free:

| Lane | Wall / CPU | Now runs beside |
|---|---|---|
| `test-deploy-gates.sh` + `test-owned-deploy.mjs` | 101 s / 65 s (load 36) | backend typecheck → vitest |
| `test-preflight-suite.sh` | 190 s / 56 s (load 66): ~50 arms of fixed 2–4 s polls | backend typecheck → vitest |
| conformance@major2 | 312 s, `--no-file-parallelism` (~1 core) | the frontend lane, joined before the date-bomb sweep |

Expected saving on a quiet machine: ~150 s (self-tests) + ~300 s (conformance)
≈ **7–8 min of a 52-min gate**. `ci.sh` gains `bg_lane_start` / `bg_lane_join`:
the lane's log is replayed whole at the join, a red fails the gate with the
lane's exit code, and any exit kills every live lane's whole subtree
(`gate_kill_tree`). `OPENWOP_CI_SERIAL_LANES=1` restores the in-line order.

**MEASURED, D6 gate on `perf/ci-lane-overlap` (EXIT 0, 2026-10-09, after a
90-min queue cap, so contended):** 2,036 s total vs 3,128 s. Backend vitest ran
1,201 s vs 1,811 s, which is machine load, not D6. Excluding vitest:
**835 s vs 1,317 s, a saving of ~8 min**. Vitest started at +137 s
instead of +208 s (+61 s on a quieter earlier run). Conformance was joined with zero
wait: it finished inside the 511 s frontend lane. The frontend build cost
+12 s beside it (87 s vs 75 s).

The first D6 run red one frontend test, `marketplaceHub.test.tsx`, at load 40.
It asserted a lazy tab pane synchronously and raced its Suspense fallback. The
file passed 3/3 alone, and its race reproduces with a 300 ms import delay, so it
was fixed in the test, not attributed to D6.

**Trade-off:** a red self-test is reported after backend vitest instead of
before it. `test-gate-tooling.sh` (11 s) stays in line and first, because it
tests `gate_kill_tree`, which the background lanes depend on.

**Not overlapped:** the date-bomb sweep (a second full frontend vitest, CPU-bound,
and already known to red under load) and backend vitest with anything CPU-heavy.

**Integration note (2026-10-09):** the original D6 branch started at
`44dac5b29`; its measured gate above predates the later host-event, data-write,
blob and auth-regression integration. D6 is integrated with that release's
`dc929e5d1` main before validating the combined gate. The application runtime
changes from that release are retained. The combined gate exposed an existing
relay test setup race: after its probe released the port, the real listener
raised `EADDRINUSE` and the hook timed out before the test body ran. The probe
and actual listener also used different address scopes; the original occupant
was not identified. A controlled matching-listener probe reproduces the old
loss of ownership on both macOS and Linux. The
fixture now binds its actual listener first and keeps it bound while building
the app, whose self-HTTP bridge receives that same assigned port. Functional
assertions and timeouts are unchanged. This integration changes only CI
scheduling, test setup/waits, and this ADR; application runtime files are intact.

> **CORRECTED 2026-10-14 — the conformance ∥ frontend-vitest overlap reds the
> frontend lane under load.** "Conformance was joined with zero wait: it finished
> inside the 511 s frontend lane" describes the overlap D6 chose. Slot 77 went red
> three times on three DIFFERENT async UI tests: `ConnectionRequiredCard`,
> `ExceptionLedgerRow` and `systemSiteScope`. Each passed 3/3 alone on the train
> tree. In every one, frontend vitest (all 1,008 files) started 8 s after
> conformance-m2 went to the background at +405–466 s, at load 12–20. The same
> tree went GREEN with `OPENWOP_CI_SERIAL_LANES=1` at similar load and with the
> Tracegate recorder still on, which isolates the overlap. That is one green: evidence, not
> proof. The overlap itself is old. ADR 0880's backend Tracegate made backend
> vitest short (≈ 5 min, was ≈ 20), so the overlap now lands on the frontend run
> at a busier time than before.
>
> **Fix: narrow the frontend run instead of serialising it.** While any background
> lane is live, frontend vitest runs with `VITEST_MAX_WORKERS=4`
> (`OPENWOP_CI_FE_WORKERS_BESIDE_BG`), against the default 7 on an 8-core machine.
> Vitest 4 reads that env var. The gate log prints the cap and the lanes it
> yielded to, plus the frontend run's seconds, so the cost can be read off
> gates rather than assumed. If reds continue under the cap, the next step is to
> join conformance-m2 before frontend vitest (≈ +5–7 min a gate). The date-bomb
> sweep was already outside the overlap.

## D7 — Frontend lint, build and types use the preamble's idle cores

MEASURED from the D6 gate's vitest summary: backend vitest keeps **~6.7 of its 7
workers busy for the whole run** (8,044 worker-seconds over 1,199 s), so after
D6 there is no spare CPU left beside it. Anything else placed there only takes
cores from it. The backend PREAMBLE is the opposite: ~2 minutes (typecheck,
distribution checks, esbuild build, shutdown and e2e-wiring probes) on mostly
one busy core.

Frontend lint + build + unit-test types (~125–170 s; two single-threaded `tsc`
passes, eslint, a vite build) need nothing the preamble produces. The default
distribution writes no file: `prebuild` is a no-op for it, and `vite.config.ts`
derives the registry in memory. So they start in the background at the top of
the preamble, and are **joined before backend vitest**, not after. A frontend
lint or type error still fails the gate in its first minutes, and backend vitest
never shares the machine with them. Expected saving: ~2 min.

**Measured and not done (yet):** making the feature-only third-party packages that
`src/index` imports eagerly (pdfkit, mammoth, docx, pptxgenjs, jszip, resvg,
node-saml, graphql, nodemailer, web-push, the OTel exporters) load on first use.
Natively, all 33 eager packages take ~480 ms against ~215 ms for the core set
(best of 5, load ~23). About 0.26 s per file × the 1,064 test files that import
`src/index`, ÷ 7 workers ≈ **40–90 s of backend vitest**, plus production cold
start. It is real, but it touches many import sites. Most of the 2.25 s per-file
import is the app's own ~1,800 modules, not third-party.

> **Correction, 2026-10-09 — implemented and parked on `perf/lazy-feature-deps`
> (2f045093d, no PR).** The estimate above did not survive measurement.
> Natively, importing the app falls ~594 → ~380 ms with the candidates stubbed,
> ~190 ms of it from the 14 packages changed. In vitest it was **not detectable**:
> 40 test files over 7 A/B rounds gave −2% CPU against ±10% noise from peer
> load, consistent with ~30 s per gate. In production only 4 packages actually
> defer: the esbuild bundle inlines first-party dynamic imports and hoists their
> static externals, so `import('./render.js')` leaves pdfkit, pptxgenjs,
> markdown-it and docx eager. Not proposed, because it cannot be shown to speed
> up the gate.

**D7 measurement: not yet clean.** Its first gate (006106b8e) waited out the
90-minute cap and ran under the DEBT-3 banner at load 54–74. Backend vitest took
3,236 s against 1,811 s on a quiet run, so the timings measure the contention,
not D7. Backend vitest 2,495/2,495 files passed. The one red was a frontend
`findByRole` timeout in `documentVersionHistory.test.tsx`, a file this diff does
not touch; it passed 3/3 on its own at load 47. Under that load the frontend
static lane was the preamble's critical path (joined at +247 s, finished at
+588 s). That is likely still shorter than the serial order, which puts those steps
after the preamble. The saving is re-measured on the next quiet gate.

**Second gate (train #4639, started at load 2.9), and a follow-up.** The
preamble finished at +98 s, but backend vitest started at +196 s: the three
frontend steps took 181 s run one after another beside it, against 130–169 s
serially in D6's gates. Net D7 saving there was only ~30–70 s. So the three
now also run beside each other (none writes what another reads; no tsc pass
is incremental), which bounds the lane by the build (~75–87 s quiet). Not yet
measured quiet: one run at load ~28 took 233 s, all of it the build. The same
train went red on `legal-hold-gates-erasure.test.ts`, a test that takes 15.3 s
alone against its 15 s timeout (fixed separately in #4641).

### D7 implementation completion — 2026-10-09

The earlier failed measurements remain above as historical observations. The
captured scheduling follow-up `4bcebb546` is merged through #4642 at
`d2b8ebcd2`. Its final integrated candidate was `cce4a4f90`, tree
`5d0afd0f73beda2abff60d5ea7b5fa08e855bd2d`.

| Phase | Commit / disposition | Actual validation |
|---|---|---|
| D2–D6 | #4612, #4616 and #4617 integrated through #4622 | Canonical CI, Linux and fresh Cloud Build passed before their earlier production deployment. |
| D7 | `4bcebb546`, integrated on main at `d2b8ebcd2` | Final canonical CI ran 18:06:03–18:39:01 UTC with a clean start/end. The frontend static lane joined at +78s; backend vitest started at +95s. All normal frontend, future-date frontend, browser and CSP gates passed. |
| D7 failure/cleanup | Same `scripts/ci.sh` bytes on macOS and pinned Linux | Five cases each: normal, lint failure, build failure, types failure and preamble interruption. Interrupted children stopped and their private temporary files were removed. These control probes are separate from the real canonical gate. |
| Lazy imports | `2f045093d`, preserved outside main | Parked after inconclusive measurements; no shipping or performance-benefit claim. |

The final canonical run passed 2,500 backend files (20,202 passes, one existing
expected failure, 132 skips), 985 frontend files (6,686 passes, two skips), and
985 future-date frontend files (6,687 passes, one skip), plus 116 browser tests,
three serial checks and zero CSP violations across 20 routes. Its approximately
33-minute wall time includes other integrated changes and is not a controlled
measurement of D7's isolated saving.

## D8 — A full backend suite waits for a running gate

Gates already queue behind a running vitest from another worktree. The other
direction was open: a bare `vitest run` (full suite) started while a gate was
running, and took the cores the gate's own vitest was using. MEASURED
2026-10-09: a train gate started at load 2.9; a peer suite started partway
through and load reached ~35. The train went red on a test that was just
under its timeout when run alone, and nothing merged.

A full backend run outside a gate now waits for the gate's CLAIM first
(`test/setup/queueBehindGate.ts` in `globalSetup` → `preflight-suite.sh
--wait-claim`).

- **Claim only, never processes, and it never claims.** A claim is held only by
  a gate that has finished waiting and is running, so two waiting suites cannot
  wait on each other. Waiting on processes would deadlock them, because a
  waiting vitest is itself a `vitest run` process. The gates' own detection of
  running vitest is unchanged.
- **Only full runs wait.** A file filter, `-t`, watch mode, the gate's own
  vitest (`OPENWOP_CI_PREFLIGHT_DONE=1`, or a claim from the same worktree),
  `CI`, and `OPENWOP_VITEST_NO_WAIT=1` all start at once. It is silent when no
  gate is running.
- **Same cap as the gate** (`OPENWOP_CI_WAIT_MAX_MIN`, default 90). At the cap it
  starts anyway with the DEBT-3 note and never fails a run.
- It covers `node node_modules/vitest/vitest.mjs run`, the form CLAUDE.md
  recommends, which a wrapper on `npm test` would not.

> **CORRECTION 2026-10-16 (GATE-CLAIM-1) — the claim D8 waits on was deleted a few
> minutes into every gate.** Found by 67: train 108 printed "claimed for pid 72352",
> yet `preflight-suite.claim` was absent while 72352 was alive, and a peer's full
> run at 14:52Z went straight into the gate (load ~65). Cause: the gate runs
> `test-preflight-suite.sh` beside backend vitest. Two of its arms ran the real
> preflight from the gate's own worktree with a stub `ps` that prints nothing,
> and without the claim-dir test seam. `foreign_claim` judged a claim stale
> whenever `proc_start` differed from the recorded start time, and an EMPTY
> reading differs, so it deleted the gate's live claim. Fixed both ways:
> - a claim is stale only on positive evidence: the pid is dead, or `ps` reports a
>   different non-empty start time;
> - the harness defaults `OPENWOP_PREFLIGHT_CLAIM_DIR` to a scratch dir for the
>   whole file.
>
> New arms: a live claim with an unreadable start time is kept, and a reused pid
> is still recovered. Witnessed: on main's script the first deletes the claim. The
> ps start time is also time-zone dependent (`TZ=UTC` prints a different string).
> Every preflight on this machine runs with the same TZ (checked, no process sets
> one), so that was not the cause here; it remains a reason never to compare those
> strings across environments.
- `filenamePattern` is internal to vitest 4. If an upgrade drops it, a targeted
  run reads as full, but it still waits only while a gate is running.

  > **CORRECTED 2026-10-09 (follow-up to #4647).** That fallback is no longer
  > the behaviour. The setup now checks that the field exists. If it does not,
  > the run does not wait and prints why, so a targeted run is never held up by
  > a mis-read. `test/queue-behind-gate.test.ts` builds a real Vitest instance
  > and asserts the field, so the upgrade that drops it goes red there. Witnessed:
  > renaming the field in the installed vitest turned that test red.

Witnessed: five `--wait-claim` arms in `test-preflight-suite.sh`. The "waits on a
live claim" and "starts when the gate exits" arms go red when the mode is
sabotaged to never wait. A unit test covers the skip rules. With a fake claim,
real vitest waited on a full run (directly and via `npm test`), started at once
on a file filter, `-t`, the gate marker and the opt-out, and started at once
after the gate exited.

Landed: #4647, merged as `7e762e469` by a green train (the first train went
red on a palette e2e under a peer suite's load; fixed in #4649).

## What would actually move the needle, at no running cost

The gate is CPU-bound and serialised per machine, so the remaining levers are:

1. **Hardware.** The 8-core / 16 GB M1 is the weakest box (free RAM measured
   at ~57 MB under one fleet). A current high-core-count Mac shortens every gate
   roughly in proportion to cores and removes the memory kills. It is a one-time
   cost.
2. **Lane overlap in `ci.sh`, on a machine with spare cores.** The D5 timings
   are the input for deciding which lanes to overlap with backend vitest.
3. **Fewer gates.** Batch PRs with `merge-train.sh` (already shipped).

## Open questions

- [ ] Is a one-time hardware upgrade for the M1 machine in budget?
- [ ] Revisit a cloud gate only as spot Compute Engine (Compute API enable + per-gate cost estimate first).

### D4 correction — claim publication under Bash 5 (2026-10-08)

Actual Linux execution found that reading a just-created claim with missing metadata
under `set -u` aborted before contention could be reported. The nested wait failure
then reached the existing CI cap fallback, allowing two gates to proceed. Claim
fields are now initialized, incomplete or invalid young tuples continue to block,
and a successful handoff requires both writing the tuple and atomically renaming
it. The existing aged-debris recovery is retained. Six deterministic regressions
cover missing, empty, truncated and malformed metadata, stale recovery, and failed
publication; existing concurrent-gate assertions remain unchanged.

> **Integration correction 2026-10-09:** the frontend static subshell removes its own temporary log directory on exit and signals, in addition to the parent gate terminating its owned process subtree. Failure, abort and canonical gate witnesses cover this cleanup.
