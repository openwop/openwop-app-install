# ADR 0550 — Conformance, provenance, CI and claims attestation

Status: Accepted — P0–P1 implemented 2026-08-11 (`bfec8b9e4`), P1 quarantine burned down 2026-08-13 (`5b70f0876`), P2 implemented 2026-08-13 (`022357c71`, `738346db7`); P3 verifier + signer + Operations projection implemented 2026-08-13 (`022357c71`) — residue: nothing invokes `scripts/sign-attestation.mjs` (no deploy pipeline calls it); **P4 implemented 2026-08-17** — the `spec-prose` block LIFTED (RFC 0155 §A's rename landed at suite 1.110.0 and RFC 0156 §E gates `OpenWOP conformant` on bundle evidence, not on the externally-gated rows; see the P4 correction below) — merged as `54229aa61` (#3309). **P0–P4 all implemented; the ADR is `implemented` on its own phase list.** Residue that is NOT a phase: nothing invokes `scripts/sign-attestation.mjs`. See § "Merged-tree provenance — reconciled 2026-08-17 (H44)" and `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md`. **Also not a phase: the delivery-gate correction (H60, 2026-08-18)** — hosted CI has been `disabled_manually` since 2026-07-21 (three weeks before this ADR was written), `main` is unprotected, recent merges carry 0 checks and 0 reviews, and the backend job ordered `typecheck` before `npm ci` so it could not have passed; the local `scripts/ci.sh` gate is the deliberate current posture and enforcement is a human item. See the CORRECTION under § "Lane 1 — pull-request correctness". **Also not a phase: the vendored-fixture parity invariant + guard (H48, 2026-08-17)** — see § "Vendored `conformance-fixtures/` parity", which carries a CORRECTION to ADR 0533's provenance claim and one open follow-up for a memory owner (`IMPLEMENTED_MEMORY_ACTIONS` is empty, so five memory fixtures are vendored but deliberately unadvertised).

Date: 2026-08-11

Composes: `backend/typescript/conformance/run.ts`, `.github/workflows/ci.yml`,
`scripts/ci.sh`, ADR 0518 deploy provenance, ADR 0395 Operations. Protocol gates:
RFC 0148, 0155 and 0156 (all `Accepted` as of 2026-08-16; they were `Draft` when this ADR was written — see the P4 correction).

## Context

The app has a substantial conformance harness and currently pins
`@openwop/openwop-conformance` 1.73.0. That resolves the audit's immediate
dependency-freshness delta. It does not resolve assurance:

- `test:conformance` exists, but the GitHub backend job runs only build and
  Vitest (`.github/workflows/ci.yml:108-142`); `scripts/ci.sh` likewise omits it.
- The harness enables test seams and opts out of many production profiles
  (`conformance/run.ts:50-184`). Its comment says CI gates on it, but CI does not.
- The backend job name says “tsc” while `npm run build` is esbuild; an explicit
  `typecheck` script exists but is not called.
- A passing test-seam profile is not evidence that the deployed Cloud Run
  posture, auth, durable adapters, or capability set passed.
- Compatibility claims are not cryptographically bound to suite version,
  profile, capability digest, commit, artifact and environment.

## Decision

Create one assurance pipeline with three distinct, non-substitutable lanes.

### Lane 1 — pull-request correctness

Block every PR on explicit backend `npm run typecheck`, build, unit/integration
tests, schema/pack checks, and a fast non-vacuous core conformance profile. No
soft skip may satisfy a required assertion. Upload the machine result even on
failure.

> **CORRECTION 2026-08-18 (H60) — Lane 1 is not enforced, and the hosted job
> could not have passed if it were.** This ADR was written on 2026-08-11 and
> describes Lane 1 in the present tense, citing `.github/workflows/ci.yml` as a
> shipped gate. Both halves of that were false on the day, and the ADR never
> said so. Measured 2026-08-18, first-hand:
>
> - `gh workflow list --all` → **`CI  disabled_manually`** (id 290520170),
>   disabled **2026-07-21 21:36 -04:00** (#2359, `ac88ed8bf`) — three weeks
>   BEFORE this ADR was written. It has not run since.
> - `gh api repos/openwop/openwop-app/branches/main/protection` → **404 "Branch
>   not protected"**; rulesets `[]`.
> - The four most recent merges (#3329–#3332) each carry **0 status checks and
>   0 reviews**.
> - The backend job ordered `npm run typecheck` BEFORE `npm ci` — introduced by
>   **this ADR's own P0** (`bfec8b9e4`) into an already-disabled workflow, so on
>   a clean runner it could never go green. Re-enabling CI as it stood would
>   have reddened every PR for the wrong reason. Fixed in H60, and
>   `ci-gate-coverage.test.ts` now pins the ORDER, not just the presence — the
>   guard that existed asserted the step EXISTS, which is the "gate that cannot
>   fail" class that file was written to catch.
>
> **The decision this records (it is not a phase, because no code closes it).**
> The CURRENT merge gate is local `scripts/ci.sh` plus the opt-in pre-push hook,
> and that is a deliberate posture (CLAUDE.md § "Local CI is THE gate", decided
> 2026-07-21 after repeated org billing/spending-limit outages made hosted
> Actions red-by-default). It is not a weaker gate: `ci.sh` runs vendored-schema
> drift, vendored-fixture parity, ADR refs, gate-tooling and deploy-gate
> self-tests, typecheck, the full backend suite, full conformance, a production
> `npm audit` with expiring exceptions, and registry parity — **none of which
> the hosted `ci.yml` has ever run**. What is missing is ENFORCEMENT: the hook
> is opt-in and bypassable (`--no-verify`), `main` accepts direct pushes, and
> nothing blocks a merge.
>
> Closing that needs org billing plus admin rights on the repository — a human
> decision, not an engineering phase. Until it is taken, Lane 1's "Block every
> PR" describes an intent, not a control, and this ADR should not be read as
> evidence that PRs are gated.
>
> **Stated non-goal.** `ci-gate-coverage.test.ts` is text-level by design
> (running the gate from inside the gate is circular), so no test in this repo
> can observe that the workflow is disabled — a green suite means "the workflow
> would work if enabled". That blind spot is exactly why this note exists rather
> than a test.

### Lane 2 — release candidate conformance

Boot the release artifact, not source through a special test runner. Run the
full declared profile matrix against its discovery document. Every advertised
capability must have an executed behavior witness; opted-out profiles are
recorded as not claimed, never pass. Pin suite and corpus versions exactly.

### Lane 3 — deployment attestation

After backend deployment, run the production-safe black-box subset against the
real origin with real auth and durable storage. Emit a signed attestation that
binds:

- app commit, container digest and deploy revision;
- protocol/corpus/conformance versions;
- exact profile list and discovery-document digest;
- environment class and storage/queue adapter kinds (no secret values);
- executed/pass/fail/skip counts and evidence artifact digest;
- timestamp, signer and expiry.

The public claim renderer reads only a valid, unexpired attestation. It says
“conforms to profiles X at evidence Y”; it never emits an unqualified
“OpenWOP-compatible” badge.

## Boundaries audit

| Concern | Owner |
|---|---|
| Test orchestration | existing CI workflows and `scripts/ci.sh` |
| Conformance execution | existing `conformance/run.ts`; no second runner |
| Build/deploy identity | ADR 0518 provenance record |
| Operator projection | existing Operations feature/panel |
| Claim vocabulary/evidence schema | upstream protocol RFCs, vendored after acceptance |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core CI/release infrastructure; Operations only projects results. |
| 2 | Toggle | None. Release gates cannot be tenant-toggleable. |
| 3 | Workflow surface | None. |
| 4 | Node pack | None. |
| 5 | Envelopes | None. |
| 6 | Agent pack | None. |
| 7 | Public surface | Attestation link/claim only in the RFC-defined form; diagnostics remain host-ext. |
| 8 | RBAC | Detailed evidence is operator-only; public claim exposes no tenant data. |
| 9 | Replay/fork | Not applicable; conformance fixtures must still test both. |
| 10 | Frontend | Add an Operations card, not a new navigation destination. |

## Phases and verification

| Phase | Scope | Gate |
|---|---|---|
| P0 | Add explicit backend typecheck and current-suite lock parity checks | CI fails when type errors or lock/package versions drift. |
| P1 | Add fast core conformance to PR CI | Required behavioral assertions execute; unavailable dependencies fail or are declared out of scope. |
| P2 | Release artifact profile matrix | Container-level evidence uploaded; advertised-without-witness is red. |
| P3 | Deployment attestation and Operations projection | Tamper, expiry, wrong-revision and discovery-drift tests. |
| P4 | Public exact-profile claims | Wait for RFC 0148/0155/0156 Accepted and their schemas vendored. **BLOCK VERIFIED 2026-08-13 — all three were `Draft`; LIFTED 2026-08-17, all three `Accepted` and the bundle-v2 schema vendored** (see below). Claims derive from the RFC 0148 §A ledger of a strict run; a profile with any non-`executed-pass` floor row is reported NOT claimed, with its reason. |

## Implementation record

### Merged-tree provenance — reconciled 2026-08-17 (H44)

Phase → PR → **merge commit on `origin/main`**, each verified with
`git show <sha> --stat` against the tree rather than from the PR body.

| Phase | PR | Merge commit | Merged | Witness |
|---|---|---|---|---|
| P0–P1 (gate wired) | — | `bfec8b9e4` | 2026-08-11 | `conformance/run.ts`, quarantine ratchet |
| P1 quarantine burn-down | — | `5b70f0876` | 2026-08-13 | `quarantine.json` 10 → 0 |
| P2 + P3 (release-artifact lane, verifier, signer, Operations projection) | — | `022357c71`, `738346db7` | 2026-08-13 | container lane, `check-vendored-schemas` |
| P2 CORRECTION — the source lane measured a moving corpus | [#3276](https://github.com/openwop/openwop-app/pull/3276) | `f9ad587f1` | 2026-08-16 | runner resolves sibling at a MATCHING version, else its release tag, else vendored |
| Pin `^1.106.0 → ^1.130.0`; quarantine 2 → 0 | [#3283](https://github.com/openwop/openwop-app/pull/3283) | `3653cd90d` | 2026-08-16 | `kms-backend-preflight.test.ts` 10/10; lockfile `added: 0, removed: 0` |
| Pin `^1.130.0 → ^1.135.0` (S24/S25 + the RFC 0157 host-path witness) + runner process-group watchdog | [#3298](https://github.com/openwop/openwop-app/pull/3298) | `756a9938d` | 2026-08-17 | `workflow-chain-expand-seam.test.ts` |
| P4 — public exact-profile claims derived from the RFC 0148 ledger | [#3309](https://github.com/openwop/openwop-app/pull/3309) | `54229aa61` | 2026-08-17 | `conformance-claims.test.ts`, `conformance-claims-routes.test.ts` (2 files / **21 tests**, re-measured at `fb6cbbcba`) |
| H42 — a stale RFC 0146 suite stamp can no longer ship | [#3303](https://github.com/openwop/openwop-app/pull/3303) | `5bd850706` | 2026-08-17 | `test-deploy-gates.sh` 21/21, `test-gate-tooling.sh` 20/20 |
| Pin `^1.135.0 → ^1.135.2` (carried in the flat-envelope PR, not a pin PR) | [#3300](https://github.com/openwop/openwop-app/pull/3300) | `9b342b3be` | 2026-08-17 | current installed suite = **1.135.2** |
| H60 — hosted job installs before it typechecks; order guard; audit gate matches on the ADVISORY and enforces its own schema | (this PR) | — | 2026-08-18 | `ci-gate-coverage.test.ts` 9/9 (sabotage: restore the old order → red); `check-audit.mjs` sabotage: new advisory id on an excepted package → UNEXPECTED, missing `revisitAfter` → MALFORMED |

**H42 belongs here even though it is not a numbered phase.** It is the same
class of defect as the one P2 was built to prevent: `build-meta/**` is gitignored
but deliberately un-ignored by `.gcloudignore`, so a long-lived deploy checkout
carries a PREVIOUS derivation into the next upload. Measured on 2026-08-17 —
two deploys of the same commit 90 s apart, one honest (field absent, RFC 0146
req. 1) and one advertising `contractProvenance.suiteVersion: "1.66.0"` against a
1.135.0 pin (req. 2). `write-build-commit.mjs` now REMOVES a stamp it cannot
derive instead of leaving whatever was there, and `deploy.sh` refuses to run
without the pinned conformance package installed. #3309 records the identical
hazard one layer up, with a public conformance claim in place of a version
string — a bundle from an earlier certify would point RFC 0089 §D at evidence
describing a different commit, and every existing gate would have passed, because
`verify-deploy.sh` checks the commit and the commit was never the claim.

**Correction to this ADR's own P4 record.** The P4 block below states the pin as
`1.135.2` and the profile-name grep as the falsified premise; both hold. What it
does not say is that the pin arrived in two steps and that the FIRST one moved
for an unrelated reason — 1.123.0 was red on `a2a-1-0-task-roundtrip`, a corpus
defect (S23), and #3283 moved to 1.130.0 rather than quarantining it. Recorded
because "the pin bumped" and "the pin bumped to escape a corpus bug we chose not
to quarantine" are different facts, and only the second one explains why the
quarantine stayed at zero.

### P0 — shipped 2026-08-11

| Item | Where |
|---|---|
| `backend: typecheck` step, BEFORE the esbuild bundle | `scripts/ci.sh:180` |
| Typecheck step + honest job name in the hosted workflow | `.github/workflows/ci.yml:109,120` |
| Guard so the gate cannot silently vanish | `test/ci-gate-coverage.test.ts` (6) |

The context section's claim is confirmed and was understated. Not only did CI
omit `typecheck` — **the GitHub job was NAMED `Backend (esbuild + tsc build +
vitest)`**, asserting a check it never ran. `npm run build` is an esbuild
bundle, and esbuild strips types without checking them, so a genuine type error
compiled clean and reached main. The `typecheck` script had been sitting in
`package.json` the whole time with no caller.

`test/ci-gate-coverage.test.ts` gates the gate: it asserts the step exists, runs
before the build, and that the build is not mistaken for a typecheck. Verified
falsifiable — deleting the step turns two of its assertions red. This is the
third instance in one session of *a gate that cannot fail reading exactly like a
gate that passes* (the others: the never-executing testcontainers file, and a
route test that forced a failure occurring before the code under test).

**Lock parity was NOT added: it already exists.** `scripts/ci.sh:89-117` carries
a stale-`node_modules` guard that compares `package-lock.json` mtime against
`node_modules/.package-lock.json` and falls back to a SHA stamp to tolerate
cosmetic lockfile rewrites. Adding a second version check would duplicate a
solved problem; the audit found it before inventing one.

### P1 — shipped 2026-08-11 (gate wired; burn-down is open work)

| Item | Where |
|---|---|
| Conformance step in the local merge gate (~2 min) | `scripts/ci.sh` |
| Shrink-only quarantine of the 10 known-failing scenarios | `conformance/quarantine.json` |
| `--exclude` wiring + `OPENWOP_CONFORMANCE_NO_QUARANTINE=1` escape hatch | `conformance/run.ts` |
| Rationale, rules, burn-down | `conformance/QUARANTINE.md` |
| Ratchet | `test/conformance-quarantine.test.ts` (8) |

With the 10 excluded the suite is **green: 393 files / 2517 tests in 116s**, so
everything outside the quarantine is now genuinely blocking — a NEW conformance
failure can no longer land unseen, which was the actual hole.

The ratchet enforces more than a count: `maxEntries` must EQUAL the current size
(a ceiling above it is pre-authorised growth), every entry needs a reason and a
date, and **every quarantined file must still exist in the installed suite** — a
renamed scenario would otherwise leave an exclusion matching nothing while the
renamed test ran ungated. It also forbids a scenario appearing in BOTH the
quarantine and `OPENWOP_OPTED_OUT_PROFILES`, because those lists mean opposite
things ("we claim it and fail it" vs "we do not claim it") and moving a failure
between them is how a red test becomes a false claim of non-support. Verified
falsifiable: an illegitimate addition turns 4 assertions red.

**What is NOT done: the burn-down.** The 10 quarantined scenarios are two
families — `envelope-*` (8, RFC 0021 envelope semantics) and `replay-*` (2,
replay determinism) — and they are **undiagnosed**. They were surfaced by wiring
the gate, not by investigation. That is 31→10 of visible debt converted from
invisible drift into a tracked, non-growing ledger, but the underlying failures
remain real and are the next tranche of ADR 0550 P1 work.

> **CORRECTION (2026-08-13) — the burn-down is DONE, and there was nothing to
> burn down. None of the ten was host non-conformance.**
>
> They shared one cause, and it was in the harness. `conformance/run.ts` boots
> via `createApp`, so `index.ts main()` never runs and
> `ensureLocalPacksMounted()` never fires — the entry-point hazard CLAUDE.md
> documents for any non-vitest boot. The node-pack resolver then read whatever
> the **shared** `~/.openwop-packs` happened to contain.
>
> On the measuring machine `~/.openwop-packs/core.openwop.ai` held **only**
> `.openwop-installed.json` — no `pack.json`, no `index.mjs`. That pack supplies
> `core.ai.structuredOutput`, the single node in every `conformance-envelope-*`
> fixture, so the typeId never resolved, the run never reached
> `dispatchStructured()`, and no `envelope.*` event could fire. Both `replay-*`
> entries clear for the same reason.
>
> **MEASURED, same commit, only the pack directory differing:** ambient dir →
> 8 files / 26 tests failing; vendored packs mounted → **403 files / 2565 tests
> passing, 0 failing.** `quarantine.json` is now `maxEntries: 0, entries: []`.
>
> Two defects, neither in the code the entries blamed:
> 1. the harness measured the machine rather than the commit — `run.ts` now
>    mounts this checkout's vendored packs into a private per-run dir;
> 2. `mountLocalPacks.shouldShadow()` returned false when the destination's
>    manifest was unreadable, so a contentless registry dir permanently blocked
>    the vendored copy with no repair path (`test/mount-local-packs-unloadable-dir.test.ts`).
>
> **The sentence above — "they were surfaced by wiring the gate, not by
> investigation" — was the honest caveat, and it was not enough.** The entries
> read "pre-existing failure on main, not diagnosed", which any reader takes as
> the host failing a capability it claims. A conformance result that depends on
> ambient machine state is not evidence about the host at all, and this ledger
> had no way to say so: its vocabulary was "failing" or "absent", with no third
> option for "the measurement was not valid". That gap is why ten harness
> symptoms sat for two days looking like protocol debt.
>
> The rule added to `QUARANTINE.md`: before quarantining anything, confirm the
> failure survives a **deterministic** pack mount. If it does not, it is a
> harness bug and belongs nowhere near this file.
>
> Pinned by `test/conformance-harness-determinism.test.ts`, which fails if
> `run.ts` stops setting its own `OPENWOP_PACK_DIR` or reverts to a static
> import of the app — the second being the regression that already bit once, see
> the note below.
>
> **A correction inside the correction, because it nearly shipped green.** The
> first fix set `OPENWOP_PACK_DIR` inside `main()`; the log read
> `mounted 208 vendored pack(s)` and ten files stayed red.
> `bootstrap/nodePackResolver.ts:24` and `bootstrap/agentPackResolver.ts:24` both
> do `const PACK_DIR = resolveDefaultPackDir()` at **module scope**, so the
> static import of `../src/index.js` froze the value before `main()` ran. The
> mount was real; the resolver ignored it. `resolveDefaultPackDir()` is
> documented as reading the env *at call time* and `test/setup/isolatePackDir.ts`
> relies on that — those two consumers break the contract, and `isolatePackDir`
> survives only because vitest `setupFiles` run before test imports. Fixed with a
> dynamic import.

### The measurement that changed the plan

`test:conformance` appears NOWHERE in `scripts/ci.sh` or
`.github/workflows/ci.yml`. Running it revealed why that matters:

**The conformance suite is RED on `origin/main` — 31 failures across 11 files**
(measured 2026-08-11 at `3373372b6`; this branch shows 30/10, i.e. the ledger
work fixed one). Failures cluster in two families: `envelope-*` (8 files) and
`replay-*` plus `run-execution-bounds-shape`. They are entirely pre-existing —
attribution was measured by reverting `backend/typescript/src` to `origin/main`
and re-running, not reasoned about.

So the harness's own header comment ("CI gates on it") describes a gate that has
never existed, and behind that absence the suite drifted red without anyone
seeing it. **P1 therefore cannot simply add the step**: wiring a red suite into
the merge gate would block every unrelated PR on main. The sequencing is:

1. add the step with a **shrink-only quarantine** of the currently-failing
   scenarios, so no NEW conformance failure can land and the existing set is
   visible and can only decrease — the repo's established idiom (see
   `capability-token-tripwire.test.ts`'s `RECORDED_DEBT`, and this ADR's own
   "opted-out profiles are recorded as not claimed, never pass");
2. burn the quarantine down as its own work, which is genuinely ADR 0550 P1
   scope but is 31 behavioural failures in envelope and replay semantics — not
   a CI-wiring task.

**Side effect worth recording:** `conformance/run.ts` boots the backend as an
ENTRY POINT without `OPENWOP_MOUNT_LOCAL_PACKS=false`, so every run re-points
all ~200 `~/.openwop-packs` symlinks at the running checkout. The gate scripts
opt out; this one does not (plausibly deliberately — it exercises pack-backed
surfaces). Anyone running it from a worktree must `npm run packs:prune` after
removing that worktree, or every symlink dangles.

> **CORRECTION 2026-08-13 — both halves of the paragraph above are false, and
> the first was false when written.** `conformance/run.ts` boots via
> `createApp`, so it is **not** an entry point: `index.ts main()` never runs and
> `ensureLocalPacksMounted()` never fires. That is the opposite of the claim,
> and it is precisely why the P1 quarantine measured the machine instead of the
> commit — the resolver read whatever ambient `~/.openwop-packs` held (see the
> burn-down, `5b70f0876`). Because the mount never ran, the harness also never
> re-pointed any symlink, so the `packs:prune` warning addressed a hazard this
> script did not have. Since that commit `run.ts` mounts the checkout's vendored
> packs into a **private per-run temp dir**, deliberately not `~/.openwop-packs`.
> The underlying entry-point hazard is real and documented in `CLAUDE.md`; it
> just belongs to `scripts/e2e-routes.sh` and manual `npm run dev`, not here.

### P2 — design, measured 2026-08-13 (pre-implementation)

Four of the five open design questions were settled by measurement rather than
argument. The fifth is a real scope decision and is left open deliberately.

**Where the lane runs — `ci:full`, not a release-only script.** The framing
assumed "a `docker build` is minutes", so a per-PR lane looked unaffordable and
a release-only script looked forced. **MEASURED on this box: a warm rebuild
after a real source change is 20s** (the `npm ci` layers cache on an unchanged
`package.json`; only esbuild and the `COPY` layers rerun). A first `time`
capture produced nothing — zsh's `time` keyword writes outside a brace group's
redirect — so the cold number is still unmeasured; it is paid once per machine
and on dependency changes. Time is therefore not the objection. The **Docker
daemon dependency** is, and only for `npm run ci`, which is THE merge gate and
must stay runnable without Docker. So: the existing `OPENWOP_CI_LIVE` block in
`scripts/ci.sh`, which `ci:full` sets and which prints a visible `↷ skipped`
line on every ordinary run. A lane nobody invokes is a gate that cannot fail;
a skip line is how this repo already makes that visible.

**"No second runner" is satisfiable, and the branch is principled.** The suite
driver is already origin-agnostic (`lib/env.ts:74` reads `OPENWOP_BASE_URL`;
scenarios self-skip when it is absent). `run.ts` merely injects its own. The
organizing rule for the mode is one sentence: **everything the harness does to
simulate `main()` must be skipped when a real `main()` is on the other end.**
Two such compensations exist today and both were written for this reason — the
vendored pack mount (`5b70f0876`) and the webhook-delivery drain
(`run.ts:306-325`, which exists because `createApp` does not start the worker
that `index.ts:729` does). In a container both happen natively, and running
them locally as well would double-drive.

**The env partition is three-way, derived from actual `process.env` reads.**
Deriving it from variable *names* is what produced a false finding earlier the
same day, so the sets come from grepping real reads in the suite source:

| Population | Examples | In external-target mode |
|---|---|---|
| driver-only | `OPENWOP_REQUIRE_BEHAVIOR` (`run.ts:90`), `OPENWOP_OPTED_OUT_PROFILES` (`:166`), `OPENWOP_CONFORMANCE_ROOT` (`:213`), the ~50 `OPENWOP_TEST_*`/fake-peer vars | set locally |
| host-only | `OPENWOP_TEST_SEAM_ENABLED`, the multi-agent phase flags, `OPENWOP_I18N_LOCALES`, storage/ratelimit/auth | **never** set locally — the container owns them |
| must agree | `OPENWOP_API_KEY`, `OPENWOP_TEST_COMPAT_ENDPOINT`, `OPENWOP_TEST_OIDC_ISSUER_URL` | passed to both, and asserted equal |

Setting a host-only var locally while measuring a container describes a host
that is not the one under test. The lane must fail on that, not warn.

> **CORRECTION 2026-08-13, while implementing the guard the sentence above
> specifies.** "Fail on any host-only var" would fire on a non-problem. In
> external-target mode the harness never applies host config, so a host-only var
> left in the operator's shell (`OPENWOP_GOALS_ENABLED`, the multi-agent phase
> flags, `OPENWOP_I18N_LOCALES`) is **inert**: it cannot reach the container and
> the driver never reads it. A guard that fails there is a false alarm — the
> exact defect class this program keeps finding, authored by me, one layer up.
>
> The hazard is real but narrower. Only the three **must-agree** vars are
> driver-visible, and two of them are set to loopback by the in-process boot:
> `OPENWOP_TEST_COMPAT_ENDPOINT` (`run.ts:88` → `http://127.0.0.1:<random>/v1`)
> and `OPENWOP_TEST_OIDC_ISSUER_URL` (`run.ts:158`). Carried into external mode
> unchanged, the driver points at a mock the container cannot reach and the
> scenarios fail as if the host were non-conformant.
>
> So the guard is: **in external-target mode, reject a loopback compat or OIDC
> endpoint** (and require `OPENWOP_API_KEY` to be supplied explicitly rather than
> defaulted). That is a guard that can actually fire, and it converts the
> mock-reachability problem below from a mystery into an assertion. It detects
> the case; it does not solve it — the three options below still decide whether
> the witness is whole.

**Two traps found by measuring, both of the silent kind.**

1. **`build-meta/commit.txt` is gitignored.** The obvious `.dockerignore` —
   modelled on `.gitignore` — would exclude it, and every image would report
   `commit: unknown`. `.gcloudignore` documents this exact failure for the
   deploy lane (`!build-meta/commit.txt`, with a note that it is *silent and
   test-invisible* because the unit tests point at `OPENWOP_BUILD_META_DIR`).
   A container witness that cannot identify its artifact is a vacuous gate, so
   the lane must run `scripts/write-build-commit.mjs` first and assert
   `/api/readiness` → `build.commit` equals the built commit, reusing ADR 0518.
2. **There is no `.dockerignore` at all** and the context is 549M, so every
   direct `docker build` uploads the whole tree including `node_modules` and
   `.git`. `.gcloudignore` covers only `gcloud run deploy --source .`.

**Pin to the published suite (1.73.0), and record the gap.** npm `latest` is
1.73.0 while the spec repo is at 1.96.0, so 1.74–1.96 exist only in the
steward's tree. A witness against a published artifact is reproducible by a
third party; one against an unpublished tree is not, and RFC 0154 §E is
explicitly about binding artifact digests to source revisions. Pinning to the
published version is therefore correct rather than a compromise. P2 does not
block on the publish — the witness's *coverage* does, and the evidence file
records the suite version so that ceiling is legible instead of implied.

**The container lane runs in the TARBALL layout, and that is a distinct hazard
class.** Added 2026-08-13 after the steward disclosed (crosstalk `1428`) that six
scenarios threw at import *from the npm tarball* — `TypeError: The "path"
argument must be of type string. Received null` — because `spec/v1/`, `RFCS/`
and `docs/` sit above the package in a repo checkout but not in the tarball, and
a null root was cast away. Fixed in their `1.98.0`.

Two facts, both measured here rather than accepted:

- **This host was never exposed.** The vendored suite is 1.73.0; its
  `src/scenarios/` holds 413 files and **none** of the six exist (no
  `workload`/`compensat`/`certification` match at all). They postdate 1.73.0.
  The directory was confirmed present first — a zero from a missing folder reads
  identically to a zero from a real one.
- **`1.98.0` is not installable.** `npm view … version` → **1.73.0**;
  `npm view …@1.98.0` → **404**. The publish gap flagged earlier at 1.96.0 is now
  25 versions, and it did not close.

Why it matters to P2 specifically: the release image has **no sibling spec repo
above the package**, so the container lane runs in exactly the layout the defect
lives in — where `run.ts`'s `OPENWOP_CONFORMANCE_ROOT` fallback to `../openwop`
cannot apply. At 1.73.0 the lane is safe by accident. On any upgrade past ~1.9x
a container witness becomes the *first* consumer to meet that class, and a
**collection error is worse than a failure**: the file reports nothing, so no
requirement is marked unwitnessed and the run still prints a green count.

Therefore the lane MUST assert a **floor on the collected file count**, not just
an exit code — the same instinct as the steward's `[7/7] check-published-layout`,
which packs, unpacks where no repo sits above, and floors the discovered count
because a collector that finds nothing exits 0. This also strengthens rather
than weakens the pin above: 1.73.0 is not merely the reproducible choice, it is
currently the only installable one.

> **CORRECTION, same day, ~2 hours later.** The last clause died: the steward
> tagged and published **1.98.0**, and it is live — `npm view … version` →
> `1.98.0`, and `@1.98.0` resolves. Verified here rather than taken on report,
> since the earlier claim ("fixed in 1.98.0") was true of their tree and false of
> the registry. The 25-version gap is closed, and the cause was the mirror of
> their own defect: `[7/7]` guarded the tarball while nothing checked that the
> tarball ever reached anyone — 25 suite bumps, zero tags, against an
> established one-tag-per-bump practice.
>
> **Amended within the hour: `latest` is now 1.99.0**, verified the same way
> (`npm view … version` → `1.99.0`; `@1.99.0` resolves). 1.98.0 was accurate when
> measured and superseded before this file was committed. The lesson is to stop
> treating the version as a fact worth pinning in prose: **the durable statement
> is "the publish gap is closed", and the pin target is whatever `latest` reads
> at bump time.** Chasing the digit here just manufactures stale claims.
>
> **What does NOT change: the pin stays at 1.73.0 for now**, and deliberately.
> Moving to 1.98.0 pulls in 25 versions of new scenarios *while this lane already
> has 16 unattributed failures*. Doing both at once would confound two sources of
> change, and attributing the current 16 is the prerequisite for trusting any
> count this lane produces. Sequence: solve container→host callback reachability,
> attribute the 16, then bump — at which point the floor stops being insurance
> and starts being the thing that catches the six tarball-layout scenarios if
> they ever regress.

**Evidence is gitignored plus a stdout digest, never committed.** A generated
evidence file committed to the repo becomes a claim that goes stale relative to
the build it describes. P2 emits the P3 attestation shape, unsigned; P3 adds
signing to the same shape rather than inventing a second one.

**OPEN — mock reachability decides whether the witness is whole.** `run.ts:85`
and `:154` bind the compat mock and the OIDC probe to `127.0.0.1`, and `:158`/
`:159` straddle the boundary: the driver mints tokens from the issuer URL while
the host is told to trust that same URL. `127.0.0.1` names two different hosts
once the host is a container. Three options, and the choice is about what P2
certifies, not about wiring:

| Option | Cost |
|---|---|
| bind mocks to a container-reachable address | `host.docker.internal` does not exist on Linux without `--add-host`; the lane becomes platform-conditional |
| opt those profiles out in container mode | portable and honest per-run, but **shrinks the witness** exactly where Lane 2 wants it widest, and yields two different profile matrices for one host |
| run the mocks inside the container network (compose) | largest change; portable; keeps the witness whole |

Option 2 is the convenient one and is recorded here rather than taken silently,
because "opted-out profiles are recorded as not claimed" would then mean
something different at container level than at source level for the same host.

> **RESOLVED 2026-08-13 — option 1, and the framing above was subtly wrong.**
>
> The three options were posed as "where do the mocks live". The actual defect
> was upstream of that: **the external-target path was not starting the mocks at
> all.** That followed from a rule I had written and over-applied —
> *"everything the harness does to simulate `main()` is skipped when a real
> `main()` is on the other end."* True of the pack mount and the webhook drain.
> **False of the compat provider and the OIDC issuer**, which are not
> entry-point simulation at all; they are test doubles the SUITE provides, and
> the suite needs them in both modes.
>
> So the fix is not "pick a networking option" but "start the doubles, and make
> them reachable". They now bind `0.0.0.0` and advertise a container-resolvable
> name; the container is run with `--add-host host.docker.internal:host-gateway`.
>
> **MEASURED before writing any of it**, since the last confident cross-platform
> guess in this program was falsified within the hour: a container reached a
> host-bound server this way on this box — the probe returned
> `reached-the-harness`. `OPENWOP_CONFORMANCE_HARNESS_HOST` overrides the name,
> because `host.docker.internal` is a Docker convention rather than a guarantee.
>
> The loopback guard still runs FIRST, so an operator-supplied `127.0.0.1` is
> still refused and the harness only fills what is unset. The guard therefore
> changed meaning: it was "this lane cannot witness callbacks", and it is now
> "this lane witnesses callbacks unless you point it somewhere unreachable".
>
> **MEASURED — 16 → 14, and NOT for the reason predicted.**
>
> | | before | after |
> |---|---|---|
> | failures | 16 | **14** |
> | files | 10 | 9 |
>
> The two that cleared are the **replay** scenarios (byte-equivalent event-log
> prefix; nondeterministic tool node reproducing its original result). The three
> I had explicitly named as callback-shaped — compat provider, OIDC issuer,
> webhook subscriber — are **still failing**.
>
> That is worth recording precisely, because the prediction was wrong in both
> directions: wrong about *which* would clear, and it overstated *how many*. The
> replay pair presumably needs a reachable model provider to record a real call
> before replaying it — a mechanism I had not reasoned about at all.
>
> **The remaining cause is my own half-finished implementation, and this ADR
> predicted it.** The env partition above identifies three vars that must agree
> on BOTH sides. The harness now starts the doubles and sets those vars in **its
> own** environment, for the driver — and `scripts/release-conformance.sh` passes
> **none** of `OPENWOP_TEST_COMPAT_ENDPOINT`, `OPENWOP_COMPAT_PROVIDER_ENABLED`,
> `OPENWOP_OIDC_ISSUER`, `OPENWOP_OIDC_AUDIENCE` to the container. The host
> therefore never learns where to dispatch.
>
> There is an ordering constraint underneath it: `docker run` happens at
> `release-conformance.sh:79`, and the mocks do not exist until the suite starts
> at `:185`, so the ports are not known when the container boots. **The fix is a
> reordering, not a redesign** — the script must pre-allocate both ports and pass
> them to the container (`-e`) and to the harness, instead of letting the harness
> choose them afterwards.
>
> Until that lands, **14 stands as measured and unattributed.** The three named
> failures now have a diagnosed cause; the other eleven still do not.

### P2 — what the lane found when it first ran (2026-08-13)

The lane works: `scripts/release-conformance.sh` stamps provenance, builds the
image, boots it, verifies it can identify itself, and runs the suite against the
container. First full run against the artifact:

| | |
|---|---|
| collected | **418 files** (floor 380 — no collection loss) |
| passed | 2541 |
| **failed** | **16 across 10 files** |
| provenance | `build.commit=5a5f681e…`, `commitSource=image` |

**The 16 are MEASURED, NOT ATTRIBUTED, and must not be read as host
non-conformance.** Reporting them that way is exactly the error P1 made when it
quarantined ten harness symptoms as protocol debt, and the ledger now requires
confirming a failure survives a *valid* environment before it can be recorded.

Two rounds of diagnosis so far, both landing on the harness side:

1. **My own config gap.** The first run omitted host-side env the in-process
   boot sets (`OPENWOP_FORM_CONTENT_CONFORMANCE_FIXTURES`,
   `OPENWOP_WEBHOOK_ALLOW_PRIVATE`). Adding them RAISED the count 13 → 16,
   because each enabled surface exposes more scenarios — diagnostic, not
   regression.
2. **The real constraint, and it is larger than this ADR first scoped.** It is
   not "two loopback mocks". Every failure identified so far is
   **callback-shaped**: the compat provider (`aiproviders-selfhosted-honesty`),
   the OIDC issuer (`auth-oidc-user-bearer`), the webhook subscriber
   (`webhook-signed-delivery`). These require the **HOST to call back into the
   suite**. In-process that is free loopback; from a container `127.0.0.1` is
   the container itself, so the call never lands.

**Restated open question.** The three options above were framed as being about
two mock servers. They are actually about whether the container can reach the
harness at all. That makes the portable form — `--add-host
host.docker.internal:host-gateway`, which modern Docker supports on Linux as
well as macOS — considerably more attractive than "opt those profiles out",
because the opt-out list would now have to swallow every callback scenario, and
those profiles ARE witnessed in the source lane. Two matrices for one host, at
a scale that is no longer marginal. It also requires the harness mocks to bind
`0.0.0.0` rather than `127.0.0.1` and to advertise a container-resolvable URL.

**Therefore the lane is opt-in** (`OPENWOP_CI_RELEASE_CONFORMANCE=1`), not on
`OPENWOP_CI_LIVE`, until the callback path exists and each failure is
individually attributed. Wiring a red lane into `ci:full` would block every
unrelated PR — the same reasoning P1 used for the quarantine — and the skip line
names the count and the reason so its absence stays visible.

**Two findings the source lane could never have produced**, both production
preconditions `createApp` never reaches; the container refused to boot on each:

```
OPENWOP_SESSION_SECRET must be set in production (>=32 chars)
BYOK local-AES master key is not configured in production
```

Both fail closed, which is correct. That this phase surfaced them at all is the
argument for Lane 2 existing.

**Falsification plan** (no guard is claimed until it has been broken):
build without the provenance stamp → lane red on `commit: unknown`; point the
lane at a stale container whose `build.commit` ≠ HEAD → refused; set a host-only
var locally while targeting an external origin → guard fires.

**Also noted, and NOT in P2's scope:** "advertised but no scenario references it
anywhere" is invisible to `behaviorGate`, which only fires where a scenario
calls it. Closing it needs a discovery-path → profile-name mapping, and none
exists (`PROFILE_NAMES` is 11 derived profiles; the gate takes ~59 ad-hoc
literals). Any mapping written by hand is self-authored, which is the shape that
produced the false finding above. P2 should emit the **diff as reviewable data**
with a required human disposition, never a computed verdict.

### P3 — the verifier, and why there is no runtime signer (2026-08-13)

The verifier landed first, because it is what makes a signer falsifiable.
`src/host/deploymentAttestation.ts` + `test/deployment-attestation.test.ts`
(10 tests) cover the phase's four named gates — tamper, expiry, wrong-revision,
discovery-drift — plus the positive case each negative depends on.

**A premise of mine died in the architect pass, and the correction matters.** I
asserted "the host has NO signing capability, only verification". **False** —
`features/connections/serviceAccountJwt.ts:50` signs RS256 with a BYOK-resolved
private key. I had generalised from `packSignature.ts` (which *is* verify-only)
to the whole host. So "a runtime signer means a new secret and new blast radius"
overstated the cost: the BYOK rail already carries private keys.

**Runtime signing still loses, for a stronger reason than key custody:**

> **A signer may only sign what it can verify.**

The attestation binds executed/pass/fail/skip counts and an evidence digest. The
backend cannot verify those — it has no way to know a pass count came from a real
suite run against itself rather than from whatever a caller posted. A runtime
attestation endpoint would therefore mint cryptographic assurance over numbers
received on trust: **P2's vacuous provenance check promoted to a signed
artifact**, which is strictly worse, because the signature makes an unverified
number look corroborated. The deploy pipeline ran the suite, so it is the only
party that can bind evidence to execution.

The expiry counter-argument dissolves on inspection. Re-attesting *without*
re-running the suite is not re-attestation — it is re-signing stale evidence with
a fresh timestamp, laundering age into apparent freshness, which is worse than
letting the claim expire. Legitimate re-attestation re-runs the evidence, i.e.
runs the pipeline. KMS signing is dominated: `byok/kmsBackends.ts` does envelope
encryption only (zero `sign` calls), so it would need new AWS `Sign` / Key Vault
`sign` surface for no benefit the pipeline signer lacks.

**Two integrity properties that are easy to get wrong, both now enforced:**

- **`environmentClass` is inside the signed payload.** Without it a local
  attestation is byte-indistinguishable from a production one, and the lane that
  certifies a laptop looks exactly like the lane that certifies production.
- **`commitSource: 'env'` is refused.** ADR 0518 already models `image` vs `env`
  because an env var is a *claim* and the baked stamp is *corroboration* — the
  distinction P2's lane learned the hard way. An attestation over a self-reported
  commit would launder that claim into an assertion.

Verification **order** is load-bearing and pinned by a test: signature first,
because reporting expiry or wrong-revision from an unverified payload means
reporting attacker-supplied data as a finding.

**Falsified before claiming** — three sabotages, each producing exactly ONE
targeted red, restore → 10/10:

| Sabotage | Red |
|---|---|
| drop the expiry check | EXPIRY only |
| accept `env` provenance | PROVENANCE only |
| remove canonical key sorting | canonicalization only |

The canonicalization test is the deliberate complement of tamper: if key order
changed the signature, a benign re-serialization would read as tampering and the
verifier would cry wolf. Tests use a real Ed25519 keypair over real canonical
bytes — stubbing the crypto would assert only that the serializer agrees with
itself, which is the vacuity this phase exists to avoid.

**Wrong-revision needs no second deploy:** "revision" is an identity bound into
the payload and compared against a live origin, so two builds suffice — which
keeps the whole gate CI-testable rather than deploy-gated.

**Caught by `tsc`, invisible to vitest:** the first canonicalization test built
its "reordered" object with a spread that duplicated a key (TS2783) *and*
preserved insertion order — so it would not have exercised canonicalization at
all. A passing test that tested nothing. Rebuilt with reversed entries plus an
assertion that the reorder is real.

**Not published.** The record is internal: RFCs 0148/0155/0156 define the public
claim vocabulary and are `Draft`, so P4 renders claims and P3 only produces
evidence. Keeping it off any public route is what keeps the shape revisable when
those schemas land.

Still open in P3: the pipeline signer itself, and the Operations projection
(which detects discovery drift as a **read-time** comparison — no scheduler, no
second owner for "is the attestation still true").

### The first REAL host defect the container lane found (2026-08-13)

The burn-down reached **16 → 14 → 12 → 10 → 4**, and every step until this one
was environment. This is not.

**`workflowChainPacks.hostExpansionSeam` is advertised by an image that cannot
serve it.**

- `routes/workflowChainExpandSeam.ts:50` resolves its fixture pack manifest with
  `require.resolve('@openwop/openwop-conformance/package.json')` — at REQUEST
  time.
- `@openwop/openwop-conformance` is a **devDependency**
  (`backend/typescript/package.json`).
- The runtime stage runs `npm ci --omit=dev` (`Dockerfile:85`), so the package is
  absent from the image.

The seam therefore answers `pack_not_found` for the bundled pack, which is also
why the negative leg fails in a revealing way: `expected 'pack_not_found' to be
'chain_not_found'` — the *pack* lookup dies before the chain lookup is reached.

**In the same run, the advertisement leg PASSED**: `✓ host discovery advertises
workflowChainPacks.hostExpansionSeam when the expand seam is served`. So the
release artifact claims the capability and then 404s it.

> **WHY that leg passed — answered by the steward, 2026-08-13 (crosstalk `069f`).**
> It was a **tautology**:
>
> ```ts
> if (!behaviorGate(PROFILE, await isExpansionAdvertised())) return;  // gates on flag === true
> expect(caps?.hostExpansionSeam).toBe(true);                          // asserts flag === true
> ```
>
> It gated on the flag and then asserted the flag — it could only ever pass —
> while the leg's NAME promised the seam was *served* and nothing verified that.
> A restatement wearing a check's clothes, i.e. the same defect class this ADR's
> P0 found in a CI job NAME and P2 found in my own provenance check. Fixed
> upstream in openwop#995 (suite `1.101.0`): the leg now probes the route, and
> was red-before-green against a host in exactly this posture.
>
> On `1.101.0` the three chain-expansion failures collapse to **one**, naming the
> cause (advertised-but-not-routed) instead of surfacing as an expansion
> mismatch three legs later.

> **CORRECTION to my own post-mortem, same source.** The commit that fixed this
> (`4d59c91b2`) explains the two failed attempts by saying `behaviorGate` throws
> on a profile that is neither advertised nor opted out, and that my
> "absent ⇒ soft-skip" assumption was therefore wrong. **The assumption was
> right.** Every leg is `behaviorGate(PROFILE, …)`-gated, so an absent advert
> soft-skips; hard-fail only applies under `OPENWOP_REQUIRE_BEHAVIOR=true`.
>
> What actually broke attempt one is simpler and was in my own diff: gating the
> ADVERT while the ROUTE still served produced a genuine contradiction — the
> inverse of the original defect — which the suite is right to flag. The
> three-sided fix is still correct; the reasoning recorded in its commit message
> is not, and a commit message cannot be amended in place, so the correction
> lives here.
>
> Worth naming the pattern: I preferred a mechanism I had read about
> (`behaviorGate` throwing) over the change sitting in my own working tree. The
> more sophisticated explanation was available and wrong.

**This is invisible to the source lane by construction.** There, devDependencies
are installed, `require.resolve` succeeds, and all three legs are green. Only a
production image — where `--omit=dev` is correct and deliberate — separates "the
seam works" from "the seam's dependency happens to be lying around".

That is precisely the gap Lane 2 was built to expose, and it is the argument for
the phase in one example: three phases of harness plumbing produced one finding
no amount of source-lane testing could have produced.

**Not fixed here, and the fix is a real decision.** Two candidates:

1. **Gate the advertisement on resolvability** — discovery reports the seam only
   when the manifest actually loads. Principled, matches "advertise only what is
   honoured", and makes the production posture honest (the seam is genuinely
   absent in production, which is fine).
2. **Ship the fixture manifest in the image** — makes the seam work, but moves a
   conformance fixture into the production artifact, which is the opposite of
   what `--omit=dev` is for.

(1) is almost certainly right, but it touches the discovery advertisement and
deserves its own change rather than being folded into a burn-down commit.

**Remaining after this: 1** — the webhook signature delivery, whose subscriber
URL the suite chooses at runtime and so cannot be pre-pinned the way the compat
and OIDC endpoints were. Still unattributed.

### The final container failure — dispositioned, not fixed (2026-08-13)

**16 → 14 → 12 → 10 → 4 → 1**, and the last one is host-complete.

`webhook-signed-delivery.test.ts` fails at container level because the SUITE
starts its own subscriber and registers a loopback URL:

```ts
await new Promise((r) => server.listen(0, '127.0.0.1', () => r()));   // :56
return { server, url: `http://127.0.0.1:${addr.port}/`, received };   // :59
```

Zero `process.env` reads in that file — **no override exists**. From a container,
`127.0.0.1` is the container, so the host's POST cannot arrive. This differs from
the compat provider and OIDC issuer, which `conformance/run.ts` starts and which
were therefore fixable by pre-allocating ports and advertising a
container-resolvable host.

**Opting the profile out would be ILLEGAL here**, and this is worth recording
because the chain-seam fix does NOT generalise: `routes/discovery.ts:1129`
advertises `webhooks: { supported: true, signed: true, … }` unconditionally, and
`behaviorGate` throws when a profile is BOTH advertised and opted out. The chain
seam could be opted out only because the host correctly stopped advertising it.
Here the host genuinely supports webhooks and says so.

**Disposition: unwitnessable at container level; host side complete; blocked on a
suite capability.** The fix is for the scenario to bind `0.0.0.0` and advertise a
configurable host — the same shape as the harness doubles, one layer in. Raised
with the steward; it is exactly the class their `REQUIRES_HOST_CALLBACK`
declaration (suite `1.100.0`+) exists to name in advance.

**Control run, owed and completed:** two consecutive `release-conformance.sh`
runs on an unchanged tree (`git status --porcelain` → 0) produced byte-identical
failure sets. That demonstrates the CURRENT state is run-stable. It does NOT
demonstrate the earlier deltas were — those trees no longer exist — and the
replay-pair wobble observed mid-burn-down remains unexplained. A plausible story
(it happened on the half-gated tree, which is the contradictory posture the suite
is right to flag) is deliberately NOT asserted here.

### P2 CORRECTION — the source lane measured a moving corpus (2026-08-16)

`conformance/run.ts` pointed `OPENWOP_CONFORMANCE_ROOT` at the sibling
`../openwop` **working tree** for the full-catalog basis while running the
scenario code of the **pinned** `@openwop/openwop-conformance`. Those are one
artifact at one version; the sibling is `main` and moves on its own.
MEASURED: openwop#1009 added a fourth cross-file `$ref` to
`workflow-definition.schema.json`; the pinned 1.106.0 `fixtures-valid.test.ts`
registers peer schemas from a fixed list, so `ajv.compile` threw at describe
time and two files (`fixtures-valid`, `workflow-primary-output-annotation`)
went red on every app branch and on `main`, for a change no app commit made.
The tarball fallback this ADR already names as a distinct hazard class is not
a clean answer either — six 1.106.0 always-on scenarios ENOENT on the prose
the tarball omits (measured, same day).

Fixed in `conformance/conformanceRoot.ts` (pure decision, 9 tests):
explicit root → sibling working tree only on version equality → the sibling
repo's release tag for the installed version (`openwop-conformance/v<n>`,
exported once per version into a tmpdir cache; the full repo layout at
exactly the pinned version) → vendored corpus, loudly labelled. The runner log
now names which corpus was measured and which pin bump restores the
working-tree basis. Consequence worth stating: **an unpublished suite version
is a live cost** — while npm serves 1.106.x and the sibling is at 1.110.0, the
app measures 1.106.0's corpus, not the current spec, and says so.

> **P2 CORRECTION, RESOLVED 2026-08-16.** The cost above has been paid off: the
> pin moved `^1.106.0` → `^1.123.0`, and the sibling `../openwop` working tree
> is at exactly `1.123.0`. The decision function therefore selects **tier 2**
> (the sibling working tree) rather than the tag or the vendored fallback, and
> the app once again measures the current spec instead of a corpus 17 minors
> behind it. The tag `openwop-conformance/v1.123.0` exists in the sibling too,
> so tier 3 is available if the working tree moves ahead again — which it will,
> and that is the normal state, not a defect. What this correction is really
> recording is that the tiering worked as designed: the gap was visible,
> attributed, and closed by a pin bump rather than by anyone editing a
> fixed schema list.

### P4 — block verified, with the premise recorded (2026-08-13)

A "BLOCKED" label decays: the thing it waits on moves and nobody re-checks, so
the label outlives the block. The premise is therefore recorded here alongside
the conclusion, so re-checking costs one command instead of a re-derivation.

Measured in the sibling `../openwop` checkout on 2026-08-13:

| RFC | Title | Status |
|---|---|---|
| 0148 | non-vacuous conformance certification | **`Draft`** |
| 0155 | core profile and extension discipline | **`Draft`** |
| 0156 | governance, independent assurance and claims | **`Draft`** |

All three are Drafts, and none has vendored schemas here. P4's gate is written
as "Accepted **and their schemas vendored**", and both halves fail — so the
block is real rather than stale.

> **CORRECTION 2026-08-16.** Both halves have since moved, and the block is
> now a different one. All three RFCs read `Accepted` (`openwop` `8170283f`,
> 2026-08-12), and the pinned suite (1.106.0) vendors RFC 0148's
> `certification-bundle-v2.schema.json`. What has NOT landed is the claim
> VOCABULARY the paragraph above was actually worried about: RFC 0155 §A's
> canonical profile-name rename (`openwop-core` → `openwop-discovery-core`) is
> absent from `spec/`, `schemas/` and `conformance/src` (RFC 0155 acceptance
> `:112` "the rename itself has not landed"), and RFC 0156 gates public claims
> on two unaffiliated maintainers + an external audit (`:28`, `:110` — externally
> gated; RFC 0147 `:18` MUST NOT claim "independently validated"). So the
> table's `Draft` cells are stale, the "schemas vendored" half is partially
> met, and P4 stays parked as `spec-prose` on 0155 §A. The RFC 0155 rename was
> delegated 2026-08-16 (crosstalk `agrade`).

Note this is one of the rare cases where a **status name is legitimately the
gate**, and it is worth being explicit about why, given `CLAUDE.md`'s
twice-corrected rule that the wire-advertisement gate is NOT a status name. That
rule governs when a host may *advertise* a capability. This is different: P4
emits **public exact-profile claims** whose vocabulary is defined by those three
RFCs. Rendering a claim in a shape the corpus has not settled would be inventing
the vocabulary, not honouring it. The dependency is on the schemas existing, not
on a rung.

Re-check with:

```bash
for n in 0148 0155 0156; do grep -m1 -iE '^\| \*\*Status\*\*' ../openwop/RFCS/${n}-*.md; done
```

> **CORRECTION 2026-08-17 — the block has LIFTED, and the re-check cost one
> command exactly as this section promised.** Re-run against `origin/main`
> (`git -C ../openwop show origin/main:RFCS/<n>-*.md`, not the peer's working
> tree):
>
> | RFC | Status on 2026-08-13 | Status on 2026-08-17 |
> |---|---|---|
> | 0148 | `Draft` | **`Accepted`** (updated 2026-08-16 — ledger sink, `--certify` rejection of unclassified returns, bundle-v2 schema, redaction; suite `1.123.0`) |
> | 0155 | `Draft` | **`Accepted`** (§A rename landed in `profiles.md` + `profiles.ts`, suite `1.110.0`) |
> | 0156 | `Draft` | **`Accepted`** |
>
> Both halves of the gate now hold. The schemas exist and are vendored here
> (`schemas/certification-bundle-v2.schema.json`, from corpus `origin/main`),
> and the canonical profile vocabulary is installed: `PROFILE_NAMES[0]` is
> `openwop-discovery-core` with `openwop-core` as a deprecated alias, at the
> pinned suite `1.135.2`.
>
> **The section's reasoning stands and is worth keeping**: the dependency was on
> the schemas existing, not on a rung, and it expired the moment they did. The
> premise recorded alongside the conclusion is what made this a one-command
> re-check instead of a re-derivation — the practice, not just the row, is the
> thing that paid off.
>
> **What the register got wrong, though, is worth more than what it got right.**
> `AGRADE-WIRE-BLOCKED-RESIDUE.md`'s 0550 P4 row also cited *"RFC 0156 §A/`:110`
> gates public claims on two unaffiliated maintainers + an external audit"*.
> That reads §E as one gate. It is a **table of seven**, each with its own
> evidence bar: the audit and Tier-3 rows gate `independently validated` and
> `vendor-neutral industry standard`, while `OpenWOP conformant` is bound to
> "RFC 0155 core-standard profile plus RFC 0148 bundle v2" — evidence a host
> produces. Had the row been read per-claim, the externally-gated part would
> never have blocked the part that is not. A policy is never blocked as a whole.

### P4 — shipped 2026-08-17

| Item | Where |
|---|---|
| Bundle + claims emitter (assemble → scrub → self-verify → schema-validate → write) | `backend/typescript/conformance/certify.ts` |
| `--certify [outDir]` mode on the ONE runner | `backend/typescript/conformance/run.ts` |
| Vendored RFC 0148 §C schema (from corpus `origin/main`) | `schemas/certification-bundle-v2.schema.json` + the `check-vendored-schemas.mjs` FIXED list |
| Runtime reader — image stamp only, never a computation | `backend/typescript/src/host/conformanceClaims.ts` |
| The RFC 0089 §D pointer + two public reads | `src/routes/discovery.ts`, `src/middleware/auth.ts` (`PUBLIC_PATH_PREFIXES`) |
| Deployed-claims parity arm, staged in BOTH postures (4 new cases, 25 total) | `scripts/check-wire-claims.mjs`, `scripts/test-deploy-gates.sh` |
| Derivation + sabotage + schema + §E policy + certify-mode shape guard (16) | `test/conformance-claims.test.ts` |
| Advert↔route parity, both postures (5) | `test/conformance-claims-routes.test.ts` |
| Certify step on the DEPLOY path + stale-stamp deletion | `scripts/deploy.sh` (`--skip-certify`), `scripts/write-build-commit.mjs` |
| Residue row flipped; tripwire INVERTED, not deleted | `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md`, `test/agrade-wire-blocked-residue.test.ts` |

**The deploy path had the same hazard the RFC 0146 stamp already taught us, and
it is sharper here.** `build-meta/*` is gitignored but `.gcloudignore`
deliberately un-ignores it, so a long-lived deploy checkout carries the LAST
certify's artifacts into the next upload. That deploy would advertise the
RFC 0089 §D pointer at evidence describing a different commit's behaviour — and
every existing gate would pass, because the commit stamp matches HEAD and
`verify-deploy.sh` checks the commit, which was never the claim. This is the
`corpus-suite.txt` → `1.66.0` incident (H42) with a public conformance claim in
place of a version string.

The `corpus-suite.txt` fix could fall back to re-deriving. This one cannot: a
bundle takes a real suite run. So **deletion is the only honest action**, and
`write-build-commit.mjs` now removes both artifacts on every run — absent ⇒ this
build publishes no claim (fully conformant per RFC 0089 §D); stale ⇒ this build
publishes another commit's evidence as its own. `scripts/deploy.sh` then puts a
fresh pair back by running the lane, with three outcomes and no fourth:

| | |
|---|---|
| lane succeeds | fresh bundle + claims, pointer advertised |
| `--skip-certify` | no run, artifacts absent, pointer omitted — deliberate, honest |
| lane fails, or exits 0 writing nothing | **REFUSE to ship** |

The last row is the one worth stating: a deploy that silently degraded to "no
claim" would be honest on the wire and useless to the operator, who asked for a
certified build. There is deliberately **no flag that ships a stale stamp**, and
`test-deploy-gates.sh` asserts that no such flag exists.

**COST, accepted deliberately: the certify lane adds ~10 minutes to a backend
deploy** (full conformance, strict, no quarantine). That is the point rather
than a regrettable overhead — the only thing that can substantiate "this build
passes profile X" is this build being made to pass profile X, and a cheaper
stamp would be a cheaper claim. `--skip-certify` exists for the deploy that
cannot afford it, and it costs the claim rather than weakening it.

Belt AND braces on the lane's exit code, because the code is not the artifact:
the lane exits non-zero for a failing scenario too, and it can exit 0 while
writing nothing (a schema rejection, an emitter defect). `deploy.sh` therefore
checks that both files EXIST, rather than trusting the code — the same
"green from a leg that never ran is not evidence" rule this ADR has applied at
every layer.

**The rule the phase is built around**, and every mechanism above exists to make
it structurally true rather than asserted:

> A profile is claimed ONLY when every requirement on its floor recorded
> `executed-pass` in the RFC 0148 §A ledger of a real run, with at least one
> assertion. `blocked`, `skipped`, `inapplicable`, `executed-fail`, a missing
> row, and a pass that asserted nothing are all NOT-CLAIMED — each reported with
> its reason.

**Where the claim is decided, and why not at request time.** The certify run
computes it, `build-meta/` carries it, and the route serves it verbatim — the
P2/P3 stamp pattern. This is P3's refusal of a runtime signer applied one layer
out: *a host may only publish a claim it can witness*, and a backend has no way
to know whether a floor executed against itself. A route deriving a profile list
from capability flags would be restating its own configuration and calling it
evidence, which is the tautology class this ADR has now found four times (a CI
job named for a check it never ran; a provenance check comparing a value to
itself; an advert leg gating on the flag it then asserted; a floor verifying
against an undefined set). The stamp also survives `npm ci --omit=dev`, which
the RFC 0146 field did not until it was moved to exactly this mechanism.

**Three refusals inside certify mode**, each a deliberate narrowing rather than
a feature:

1. **The quarantine is disabled, not bypassed.** `scenarioManifestSha256`
   digests the scenario set that ran. Certifying against an excluded set binds
   the claim to a manifest that omits precisely the scenarios the host is
   failing — a smaller suite wearing a bigger suite's digest.
2. **`OPENWOP_REQUIRE_BEHAVIOR=true` (RFC 0148 §B).** An advertised capability
   whose behavioural assertion cannot execute must fail, not soft-skip.
3. **The suite's exit code is not the verdict.** A failing scenario outside every
   claimed floor does not invalidate a claim, and a green run whose floor rows
   were never recorded does not substantiate one. The ledger decides; the run's
   exit code is reported separately.

**What is deliberately NOT reimplemented.** The derivation
(`deriveRequirementDispositions`), the shape audit (`verifyBundleV2`), the floor
sets (`PROFILE_FLOOR_SCENARIOS`) and the alias rule
(`DEPRECATED_PROFILE_ALIASES`) are all the suite's. `certify.ts` assembles and
projects; it does not decide what passes. Two helpers ARE transcribed —
`scenarioStatesFromReport` and `claimedProfilesFor` — because the package
exports neither; both are pinned by test and are ~10 lines each. Typed imports
come from the package's shipped `src/*.ts` (it publishes no `.d.ts`), which
`tsc --noEmit`, `tsx` and vitest all resolve — verified all three before
relying on it, because the alternative was a hand-written `.d.ts` mirroring the
suite's types, i.e. a second SSoT for the very definitions this phase must not
second-guess.

**What this host does NOT claim**, stated because a claims document is only as
honest as its omissions:

- **`openwop-replay-fork`** — and it is the most instructive omission, because
  two independent mechanisms arrived at it. The floor requirement
  `openwop.floor.replay-side-effect-suppression` is `blocked`, with the ledger's
  own reason: *"host advertises `replay.sideEffectSuppression` `"none"` —
  caveat 1 (a replay MUST NOT re-fire external effects) is unconditional but no
  declared mechanism is probeable; unwitnessed, not inapplicable."* That advert
  is `"none"` because this host WITHDREW `recorded-outcome` on 2026-08-15 (the
  withdrawal `scripts/check-wire-claims.mjs` was written to police). So the wire
  retraction and the certification ledger agree without being wired to each
  other — the claim surface refuses exactly the profile the capability surface
  gave up. That is the coherence this phase is for, and it was not arranged.
- **Six of §E's seven claims can never be host-evidenced**, and are withheld
  structurally rather than pending work: `current A2A compatible` and `current
  MCP compatible` require a REAL-PEER result (the suite exercises this host
  against itself); `production multi-region` requires RFC 0150
  partition/failover evidence from a deployed topology; `best-in-class durable
  orchestration` requires production compensation evidence; `independently
  validated` and `vendor-neutral industry standard` require an external audit
  and a Tier-3 host, and are claims about the PROJECT, not this deployment. A
  host cannot mint any of them, so asserting them would be asserting something
  with no witness. This is not conservatism — the unwitnessed assertion is the
  failure mode, not the cautious alternative to it.
- **The bundle is self-asserted, and says so by omission.**
  `conformance-certification.md` §C: a bundle is *authoritative* only when
  generated by an independent verifier. This one is generated by the host under
  test. Nothing in the emitted document claims otherwise, and P4 does not add a
  signature — signing self-produced evidence would make an unverified number
  look corroborated, which is P3's argument verbatim.
- **`certificationBundleUrl` is omitted whenever the image carries no bundle.**
  RFC 0089 §D makes omission fully conformant; a pointer whose route 404s is the
  advertised-but-not-served defect the container lane caught in
  `workflowChainPacks.hostExpansionSeam`. The advert and the route read the same
  function, so they cannot disagree.

### P4 — the measured run (2026-08-17)

`npx tsx conformance/run.ts --certify`, in-process boot, quarantine disabled,
`OPENWOP_REQUIRE_BEHAVIOR=true`, suite `1.135.2` (corpus basis: the sibling
repo's `openwop-conformance/v1.135.2` tag, since the working tree is at
`1.135.4` — the P2-correction resolver saying so out loud).

| | |
|---|---|
| scenario files collected | **466** |
| ledger rows recorded | **478** |
| requirement rows in the bundle | **467** |
| `executed-pass` | **359** |
| `executed-fail` | **0** |
| `inapplicable` | 44 |
| `skipped` | 25 |
| `blocked` | 39 |
| suite exit | 0 |
| bundle / claims | 130 KB / 3.6 KB, both canonical-JSON |

**Claimed (10):** `openwop-core-standard`, `openwop-discovery-core`,
`openwop-fixtures`, `openwop-interrupts`, `openwop-node-packs`,
`openwop-provider-policy`, `openwop-secrets`, `openwop-stream-poll`,
`openwop-stream-sse`, `openwop-trigger-bridge`. **Aliases:** `openwop-core`
(RFC 0155 §E — reported, never claimed). **Not claimed:** `openwop-replay-fork`,
for the reason above. **RFC 0156 §E permits:** `OpenWOP conformant`.

**Read the 39 `blocked` rows correctly, because the number invites a wrong
reading.** None of them sits on a claimed profile's floor — that is the only
reason any profile certifies at all, and it is the property RFC 0148 §A cares
about. `blocked` here means "advertised behaviour this boot could not exercise",
mostly seams and fixtures an in-process `createApp` does not light. It is not a
count of failures: `executed-fail` is **0**. The three totals that matter are
different questions, and flattening them is precisely what bundle v1 did.

Two honest limits on this evidence, stated because the document does not carry
them:

- **It measures the in-process boot, not the release artifact.** The P2 container
  lane is the stronger witness and is opt-in
  (`OPENWOP_CI_RELEASE_CONFORMANCE=1`); certifying from it is the natural next
  step and needs no new mechanism — `--certify` already rides `runSuite`, which
  both boots share.
- **The captured `discovery.document` in this bundle already carries a
  `certificationBundleUrl`**, pointing at the bundle a PREVIOUS certify run
  stamped. That is correct steady-state behaviour (a host certifies while
  serving its last evidence) rather than a self-reference defect — and it is
  incidental proof that the advert leg works against a real boot rather than
  only in the route test.

**Sabotage — no guard is claimed until it has been broken.** Recorded in the PR
body; each row is one deliberate defect and the single red it produces.

### Vendored `conformance-fixtures/` parity — decided 2026-08-17 (H48)

**The gap.** H47 (#3315, pin `^1.136.0`) recorded as residue that the vendored
fixture tree was stale against the pin and that nothing guarded it beyond its own
two-fixture byte test. Re-measured here at 1.136.0, and H47's list is exact —
**7 files missing** (`conformance-agent-memory-injection-budget.json`,
`conformance-context-budget-multiturn.json`, `connection-packs/` ×2,
`trigger-events/` ×4, `pack-manifests/workflow-chain-sample.pack.json`) and
**3 present that the suite does not ship** (`conformance-replay-effect.json`,
`conformance-replay-effect-unreached.json`, `form-content/`).

New measurement H47 did not have: **the corpus at `origin/main` is byte-identical
to the pinned package** (`diff -rq` exit 0; `conformance/package.json` on the
corpus reads exactly `1.136.0`). So the two upstream inputs agree today, and the
vendored tree alone was the stale side.

**Why the tree is allowed to be a superset (option (b)), not an exact mirror.**
Option (a) — split the tree, `conformance-fixtures/` == the pin exactly, move the
host-authored content to a sibling dir — was weighed and rejected on three
grounds:

1. **The repo already answered this question, for `packs/`.** That dir has the
   same shape (canonical `core.openwop.*` / `vendor.*` beside repo-owned
   `feature.*` / `community.*`) and the same original defect. It was fixed on
   2026-07-22 by keeping ONE dir and making the sync family-scoped —
   `scripts/sync-packs.sh:31-33`, *"A blanket `rm -rf packs/` would also delete
   the repo-owned feature.\* / community.\* packs, which live ONLY in this repo."*
   Splitting fixtures would leave the repo with two contradictory answers to one
   question.
2. **The wire explicitly blesses a mixed advert.**
   `schemas/capabilities.schema.json` §`fixtures`: *"Hosts MAY advertise
   vendor-prefixed IDs; clients MUST tolerate unknown IDs"*, and the suite ships
   `OPENWOP_OPTED_OUT_FIXTURES` whose own doc-comment names this exact situation
   (*"the host happens to carry a fixture file (e.g., it auto-loads every
   `conformance-*.json` on disk)"*). Option (a)'s headline benefit — a
   corpus-only advert — is not something the spec asks for, and moving the
   host-authored fixtures out of the dir `src/host/index.ts` loads would make the
   host **stop** advertising two fixtures it can genuinely run. That is a loss of
   honest advertisement, not a gain.
3. **Option (a) adds a deploy-skew failure mode.** The image and bundle contents
   are asserted by *hardcoded path lists* in `scripts/build-whitelabel-zip.sh`
   and the `cut-app-release` skill. A sibling dir nobody adds to them ships an
   image missing `form-content/` — red in the release lane only, green
   everywhere a developer would look.

**The invariant, then:** `conformance-fixtures/` ⊇ the pinned package's
`fixtures/`, byte-identical on the intersection, every extra path named in
`HOST_AUTHORED` in `scripts/check-vendored-fixtures.mjs` with a comment saying
who wrote it and who reads it.

**Scope is the WHOLE tree, compared against the PIN.**
`check-vendored-schemas.mjs` deliberately guards only a load-bearing subset,
because it diffs against corpus `main` and covering all ~57 schemas would force a
re-vendor PR on every unrelated upstream edit. **That objection does not
transfer**: this guard diffs against the *pin*, so drift can only appear when
someone bumps the pin — the moment at which being forced to re-vendor is the
whole point rather than churn. Hence `connection-packs/` and `trigger-events/`
are covered too, despite no in-repo reader naming them — they went missing
*precisely because* nothing named them.

**CORRECTION to ADR 0533 § Phase record.** That table lists
`conformance-fixtures/conformance-replay-effect{,-unreached}.json` as
**"Fixtures (verbatim from the corpus)"**. That premise is false and is corrected
in place at ADR 0533. `git log --all --diff-filter=A --
'conformance/fixtures/conformance-replay-effect*.json'` in `openwop/openwop`
returns nothing: no file by either name has ever existed there. The corpus's own
RFC 0140 fixture is `conformance-replay-side-effect.json`, which is vendored and
is canonical. `form-content/` is host-authored on the same evidence — the corpus
ships RFC 0137, `spec/v1/form-content-packs.md`, the manifest schema and two
scenarios, and **zero** fixtures, so a host must supply its own template pack for
`form-content-instantiation` to instantiate anything.

**A live landmine, not a hypothetical.** `scripts/sync-fixtures.sh` opened with
`rm -rf "$VENDORED"`. Running the refresh documented at `DEPLOY.md:479` — with
the corpus at exactly the pinned version — **deletes** all three host-authored
paths. Measured against `origin/main`'s script on a scratch copy: the two
`conformance-replay-effect*` files go 2 → 0 and `form-content/` ceases to exist,
which reds `test/form-content-seam.test.ts` and both RFC 0137 instantiation legs
under `OPENWOP_REQUIRE_BEHAVIOR`. Nothing guarded it. Fixed the way
`sync-packs.sh` was: stash the host-authored paths, mirror the canonical half,
restore. The preserve-list is **not** restated in the shell script — it reads
`check-vendored-fixtures.mjs --list-host-authored`, because two copies of that
list is the thing that drifts and here the drift is destructive.

**Finding — an advert widened, and one scenario changed state.** Vendoring the
two missing top-level fixtures adds their ids to `capabilities.fixtures`
(`src/host/index.ts` loads every top-level `*.json`). Consequences, measured:

- `conformance-context-budget-multiturn` — **no change**. Both its scenarios
  (`context-budget-transcript-bound`, `context-summarization-replay`) gate on
  profiles this host opts out of at `conformance/run.ts:89-90` ("no multiAgent
  contextBudget sub-block"), so `behaviorGate` short-circuits before the fixture
  gate is reached.
- `conformance-agent-memory-injection-budget` — **changed state, and went RED.**
  The host advertises `memory.injectionBudget.supported: true`
  (`src/routes/discovery.ts:1272`) with no opt-out, so `memory-injection-budget`
  (RFC 0113) previously reached `isFixtureAdvertised()` and returned
  `softSkip('inapplicable')`. Vendored, it EXECUTED for the first time and
  failed:

  ```
  FAIL src/scenarios/memory-injection-budget.test.ts
    > token-bounds the injection read, omits the over-budget entry, and preserves SR-1 + CTI-1
  AssertionError: fixture MUST echo the requested tokenBudget: expected undefined to be defined
    at memory-injection-budget.test.ts:123
  ```

  This matters because `scripts/ci.sh:281` runs the **full** conformance suite,
  so the vendoring alone would have turned the merge gate red.

**Root cause — a second, quieter route to the dishonest fixture advert.** The
corpus expresses its memory scenarios as a `core.identity` node carrying
`config.memoryAction` (`write-then-read`, `redaction-probe`, `ttl-probe`,
`list-budgeted`); the host is expected to recognise the action, drive its
`MemoryAdapter`, and surface the results as run VARIABLES the scenario reads
back. **This host implements none of them** — `grep -rn memoryAction src/`
returns nothing — so `core.identity` runs such a fixture as a pass-through: the
run reaches `completed` and the variable bag stays empty.

That is the same defect `fixtureNeedsConformanceNodes` (ADR 0533) already
guards, reached differently and failing more quietly — no typeId fails to
resolve, the run simply succeeds having done nothing. **Five** vendored fixtures
declare a `memoryAction`. Four (`conformance-agent-memory-{roundtrip,redaction,
ttl,cross-tenant}`) have been advertised falsely for as long as they have been
vendored, invisible because every one of their scenarios ALSO gates on the
suite-side `hasLongTermMemory()` and this host advertises `memory.supported:
false`. The fifth gates root-first on `memory.injectionBudget.supported` per RFC
0073, so it had no such cover — it merely needed the fixture to exist to expose
the whole class.

**Disposition — fix the advert, not the scenario.** `listLoadedConformanceFixtures()`
now also filters on `IMPLEMENTED_MEMORY_ACTIONS` (empty today), derived from each
fixture's own graph like its sibling predicate, so a newly-vendored memory fixture
is covered the day it lands. The capability claim is **left standing and is
true**: the HTTP read (`GET /v1/host/openwop-app/memory?tokenBudget=`) really does
bound the returned set, counting chars and declaring `tokenCounter: "chars"`
honestly (`host/inMemorySurfaces.ts:1411`, `routes/memory.ts:38-46`). Only the
fixture-driven WITNESS is missing, so the honest statement is "I support this,
and I do not offer that fixture" — which is exactly what the advert now says.

Two alternatives rejected: adding the fixture to `OPENWOP_OPTED_OUT_FIXTURES`
suppresses the symptom while leaving the host advertising a fixture it cannot
run; dropping the `injectionBudget` advert would delete a true claim to make a
gate green. **Follow-up, not taken here** (it is a memory-feature task, not a
vendoring one): implement the `memoryAction` seam and add each action to
`IMPLEMENTED_MEMORY_ACTIONS` as it lands — the set is written so that the
fixture becomes advertised and its scenario becomes a real witness in the same
commit.

**Second finding — the SAME defect a third time, and the widest of the three.**
Chasing whether the unexercised `conformance-replay-effect*` pair could simply be
deleted turned up why they were advertised at all:
`fixtureNeedsConformanceNodes` matched only `core.conformance.*`, while
`registerConformanceNodes()` — the function `conformanceNodesEnabled()` gates —
has always registered five typeIds under the **bare** `conformance.` prefix
(`requiresMissing`, `secret.echo`, `cost.emit`,
`modelCapability.insufficient`, `effect.emit`). Neither prefix matches the other.

**Six** vendored fixtures depend on those nodes, and **four are CANONICAL corpus
fixtures**: `conformance-capability-missing`,
`conformance-model-capability-insufficient`, `openwop-smoke-byok-roundtrip`,
`openwop-smoke-cost-emit` (plus the two host-authored replay-effect ones). All
six were advertised unconditionally, so a host with conformance nodes OFF — the
production / auth deploy posture the predicate exists to protect — advertised six
fixtures whose only real node is unregistered, and would fail every one at
dispatch. That is the exact advertise-and-spuriously-fail harm ADR 0533 wrote the
predicate to prevent, reached by a spelling it did not cover. H47's narrowing
comment ("the `core.conformance.` prefix is now the WHOLE membership") is
corrected in place; the hole predates that change rather than being caused by it.

The predicate now tests both prefixes. The test's "independent restatement" had
carried the identical hole — it was copied from the host rather than derived from
the registration, so it agreed with the bug for as long as the bug existed; it
now **derives** the gated typeId set by reading `bootstrap/nodes.ts`, which is
what makes it independent.

**Residue disposition — the replay-effect pair KEPT, not deleted.** Deletion was
evaluated on the evidence that nothing executes them (the corpus never names the
ids; no host test drives either; the RFC 0140 scenario drives
`conformance-replay-side-effect`). Rejected because they are the only in-tree
exercise of `conformance.effect.emit`, the node ADR 0533 registers + classifies
and ADR 0572's side-effect floor names — deleting the fixtures orphans the node,
making it a replay-semantics change rather than a vendoring cleanup — and because
`conformance/witness-boot-rfc0140.ts` names them. The honesty concern that
prompted the question is answered by the prefix fix above rather than by
deletion: they are now advertised only when they can actually run. Both are
allowlisted with their referencing file named, and the narrowed open question
(wire them into a real witness, or retire them together with the node) is
recorded in ADR 0533's correction.

| Piece | File |
|---|---|
| Parity guard + the `HOST_AUTHORED` allowlist (one SoT, `--list-host-authored`) | `scripts/check-vendored-fixtures.mjs` |
| Destructive sync fixed (stash → mirror → restore) | `scripts/sync-fixtures.sh` |
| Wired into the merge gate, next to the schema guard | `scripts/ci.sh` |
| 7 files vendored at 1.136.0 (verified byte-identical to the corpus at the matching version) | `conformance-fixtures/` |
| Wiring + three-violation-shape + allowlist-rot tests | `backend/typescript/test/vendored-fixture-parity-gate.test.ts` |
| Fixture advert filtered on `IMPLEMENTED_MEMORY_ACTIONS` (finding 1) | `backend/typescript/src/host/index.ts` |
| `fixtureNeedsConformanceNodes` widened to the bare `conformance.` prefix (finding 2) | `backend/typescript/src/host/index.ts` |
| Advert-gating tests for both routes; restatement now DERIVED from the registration | `backend/typescript/test/conformance-fixture-advert-gating.test.ts` |
| Witness-boot comment corrected (named the wrong node + wrong fixtures) | `backend/typescript/conformance/witness-boot-rfc0140.ts` |

H47's `test/conformance-mcp-invoke-node.test.ts` is **kept as-is**. Its last `it`
(the two-fixture byte comparison) is now a strict subset of the new whole-tree
guard, but the rest of that describe asserts something different — that the
reserved typeId reaches its bridge through the real catalog path — and the
narrow byte check costs nothing and fails with a message pointed at the two
fixtures whose host code H47 deleted. Deleting it would trade a specific
diagnostic for no gain.

## Alternatives weighed

### 2026-09-20 — deploy dependency parity follow-through

The deploy wrapper now refuses certification when the installed
`@openwop/openwop-conformance` version differs from the exact version resolved
by `backend/typescript/package-lock.json`. This closes the long-lived-checkout
failure measured in KickTodo: the lockfile resolved 2.31.0 while `node_modules`
still held 2.1.5, so the deploy ran the wrong suite and derived the wrong
`contractProvenance.suiteVersion`. Directory presence was not evidence of
dependency parity. The repair remains explicit and reproducible: `npm ci`.
The gate runs before certification and before any Cloud Run write, with both
match and mismatch polarities pinned by `scripts/test-deploy-gates.sh`.

- Run only the full suite on every PR: rejected for latency; fast core plus
  release/deploy matrices makes each claim stronger without making feedback
  unusable.
- Treat an opt-out as a pass: rejected; it is explicitly “not claimed”.
- Hand-maintain a compatibility badge: rejected; it drifts from the deployed
  artifact and cannot be independently verified.
