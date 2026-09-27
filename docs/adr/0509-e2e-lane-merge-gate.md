# ADR 0509 — Should the Playwright e2e lane block a merge?

Status: Accepted (Phases 2–4 implemented)
Date: 2026-08-01

## Context

`npm run ci` is the merge gate (the hosted GitHub Actions workflow is deliberately
disabled — repeated org billing outages made it red-by-default). It runs backend
build + vitest and frontend lint + build + vitest.

It does **not** run the Playwright e2e lane. That lives in `npm run ci:full`
behind `OPENWOP_CI_E2E=1`, because it needs Chromium, free ports, and a
purpose-booted backend (`scripts/ci.sh:95-128`).

So the app has a browser-level test lane that **nothing blocks on**. This ADR
decides what to do about that.

### The evidence that prompted it

While verifying #2739 (a first-real-browser test of the hub Suspense boundary),
running the full lane surfaced **five** failures. None were caused by that
change — all reproduced with the new file removed. Diagnosed:

| Failure | What it actually was | Outcome |
|---|---|---|
| `a11y: /keys` light + dark | **A real WCAG 2 AA violation.** `.btn-link` rendered `#b95c3a` on `#f4f1ea` at 13px = **3.99:1** against a 4.5:1 requirement — a shared primitive with 15 call sites, inaccessible **at rest** in both themes | Fixed, #2742 |
| `a11y: /` light + dark | **A stale assertion hiding total absence of coverage.** The spec waited for `main#main-content`, but ADR 0487 made `/` the PUBLIC root rendering `main#public-main`. `/` timed out at 30s and axe **never ran on it** | Fixed, #2743 |
| `collab` two-client | Undiagnosed; fails waiting for `.doc-editor__content` | Open |

Two of the three were **real defects sitting on main**. The lane had been
reporting the contrast violation continuously; nobody was listening, because
nothing blocks on it.

The `/` case is the more instructive one. Its symptom was a **timeout, not a
violation**, so it read as a flaky lane rather than a stale assertion — and a
lane with two permanently-red tests is a lane people stop reading. The failure
that hid the coverage gap was also the failure that discredited the messenger.

## Decision drivers

1. **The lane catches real, shipped defects.** Demonstrated above, twice, in one
   sitting. This is the whole case for promotion.
2. **A red or flaky blocking gate is worse than no gate.** It trains
   `git push --no-verify`, and a bypassed gate protects nothing while costing
   everyone time. The lane was 5-red an hour ago; it is 1-red now.
3. **Cost of entry.** Promotion puts a Chromium dependency
   (`npx playwright install chromium`) and ~3 min of wall-clock on every merge
   path. That is a real tax on a gate developers run locally.
4. **Not all specs are equal.** The `a11y` specs are fast (~45s for 32 tests),
   deterministic, and catch a defect class that static analysis provably cannot —
   colour contrast is measured on rendered pixels. The multi-context realtime
   specs (`collab`) are slower and inherently more timing-sensitive.

## Options

| Option | Buys | Costs | Reversible |
|---|---|---|---|
| **A. Leave it opt-in, document honestly** | Nothing changes; zero risk | The two defects above were found by accident, not by process. Guarantees a recurrence | n/a |
| **B. Promote the whole lane into `npm run ci`** | Maximum coverage | Chromium + ~3 min on every merge; `collab`'s timing sensitivity lands directly in the gate | Easy |
| **C. Promote a fast, deterministic SUBSET; keep the rest in `ci:full`** | The a11y/boundary classes become a ratchet; the flake-prone realtime specs stay opt-in | Two tiers to explain | Easy |
| **D. Pre-push hook only (`npm run hooks:install`)** | Catches regressions before they land, no gate change | Silently skipped by `--no-verify`; not a ratchet | Easy |

## Recommendation

**C, sequenced behind a hard precondition.**

**The precondition is non-negotiable: the promoted subset must be green first.**
Promoting a red lane is how a gate becomes something people route around. As of
this ADR the a11y specs are green (32/32) and the hub-boundary specs are green
(4/4); `collab` is not, and stays out of the gate until it is diagnosed.

Phasing, with real gates between:

- **Phase 1 (done).** Make the candidate subset green — #2742, #2743, #2739.
- **Phase 2.** Diagnose `collab`. Either fix it or quarantine it explicitly with
  a stated reason. An undiagnosed failure must not be silently excluded: that is
  how the `/` timeout survived.
- **Phase 3.** Add an `OPENWOP_CI_E2E_FAST=1` tier to `scripts/ci.sh` running the
  deterministic subset, and call it from `npm run ci` **when Chromium is already
  installed**, skipping with a loud, actionable message when it is not. A gate
  that hard-fails on a missing browser would block work unrelated to it.
- **Phase 4.** Once it has been green across a meaningful number of merges, make
  the Chromium requirement mandatory rather than skip-if-absent.

Phase 3's skip-if-absent is the compromise between drivers 1 and 3, and it is
deliberately weaker than a true ratchet — it is a gate for people who have the
browser, not a guarantee. Phase 4 is what makes it a guarantee, and it should not
be skipped just because Phase 3 feels like progress.

## What would change this recommendation

- If `collab` turns out to be **genuinely flaky rather than broken**, the case for
  any promotion weakens: a lane that fails intermittently teaches bypass faster
  than it catches defects. Diagnose before promoting.
- If Phase 3's skip-if-absent turns out to skip for most developers in practice,
  it is theatre and should be replaced by Phase 4 immediately or reverted to
  option D.

## Consequences

- The two defect classes that motivated this (rendered-pixel contrast; assertions
  that silently stop covering their target) get a ratchet rather than depending on
  someone running `ci:full` by hand.
- Two-tier e2e needs documenting in `CLAUDE.md` § "Verifying changes", or the
  distinction will erode.
- **This ADR does not touch the wire.** No RFC required.

## Correction note (2026-08-01) — Phase 3 as originally written was unsafe

Implementing this found two defects in the plan above. Recorded here rather than
silently rewritten, because the reasoning trail is the point.

**1. Promoting the lane would have SIGKILLed developers' dev servers.** The e2e
block ended with

    lsof -nP -iTCP:8080 -sTCP:LISTEN -t | xargs kill -9

which is not "kill my backend" — it is *kill whatever owns the port*. Tolerable
for an opt-in lane run deliberately; catastrophic in a merge gate that is also
wired as a pre-push hook on a machine where several sessions work and a dev
backend normally holds :8080. Be precise about what was verified: the NEW guard was
executed against the live dev-server process and left it running (pid checked
before and after). The old sweep's behaviour is READ FROM THE CODE — `lsof … |
xargs kill -9` on a port it does not own — and was deliberately NOT executed,
because running it would have killed the developer's server to prove a point.

**2. The readiness probe could not tell its own backend from a pre-existing
one.** Anything already listening with the test seams answers `test/login` 201,
so the probe passed and the suite ran against a DIFFERENT BUILD. This is the same
defect `playwright.config.ts` already fixed one layer up by keeping
`reuseExistingServer` off — "a green suite that never executed your code". The
backend half still had the bug the frontend half was hardened against.

So a **Phase 2.5** was inserted ahead of promotion: pick a free port, REFUSE to
start on an occupied one rather than adopting the occupant, and kill only the PID
we started.

**3. The `OPENWOP_CI_E2E_FAST` subset tier was dropped.** `scripts/ci.sh` already
tiers on **runtime dependency** (`OPENWOP_CI_E2E` = needs Chromium,
`OPENWOP_CI_LIVE` = needs Docker); a subset-vs-full flag adds a second, orthogonal
axis to that seam. It also buys nothing measurable: setup dominates (8 tests ran in
~11s against ~30s of setup), so curation saves seconds while costing a permanent
second concept. The whole lane is promoted instead, minus quarantine.

**4. The two entry paths must fail DIFFERENTLY** — discovered only by building it.
The new port guard exits 1, so promoting it unchanged would have broken the merge
gate for every developer with a dev server running. Explicit `OPENWOP_CI_E2E=1`
hard-fails (you asked for the lane; quietly not running it is the dishonest
outcome); the auto path skips loudly (a developer's machine state must not break
their gate).

### Phase 2 — collab is QUARANTINED, not skipped

`collab.spec.ts` carries a `@serial` tag: `npm run test:e2e` is
`--grep-invert @serial`, `npm run test:e2e:serial` is `--grep @serial --workers=1`,
and `ci.sh` runs both. It therefore still executes on every pass. Deliberately not
a fifth `test.skip` — 4 of 13 specs already skip behind opt-in env vars and this
lane's coverage is measurably overstated by file count (`E2E-2`); a quarantine that
stops a test executing is indistinguishable from deleting it a few months later.

### Phase 4 remains GATED, and the criterion is stated

Phase 4 (making Chromium mandatory so the auto path stops skipping) is **not
done**, and cannot be done today: it is gated on the promoted lane being green
across real merges, which is evidence that accrues over time, not a task. The
falsifier stands: **if the auto path turns out to skip for most developers in
practice, this is theatre** and should be escalated to Phase 4 or reverted to a
pre-push hook — not left in place looking like coverage.

### Implementation record

| Phase | Status | Evidence |
|---|---|---|
| 1 — make the subset green | done | #2739, #2742, #2743 |
| 2 — quarantine collab | done | `@serial` + two-pass `ci.sh`; 57 parallel + 1 serial = 58 green, 0 failed (was 45/5) |
| 2.5 — port safety | done | guard refuses on a busy port with the dev server verifiably untouched; own-PID-only teardown |
| 3 — promote to the default gate | done | auto-runs when the machine can; loud skip naming the blocker otherwise |
| 4 — Chromium mandatory | **gated** | needs a green streak across real merges |

## Phase 4 (2026-08-01) — most of it was an engineering problem I had called a time gate

Phase 4 was deferred as "gated on evidence accruing over merges". That was partly
an excuse. The auto path had exactly two skip causes and both were removable:

**4a — port contention: REMOVED.** The gate now selects a free port instead of
skipping (`pick_free_port`). This bit exactly when the repo was busiest — two
sessions running the gate meant the second silently did not run the browser lane.
It does NOT reintroduce the Phase 2.5 defect: that bug was *adopting* an occupant;
here we bind a port nobody holds. A lost race fails loudly at the readiness probe.
An explicitly pinned `OPENWOP_CI_E2E_BACKEND_PORT` is honoured verbatim and never
auto-moved — if you named a port you meant it. Verified with :8080 and :5173 both
occupied: selects 8081/5174 and the full lane runs.

**4b — the escalation criterion: NOW DECIDABLE.** "Green across a meaningful
number of merges" was never defined, never instrumented, never recorded — a gate
nobody can evaluate is never discharged. That is the exact half-measure this ADR
warned about, committed by this ADR. `ci.sh` now appends one line per gate run
(timestamp, sha, ran/skipped + why) and `npm run ci:e2e-report` returns a verdict
with a stated threshold: **below an 80% run rate, promotion is theatre, not
coverage** — escalate or revert, do not leave it looking like coverage.

**4c — browser auto-install: DELIBERATELY NOT DONE.** I proposed it, then checked
current practice, which is explicit: browser installation belongs in a cached CI
setup step, and pre-commit/pre-push hooks should stay lightweight. `npm run ci` IS
the pre-push hook, so a ~150MB download on `git push` is the anti-pattern, not the
fix — surprising, slow, offline-hostile. "Chromium not installed" stays a skip,
with a message that names the one command that clears it.

### The retreat: the @serial pass is ADVISORY, not blocking

Phase 2 put `collab.spec.ts` in the gate's serial pass on the theory that its
failure was a parallelism artifact. **More evidence says otherwise.** On a loaded
machine (measured at load ~130 with peer suites live) it fails
**deterministically** — three attempts including two retries, three failures. Not
a flake retries can absorb.

A merge gate runs precisely when the machine is busy, so blocking on it would
redden everyone's gate exactly when they are working. It now RUNS and is
LEDGERED — so "is collab actually passing?" stays decidable — but it does not
fail the gate. That is a weaker guarantee than Phase 2 claimed, and it is recorded
as a retreat rather than quietly softened.

### Phase 4 status: substantially complete, with one sharp residual

| Component | State |
|---|---|
| Remove the port skip cause | **done** (4a) |
| Make the escalation criterion measurable | **done** (4b) |
| Remove the browser skip cause | **deliberately not done** (4c) — contrary to practice |
| Flip Chromium to mandatory hard-fail | **OPEN** — now blocked on real data, which 4b finally produces |

The residual is sharp and small: run `npm run ci:e2e-report` after ~10 gate runs.
If the run rate is ≥80%, flip the auto path to hard-fail. If it is not, this
promotion is theatre and should be reverted to a pre-push-only hook.

## Phase 4 final step (2026-08-01) — the flip shipped, and the criterion I set was wrong

Phase 4 was left with one residual: flip the auto path from skip-if-Chromium-absent
to hard-fail, "once green across ~10 gate runs". **That criterion measured the wrong
variable.** After 4a removed port contention, the run rate reduces to a single
directly-observable fact — does this developer have Chromium — which needs no
sampling. I could just look, and I did: 6 browsers cached, and all sessions on this
machine share `$HOME`, so the measured blast radius was zero.

Three things made the flip correct rather than convenient:
- `@playwright/test` is **already a declared devDependency**; the browser binaries
  are its binary half, not an optional extra.
- `scripts/ci.sh` **already** hard-fails on a missing dev dependency and refuses to
  auto-install — "that's the dev's choice". Same policy, same class of thing, same
  file.
- A silent skip means `npm run ci` can go green **having never opened a browser**,
  which is the whole defect this ADR exists to remove.

### But NOT unconditionally — the adopter case blocked that

`scripts/build-whitelabel-zip.sh:72` is `git archive HEAD`, so the white-label
bundle ships **this script and the e2e specs** to adopters. Hard-failing a fresh
adopter clone on a browser they never asked for is a hostile first run, and
`check-whitelabel-build.sh` exists precisely because that run must work.

So the shipped form is **mandatory by default, escapable by intent**:
`OPENWOP_CI_E2E=0` opts out, and the error names it alongside the install command.
**A silent skip and an explicit opt-out are not the same thing** — only the first
was the defect.

### The ledger is kept, and its question changed

It was built to decide the run-rate criterion, which is now closed by argument.
It stays because it answers a *different* live question: `ran:pass` / `ran:fail`
tells the next person whether the promoted lane is actually staying green over
time, which no amount of reasoning can establish in advance.

| Phase | Status |
|---|---|
| 1 make the subset green | done (#2739, #2742, #2743) |
| 2 quarantine collab | done — later RETREATED to advisory (#2766); it runs and is ledgered, it does not block |
| 2.5 port safety | done (#2761) |
| 3 promote to the default gate | done (#2761) |
| 4a auto-select a free port | done (#2766) |
| 4b make the criterion decidable | done (#2766) — ledger + `npm run ci:e2e-report` |
| 4c auto-install the browser | **deliberately not done** — contrary to current practice for pre-push hooks |
| 4d Chromium mandatory | **done** — hard-fail by default, `OPENWOP_CI_E2E=0` to opt out |

**Residual risk, stated:** on a machine without Chromium the gate now fails until
someone runs one command or opts out. That is the intended cost of the guarantee.
If it proves hostile in practice — particularly for adopters — the honest response
is to revert 4d, not to weaken it back into a silent skip.

## Correction note (2026-08-02) — "advisory" was not advisory, and two claims were too strong

A peer ran the composite on a QUIET machine and got `EXIT 1` while both unit
suites passed. The browser lane was not what failed the gate: collab failed,
printed **"advisory: not blocking the gate"**, and the NEXT stage died on
`http://localhost:5174 is already used`.

**Root cause was mine, from Phase 4a.** `ci.sh` did `export OPENWOP_E2E_PORT`
after auto-selecting a free Vite port. `e2e-routes.sh` reads DIFFERENT variable
names (`OPENWOP_E2E_WEB_PORT`, `OPENWOP_E2E_BACKEND_PORT`), so it kept its own
5173/8080 defaults — but Playwright reads `OPENWOP_E2E_PORT`, inherited the
exported 5174, and with `reuseExistingServer:false` tried to start a SECOND Vite
on the port the previous stage had not finished releasing. Phase 4a taught one
stage to stop assuming a port and left the other assuming it.

Four fixes, and the third is the one I would have missed:
1. The export is **scoped to the invocation that chose it**, never global.
2. `e2e-routes.sh` **selects its own free ports and REFUSES a pinned-but-busy
   one** — adopting an occupant would run the suite against a different build.
3. Teardown now waits for the **PORT to be released**, not just the PID to exit.
   `kill` returns before the socket is free, and that gap is the failure window.
4. `e2e-routes.sh` pins Playwright to the Vite **it already started**
   (`OPENWOP_E2E_REUSE_SERVER=1`), so the stage runs ONE server instead of two.
   Reuse is normally off for good reason; it is safe here only because step 2
   proved the port was free and this script started the server.

**The message was also dishonest.** "Not blocking the gate" is a claim a single
step cannot make. It now says "not failing THIS step" and states plainly that a
failing collab can leave state behind.

### And a claim of mine that the evidence weakened

I wrote that collab "passes on a quiet machine — load-sensitive rather than
broken", from ONE passing run. The peer's run failed on a genuinely quiet machine
at `collab.spec.ts:114` (the per-user undo assertion, 15s timeout). That is
1-for-2. The advisory decision stands — arguably more firmly if it is genuinely
broken — but **the reason I gave for it does not**, and the underlying flake
remains uncharacterised rather than explained.

### Correction to fixes 3 and 4 above (2026-08-02, #2868)

A `/code-review` pass over the fix I had just merged found that **two of the four
items above described weaker code than they read like**, and both were changed.
The list stays as written; this is what it should have said.

**Fix 3 waited but did not enforce.** As shipped in #2864 the loop polled `lsof`
for 15s and, if the port was still held, printed a warning and continued. That is
a quieter version of the very bug it was written to fix: the next stage collides
anyway, now with a warning nobody reads. It is now **fatal** — and it fails where
the cause is rather than two stages later. Fifteen seconds is generous for a
socket to close; if it has not, the next stage cannot succeed.

**Fix 4's safety argument was not a proof.** "Step 2 proved the port was free and
this script started the server" is true in the happy path and does not cover the
window between `pick_free_port` returning and `npm run dev` binding. Another
process can take the port in that gap, `wait_for` cannot tell OUR server from an
occupant, and Playwright would then adopt a server built from different code and
report the suite green — exactly the defect `reuseExistingServer:false` exists to
prevent, re-opened by my own hand. #2868 replaces the argument with a check: the
listener holding the port must be our vite (or its child), or the stage refuses.
**The reuse flag is safe because it is now verified, not because the timing is
usually fine.**
