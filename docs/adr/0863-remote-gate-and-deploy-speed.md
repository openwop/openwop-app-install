# ADR 0863 — gate and deploy speed on the dev Macs

Status: implemented for D2–D8. D1 (a remote Cloud Build gate) was piloted and **rejected on cost** on 2026-10-08. D9, the requested SSH gate rebuild: its libraries are qualified offline and merged INACTIVE. The worker host is a **GCP Linux VM, per-gate on-demand, $200/month cap with auto-stop** (user, 2026-10-31; this replaces the 10-29 deferral). It is not provisioned yet, so no remote gate runs. The lazy-import experiment's later recovery is recorded below.

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

**Correction, 2026-10-28:** `OPENWOP_CI_SERIAL_LANES=1` originally moved the
frontend static lane into the foreground but still launched its lint, build and
unit-test typecheck children together. On the Air, the resource monitor interrupted
train 268 R1 during that phase despite the requested serial mode. Serial mode now
waits for each child before starting the next; the default retains all three in
parallel. Both schedules retain every command, failure status and output. The
process fixture `scripts/test-ci-frontend-static.py` measures concurrency and
injects a failure into each command. This scheduling correction does not establish
that the interrupted train would otherwise have passed.

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

### Recovery completion of the parked import experiment — 2026-10-21

The original `2f045093d` experiment is retained in this branch's ancestry. The
final candidate keeps only the four direct external-library deferrals (mammoth,
jsonata, nodemailer, tar-stream) at their existing asynchronous call sites. The
first-party renderer/slides deferrals are removed: as measured above, esbuild
hoists their static external imports, so they added asynchronous plumbing without
removing the production eager loads. No gate-speed or cold-start saving is claimed.
Existing document import/export, SMTP, data integration and pack validation tests
are the behavioral gates; full combined CI validation is pending.

## D9 — Rebuild the remote gate over SSH, with explicit trust (2026-10-28)

The user requested rebuilding the archived remote gate on current main, with a
security review of transport authentication and verdict provenance. The b7
handoff identifies the larger Mac as the intended worker. This replaces the
archived transport; it does **not** reinstate the rejected Cloud Build spending,
create a cloud bucket, grant IAM permissions, or copy the old merge-train scripts.

### Source audit and existing owners

Baseline: `002e1ed1538b841fd739bf67ea6c969f54faada1`. Reference archives:
`archive/adr-0863-remote-gate` → `a01d7b1216f68701cf5cb6ce2993d132e665293f`
and `archive/adr-0863-remote-gate-ajv` →
`0c4fefbbb91fd96a989ec7845f413486f6f9507d`.

Both archives contain Cloud Build submit/reconstruction scripts, not an SSH
runner. Their useful constraints are a frozen commit, complete required Git
history/refs, immutable bundle identity, worker-byte verification and a result
bound to one submission. Their infrastructure defaults, automatic bucket
creation, `git stash create` snapshot path and `OPENWOP_CI_NO_WAIT=1` are not
restored. D2/D3 changes already on main must not be overwritten by stale copies.

The existing owners remain: `scripts/merge-train.sh` constructs and verifies the
candidate; `scripts/ci.sh` is the gate; Hyvemind records exact-tree evidence;
`preflight-suite.sh` and `ci-claims.sh` coordinate local resource use; the release
bus reports advisory cross-machine state. No new merge or deploy authority is
introduced. The proposed SSH controller transports a candidate and reads evidence.
It cannot merge, deploy, publish, change production configuration, or declare a
partial lane equivalent to the full gate.

### Trust boundary

1. **Host and account are explicit.** No guessed host, default public endpoint or
   automatic trust-on-first-use. The operator supplies a verified host-key pin,
   approved SSH destination, runner ID and approved runner-policy digest. Use
   batch-mode SSH, strict host-key checking and a dedicated known-hosts file;
   disable forwarding, proxy commands and ambient SSH configuration surprises.
   Never use `StrictHostKeyChecking=no`, accept a changed key automatically, copy
   private keys, or forward an authentication agent.
2. **Transport trust is not in the returned JSON.** The local SSH controller
   records the host identity it authenticated. The evidence validator compares
   that observation with local configuration. A worker's claim that it has a
   particular host key cannot authenticate itself.
3. **Worker trust is explicit.** Candidate CI executes repository code. SHA256
   binding and SSH do not make a compromised worker, malicious contributor, or
   same-user process unable to forge evidence. This lane initially accepts only
   reviewed candidates on an explicitly trusted runner under the same code-trust
   assumptions as the local gate. It is not an untrusted-PR execution sandbox.
   Do not advertise cryptographic attestation or import a worker-generated GREEN
   blindly as local Hyvemind evidence.
4. **Constrain the execution account.** The planned worker account must not carry
   production credentials, agent-forwarded identities, deploy rights or peer
   session data. Required private dependency reads use narrowly scoped provisioning.
   Use an approved fixed runner entry point outside the submitted checkout and a
   disposable workspace. Actual account/SSH setup and trust pins are prerequisites
   for a real remote run; this source change does not configure another machine.
5. **No shell interpolation of submission data.** Pass the request through a
   bounded data channel to a fixed remote command. Validate identifiers, hashes,
   revisions and paths as data; never source a submitted env file or execute a
   returned command. A remote result parser stays on the submitting host.

### Candidate and result contract

- The first lane gates a clean, explicit committed candidate. It refuses dirty
  or untracked source instead of mutating a shared checkout or taking a stash.
  Capture the full candidate SHA/tree, current remote-main SHA, required ref
  manifest digest and source-bundle digest. Determine the required ref set from
  the existing gate's history/ADR checks; no arbitrary filesystem archive.
- A random 128-bit request ID and the hash of the exact request bytes bind one
  attempt. Requests expire within six hours. Reconstructed refs, main, tree and
  commit must match before installs; the worker returns those observations again
  after the gate. Never gate a floating branch tip or a peer's working directory.
- The approved runner policy requires Node 22, real npm 10.9.8 installs in all
  three workspaces, normal adaptive CI selection and the complete canonical
  `npm run ci` through Hyvemind 0.2.0. No primary browser opt-out, quick gate,
  forced Tracegate reuse, copied node_modules or invented Linux pixel baseline.
  Required WASI/browser assets and platform parity must be qualified first.
- Return the complete gate log, full Hyvemind evidence and browser ledger with
  SHA256 digests. Missing, empty, truncated or changed artifacts cannot produce
  GREEN. The gate must finish within this request's interval, exit zero, retain
  the same clean tree, and record a full—not partial—canonical pass on the exact
  candidate. Required browser success and an advisory browser failure remain
  distinct facts in the returned summary.
- The local candidate is checked again before accepting the result; the merge
  train still refreshes all PR heads and main and uses GitHub's head precondition.
  A moved candidate invalidates acceptance. A stale or unverifiable remote result
  is an error, not permission to merge or to silently launch a duplicate local gate.

`scripts/lib/remote-gate-result.mjs` is the first rebuilt component: a local,
dependency-free evidence validator with separate request, artifact and transport
inputs. Its tests use synthetic fixture evidence, so a passing unit check proves
the validator's acceptance/rejection behavior, not a real remote gate. The SSH
controller, worker, reconstruction and merge-train integration are still owed.

### Coordination and lifecycle

The worker's own coordinator retains its existing queue. Remote work observes
that machine's real gate/claims and never runs through an active e2e phase.
Announcements and leases are advisory; no repository freeze or deploy hold.
If unavailable or busy, return a bounded, explicit queued/unavailable result;
choose a later slot or deliberate local fallback rather than overriding a peer.

An interrupted SSH client reports interruption, never GREEN. Reconnection uses
the same request ID to inspect an existing run rather than start another. The
runner records individual owned PID/start identities. Cancellation targets only
those PIDs after identity rechecking; it never signals a process group, a guessed
name, or an agent session. Cleanup only removes the request's disposable paths
and cannot follow a caller-supplied path outside its workspace. Preserve failure
logs long enough for review; retention is bounded and documented.

### Qualification still required

| Boundary | Required evidence |
|---|---|
| Transport | Wrong/missing/changed host key refused before code execution; no agent, credential or port forwarding; hostile request strings remain inert data |
| Reconstruction | Altered bundle/ref manifest, missing history, wrong SHA/tree/main and unsafe archive paths refused before npm; real clean reconstruction matches the submitting tree |
| Verdict | Wrong request/runner/policy/head/tree, partial/quick/red gate, stale browser record and modified/missing logs refused; advisory failure preserved |
| Ownership | Interruption and reconnect do not double-start; PID reuse and unrelated peer processes survive cancellation; no collateral file cleanup |
| Integration | A real approved-worker full gate plus local acceptance, moved-main/head refusal and canonical merge-train proof; no speed claim without comparable measurements |

The standalone validator checks are not release qualification. Schedule the
complete change in its own train after implementation and worker configuration.
Retain both archive tags until the replacement PR is verified merged.

Preparation evidence, 2026-10-28 00:24Z: the dependency-free validator's 28 cases
passed. Three disposable negative-control copies removed, individually, SSH
identity comparison, the full-gate requirement and artifact-byte comparison;
each corresponding rejection test failed with a missing expected exception.
Candidate source was unchanged by those probes. Shell syntax and whitespace
checks passed. No SSH connection, remote job, install, browser or full gate was
run; transport/reconstruction/merge integration remain incomplete.

### Local transport preparation checkpoint — 2026-10-28

`scripts/lib/remote-gate-ssh.mjs` now prepares an argument array for the installed
OpenSSH client. A closed local configuration names the host, non-root runner
account, port, identity path, runner policy and an Ed25519 public host key whose
wire encoding and SHA256 fingerprint are verified. It emits a dedicated
known-hosts entry and always selects `/usr/local/libexec/openwop-ci-worker`;
submission data never chooses a shell command. The caller still must create the
private known-hosts file and perform the authenticated connection. The planner
deliberately returns a **pin**, not an assertion that authentication occurred.

Ambient SSH configuration, automatic key acceptance, host-key updates, agent and
port forwarding, proxy commands, multiplexing, interactive/password login and
environment forwarding are disabled. This initial lane accepts literal DNS/IPv4
hosts and ordinary Ed25519 keys only. Paths are restricted to literal absolute
names: OpenSSH parses `-o` values and expands filename tokens independently of
the process argument boundary, so whitespace, quotes, percent tokens and `..`
are refused rather than accidentally selecting another known-hosts file.

Evidence: 51 dependency-free result/transport checks pass. The installed client's
`ssh -G` output confirms its effective options without any network connection.
The first planner accepted unsafe path syntax; two refusal witnesses failed
before the path restriction and passed afterward. A separate test expectation
was corrected to the installed client's `requesttty false` spelling. Temporary
negative-control copies removing the key comparison, disabling strict host-key
checking or enabling agent forwarding each turn the relevant checks red; the
candidate source was unchanged by those probes.

A further effective-configuration witness exposed a credential fallback:
OpenSSH drops a nonexistent `-i` filename and selects the default user key paths.
The planner now uses the literal `IdentityFile` option instead, which retains
the explicitly selected path even when absent. The real `ssh -G` check asserts
exactly one identity filename and no default user identities. Its original red
output and the repaired 51-case result are preserved; no key was opened or used
for authentication during that check.

This is local validation, not a remote gate. Actual wrong-key connection refusal,
runner/account provisioning, bounded request transport, source reconstruction,
worker lifecycle, reconnect/cancellation and full-gate/merge integration remain
required. No private key was read or copied, no remote command was executed, and
no archive tag was deleted by this checkpoint.

### Git source reconstruction checkpoint — 2026-10-28

The next component transports Git bundles and a ref manifest, never a filesystem
archive. The local preparer refuses dirty, untracked or shallow source, requires
the explicit candidate and refreshed `origin/main`, and checks source refs again
after building the bundle. It does not fetch, create a stash, move a ref or freeze
other sessions. `check-adr-refs.mjs` reads `git log --all`, while pack-version
checks use `origin/main`; therefore every frozen ref, including peer-only ADR
history and annotated release tags, must survive reconstruction. Replace refs
are refused, since they could change the meaning of object IDs.

The fixed worker library copies the bounded bundle into a new private directory
and checks its SHA256 before Git reads it. Streaming uses a 1 MiB buffer with a
1 GiB bundle limit; the manifest is bounded at 8 MiB and 50,000 refs. The runner
root belongs to the configured account and has no group/other access. Git has a
private HOME, no ambient config or object-store overrides, no hooks, no network
protocols and an empty init template. An empty object database must verify the
complete bundle before refs are created. Bundle heads, commit, tree, main ancestry
and reconstructed refs must match. Submodules and escaping/dangling symlinks are
refused before installs. Any failure removes only this attempt's new directory.
The request schema is shared with the result validator and accepts no command or
workspace fields.

Qualification uses real temporary Git repositories: exact source round-trip,
peer-only ADR history, annotated tags, altered-but-valid bundle compression,
changed ref serialization, wrong identities/tree/main, incomplete history,
unsafe paths, ambient filter/config injection, and dirty/staged/untracked source
preservation. The result, transport and source checks total 74 passing cases.
Four disposable negative controls remove the bundle digest, ref digest, tree
comparison and clean-source refusal separately; each accepts the otherwise valid
wrong input and turns its refusal witness red. The controller's final local-head check,
bounded SSH protocol, worker lifecycle and an approved real remote full gate
are still required. These local Git checks do not establish remote gate trust or
performance, and the archive tags remain until the replacement merges.

### D9 transport framing checkpoint — 2026-10-28

Architecture review: Track A, local release-tooling seam. The existing source
reconstructor still owns Git interpretation, the local result validator owns
verdict acceptance, and the canonical CI/Hyvemind commands own the gate. No host
route, OpenWOP wire contract, production permission, scheduler or merge authority
is introduced. The private-root assertion is shared with source reconstruction.

`remote-gate-frame.mjs` now encodes/receives bounded binary artifacts for the fixed
SSH worker command. A magic prefix and bounded JSON header declare the exact
ordered artifact set, byte counts and SHA256 digests. Source frames contain only
request/refs/bundle; result frames contain only result/evidence/log/browser ledger.
Names are constants, never received filesystem paths. Request/evidence/result
JSON are capped at 1 MiB, refs/ledger at 8 MiB, bundles at 1 GiB, logs at 256 MiB,
and header at 4 KiB. A larger artifact refuses the transfer; it cannot be truncated
into a green result. Encoding hashes an open regular file before transfer and
checks its bytes again before emitting the end marker. Reception streams 64 KiB
slices to a fresh owned 0700 directory with exclusive 0600 files and exposes the
paths only after hashes, end marker and EOF all pass. Failures remove only that
transfer directory. Idle and total deadlines plus cancellation bound stalled input.

This is the artifact-transfer layer, not a long-running gate session protocol.
The future controller must use request status/reconnect before fetching a ready
result, then require successful SSH exit and local contract validation. It must
not start this bounded receiver and wait silently through a whole gate. The
worker lifecycle, acknowledgement/status protocol, account provisioning, real SSH
qualification and merge-train integration are still owed; no remote gate was run.

Local evidence: 100 combined result/SSH/source/frame checks pass, including 26
frame checks. A subsequent continuous-input deadline witness passes separately.
Removing the received digest comparison makes the changed-artifact witness RED;
removing the final stream-EOF assertion makes the separate-trailing-chunk witness
RED. The original source was restored byte-for-byte after each experiment.
Evidence is in the coordinator's `remote0863-frame-*.log` and negative-control
record; this is scoped tooling evidence, not full application CI. These brief
checks ran during train258's backend phase with pressure1; no application suite
or peer browser work was started. All four tooling files are wired into ci.sh.

### D9 job journal preparation — 2026-10-28

The next component is a request-scoped job journal on the explicitly trusted
worker. An exclusive request directory binds the exact original request bytes.
Complete, fsynced state records are published by an exclusive hard link under
immutable sequence names, with each record hashing its predecessor. Competing
transitions cannot overwrite a winner. This is confined to one request; it is
not a repository lock, queue override, lease or permission to block peer work.

A reconnect returns the recorded state, including after request expiry. Only an
unexpired `accepted` request can transition to `starting`, and the worker must
persist that transition before launching a supervisor. A crash between those
steps is unresolved, not permission to relaunch. Partial admission, malformed
history, symlinked/public records and changed request bytes fail closed and are
preserved for investigation. `running` retains the observed supervisor PID,
start identity and executable. Terminal states cannot restart. `completed` binds
a result digest but supplies no GREEN verdict; the independent evidence reader
must still verify the actual returned artifacts and SSH provenance.

The component does not yet implement the worker supervisor, request/status SSH
envelopes, cancellation or final local acceptance. In particular, recording a
PID is not proof that it is safe to signal; the supervisor must recheck process
identity and establish all owned descendants are gone before recording a
cancelled state. It must never cancel an agent or a process group. No worker is
installed on another machine by this checkpoint.

The journal tests are prepared, including two real processes contending for the
same start transition, restart/reconnect, expiry, identity collision, partial
admission, history damage, symlink targets and terminal-state refusal. They have
not been executed while release260 owns the Air's full-gate slot. Syntax checks
alone do not qualify this journal. Keep both archive tags until the replacement
is fully qualified and merged.

#### Journal qualification update — 2026-10-28 at 09:17Z

The 18 standalone journal cases now pass. They ran in less than one second while
release260 was in its full backend lane with normal memory pressure; no browser
phase or second application suite overlapped. The final concurrency witness
pauses both real processes at the first file fsync, after reading the same
accepted state and before publishing the start record. Both then use the actual
filesystem operation. Replacing the exclusive hard link with an overwriting
write produces two successful starters instead of one and makes that test RED.
Removing, separately, the terminal-transition refusal, record symlink refusal
or history digest check also makes its corresponding witness RED. Source bytes
were restored after all four probes.

This qualifies the local journal boundary only. It does not establish worker
process supervision, safe cancellation, authenticated SSH status/reconnect,
platform build parity, final candidate acceptance or a full remote gate.


### D9 local acceptance checkpoint — 2026-10-28

The local reader now inspects the submitting checkout before and after validating
worker artifacts. It requires the exact HEAD and tree, a clean tracked/untracked
working tree, and the same locally refreshed origin/main. Git reads use the
existing isolated configuration so ambient GIT_DIR cannot redirect this check.
The reader preserves required versus advisory browser results and returns no
merge authority. It does not write a remote GREEN into the local Hyvemind ledger.

Nine checks exercise actual temporary Git repositories and synthetic returned
evidence: the unchanged candidate is accepted; a different commit with the same
tree, an incorrect tree claim, tracked/staged/untracked changes, moved main,
a nested checkout path and ambient Git redirection are refused. Removing the
HEAD, main or clean-tree guard separately makes its corresponding test fail.
All 60 source/result/acceptance checks pass after restoration. The synthetic
worker evidence is explicitly not a real SSH gate result.

The controller must refresh main before invoking this reader. A local ref alone
cannot prove the remote has not advanced, and another change can still occur
after acceptance. The canonical merge train therefore retains its final fresh
remote-main, PR-head and GitHub head preconditions. Actual worker supervision,
SSH status/fetch/cancel, controller wiring and a real full remote gate remain
unqualified; no archive tag is deleted at this checkpoint.

### D9 read-only status/fetch implementation — 2026-10-28

`remote-gate-status.mjs` composes the existing journal and frame encoder. Status
does not admit unknown requests, repair an unresolved start or launch work;
existing requests remain inspectable after submission expiry. It exposes the
request binding and immutable sequence/state without local paths or supervisor
identities. `artifactsReady` means only that the journal records completion;
`gateVerified` remains false until the submitting host independently accepts it.

The supervisor's artifact publication destination is the private, fixed
`<job>/artifacts/` directory with `result.json`, `evidence.json`, `gate.log` and
`browser.tsv`. Fetch refuses non-completed jobs, symlinks/public artifacts,
changed result digests and another request's result. The frame encoder now
accepts optional expected digests and compares them against its own open file
descriptors before emitting any header, closing the earlier path-read gap.
Its existing second-pass digest and EOF checks remain in place. Neither status
nor fetch signals a process or changes a journal entry.

Architecture review (Track A, CI tooling): the journal remains the single job
state owner; the frame module remains the byte-transfer owner; result acceptance
and merge authority stay on the submitting host. No product route, OpenWOP wire
contract, credential mechanism or competing scheduler is introduced. Root and
trust must come from the installed worker configuration, never submitted JSON.
This retains D9's trusted-account assumption; it is not a sandbox against a
compromised worker or another process using that account.

After release260 completed, all 58 status/fetch, frame and job checks passed.
They use actual private files and frame decoding with synthetic gate payloads.
Removing the descriptor digest guard or private-artifact guard separately made
its negative witness RED (the expected refusal disappeared). Both guards were
restored and all 58 checks passed again. This qualifies those local boundaries,
not authenticated SSH execution or a real gate result. Full CI,
the supervisor that atomically publishes artifacts before completion, SSH command
dispatch, cancellation and an approved real worker run remain required. No worker
has been provisioned and no archive tag has been deleted.

### D9 artifact publication preparation — 2026-10-28

`remote-gate-publish.mjs` adds the installed supervisor's publication step. The
existing journal remains the sole visibility commit: fetch refuses everything
until the `running → completed` CAS succeeds. Publication exclusively creates
the fixed private `artifacts/` directory, copies only the four allowed files
through owned non-symlink descriptors, hashes the bytes actually written, and
fsyncs files/directories before recording completion. The result must name this
request, candidate, policy and observed zero exit, and its three artifact hashes
must match the copied bytes. Size limits come from the frame module's single
exported artifact contract.

An incomplete directory is deliberately retained on every subsequent failure.
It is unreachable through fetch and cannot be overwritten by a retry or second
publisher. A concurrent cancellation wins the journal CAS; fully copied files
then remain unaccepted. Status/reconnect inspect the durable record instead of
starting another command. `completed` continues to mean that files are ready,
not that the submitting host has accepted full gate/SSH evidence.

Architecture review (Track A, security-shaped CI tooling): this extends the
existing journal/frame boundaries rather than adding a scheduler or authority.
Source directory, recorded owner identity and observed command exit must come
from the installed supervisor, never network request fields. The implementation
does not itself observe a process or authenticate the owner; it retains the
explicit trusted-account assumption. No OpenWOP wire or production configuration
changes are introduced.

Prepared tests exercise real private files, immutable publication, wrong identity
and digests, symlink/permission/size refusals, interrupted-output retention,
cancellation and two actual competing publisher processes. These use synthetic
gate payloads. At this checkpoint only syntax/diff checks have run: execution
and negative controls are queued until release train262 releases this Mac's
test capacity. Full gate, actual supervisor execution, SSH dispatcher/controller,
process-identity cancellation and approved worker qualification remain owed.

**Qualification update, 2026-10-28 12:06Z:** after train262 completed and the
release deploy finished its local builds, all 76 publication/status/frame/job
checks passed, including the 18 new publication cases. Three independent
negative controls removed the artifact-digest comparison, the private-file mode
check, and exclusive directory creation. Each corresponding test failed because
the expected refusal disappeared. The production source was restored byte for
byte and all 76 checks passed again. This includes actual two-process publication
contention and actual filesystem/journal/frame boundaries, with synthetic gate
payloads. Evidence: `remote0863-publication-verification.json` in the acting
coordinator's release state directory, bound to source commit `ba0785229`.
No full remote gate, SSH worker activation or archive retirement is claimed.

### D9 cancellation intent preparation — 2026-10-28

Architecture review identified a missing distinction: a cancellation request
cannot claim that a running supervisor and its descendants have stopped. The
existing request journal remains the single lifecycle owner; a separate cancel
file or another lock would create a race with its start/completion CAS.

`requestRemoteGateCancellation` therefore uses that same immutable transition:
an `accepted` job can become `cancelled` because no caller has acquired its
start transition. A concurrent starter must observe whether its own CAS won.
For `starting` or `running`, cancellation records **`cancelling`**, retaining the
observed supervisor identity. No new start or completed result may follow that
state. Only the installed supervisor may record `cancelled` after independently
observing owned-process cleanup; uncertain cleanup becomes `interrupted` and
retains the cancellation intent in status. The request API sends no signals,
launches nothing, and accepts no caller PID or filesystem path.

Completion and cancellation compete through the same journal sequence. If
completion wins first, cancellation returns that completed state unchanged. If
cancellation wins while the publisher is copying artifacts, its final CAS loses
and copied artifacts remain non-fetchable. Acknowledged intent is not a cleanup
receipt. Reconnects, including after request expiry, inspect the existing job;
unknown or changed request bytes cannot admit or cancel another job.

Thirteen new cases are prepared: unknown/changed identity, accepted cancellation,
pending startup/running cleanup, expired duplicate requests, terminal states,
two actual-process races against start/cancel, and a real publisher paused after
reading `running` while cancellation advances the journal. The latter checks
that fully copied synthetic artifacts remain unavailable. This is host tooling,
with no product route, wire contract, production mutation or new execution
authority. Existing trusted-worker-account assumptions still apply.

These changes and tests are **prepared but not executed** while Air CI267 owns
the local full-gate slot. Next: run the journal/status/publication/cancellation
suites; remove the pending-state guard and then the completion transition guard
in separate negative controls; restore and rerun. Actual supervisor execution,
PID-identity cleanup, SSH dispatcher/controller, approved worker configuration
and full local/remote gate qualification are still required. Both archive tags
remain until the replacement merges.

Cancellation qualification on `469ef1279` completed at 17:14Z on 2026-10-28.
The journal/status/frame/publication/cancellation suites passed all 89 cases.
Removing pending cancellation made the two startup/running witnesses fail;
allowing completion after cancellation separately made both fail. Restoring the
exact source passed all 89 again. The wrapper exited zero with no owned process
remaining. `remote0863-cancellation-verification.json` records that exact tree;
it is not evidence for later changes or actual worker process supervision.

### D9 fixed control dispatch preparation — 2026-10-28

Architecture track A, existing CI tooling owners: the immutable job journal owns
state, the frame module owns bounded inert transport, and the result reader owns
artifact validation. The new `remote-gate-control.mjs` composes those owners for
the installed worker entry point. It creates no execution, merge or deploy path.

The existing frame protocol gains `control` (original `request.json` plus a
4-KiB `operation.json`) and `status` (a 4-KiB `status.json`). Operations are the
closed set `status`, `cancel`, and `fetch`; callers cannot supply a command,
filesystem root, PID, runner policy or alternate worker. Only the installed
entry point supplies the trusted root, spool root and runner policy. The entire
frame, its digests, end marker and EOF must validate before a cancellation can
change the journal. Both idle and total receive time are bounded.

Status and cancellation use the exact original request bytes. Unknown requests
are never admitted as a side effect of reconnecting. Expired existing jobs remain
inspectable. Cancellation returns the actual state, which can be `cancelling`;
it never asserts that processes have stopped. Disconnect after an intent was
recorded cannot undo that intent; the next connection asks for status. Fetch
streams only the existing completed, journal-bound result frame. Neither a
status response nor the presence of artifacts constitutes an accepted green gate.

The handler allocates a private spool and removes only that spool when its
response generator completes or is closed. It never removes a job directory or
peer files. An integrating SSH entry point must consume or close that generator
on transport failure. This retains the explicit trusted-account assumption; it
does not isolate against a malicious process using the same account.

Nineteen integration witnesses are prepared using real frames, journals and
private files: unknown/expired reconnect, accepted/running cancellation,
unrecognized operation/fields/encoding, changed original request, trailing or
interrupted input before EOF, abort, disconnect after intent, unfinished fetch,
and completed synthetic artifact transport. The new suite is in canonical CI.
**Not executed at this checkpoint:** Client271 owns the local gate. Next run
the six focused suites and independently remove EOF, closed-field, cancellation
dispatch and spool-cleanup guards, restoring source between probes.

The actual installed SSH dispatcher/controller, PID-identity supervisor,
approved worker account and real local/remote full gate remain required. The
existing generic `owned-process.mjs` sends process-group signals and cannot be
reused unchanged under the PID-only rule. Sampling a process tree alone is not
proof that a rapidly reparented child was observed; unresolved ownership must
refuse a cleanup claim. This preparation starts no SSH connection and enables
no remote execution. Archive tags remain until the replacement merges.

### D9 PID-identity supervisor design — 2026-10-28 (design only, not implemented)

Owner change: the Air's Codex session handed D9 to `openwop-app-d8` on this
date. The control framing at `676dd42c0` is qualified (a 191/191 baseline over
all ten remote-gate suites; nine disposable mutants each reddened a named
witness; the restored copy passed 191/191 again). This section designs the
installed supervisor, the one component that touches live processes. Nothing
below is implemented or enabled. Provisioning (host, account, key, policy)
remains the user's decision before any activation.

**Platform facts measured on the worker class (macOS 26.5, 2026-10-28):**
- An orphaned child is reparented to `launchd` (ppid 1) within a second. A
  parent-pointer tree walk therefore loses descendants. Sampling it cannot prove
  that a fast-reparented child was ever seen.
- The process group (`pgid`) is inherited and survives reparenting. `ps -o sess`
  reports 0 for every process, so the session is unusable.
- `ps eww` / `ps -E` do not reveal another process's environment, even under the
  same uid. A per-job environment marker cannot be read back, so it is not an
  ownership proof.
- `ps -o lstart` has one-second resolution and is printed in the local time
  zone (the same process read 19:35:24 under `TZ=UTC` and 15:35:24 locally).
- macOS has no `pidfd` and no child subreaper.

**Identity.** A process identity is the tuple `{pid, startedAt, uid,
executable}`:
- `startedAt` is `lstart` read with `TZ=UTC` and `LC_ALL=C` forced in the
  supervisor's `ps` environment, never inherited.
- `executable` is the `comm` value.

A PID alone is never an identity. Two readings match only when every field is
non-empty and equal. If any field is empty or unreadable, the process is
**unknown**, never "not the same process" (the GATE-CLAIM-1 lesson above: an
empty reading must not count as evidence). Residual: two processes with equal
pid, second, uid and comm would need the PID space to wrap within one second.
This design does not treat that as impossible. It treats it as the stated
residual of the identity check.

**Ownership.** The supervisor spawns the gate as the leader of a new process
group (`detached: true`), records its OWN identity as `running.owner`
(the field already validated by the journal) and the leader in `owned.tsv`, and holds
the leader **unreaped** until cleanup ends. While the leader is a zombie its PID
cannot be reused, so signalling the direct child is reuse-free. Membership is
sampled by group, not by tree: every 2 s and at each cleanup step the supervisor
lists same-uid processes with `pgid == leader`. It adds each new identity to an
in-memory owned set and to a per-job `owned.tsv` append log. The group is
**discovery only**: nothing ever calls `kill(-pgid)`. That honours the PID-only
rule, which `owned-process.mjs` (a group signaller) does not.

**Signalling.** For each owned identity, the supervisor re-reads the identity
immediately before `kill(pid, sig)` and signals only on an exact match:
- TERM first, then KILL after a bounded grace.
- A mismatch means the PID was reused. That process is not signalled and is
  recorded as departed, never as stopped.
- An unreadable identity is not signalled, and makes cleanup uncertain.

A check-then-kill window remains for descendants (not for the unreaped leader).
It is named as residual R1.

**Proof of cleanup, and when it stays uncertain.** The supervisor may record
`cancelled` (after cancellation) or proceed to `completed`/`failed` only when
**all** of the following hold, re-read after a 2-s quiet period:
1. every owned identity is gone or reads as a different identity;
2. no process with `pgid == leader` exists, other than the unreaped leader;
3. no owned identity was ever observed in another process group or session.
   Such a process escaped discovery (a `setsid`/`setpgid` daemon).
4. every `ps` read in the cleanup succeeded and parsed.

Any failure records **`interrupted`** with `cleanup: "uncertain"` and a closed
list of reasons:
- `identity_unreadable`
- `escaped_group`
- `members_remain`
- `scan_failed`
- `supervisor_restarted`

`interrupted` never publishes artifacts and never yields GREEN. The client
reads it as interruption, and a person decides.

Two cases are beyond any sampling design and are therefore never claimed:
- **Escape before observation:** a descendant calls `setsid` before a sample
  sees it.
- **Supervisor restart:** a supervisor that starts and finds its own job
  `starting`, `running` or `cancelling` cannot rebuild the owned set. It records
  `interrupted/supervisor_restarted` and never relaunches.

So `cancelled` means "no owned or discoverable process remains". It never means
"every descendant is proven dead". The ADR states that bound rather than hiding
it.

**Journal change (the same immutable CAS, no new lock).** `cancelled` and
`interrupted` gain closed `details`:
- `cancelled` after `cancelling`: `{ cleanup: "verified", owned: <n> }`.
- `cancelled` from `accepted`: no details, because no process ever existed.
- `interrupted`: `{ cleanup: "uncertain", reasons: [...] }`.

`completed` and `failed` also require the four checks above. If they fail,
`interrupted` wins and the exit code and artifacts become non-fetchable.

**Disconnect.** The supervisor is launched outside the SSH session (its own
process group, stdio to journal-owned files), so a dropped SSH connection
neither signals nor reparents-and-kills it. Cancellation arrives only as the
journal's `cancelling` state, which the supervisor polls. The control API still
sends no signal.

**Qualification (all offline, on this machine, no SSH):**
- a real gate stand-in that forks a reparented grandchild;
- a `setsid` escapee, which must yield `interrupted/escaped_group`, or
  `members_remain` if it is never seen;
- a TERM-ignoring child, which must be stopped by KILL;
- forced PID reuse, simulated by an identity reader that reports a different
  start time for a live pid: it must not be signalled and must be recorded as
  departed;
- an unreadable `ps`, which must yield uncertain, never verified;
- an unrelated peer process, including one in a different group that runs the
  same executable, which must survive;
- a supervisor crash and restart, which must not relaunch;
- a kill of the SSH-side caller, which must leave the job running.

Each guard gets a disposable negative-control mutant, as in the framing
qualification. Signals in the tests target only processes the test itself
spawned.

#### Supervisor implementation checkpoint — 2026-10-28 (offline, macOS)

Review by `openwop-app-14` approved the design above, with two amendments, both
now applied.

**1. Platform interface.** The identity and signal layer is a per-platform table
(`remote-gate-process.mjs`: an async `list()` and a single-pid `signal()`). The
macOS table is the design above. The Linux table refuses ("worker host
undecided") and is not built until the user chooses a worker host. Qualification
must run on the OS the worker actually uses. **Linux is what removes R1 and the
reparent-loss case:**
- `PR_SET_CHILD_SUBREAPER` makes orphans reparent to the supervisor instead of
  launchd, so descendants cannot be lost by reparenting;
- `pidfd_open`/`pidfd_send_signal` bind a signal to the process that was checked,
  which closes the re-read-to-kill window for every process;
- `/proc/<pid>/stat` starttime in clock ticks replaces one-second `lstart` (R3).
On macOS those three remain stated residuals.

**2. Timing parameters.** The sample, quiet and grace intervals are parameters.
Qualification uses 25 / 60 / 400 ms.

Findings made while implementing, both measured:
- **`spawnSync` must not be used for scans.** It runs a private libuv loop that
  consumed the SIGCHLD of the async holder. The holder then stayed an unreaped
  `<defunct>` process and the supervisor waited forever. Scans are async
  (`execFile`).
- **Holder loss gets a sixth reason, `holder_lost`.** Once the holder is gone,
  discovery stops adopting new group members, because a later group with the
  same id could belong to a stranger. Members found after that point keep cleanup
  uncertain (`members_remain`); they are never signalled. Also measured: `comm`
  is argv[0], and a `uid` can be negative (-2 for system daemons).

Journal: `cancelled` after launch requires `{cleanup: "verified", owned}`.
`interrupted` requires `{cleanup: "uncertain", reasons}`, drawn from the closed
set. A passing command whose publication is refused becomes `failed` with exit
code 70, never `completed`. Boot recovery treats an owner that is gone or
different as `supervisor_restarted`, and leaves alone an owner that is live or
unreadable. It abandons `starting` only after 60 s. It never relaunches.

**Qualification on `d6002be68` (macOS 26.5, 2026-10-28).** Run by a dedicated
wrapper that refuses unless HEAD is the named commit and `scripts/` is clean. It
runs every suite in a disposable copy of `scripts/`, one test at a time.

- **Baseline:** 211/211 tests passed across 11 suites (the supervisor suite has
  19).
- **Mutants:** 20 disposable mutants, applied one at a time, each turned a
  *named* test red:
  - 8 framing mutants (control framing as before);
  - 10 supervisor mutants: group kill; no identity re-read; unknown treated as
    different; scan failure swallowed; escape unreported; final members
    ignored; adopting after holder loss; no KILL escalation; uncertain cleanup
    not recorded as interrupted; recovery ignoring a live owner;
  - 2 journal mutants: unverified `cancelled`; open reasons.
- **Restored:** 211/211 again.

On the first wrapper run, "unknown treated as different" reddened only its unit
witness, "an unparseable row is unknown, never different". The behaviour test
stayed green because the final scan's unreadable-row guard independently holds
the verdict. The two guards overlap; this is recorded rather than hidden.

This does not qualify any of the following:
- the SSH dispatcher/controller;
- launching the supervisor outside an SSH session;
- a Linux worker;
- a real gate.
No SSH connection was made and no worker was enabled.

**What `cleanup: "verified"` proves (wording fixed 2026-10-28, at review).** It
means *every process observed in the gate's process group is gone*. It does not
mean *no descendant survives*. On macOS, a descendant that calls
`setsid`/`setpgid` before any sample sees it is invisible (R2). The suite pins
that case as reading `verified`: a stated false green, not a claim. Consumers of
the journal, status and result must not present `verified` as "no survivors".
A Linux worker with `PR_SET_CHILD_SUBREAPER` closes R2, because such an escapee
still reparents to the supervisor. The same wording is in the journal schema's
doc comment (`CLEANUP_REASONS`, `remote-gate-job.mjs`).

### D9 host decision: DEFERRED (user, 2026-10-29)

The user decided, in the release manager's session (openwop-app-14) and
relayed to this one, that gates keep running on MacBook-Pro-48 and the
MacBook Air for now. **There is no remote worker host.** The framing,
journal, control and supervisor code merges INACTIVE: libraries and
their self-tests only. No entry point, launchd job, SSH key or host
config ships, and nothing calls these modules outside `scripts/test-remote-gate-*`.
The `archive/adr-0863-remote-gate*` tags stay.

Options for a future decision:

| Option | For | Against |
|---|---|---|
| **A. Linux VM in GCP `openwop-dev`** (e.g. 16 vCPU / 64 GB) | `PR_SET_CHILD_SUBREAPER` + pidfd + `/proc` starttime close R1, the reparent loss and R3, so `verified` means no survivors; isolated from both Macs; can stop when idle or run on spot | ≈ $0.75–0.80/h on demand for 16 cores (≈ $550/month always on), far less started per gate or on spot. Needs the user's spend approval, a budget cap and a usage mode (always-on vs per-gate). The Linux process table is not built. |
| **B. The MacBook Air** | No new cost | ≈ 17 GB RAM; gates stopped repeatedly under memory pressure on 2026-10-28; macOS keeps R1, R2 and R3 |
| **C. Another user-owned machine** | Depends on the machine | Needs OS, cores, RAM and reachability before it can be weighed |

Before ANY option is activated, all of these are required, each in the
session that acts and with the user's approval there:

1. **Account:** a dedicated non-admin worker account on the host.
2. **Key:** a new Ed25519 key used only for the gate, stored in Secret Manager
   (or the host's keychain for the private half). Never in the repo, the
   release bus or a note.
3. **SSH restrictions** on the worker's `authorized_keys` entry: forced
   command (the fixed control dispatch), `from=` the two Macs' addresses,
   `no-pty`, `no-port-forwarding`, `no-agent-forwarding`, `no-X11-forwarding`.
4. **Trusted-worker config review** by the release manager: host key pinned,
   paths, timings, artifact directory.
5. **Linux only:** the subreaper + pidfd process table, qualified offline
   the way the macOS one was (baseline, named mutants, restore).
6. **The SSH dispatcher/controller and launching the supervisor outside the
   SSH session**, built and qualified (not built yet).
7. **A dry run** with no real gate jobs: accept, status, cancel and fetch
   against a no-op command, and a recovery after killing the supervisor.

### D9 host decision: option A, a GCP Linux VM (user, 2026-10-31)

> **Supersedes the 2026-10-29 deferral above.** The user chose, in openwop-app-d8:
> option A, **per-gate on-demand** (the VM starts for a gate and stops when idle),
> with a **$200/month budget that stops the VM at 100 %**, after which gates fall
> back to the Macs. The order agreed with the release manager (openwop-app-14):
> P1/P2 offline and free; then a host proposal for its config review before
> anything is created in `openwop-dev`; then a dry run with no real jobs; then a
> shadow gate compared with a local one; no merge use until the user and the
> release manager sign off. Every API enable and resource creation is posted to
> the release bus as it happens.

### D9 P1 checkpoint: the Linux process table — 2026-10-31

`linuxProcessTable()` (`scripts/lib/remote-gate-process.mjs`) closes the three
macOS residuals:

| Residual | Linux mechanism |
|---|---|
| R1 (pid reused between the re-read and the kill) | The signal goes through a **pidfd opened before** the identity re-check; a pidfd keeps naming the process it was opened on, so a reused pid can't receive it. |
| R2 (an escapee nobody sampled) and the reparent loss | The holder is a Python process that sets `PR_SET_CHILD_SUBREAPER`, so every descendant, including one that ran `setsid`/`setpgid`, stays its descendant. Membership is the holder's descendants plus its group (orphans of a lost holder still count). |
| R3 (one-second start resolution) | The identity is `boot_id/starttime`, with `starttime` in clock ticks from `/proc/<pid>/stat`, parsed at the last `)` because `comm` may contain spaces and parentheses. |

The supervisor now takes the holder and the membership rule from the platform
table, and awaits `signal(identity, sig)`. The macOS behaviour is unchanged.
Python is used because Node has neither `prctl` nor pidfd; both scripts are fixed
and their argv is data.

**Qualification** (offline, the same method as the macOS record: baseline, each
named mutant in a throwaway copy must turn a named test red, then restore). Head
`34b0a4007`:
- **macOS:** 213/213 baseline, 20/20 mutants killed, 213/213 restored.
- **Linux** (`node:22-bookworm`, kernel 6.10): the same result twice, once without and
  once with `--init`. 22/22 mutants killed: 19 shared and 3 Linux-only (no
  subreaper, no pidfd re-check, group-only membership). The macOS-only
  escaped-group mutant does not apply on Linux, where subreaper membership
  makes that reason unreachable while the holder lives.

**Found by the mutant run:** on Linux, "never adopt after the holder is lost"
survived at first. The test was right about the supervisor and wrong about
liveness: in a container, node is PID 1 and never reaps orphans, so a killed
process stays a zombie, and `kill(pid, 0)` reports a zombie as alive. The
assertion "an unowned process is not signalled" therefore passed whether or not
it was signalled. The suite's `alive()` now treats a `/proc` state `Z` as dead.
Both Linux runs kill the mutant.

Still not built or qualified: the worker entry and controller (P2), the host
and its SSH restrictions (P3), and any real gate.

### D9 P2 checkpoint: worker entry, runner, gate command and controller — 2026-11-01

New, all inactive (nothing outside the self-tests calls them):

| Piece | What it does |
|---|---|
| `scripts/remote-gate-worker.mjs` + `lib/remote-gate-worker.mjs` | The forced-command entry. One frame in. A `source` frame is rebuilt, admitted and handed to the launcher, and its status comes back. A `control` frame is answered with status, cancel or fetch. While any job is unfinished it exits 75 (busy) and admits nothing; an unreadable job counts as unfinished. A refused frame exits 65. A failed launch cancels the `accepted` job, so it can't block later ones. |
| `scripts/remote-gate-runner.mjs` + `lib/remote-gate-runner.mjs` | Started outside the SSH session (`systemd-run --user` on the VM). It supervises the gate, keeps the last 20 gate logs and removes the rebuilt checkout. `--recover` at boot settles jobs a dead runner left: `accepted` older than 10 min is cancelled, and a dead owner becomes `interrupted`. |
| `scripts/remote-gate-gate.mjs` | The canonical gate as the supervisor's one command: `npm ci` in the three workspaces, then one `hyvemind@0.2.0 gate` (the same command `merge-train.sh` runs). Writes the four fixed artifacts as private files. Missing evidence or a missing ledger row is exit 1. |
| `lib/remote-gate-controller.mjs` | On the Mac: snapshot, submit, poll status, fetch, then accept with the LOCAL validator. Outcomes are closed: `green`, `red` (the gate ran and failed), or `fallback` with a reason (busy, refused, ssh failed, interrupted, cancelled, timed out, evidence refused, worker fault 70/124). **A fallback means "gate locally", never red.** |

`remoteGateJobStatus` now also reports a failed job's `exitCode`. That is how the
controller tells a red gate from a worker fault.

**Found and fixed by the end-to-end suite: a latent bug in the qualified
supervisor.** `runRemoteGateJob` read the journal with the time its job started.
The worker records a cancellation at its own, later time, and the runner's next
read rejected that record as "out of order". The runner crashed and the job stayed
`cancelling` for good. Any real cancellation of a running gate would have done
this. The supervisor suite never saw it, because it recorded cancellations with
the same frozen time. `runRemoteGateJob` now takes a `clock` and reads it at every
journal call. Witness: "a cancellation recorded after the job started is
honoured". It is red under a frozen-clock mutant and green with the fix.

**Tests:**
- `scripts/test-remote-gate-e2e.mjs`: 6 cases through the real worker entry,
  runner, supervisor, gate command, controller and validator. Only `npm`/`npx`
  are stubs, and the SSH hop is a pipe. The cases are: green accepted; red with
  its exit code; evidence for another commit refused locally (fallback);
  busy (fallback, nothing admitted); another runner's request refused before
  any checkout; timeout cancelled on the worker with verified cleanup.
- They pass on macOS and on Linux (`node:22-bookworm`, with and without
  `--init`). All 12 remote-gate test files pass on macOS. Added to `ci.sh`.

**Real SSH, offline** (scratch harness, container sshd at the planned settings:
`restrict,command="/usr/local/libexec/openwop-ci-worker"`, ed25519 host key only,
`PermitTTY no`, `DisableForwarding yes`, `PermitUserEnvironment no`), with the
controller on the Mac using the existing SSH planner: **7/7.**
- A: green over SSH, accepted locally.
- B: a wrong pinned host key is refused before any worker code runs, and no job
  is created.
- C: a client-chosen command never runs.
- D: no PTY.
- E: no remote forwarding.
- F: an unlisted client key is refused.
- G: the client cannot redirect the worker's configuration through its environment.

Sabotage: removing `command=` makes C red, because `id; echo PWNED` runs, and
restoring it makes it green again. Provisioning note: `useradd` leaves the account
locked (`!`), and sshd without PAM refuses a locked account. The worker account
needs `usermod -p '*'` (no password, not locked).

### D9 P3 host proposal (for the release manager's config review; nothing created yet)

**(a) Machine, disk, zone, start/stop.**
- `c2d-standard-16` (16 vCPU AMD Milan, 64 GB) in `us-central1-a`, on demand,
  about $0.726/h. The C2D quota is 100 vCPUs, none in use. D1 measured E2
  hyperthreads as slow per core, so a C2D is the one to measure. If it doesn't
  beat the Macs, that is reported, not hidden.
- Boot disk: 100 GB `pd-balanced`, about $10/month, also charged while stopped.
  Debian 12 with Node 22, npm 10.9.8 pinned globally, git, python3, Playwright
  Chromium with its OS dependencies, and a persistent npm cache.
- **Start:** the controller runs `gcloud compute instances start` when the VM is
  `TERMINATED`, then waits for SSH (bounded at 3 min, else fallback). It never
  starts a VM marked `openwop-ci-disabled`.
- **Stop:** a systemd timer on the VM powers it off after **15 minutes** with no
  unfinished job and no SSH session. A guest shutdown is a GCE stop: no CPU
  charge. Macs never stop it, because another Mac may be mid-gate.
- Every gate is also bounded by the controller's `maxMs` (3 h, then cancel and
  fallback) and the supervisor's own `maxMs`.

**(b) Budget action path.**
- A Billing Budget of **$200/month**, filtered to the resource label
  `openwop-ci=gate`, alerts at 50, 90 and 100 %, and publishes to the Pub/Sub topic
  `openwop-ci-budget`.
- A small Cloud Run function `openwop-ci-budget-stop` (Eventarc on that topic)
  reads the message. When `costAmount >= budgetAmount`, it stops the instance and
  sets the metadata `openwop-ci-disabled=budget`, so no Mac restarts it. Gates
  then fall back to the Macs until the user clears the flag.
- **Test:** during the dry run, publish a synthetic budget message with cost ≥
  budget to the topic, then check that the VM stops, the flag is set, and the next
  controller run returns `fallback`.
- **Caveat:** budget notifications can lag by hours. The cap is approximate; the
  15-min idle stop and the 3-h gate bound limit how fast it can overrun.

**(c) IAM bindings created, one by one.**
1. Service account `openwop-ci-vm@` is attached to the VM with **no roles**
   and no access scopes. The VM can't call any Google API.
2. Service account `openwop-ci-budget-stop@` gets a custom role
   `openwopCiStop` (`compute.instances.get`, `compute.instances.stop`,
   `compute.instances.setMetadata`), bound **on that one instance**, not the
   project.
3. On the topic `openwop-ci-budget`: `roles/pubsub.publisher` for the Billing
   budget notification service account.
4. On the function: `roles/run.invoker` for its Eventarc trigger service account,
   plus `roles/eventarc.eventReceiver` for that account.

No human bindings are added. Starting the VM, the IAP tunnel and the SSH key
secret use the user's existing project roles.

**(c') Network and key.**
- A dedicated VPC `openwop-ci`. The default network's `default-allow-ssh` from
  0.0.0.0/0 must not apply.
- One ingress rule: tcp:22 from the IAP range `35.235.240.0/20` to the tag
  `openwop-ci-gate`. Nothing else comes in.
- An ephemeral external IP for egress only (npm, the Playwright download), which
  is cheaper than Cloud NAT at this usage.
- SSH goes through `gcloud compute start-iap-tunnel` to `127.0.0.1:<port>`.
  The planner is unchanged: literal host, pinned ed25519 host key, `ProxyCommand=none`.
- Client key: a new ed25519 pair. The private half is stored in Secret Manager
  `openwop-ci-ssh-key` and fetched to a 0600 file on each Mac. It is never in the
  repo, a note or the bus.
- `authorized_keys`: `restrict,command="/usr/local/libexec/openwop-ci-worker",from="35.235.240.0/20"`.
- `sshd`: `PermitTTY no`, `DisableForwarding yes`, `PermitUserEnvironment no`,
  `AllowUsers ci`, ed25519 host key only. The worker account is non-admin, with
  no sudo, and `usermod -p '*'`.

**(d) Evidence, the Tracegate ledger, and fallback.**
- The gate's evidence comes back in the fetch frame: the Hyvemind record, the
  gate log and the browser ledger. The Mac validates them locally and **does not
  import** them into its own Hyvemind or Tracegate ledgers. A Linux run is not a
  Mac footprint.
- The VM rebuilds every candidate from a bundle into a fresh `.git`, so its
  Tracegate has no history and runs every lane whole. That is slower, but no reuse
  crosses machines.
- A persistent VM-side ledger, and returning it, is a later, separate decision.
- **Every outcome other than an actual failed gate is `fallback`:**
  - unreachable, stopped or budget-disabled VM;
  - busy;
  - refused;
  - interrupted;
  - cancelled;
  - timed out;
  - evidence refused;
  - worker fault.

  The train then gates locally. Only a remote run that ran and failed is `red`.
  During the shadow phase, even that is advisory, and the local gate decides.

**Known gap before the gate can be green on Linux:** the `-linux` pixel baselines
(D1). They will be qualified in the shadow phase, not generated blindly.

### D9 P3 record: the gate VM is built; dry run — 2026-11-01

The release manager reviewed the proposal above, and its six conditions are
folded in:
1. no external IP, with Cloud NAT;
2. the budget function runs as its own account;
3. the IAP principal is named;
4. labels are on the VM and its disk;
5. the VM holds no credentials, runs Shielded VM, and gets unattended upgrades;
6. the disabled flag is a fallback.

Every resource was posted to the release bus as it was created.

**Created in `openwop-dev`:**

| Resource | Setting |
|---|---|
| VPC `openwop-ci` | custom mode; subnet `openwop-ci-us-central1` 10.88.0.0/24 with Private Google Access |
| Firewall `openwop-ci-allow-iap-ssh` | INGRESS tcp:22 from 35.235.240.0/20 to tag `openwop-ci-gate`. It is the only rule on that network. |
| Cloud Router `openwop-ci-router` + Cloud NAT `openwop-ci-nat` | Egress only, auto IP, about $5/month at most. Chosen instead of an ephemeral external IP, so the "no external IP" in the approved plan holds. |
| VM `openwop-ci-gate` | `c2d-standard-16` in **`us-central1-b`**. `-a` had no C2D capacity, and a start can also fail on capacity, which is a fallback. No external IP. Shielded VM (secure boot, vTPM, integrity). Account `openwop-ci-vm@` with **no roles and no scopes**. `block-project-ssh-keys`, OS Login off. Label `openwop-ci=gate` on the VM and its boot disk. |
| Service account `openwop-ci-vm@` | no roles anywhere |
| Service account `openwop-ci-budget-stop@` | 1. custom role `openwopCiStop` (instances get/stop/setMetadata) bound **on the instance**; 2. `roles/iam.serviceAccountUser` **on `openwop-ci-vm@` only**; 3. `roles/run.invoker` on the function only |
| Secret `openwop-ci-ssh-key` | the gate client's private key (version 1). On the Mac it lives in a 0600 file outside the repo. |
| Topic `openwop-ci-budget` | publisher: `billing-budget-alert@system` (added by Google) |
| Function `openwop-ci-budget-stop` | gen2. **Runtime and trigger identity are `openwop-ci-budget-stop@`.** Internal ingress, max 1 instance. |
| Budget `57e3b4e3` | $200/month, project `openwop-dev` + label `openwop-ci=gate`, alerts at 50/90/100 % to the topic |

**Deviation from the reviewed proposal (accepted by the release manager,
2026-11-01): a fifth IAM binding.**
- **What:** `roles/iam.serviceAccountUser` for `openwop-ci-budget-stop@`.
- **Why:** GCE requires actAs on an instance's attached service account to run
  `setMetadata` on that instance. Without it the budget stop could stop the VM
  but not set the `openwop-ci-disabled` flag, so a Mac would start it again.
  Found by the budget dry run (defect 8).
- **Scope:** bound on the service account `openwop-ci-vm@` **only**, not the
  project. That account holds no roles and no scopes, so acting as it grants
  nothing beyond the custom instance role.

**IAP principal:** the user's existing project-Owner account on MacBook-Pro-48.
No new human binding. A second Mac's account gets
`roles/iap.tunnelResourceAccessor` on the instance once the user names it.

**Provisioning:** `scripts/remote-gate-vm-startup.sh` as the startup script.
- Node 22.13.1 is installed from a tarball whose sha256 is pinned; npm is 10.9.8.
- Playwright's OS dependencies are installed.
- The worker code is a reproducible `git archive` of the reviewed files. Its
  sha256 is checked at boot **and is the runner policy pin** the Macs hold, so a
  request is bound to that exact worker code.
- sshd accepts one key, for one forced command, from the IAP range only.
- The VM publishes its ed25519 host key as a guest attribute, read over the
  authenticated GCE API and pinned.
- Unattended security upgrades run daily. There is no automatic reboot; a new
  kernel loads at the next start.

**Dry run results** (live, against the VM):

| Check | Result |
|---|---|
| Pinned host key, client key, forced command, through IAP | ✓ The worker answered a malformed frame with 65. |
| Wrong host key pin | ✓ Immediate `fallback: host key mismatch`, and no job. |
| Disabled flag (set by hand, then by the budget) | ✓ `fallback: remote gate disabled (…)`, and the VM was not started. |
| Real submission of `main`, cancelled at 150 s | ✓ `cancelled` mid-gate, with **verified** cleanup (the gate had used ~8 CPU-min in ~3 min). |
| VM hard reset during a gate | ✓ Boot recovery marked the job `interrupted`. |
| Synthetic budget message, cost ≥ budget | ✓ Flag set, then the VM stopped, both operations confirmed; the controller falls back. |
| Red gate log brought home (`log` operation) | ✓ |
| Idle power-off after 15 min | see below |

**Defects the dry run found, all fixed:**
1. **No user D-Bus** on the image. `systemd-run --user` and the idle query failed.
   Worse, the idle check read that failure as *idle*, so it could have powered off
   a running gate. Now `dbus-user-session` is installed, the user manager is
   restarted, and the check fails closed: a running worker or runner, or a failed
   query, counts as busy.
2. **`gcloud start-iap-tunnel --local-host-port` hung** at "Testing if tunnel
   connection works" (> 200 s), while `--listen-on-stdin` reached sshd at once.
   The Mac now runs a small relay on 127.0.0.1 with one `--listen-on-stdin`
   process per connection. The SSH planner is unchanged: literal host, pinned
   key, `ProxyCommand=none`.
3. **Snapshots from a linked worktree were refused.** `bundle create --all` also
   bundles `worktrees/<name>/HEAD`. Every real candidate is in a worktree.
4. **"No ref moved during the snapshot" almost never held** in this busy repo.
   The manifest is now what the bundle recorded. Only the candidate and `main`
   must be frozen, and they are checked around the bundle.
5. **A lost submit reply left a real gate running that could not be cancelled.**
   The Mac waited 15 s; the rebuild takes minutes. Two dry-run submissions were
   admitted and launched real gates on `main` (no merge, deploy or publish
   effect). One failed at once on fix 10; the other was stopped by the reset
   test. Now the submit waits up to 10 min, a lost reply is recovered by asking
   for status, and any fallback after the source was sent tries to cancel.
   **Open residual, BLOCKS MERGE USE UNTIL CLOSED:** a job the worker has not
   admitted yet can't be cancelled, because the journal only knows admitted jobs.
   If the connection drops after the upload but before admission, the worker can
   still admit and launch it. It then runs to the runner's 2-hour limit (was 4 h)
   and the VM reads as busy (fallback for everyone) until it ends. It cannot
   produce a merge, a deploy or a bus result, but no remote result may be used
   for merging while this is open.

   > **CLOSED 2026-11-02: admission no longer launches.** A `source` frame now
   > only rebuilds and admits the job (`accepted`). The runner starts on a new
   > control operation, `start`, which the controller sends only after it has
   > seen the job's status, so it always holds the request bytes that can cancel
   > it. `start` launches only an `accepted` job, once (an exclusive marker), and
   > only through the installed launcher. A job admitted but never started is
   > cancelled at the next admission after `acceptedStartGraceMs` (default 5 min):
   > `accepted` -> `cancelled` launches nothing, and its checkout is removed.
   > This changes the control contract: control could inspect, cancel and fetch;
   > it can now also *start an admitted job*, never admit or choose a command.
   > Witness: e2e "a submission whose reply is lost never runs, and the next
   > admission cancels it". It goes red when admission launches again. Linux and
   > macOS pass. Provisioning also re-runs when the worker payload's sha256
   > changes, so a new payload needs only a metadata update and a restart.
6. **A policy upgrade made the worker busy for good.** Jobs journaled under the
   old pin no longer validated, and an unreadable job counts as unfinished. A job
   for another runner or policy is now **retired**: a policy changes only at
   boot, so no live runner can own one.
7. **No way to read a red gate's log.** Added the `log` control operation: a
   finished job's kept log, only to the holder of that job's exact request bytes.
8. **The budget function reported success when `setMetadata` had failed**
   (`SERVICE_ACCOUNT_ACCESS_DENIED`: an instance with an attached account also
   needs actAs, hence binding 2 above). It now waits on each GCE operation,
   errors on failure, and sets the flag before stopping.
9. **A wrong host key waited out the 3-min SSH bound.** It is now an immediate
   fallback.
10. **`lsof` was missing.** Four gate-tooling self-tests failed on the port guard.
    Now installed, with `procps`, `zip` and `unzip`.

Each fix has a test where a test can hold it: linked worktree (source),
earlier-policy job (e2e, red under sabotage), lost reply and log (e2e),
budget-stop operation errors, the flag decision, and the live clock (supervisor).

**Budget caveat (restated):** budget notifications lag by hours. The real
spend controls are the 15-min idle power-off and the 2-h runner limit, plus the
controller's 3-h bound.

**Next:** a shadow gate. A full remote gate on a candidate that is also gated
locally is compared lane by lane, with the Linux pixel baselines as the expected
gap. The remote result has no merge use until the user and the release manager
sign off.

### D9 P5: visual baselines from a pinned image (user decision, 2026-11-02)

**Shadow comparison (shadow 8):** the candidate was `main` + #5475 + #5480 + #5487.
Every lane matched the local train result:
- gate tooling;
- frontend lint, build and vitest (1177/1177);
- backend vitest (2,999 files);
- every self-test;
- the ratchets;
- 110 e2e tests.

The exceptions were the 12 visual-snapshot tests (plus 1 advisory), which refuse
because baselines exist only for darwin. The VM gate took 29 min, against ~45 min
on a Mac. Cleanup was verified, with 4,443 processes owned.

**Decision (user, in openwop-app-d8):** generate a baseline set **inside the
official, version-pinned Playwright image**, have the user review it side by side
against the Mac set before it is committed, and have the VM render in that same
image.

**Design.**
- **Where pixels come from.** Pixels come from the browser, not the test runner.
  The two visual spec files connect to a remote browser named by
  `OPENWOP_E2E_PINNED_WS`, through a file-level `test.use({ connectOptions })`
  with `exposeNetwork: '<loopback>'`, so the browser reaches the runner's
  `localhost`. Every other e2e test keeps the local browser.
  > **Corrected 2026-11-02 (shadow 9):** this first used the global
  > `PW_TEST_CONNECT_WS_ENDPOINT`, which moved every e2e test into the container.
  > The 12 visual tests passed on the VM against the Mac-recorded `-pinned` set,
  > but 4 network-egress specs (WebRTC, self-navigation to the runner's sinks)
  > went red, for a reason that belongs to the container, not the app. Only the
  > visual specs need the pinned renderer. The browser runs from
  `mcr.microsoft.com/playwright:v1.60.0-noble` **pinned by its amd64 digest**
  (`sha256:83192064…71fd9`; Playwright 1.60.0 is the locked version) through
  `run-server`. The app stack and the runner stay where they are.
- **Naming.** Baselines rendered that way are keyed by the rendering environment,
  not the runner's OS: a fixed `-pinned` suffix instead of `-{platform}`. A Mac
  runner driving the pinned container therefore produces the same files the VM
  compares against. The darwin set is untouched, and Mac gates keep using it.
- **Guard.** The visual specs still refuse on a platform that has no baselines,
  with the remedy named. They accept `darwin` with a local browser, or any runner
  with the pinned remote browser. A remote browser that is not the pinned one
  must refuse: the endpoint is checked against the expected browser build.
- **Generation.** `scripts/e2e-pinned-baselines.sh` boots the same e2e backend
  as `ci.sh`, starts the pinned `run-server`, and runs only the visual specs
  with `--update-snapshots`. It writes `*-pinned.png` and a contact sheet
  (darwin | pinned) for the user's review. It is never part of a gate.
- **VM.** Provisioning installs Docker, pulls the image **by digest**, and runs
  `run-server` on 127.0.0.1 as a service. The gate env sets the two
  `PW_TEST_CONNECT_*` variables, and `playwright_browsers_present` treats a
  configured remote browser as present.
- **Qualification.** The baselines are generated on a Mac (amd64 emulated) and
  compared on the VM (native amd64). If the VM passes against them, two
  independent amd64 environments agree. If they differ, that is reported, not
  re-recorded.

**Release-manager conditions before any merge use:**
- (a) two consecutive shadow runs with no `interrupted`;
- (b) the fallback path exercised once for real: VM unreachable, then a local
  gate decides;
- the user's and the release manager's sign-off.

### D9 P6: merge-train gates remote-first (off by default) — 2026-11-02

The design was approved by the release manager with four changes, which are all
folded in. **It is OFF unless `OPENWOP_REMOTE_GATE=1`**, and stays off until the
user and the release manager sign off.

- **Order.** `gate_train` tries the FULL train gate on the remote VM first,
  through `scripts/lib/remote-gate-train.sh`:
  - green → the gate pass;
  - **red → final.** No local second chance, and no bisection, because local
    halves could merge what the remote gate failed. The log says to re-run with
    `OPENWOP_REMOTE_GATE=0` to find the culprit;
  - **anything else is a fallback**, and the local gate runs exactly as before:
    unreachable, the disabled flag, busy, timeout, interrupted, refused, a host-key
    mismatch, or the closed worker faults.

  Bisection sub-gates are always local.
- **Busy VM.** A busy VM falls back at once and never queues. The log prints
  `remote fallback: busy (held by <host>)`. The holder comes from the bus (the
  newest `remote-start` with no `remote-end` from another host), because the
  worker cannot name it: requests carry no submitter.
- **Time bound.** `OPENWOP_REMOTE_GATE_TRAIN_MAX_MIN` (default 75) bounds the whole
  remote attempt. Past it the controller cancels the remote job and the train
  falls back.
- **Acceptance record.** It is written to
  `<git-common-dir>/remote-gate/train-*.json`, **outside the train worktree**. The
  candidate cannot pre-place or alter what lets it merge. `merge_train` refuses
  unless the record names this request, the train's commit and its tree.
- **The controller is pinned.** It never runs from the train (the candidate) nor
  from this checkout. It runs from
  `~/.config/openwop-ci/install/<policy-sha>/`, installed by
  `scripts/remote-gate-install-controller.sh <commit>` only when the payload's
  sha256 equals the policy pin. **One payload definition**
  (`scripts/lib/remote-gate-payload.sh`) feeds both the VM's provisioning and the
  Macs' installs, so controller and worker are the same code.
- **Where it ran.** Every gate logs `gate ran on: remote openwop-ci-gate (request …,
  policy …, N min)`, `gate runs on: local <host>`, or `remote fallback: <reason>`.
  The bus gains `remote-start` and `remote-end` events, and the train result
  carries `where`.
- **Tracegate.** Remote footprints are never ingested. With remote gates on, each
  train WARNs when a local lane's last complete full run is more than 24 h old,
  because its STALE checks run only locally.

**Found while building it: the policy pin was not reproducible.** `git archive
<commit>:scripts` archives a tree, which stamps the current time into every entry,
so the sha256 changed from one second to the next. The earlier pins that matched
did so because both builds ran within the same second. The payload now uses
`--mtime=@<commit time>` (git ≥ 2.43). Witness: the gate-tooling case builds
twice, a second apart; it is red without `--mtime`.

> **CORRECTED 2026-11-05 — `--mtime` does not exist on Apple git 2.39.5** (it
> arrived in git 2.42, not 2.43). There, `git archive` printed usage and wrote
> nothing, and train 379 went red at "remote-gate install did not install the
> pinned payload". The witness above passed anyway: both builds hashed an empty
> file and agreed. The payload is now written by `scripts/lib/remote-gate-payload.mjs`:
> a ustar archive from the commit's blobs (sorted, mtime = commit time, root,
> 0644/0755) gzipped by node's zlib under a fixed header (mtime 0, OS 3). No git
> archive and no system zlib, so the sha depends only on the commit. Tests: a
> fixed fixture commit must build one golden sha with `git archive` refused by a
> PATH shim, run through a symlink; the build must print a sha and extract to the
> commit's bytes. **The sha differs from the git ≥ 2.42 builds, so a pin minted
> from them must be re-minted.**

**Tests** (`test-merge-train-bisect.sh`, fake pinned controller), 45/45. The cases:
- remote green merges with no local gate, and its record is not in the train
  worktree;
- remote red is final, with no local gate and nothing landed;
- busy falls back to one local gate;
- the disabled-flag drill makes the local gate decide;
- a mismatched record refuses the merge;
- no pinned install falls back;
- with the switch off, the remote gate is never called.

Sabotage checks:
- removing the no-bisect rule lets a remote-red train's halves merge locally (red);
- removing the record check lets a mismatched record land (red).

Gate tooling 97/97 (payload reproducibility; the installer refuses a wrong pin and
installs the right one).

**Remaining before any merge use:**
- (b) the real fallback drill, on a real train with the VM flagged;
- the user's and the release manager's sign-off.

### D9 shadow record and the baseline decisions — 2026-11-02/03

**User decisions (in openwop-app-d8):**
- **All 53 `-pinned` baselines approved** after a side-by-side review against the
  darwin set (2026-11-02).
- **The `-pinned` set is merge-gating on the remote gate**, as `-darwin` is on the
  Macs (2026-11-02). A visual red on the VM is a real red, not advisory.

**Shadow runs.** Each ran the full canonical gate on the VM for a candidate train
while the real train gated locally. None was used to merge. What each one found:

| Shadow | Finding | Fix |
|---|---|---|
| 1 | merge-train fetched origin before its freeze check | #5475 |
| 2 | preflight waiter's PID race; a newer controller ran against an older worker | #5480; one payload definition (P6) |
| 3 | #5480's `printf \| grep -q` broke the EPIPE ratchet; rsync missing on the VM | here-string; rsync installed |
| 4 | no git identity in the VM's gate environment | identity in worker.json |
| 5 | a full gate's log outgrew 256 MiB and could not be fetched | 1 GiB bound; the controller says why a fetch failed |
| 6 | ci.sh's Chromium check ignored `PLAYWRIGHT_BROWSERS_PATH` | #5487 |
| 7 | interrupted once, with no reason logged | the runner logs details and the cleanup verdict |
| 8 | every lane matched the local train except the 12 visual tests (no Linux baselines) | P5 |
| 9 | a global remote browser broke 4 network-egress specs | only the visual specs use the pinned browser |
| 10 | the clockshift floor misread vitest's coloured output | #5496 |
| 11 | a candidate conflict between #5487 and #5496; a green gate refused locally because `origin/main` had moved | #5496 re-placed; shadows run from a private clone with a pinned `origin/main` |
| 12 | green on the VM, but the result fetch stalled | the log travels gzipped; the fetch is retried |
| 13 | **fully accepted** | — |

**Shadow 13** (candidate `main` 8615a9d10 + #5475 + #5480 + #5487 + #5496 + the
pinned baselines): the full gate was green on the VM in **32 min** (34 with
transfer, against ~45 on a Mac), the result was fetched on the first try, and the
Mac validator **ACCEPTED** it (commit 73cc59ed6, tree a91c011f2, required and
advisory browser lanes passed, `mergeAuthorized: false`).

**Release-manager condition (a)** — two consecutive shadows with no `interrupted` —
is met (shadows 8, 9 and 10, and every one after). Condition (b), the real fallback
drill, and both sign-offs remain, after the VM is re-provisioned from `main`.

> **Corrected 2026-11-08 (shadow 14): the two baseline sets drift apart unless a check
> ties them.** After the merges the VM was re-provisioned from `main` 5d208fb35 (payload
> a423823d) and shadow 14 ran the full gate there. It was **red on two required visual
> tests** (`public-home` light and dark), and correctly so: on 2026-11-07, b927451a8
> (public-home) and b9ef29fcc (builder, ADR 1065) re-recorded four `-darwin` baselines
> on a Mac and left their `-pinned` twins as they were. The Macs passed; the VM, rendering
> the new page against the old `-pinned` image, did not. With the remote gate first, that
> red is **final for the whole train**, so a darwin-only re-baseline would red every
> VM-first train that carried it.
>
> **Fix:** `frontend/react/e2e/pinned-baselines.lock.json` records the sha256 of each
> `-darwin` image that its `-pinned` twin was rendered beside. The generator writes it
> after a clean recording (`check-pinned-baselines.mjs --write`). The gate, `ci:quick`
> included, runs `scripts/check-pinned-baselines.mjs` and fails on a changed `-darwin`
> image, a missing twin or entry, or an orphan entry, naming the remedy. So an author
> re-baselining visuals now learns on the Mac to re-run `scripts/e2e-pinned-baselines.sh`
> (Docker), not in a VM train. The lock was seeded from the `-darwin` images at
> 21c895056, the commit that added the `-pinned` set; on `main` it reports exactly the four
> stale pairs. The four were then regenerated in the same PR. Condition (b), the fallback
> drill, waits for this to merge.
