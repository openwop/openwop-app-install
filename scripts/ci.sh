#!/usr/bin/env bash
#
# Local CI gate — a trustworthy pre-merge signal that mirrors
# `.github/workflows/ci.yml`. Use it while GitHub Actions is unavailable (the
# hosted jobs currently fail at startup — an account/billing or org Actions-policy
# matter, not a code defect; see the CI note in CLAUDE.md).
#
# Runs the non-Docker, non-browser jobs (the ones that give the real signal):
#   - backend:  build (esbuild) + vitest        (testcontainers skipped, as in CI)
#   - frontend: lint (0 warnings) + build (tsc + token/CSS + vite + budgets) + vitest
#
# Browser lane (ADR 0509, Phases 3–4) — RUNS BY DEFAULT and is MANDATORY. A gate
# that silently skips the browser can go green having never opened one, so a
# missing Chromium is a HARD FAILURE, not a skip. Ports no longer block it at all:
# the lane auto-selects free ones.
#   npx playwright install chromium  the one-time setup this requires
#   OPENWOP_CI_E2E=0                 OPT OUT ON PURPOSE — for an adopter clone, an
#                                    offline machine, or a box with no browser.
#                                    Explicit and loud; never silent.
#   OPENWOP_CI_E2E_BACKEND_PORT=NNNN pin the backend port (default: auto-select
#                                    from 8080). A PINNED port that is busy is an
#                                    error — we never silently move a port you named.
#   OPENWOP_E2E_PORT=NNNN            pin the Vite port (default: auto-select from 5173)
#   npm run ci:e2e-report            did the browser lane actually run, and was it green?
#
# Still opt-in (needs Docker):
#   OPENWOP_CI_LIVE=1  backend live adapters via testcontainers
#
# Usage:  npm run ci         (or: bash scripts/ci.sh)
#         npm run ci:full    (forces e2e + live adapters)
# Bypass on push: git push --no-verify
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── H101: the gate must be able to say WHICH TREE it tested ──────────────────
# A gate run reads the working tree continuously — backend `tsc` builds it early,
# vitest reads `src/` throughout, the frontend build reads it again minutes later.
# Edit a file mid-run and the result corresponds to NO SINGLE TREE STATE.
#
# MEASURED 2026-08-18: a peer edited a source file ~10 minutes into a run and
# killed it themselves. Nothing here would have caught it — and that is the
# lesser half. The e2e ledger row below is keyed by `git rev-parse --short HEAD`,
# so a mutated-tree run does not merely go undetected: it is DURABLY ATTRIBUTED
# to a commit it never tested.
#
# That distinction is why this is code rather than care. Every other gap this
# repo has closed was a check that FAILED TO DETECT something. This one
# MANUFACTURES A FALSE RECORD, in the one artifact people consult later, when the
# context that would let them doubt it is gone.
#
# The fingerprint covers HEAD *and* the dirty set, because both move: a rebase or
# `git checkout` mid-run changes HEAD, an editor save changes only the porcelain.
tree_fingerprint() {
  printf '%s\n' "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo no-head)"
  git -C "$ROOT" status --porcelain 2>/dev/null || true
}
CI_TREE_AT_START="$(tree_fingerprint | shasum -a 256 | cut -d' ' -f1)"
# Returns 0 when the tree is exactly as it was at gate start.
tree_unchanged() {
  [ "$(tree_fingerprint | shasum -a 256 | cut -d' ' -f1)" = "$CI_TREE_AT_START" ]
}

# The ONLY writer of the e2e ledger. REFUSES the row when the tree moved, rather
# than writing it with a caveat: an absent row is honest, a mis-attributed one is
# not, and a reader months from now cannot tell a caveated row from a clean one
# once it is a line in a file.
ledger_append() { # ledger_append <path> <outcome>
  if ! tree_unchanged; then
    printf '\n\033[31m✗ the working tree CHANGED during this gate run.\033[0m\n' >&2
    printf '  This result corresponds to no single tree state, so it is not evidence.\n' >&2
    printf '  The e2e ledger row is REFUSED rather than attributed to a commit that\n' >&2
    printf '  was never tested (H101). Commit or stash, then re-run.\n' >&2
    return 0
  fi
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)" "$2" \
    >> "$1" 2>/dev/null || true
}
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
skip() { printf '\n\033[2m↷ skipped %s\033[0m\n' "$*"; }

# ── DEBT-3: make a load-induced red run SELF-DIAGNOSING ────────────────────────
#
# This suite is load-sensitive and the failure is silent about its own cause.
# MEASURED 2026-08-05 on one unchanged tree: at a 15-minute load average of ~237
# (five concurrent agent sessions + Spotlight) the backend suite failed 32 files
# and Playwright 26 specs — every one a 30s hook timeout or a ~1,000,000ms
# duration. The SAME tree at load 17 was fully green. Hours went into bisecting
# and, worse, into blaming a peer's commit for it.
#
# What this does NOT do, deliberately:
#   - it does not REFUSE to run above a threshold. That moves the flake: the gate
#     becomes unavailable exactly when several sessions need it, and the bypass
#     flag it would need becomes default-on.
#   - it does not raise timeouts or cap workers. Both were tried in earlier
#     sessions and FALSIFIED — the worker cap made it strictly worse (20 files /
#     29 min), and simulated external load did not reproduce the failures.
#
# It records the load, so a red run says what it was running under. The cause is
# still a guess; the point is that the NEXT person does not spend an hour
# rediscovering that a guess is available.
LOAD_AT_START="$(uptime 2>/dev/null | sed 's/.*load average[s]*: //' || echo 'unknown')"
load_now() { uptime 2>/dev/null | sed 's/.*load average[s]*: //' || echo 'unknown'; }
# 1-minute average as an integer, for the advisory threshold. Non-numeric => 0.
load_1m_int() { load_now | cut -d, -f1 | tr -d ' ' | cut -d. -f1 | grep -E '^[0-9]+$' || echo 0; }

ci_load_note() { # printed on FAILURE only — a green run needs no excuse
  printf '\n\033[33m⚠ load context (DEBT-3):\033[0m start=[%s] now=[%s]\n' "$LOAD_AT_START" "$(load_now)"
  if [ "$(load_1m_int)" -ge 40 ]; then
    printf '   This machine is HEAVILY loaded. A red run here is not evidence of a\n'
    printf '   regression: 32 backend files + 26 e2e specs failed on an UNCHANGED tree\n'
    printf '   at load ~237, and the same tree was green at load 17.\n'
    printf '   Re-run when quiet BEFORE blaming a diff or naming a commit.\n'
  fi
  # Name the actual competitor rather than leaving "heavily loaded" as a vague
  # excuse. MEASURED 2026-08-10: four concurrent backend fleets (two from a peer
  # worktree, two of my own orphaned jobs) drove this 10-core box to load 144.
  bash "$ROOT/scripts/preflight-suite.sh" 2>/dev/null || true
}
trap 'rc=$?; [ "$rc" -ne 0 ] && ci_load_note; exit $rc' EXIT

# Contention advisory, BEFORE the ~20 minutes of work rather than after it. This
# only reports (always exit 0) — the decision to serialise stays the operator's.
# A parallel session's suite is invisible from inside this one unless something
# looks, and that invisibility is why three separate flake hypotheses were each
# tested without holding the controlling variable.
bash "$ROOT/scripts/preflight-suite.sh" || true

# Fail early with a clear message if deps aren't installed. We don't auto-install
# — that's the dev's choice.
#
# CORRECTED 2026-09-04: this comment used to read "(CI runs `npm ci`; locally you
# install once)", and that parenthetical was the hole. NOTHING runs `npm ci`. The
# hosted GitHub Actions workflow is deliberately disabled (CLAUDE.md), so
# `npm run ci` IS the merge gate — and every check below it runs against whatever
# `node_modules` the developer already had.
#
# The guards in this loop ask "is the INSTALLED TREE current with the lockfile?".
# None of them asks "is the COMMITTED LOCKFILE installable at all?". Those are
# different questions, and a lockfile can fail the second while passing the
# first, because a tree installed while the lockfile was still good keeps
# satisfying both the mtime and the content-hash guard afterwards.
#
# Not hypothetical. #3634 (v2 charter P4-A) committed a backend lockfile whose
# three top-level `@emnapi/*` entries were absent — the transitive deps of
# `@napi-rs/wasm-runtime` (`optional: true, dev: true`). `npm ci` then refuses
# with EUSAGE `Missing: @emnapi/core@1.11.3 from lock file`. Per the P4-A author
# the lockfile was produced by `npm install --legacy-peer-deps` (needed to get
# past npm's resolver on vitest 4's optional peers), which left entries a strict
# `npm ci` requires; the npm>=11.5 optionalDependency pruning that CLAUDE.md
# documents for `npm audit fix` is a sibling of the same class, and this gate
# catches both because it checks the OUTCOME, not the cause.
#
# It merged green and survived two more commits, because the only machine that
# runs `npm ci` on this repo is the Docker builder (`npm ci --include=dev`) —
# i.e. the ~8-minute Cloud Build. The defect was reachable ONLY at deploy time,
# and that is where both a deploy attempt and this gate's author found it, twice,
# independently, within twenty minutes of each other (#3636).
#
# `npm ci --dry-run` answers the second question in well under a second without
# writing anything, and it is the resolution `npm ci` actually performs rather
# than a re-implementation of it. MEASURED both directions before wiring it in:
# exit 1 in 0.69s on the broken lockfile, exit 0 in 0.80s on the repaired one,
# and exit 0 on frontend/react (never affected — checked, not assumed). A gate
# proven able to BOTH fail and pass, per this repo's rule that a check which
# cannot fail is not a check.
for d in backend/typescript frontend/react; do
  if [ ! -d "$ROOT/$d/node_modules" ]; then
    echo "error: $d/node_modules missing — run 'npm ci' there first (never 'npm install': it re-resolves and rewrites the committed lockfile — CLAUDE.md)." >&2
    exit 1
  fi
  # STALE deps guard: a pull that changes package-lock.json without a reinstall
  # makes hundreds of suites fail on one missing import (e.g. the gifenc
  # incident, 2026-07-21: 542 suites red from one uninstalled dep). npm keeps
  # node_modules/.package-lock.json current on install, so an older mtime than
  # the repo lockfile means the tree predates the lockfile.
  if [ "$ROOT/$d/package-lock.json" -nt "$ROOT/$d/node_modules/.package-lock.json" ]; then
    # ...but mtime is a PROXY for "the contents changed", and it is wrong often
    # enough to matter: `git checkout -- package-lock.json`, a rebase, or a
    # branch switch rewrites the file with byte-identical content and a fresh
    # mtime. The guard then demands a reinstall that changes nothing, and the
    # reinstall itself rewrites the lockfile with cosmetic key reordering — so
    # the "fix" dirties the tree. (Cost four full CI cycles in one session,
    # 2026-07-26.) Same shape as the defect class we keep fixing in the app: a
    # signal standing in for a fact it does not actually establish.
    #
    # So confirm against CONTENT before failing. The stamp is written below
    # after a clean pass; if the current lockfile hashes to the same value, this
    # tree already ran green against these exact deps and the mtime moved for an
    # unrelated reason. A real dependency change never matches, and an absent
    # stamp (first run, or `npm install` since) falls through to the failure —
    # the guard is only ever weakened by evidence, never by default.
    lock_sha="$(shasum -a 256 "$ROOT/$d/package-lock.json" | cut -d' ' -f1)"
    stamp="$ROOT/$d/node_modules/.openwop-ci-lock-sha"
    if [ "$(cat "$stamp" 2>/dev/null)" != "$lock_sha" ]; then
      echo "error: $d/node_modules is STALE (package-lock.json is newer) — run 'npm ci' in $d (never 'npm install': it rewrites the committed lockfile — CLAUDE.md, #2680)." >&2
      exit 1
    fi
    echo "note: $d lockfile mtime moved but content is unchanged since the last green run — continuing." >&2
  fi
  # INSTALLABILITY gate (rationale in the block comment above). Asks the one
  # question the guards above cannot: could a CLEAN machine install this
  # committed lockfile? That is what the Docker builder and every fresh clone
  # do, so a red here is a broken build that simply has not happened yet.
  lockcheck_log="$(mktemp -t openwop-ci-lockcheck)"
  if ! ( cd "$ROOT/$d" && npm ci --dry-run --no-audit --no-fund ) >"$lockcheck_log" 2>&1; then
    echo "error: $d/package-lock.json is NOT INSTALLABLE — 'npm ci' would fail on a clean" >&2
    echo "       machine. This is exactly what the Docker builder runs, so this is a" >&2
    echo "       broken Cloud Build caught before the 8-minute build instead of during it." >&2
    sed -n '1,12p' "$lockcheck_log" >&2
    echo "       Repair with the PINNED npm — never your local one if it is >= 11.5 (it" >&2
    echo "       prunes optionalDependency transitives; CLAUDE.md):" >&2
    echo "         ( cd $d && npx -y npm@10.9.8 install --package-lock-only --no-audit --no-fund )" >&2
    echo "       Then diff the lockfile's added/removed counts before committing, and" >&2
    echo "       re-run backend/typescript/test/kms-backend-preflight.test.ts (the tripwire" >&2
    echo "       for the pruning variant of this class)." >&2
    rm -f "$lockcheck_log"
    exit 1
  fi
  rm -f "$lockcheck_log"

  shasum -a 256 "$ROOT/$d/package-lock.json" | cut -d' ' -f1 > "$ROOT/$d/node_modules/.openwop-ci-lock-sha"
done

step "vendored schemas: load-bearing drift guard"
node "$ROOT/scripts/check-vendored-schemas.mjs"

# ADR 0550 (H48) — the vendored fixture tree and the pinned conformance package
# are two independent inputs to one behaviour: the HOST loads only
# conformance-fixtures/ (and advertises the ids), the SUITE reads only its own
# package copy. They drifted silently for months — 7 files missing at the pin —
# and H47 caught it only because it happened to touch two of them by hand.
step "vendored fixtures: parity with the pinned conformance suite (ADR 0550 / H48)"
node "$ROOT/scripts/check-vendored-fixtures.mjs"

step "ADR numbering: every 'ADR NNNN' resolves, and resolves UNIQUELY (CRMGAP-17)"
node "$ROOT/scripts/check-adr-refs.mjs"

# v1 retirement is ATOMIC and gated on the EOS clock (2026-12-04, ADR 0642), so
# this canNOT demand zero — `versioning.md` §1.1 requires a 1.x preferredVersion
# while protocolVersions[] carries one. What IS enforceable today is that the
# migration surface does not GROW: every new /v1/ call site is one more thing to
# move on cutover day, and the SPA already carries 630 of them.
step "chain-pack event names: a protocol event or a registered vendor org (ADR 0683)"
node "$ROOT/scripts/check-pack-event-names.mjs"

step "v1 reliance: the migration surface does not grow (ADR 0642)"
node "$ROOT/scripts/check-v1-reliance.mjs"

# ADR 0548's program roll-up is DERIVED from its children's Status lines. The
# hand-kept version trailed six program merges before anyone noticed, and no
# gate could say so — the only test citing 0548 pins wire negative space, not
# the roll-up. Now a child ADR moving reds here until the umbrella is re-read.
step "docs: ADR 0548 program roll-up matches its children"
node "$ROOT/scripts/adr-rollup.mjs" --check

# ADR 0556 P0 — the STATIC half of the cardinality lint. An unbounded metric
# label (tenant/run/user id, a resolved URL path) turns a metric into a
# per-entity time series and takes the collector down. That failure is
# operational, arrives late, and NO unit test asserting "the counter went up"
# can see it — so it is a gate, not a review item. The runtime half
# (`guardAttributes`) covers labels whose NAME is computed at the call site.
step "metric labels: no unbounded dimension in METRIC_CATALOG (ADR 0556 P0)"
node "$ROOT/scripts/check-metric-labels.mjs"

# replay.md requirement 4 — every pack-manifest node must declare a role from
# the closed taxonomy, and the derived floor snapshot must be current. A missing
# or typo'd role fails the BUILD rather than defaulting to safe: `"side_effect"`
# would otherwise drop a node out of protection silently, which is exactly how
# `core.storage.blob-put` (ADR 0563) and the ten `core.openwop.http.*` senders
# (the ADR 0533 correction) each shipped a replay that re-fired a real effect.
step "side-effect floor: manifest roles declared + snapshot current (replay.md req 4)"
node "$ROOT/scripts/gen-side-effect-floor.mjs" --check

# ADR 0572 P2 — the served-set ratchet. Per the steward's ruling (#999), a typeId
# is discharged only by SERVING the source run's recorded outcome; a guarded-seam
# THROW is a backstop, so a throw-only host is "safe and non-conformant".
#
# A RATCHET, not a hard failure: ~214 floor typeIds are undischarged, and a gate
# that reds on all of them is one nobody can land through — which gets it
# disabled, which is worse than not having it.
#
# It PRINTS THE BUCKET COUNTS ON EVERY RUN, pass or fail. An exemption list rots
# by growing; a ratchet rots by NOT SHRINKING — 214, 213, 212, stall, green
# forever. Every could-not-fail gate this program found failed loudly once
# someone looked; a stalled ratchet never looks wrong. So the burn-down has to be
# legible in the log even when nothing is red.
#
# ADOPTER BUNDLES HAVE NO STEWARD LANE. `build-whitelabel-zip.sh` strips
# `docs/steward/`, `docs/research/`, `.agents/`, `.github/` and
# `backend/typescript/test/steward/` from the bundle, so a gate that READS one
# of those paths cannot run there. Measured on kicktodo.com's checkout
# 2026-09-11, red on an unchanged tree: "no served-set baseline" here and
# ENOENT `docs/steward` in check-steward-probes below. The steward TESTS were
# already stripped one layer down (the ratchet test refuses any test outside the
# strip list); these two GATES were missed, so every adopter's `npm run ci` was
# structurally red and the adopter substituted the individual lanes — dropping
# the +365-day sweep without noticing. `docs/steward/` is the lane marker:
# absent means a bundle, and the step SAYS it was skipped. Never silently green:
# a skipped ratchet prints itself, exactly as a passing one prints its counts.
# Detection lives in scripts/lib/steward-lane.sh with a co-marker (.github/), so a
# moved docs/steward/ in the FULL repo fails the run instead of skipping both gates.
# shellcheck source=lib/steward-lane.sh
. "$ROOT/scripts/lib/steward-lane.sh"
STEWARD_LANE_MODE="$(steward_lane "$ROOT")" || { echo "ci: steward-lane detection refused (see above)" >&2; exit 1; }
STEWARD_LANE=1
[ "$STEWARD_LANE_MODE" = take ] || STEWARD_LANE=0
if [ "$STEWARD_LANE" = 1 ]; then
  step "served-set ratchet: undischarged floor may only shrink (ADR 0572 P2)"
  node "$ROOT/scripts/gen-served-set.mjs" --check
else
  step "served-set ratchet: SKIPPED — docs/steward/ absent (adopter bundle; the steward lane is stripped by build-whitelabel-zip.sh)"
fi

# Deliberately BEFORE the two `--check` generators below, because it guards
# THEM. Both are invoked here as `"$ROOT/scripts/..."`, and `$ROOT` comes from
# `BASH_SOURCE` — which keeps the symlinked spelling. So when their entry guard
# was hand-rolled, running the gate from a worktree under `/tmp` made both of
# them exit 0 having checked NOTHING (#3070 class). A gate that cannot fail is
# worse than no gate; this one fails first.
step "entry guards: no hand-rolled import.meta.url/argv[1] comparison (zero gate)"
node "$ROOT/scripts/check-entry-guard.mjs"

# H98 — the root Dockerfile moved to `npm ci` in #2680/#2696 and the OTHER build
# configs did not, for months, because nothing looked. `npm install` on npm >= 11.5
# prunes an optionalDependency's transitive deps (Azure KMS goes
# present-but-unloadable). This gate carries a REQUIRED-paths floor so a glob that
# stops matching fails loudly instead of printing a clean scan of nothing.
step "build configs: `npm ci`, never `npm install` (zero gate)"
node "$ROOT/scripts/check-build-installs.mjs"

step "feature-dependency map: docs/FEATURE-DEPENDENCIES.md is current (ADR 0446)"
node "$ROOT/scripts/gen-feature-deps.mjs" --check

# ADR 0555 P0 — `steward` trust is attested by a COMMITTED digest per vendored
# pack, never by "it was in the packs dir" (which two env vars can redefine).
# The runtime policy fails CLOSED, so a stale manifest is not a lint nit: every
# drifted pack stops dispatching. This step is the tripwire that keeps the
# manifest and the vendored bytes from parting company.
step "steward manifest: packs/.steward-manifest.json matches the vendored packs (ADR 0555 P0)"
node "$ROOT/scripts/gen-steward-manifest.mjs" --check

step "agent-skill mirror: .agents/skills matches .claude/skills"
node "$ROOT/scripts/check-agent-skill-mirror.mjs"

step "root docs: only adopter deliverables at the repo root (steward reports live in docs/steward/)"
node "$ROOT/scripts/check-root-docs.mjs"
step "default page drift: the ADR 0027 default home page exists TWICE and must agree"
node "$ROOT/scripts/check-default-page-drift.mjs"

step "chain packs: content changed ⇒ version bumped (the registry copy WINS — ADR 0370)"
node "$ROOT/scripts/check-pack-version-bump.mjs"
# ADR 0525 — a pack's schema `$id` must name that pack's CURRENT version. Ported
# from openwop-registry, where the same check had lived only as an inline CI
# heredoc and could not be run locally; running it HERE, where node packs are
# authored, found 122 drifts the registry would only have seen at publish time.
node "$ROOT/scripts/check-pack-schema-ids.mjs"
# ADR 0525 — a steward data-probe must be able to MATCH what it claims to
# measure. A wrong predicate returns 0 rows, and 0 rows is what most of these
# declare "healthy" — so a broken probe reads as a passing one.
if [ "$STEWARD_LANE" = 1 ]; then
  node "$ROOT/scripts/check-steward-probes.mjs"
else
  echo "check-steward-probes: SKIPPED — docs/steward/ absent (adopter bundle)"
fi

step "gate tooling: the gate's own port/process helpers (GATE-5)"
# Cheap and early on purpose. Four defects shipped in this tooling — including a
# guard that would have refused its own server, and a ratchet that read "tsc could
# not run" as an improvement — and every one passed `bash -n` and review. They were
# found only by running the failure case, so those probes are assertions now.
bash "$ROOT/scripts/test-gate-tooling.sh"

step "deploy gates: preflight + verify actually refuse (ADR 0518 / ADR 0530)"
# Pure shell + fixture repos + a local stub, so it costs ~2s and needs no build.
# These two scripts are the last thing between a stale worktree and production;
# an untested guard is a guard nobody should trust. The suite is written around
# failure modes that HAVE happened (deploying a worktree behind origin/main) or
# would silently defeat the guard if they regressed (an unstamped deploy reading
# as a pass; a broken backend locking the operator out of the fix).
bash "$ROOT/scripts/test-deploy-gates.sh"

step "guard: the contention detector actually fires (preflight-suite)"
bash "$ROOT/scripts/test-preflight-suite.sh"

step "backend: typecheck (tsc --noEmit)"
# ADR 0550 P0 — THE BUILD BELOW DOES NOT TYPECHECK. `npm run build` is an
# esbuild bundle, and esbuild strips types without checking them, so a genuine
# type error compiled clean and reached main. A `typecheck` script existed in
# backend/package.json the whole time and nothing called it.
#
# The GitHub job was named "Backend (esbuild + tsc build + vitest)" — a name
# asserting a check that was never run. Naming a gate is not running it.
#
# Placed BEFORE the build: a type error should cost seconds, not a full bundle.
( cd "$ROOT/backend/typescript" && npm run typecheck )

step "distributions: catalog + manifest validity, and composition"
# Until now the distribution gates were in NO gate at all. `ci:distribution`
# exists in package.json and is NAMED in three source comments as the thing that
# runs `--check` — but nothing invokes it: not this script, not the (disabled)
# GitHub workflow, not any hook. Same shape as `test:conformance` below, which
# was also unrun while its harness header claimed CI gated on it.
#
# So every catalog invariant — including the bundle-name-collision check that
# would have caught `distributions/kicktodo.json` selecting the wrong bundle —
# could only ever fire when a human typed the command. Naming a gate is not
# running it.
#
# Both are pure node over a few files: ~1s, no build, so they run in the fast
# lane and fail before anything expensive starts. `npm run ci:distribution`
# additionally builds a slim distribution end-to-end; that stays opt-in on cost.
( cd "$ROOT" && node scripts/gen-distribution.mjs --check )
( cd "$ROOT" && node scripts/check-distribution-composition.mjs )
# ADR 0630 layer 1: a `features/<id>` module imported outside the registry is
# reachable no matter what a manifest excludes — the two checks above validate
# the manifest and the registry FILTER; this one validates the module GRAPH the
# filter is applied to. Static, ~1s, and it fails HERE rather than in an
# adopter's terminal after they built a distribution that "excluded" a feature
# whose public page still shipped in their entry chunk (#3627).
( cd "$ROOT" && node scripts/check-feature-import-boundary.mjs )

step "backend: build (esbuild bundle)"
( cd "$ROOT/backend/typescript" && npm run build )

step "shutdown: the backend EXITS on SIGTERM (SHUTDOWN-1)"
# Needs the backend build above. Only observable in a REAL process — the handler
# lives inside `main()`, which runs only as the entry point, so no test that
# imports the module can ever see this. It shipped un-noticed for exactly that
# reason, and leaked a backend on every e2e-routes run.
bash "$ROOT/scripts/test-shutdown.sh"

step "e2e-routes wiring: ONE Vite, handed to Playwright (GATE-6)"
# Placed right after the backend build, which it needs — so the build is warm and
# this costs ~7s, not the minute I predicted when I filed GATE-6 and assumed it
# would have to live in `ci:full`. That measurement is the whole reason it runs
# HERE: `e2e-routes.sh` regressions were invisible to the default gate, which is
# exactly how a guard that refused its own server reached main. Stub Playwright,
# no browser.
bash "$ROOT/scripts/test-e2e-routes-wiring.sh"

step "backend: vitest (OPENWOP_SKIP_TESTCONTAINERS=1, as in CI)"
# ADR 0702 — the event-payload recorder rides ALONG with this run. The samples
# are free: this lane already exercises every emit path, and the recorder is one
# comparison per append, hoisted to module load and off unless the var is set.
# Building a second lane to produce the same events would have cost 20 minutes
# and measured slightly different code.
OPENWOP_PAYLOAD_AUDIT_DIR="$(mktemp -d -t owp-payload-audit)"
( cd "$ROOT/backend/typescript" && OPENWOP_SKIP_TESTCONTAINERS=1 OPENWOP_PAYLOAD_AUDIT="$OPENWOP_PAYLOAD_AUDIT_DIR" npm run test )

# ADR 0702 — do the persisted event payloads validate against the corpus `$def`
# the codemap names for each type?
#
# This axis had NO gate at all, and the gap is not theoretical: `output.chunk`
# and `interrupt.resolved` shipped payloads missing required keys through a
# major-2 conformance lane that was EXIT=0, 490 files, 0 red — twice in one day.
# `myndhyve-1` measured why on the corpus side: 31 of 355 scenarios apply Ajv,
# and those validate hand-written literals, which are correct by construction.
# The suite is strong on a wrong VALUE and blind to a missing REQUIRED KEY.
#
# Shrink-only by TYPE (not by count — the count moves with test ordering, and a
# gate that moves for unrelated reasons is one people re-baseline on reflex).
step "backend: event-payload conformance ratchet (ADR 0702)"
OPENWOP_PAYLOAD_AUDIT="$OPENWOP_PAYLOAD_AUDIT_DIR" node "$ROOT/scripts/audit-event-payloads.mjs" --ratchet 2>&1 | tail -20
pa_rc="${PIPESTATUS[0]}"
# ADR 0730 / Phase F — `OPENWOP_PAYLOAD_AUDIT_KEEP=1` preserves the sample set
# instead of deleting it. The ratchet only needs a verdict, but the SAMPLES
# answer a question the verdict cannot: which corpus types this host never
# emitted, and therefore which green results are no evidence rather than weak
# evidence (ADR 0702 called those 75 types "the number I would watch").
# Re-deriving them costs a second full suite run; keeping them costs a temp dir.
# Default behaviour is unchanged — unset, the dir is still removed.
if [ -n "${OPENWOP_PAYLOAD_AUDIT_KEEP:-}" ]; then
  echo "payload-audit samples PRESERVED at $OPENWOP_PAYLOAD_AUDIT_DIR"
else
  rm -rf "$OPENWOP_PAYLOAD_AUDIT_DIR"
fi
# `| tail` MASKS the exit code — this repo has been bitten by that at least three
# times — so the status is captured from PIPESTATUS and re-raised explicitly.
[ "$pa_rc" -eq 0 ] || { echo "event-payload ratchet FAILED (exit $pa_rc)"; exit "$pa_rc"; }

# The quarantine is EMPTY as of 2026-08-13 (ADR 0550 P1 burn-down): all ten
# entries were harness non-determinism, not host non-conformance. The label no
# longer says "quarantined set excluded" because nothing is excluded, and a step
# named for something it does not do is the same defect class this repo keeps
# finding. `conformance/run.ts` still honours the list if one is ever re-added.
step "backend: conformance (full suite — ADR 0550 P1 quarantine is empty)"
# Until now `test:conformance` was in NO gate at all, while the harness header
# claimed CI gated on it. Behind that absence the suite drifted red: 31 failures
# across 11 files on main when first measured (2026-08-11, 3373372b6).
#
# The known-failing scenarios are quarantined by name in
# `backend/typescript/conformance/quarantine.json` (shrink-only, each with a
# reason) so the REST of the suite can be a real blocking gate — a NEW
# conformance failure can no longer land silently. ~2 minutes.
#
# See the real state, quarantine included:
#   ( cd backend/typescript && OPENWOP_CONFORMANCE_NO_QUARANTINE=1 npm run test:conformance )
( cd "$ROOT/backend/typescript" && npm run test:conformance )
# #3644 / ADR 0631 — the lane above runs at TARGET MAJOR 1 only, so every
# `v2-*` scenario records `inapplicable` there and the major-2 wire was never
# EXECUTED by this gate (measured 2026-09-05: 57 files honestly skipped). This
# second lane runs the same suite at major 2 and ratchets it BOTH ways against
# an explicit known-red list — an unlisted red fails, a listed file that has
# gone green fails too (a stale entry is a lie about the wire).
step "backend: conformance at TARGET MAJOR 2 (ratchet — scripts/conformance-v2-known-red.txt)"
( cd "$ROOT" && bash scripts/check-conformance-major2.sh )

step "frontend: lint (eslint, zero warnings)"
( cd "$ROOT/frontend/react" && npm run lint -- --max-warnings=0 )

step "frontend: build (tsc + token/CSS checks + vite + bundle budget)"
( cd "$ROOT/frontend/react" && npm run build )

step "frontend: unit-test types (shrink-only ratchet — tests are excluded from the build's tsc)"
( cd "$ROOT/frontend/react" && npm run check:test-types )

step "frontend: live-fetch allowlist (shrink-only — ADR 0661)"
node "$ROOT/scripts/check-live-fetch-allowlist.mjs"

step "guard: the live-fetch guard actually fires (ADR 0661)"
bash "$ROOT/scripts/test-live-fetch-guard.sh"

step "frontend: vitest"
# ADR 0661 phase 2 — WITNESS every allowlisted live fetch during the suite we are
# already running, so the stale-entry check below costs no extra run. The guard
# appends one line per allowed call; the checker aggregates after.
LIVE_FETCH_AUDIT="$(mktemp -t owp-live-fetch-audit)"
( cd "$ROOT/frontend/react" && OPENWOP_LIVE_FETCH_AUDIT="$LIVE_FETCH_AUDIT" npm run test )

step "frontend: live-fetch allowlist has no STALE entries (ADR 0661 phase 2)"
node "$ROOT/scripts/check-live-fetch-stale.mjs" "$LIVE_FETCH_AUDIT"
rm -f "$LIVE_FETCH_AUDIT"

# ── E2E PROMOTION (ADR 0509 Phase 3) ──────────────────────────────────────────
#
# The lane used to run ONLY under an explicit OPENWOP_CI_E2E=1, i.e. `ci:full`.
# That made its value accidental: it caught two real defects on main (a WCAG AA
# contrast failure in a 15-call-site primitive; `/` never being audited at all)
# and neither was found by the gate — a human happened to run it. #2718 proved
# the other direction, breaking a browser test with nothing noticing.
#
# Phase 3 shipped this as "runs when the machine can, skips loudly otherwise" —
# honestly described at the time as "a gate for machines that can run it, not a
# guarantee". Phase 4 closed both halves of that gap: 4a auto-selects ports so
# contention can no longer cause a skip, and 4d (below) makes a missing Chromium
# FATAL rather than skippable. The only remaining way not to run it is to say so
# explicitly with OPENWOP_CI_E2E=0.
# ── PHASE 4a: PICK A FREE PORT INSTEAD OF SKIPPING ───────────────────────────
# "Port in use" was the skip cause that bit exactly when the repo was BUSIEST:
# two sessions running the gate concurrently meant the second one silently did
# not run the browser lane. Selecting a free port removes the cause entirely.
#
# This does NOT reintroduce the Phase 2.5 defect. That bug was ADOPTING an
# occupant — inheriting a server built from other code and reporting it green.
# Here we bind a port nobody holds, so there is no occupant to adopt. If two
# gates race for the same free port, the loser's backend never comes up and the
# readiness probe fails LOUDLY; refusing-to-adopt is still in force below.
#
# An explicit OPENWOP_CI_E2E_BACKEND_PORT is honoured verbatim and never
# auto-moved: if you named a port, you meant it, and silently using a different
# one would be its own dishonesty.
# Port + process helpers are SHARED with `e2e-routes.sh` (scripts/lib/gate-ports.sh)
# and tested by `scripts/test-gate-tooling.sh`. They used to be duplicated here and
# there, and both copies carried the same defect — a failed `lsof` read being
# indistinguishable from "nothing is listening", so an environment without a usable
# lsof believed every port was free and three protections became no-ops at once.
# Two copies is also two places for the next fix to miss.
# shellcheck source=lib/gate-ports.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/gate-ports.sh"
gate_require_lsof || exit 1
pick_free_port() { gate_pick_free_port "$@"; }
e2e_port_pinned=0
e2e_port_exhausted=0
if [ -n "${OPENWOP_CI_E2E_BACKEND_PORT:-}" ]; then
  E2E_PORT_BE="$OPENWOP_CI_E2E_BACKEND_PORT"; e2e_port_pinned=1
else
  # `pick_free_port` returns its START port with a non-zero status when it
  # exhausts the scan. Capture that: without it we would boot onto a BUSY port,
  # fail to bind, and then let the readiness probe be answered by the OCCUPANT —
  # resurrecting the exact adopt-a-different-build defect Phase 2.5 removed, in
  # the one edge case the pinned-port guard no longer covers.
  E2E_PORT_BE="$(pick_free_port 8080)" || e2e_port_exhausted=1
fi
if [ -n "${OPENWOP_E2E_PORT:-}" ]; then
  E2E_PORT_FE="$OPENWOP_E2E_PORT"
else
  E2E_PORT_FE="$(pick_free_port 5173 || true)"
fi
# NOT exported. `export` leaked this stage's chosen port into the NEXT one:
# `e2e-routes.sh` starts its own Vite on its own var, but Playwright reads
# OPENWOP_E2E_PORT — so it inherited 5174 from here and tried to start a SECOND
# Vite on the port this stage had not finished releasing. A peer hit exactly that
# on a quiet machine: collab failed, printed "advisory", and the next stage died
# on "5174 is already used". Passed per-invocation below instead.

e2e_explicit=0; [ "${OPENWOP_CI_E2E:-0}" = "1" ] && e2e_explicit=1
e2e_run=$e2e_explicit
e2e_blocked=""
# Browser presence = the Playwright cache exists (macOS or Linux path). An earlier
# cut wrote `command -v npx && [ -d mac ] || [ -d linux ]`, which parses as
# `(npx && mac) || linux` — so the npx check applied on macOS and silently did not
# on Linux. Asymmetric and confusing in a merge gate; the cache dir IS the signal.
if [ -d "$HOME/Library/Caches/ms-playwright" ] || [ -d "$HOME/.cache/ms-playwright" ]; then
  e2e_have_browser=1
else
  e2e_have_browser=0
fi
# Chromium stays a SKIP, deliberately — Phase 4 does NOT auto-install it.
# Current practice puts browser installation in an explicit, cached CI setup step
# and keeps pre-commit/pre-push hooks lightweight. `npm run ci` IS the pre-push
# hook, so a ~150MB download triggered by `git push` would be the anti-pattern,
# not the fix — surprising, slow, and broken offline. The remedy for this skip is
# to make it impossible to ignore and trivial to clear, which is what the message
# and the ledger below do.
[ "$e2e_have_browser" = "0" ] && e2e_blocked="Chromium not installed — run: npx playwright install chromium"
# Only reachable when the port was PINNED by the caller; the auto path already
# selected a free one above.
if [ "$e2e_port_pinned" = "1" ] && gate_port_in_use "$E2E_PORT_BE"; then
  e2e_blocked="pinned port :$E2E_PORT_BE is in use — free it, or unset OPENWOP_CI_E2E_BACKEND_PORT to auto-select"
elif [ "$e2e_port_exhausted" = "1" ]; then
  e2e_blocked="no free backend port in 8080-8120 — free one, or pin OPENWOP_CI_E2E_BACKEND_PORT"
fi
# ── PHASE 4d: THE BROWSER LANE IS NOW MANDATORY BY DEFAULT ───────────────────
#
# Phase 3 let the auto path SKIP when Chromium was absent — "a gate for machines
# that can run it, not a guarantee". Phase 4a removed the other skip cause (port
# contention), so "Chromium not installed" was the only one left, and a silent
# skip on it means `npm run ci` can go green having never opened a browser.
#
# WHY THIS DOES NOT NEED THE LEDGER FIRST. The gate I wrote for this was "≥80% run
# rate across ~10 gate runs". That measured the wrong variable: with port
# contention gone, the run rate reduces to "does this developer have Chromium",
# which is directly observable and needs no sampling. `@playwright/test` is already
# a declared devDependency; the browser binaries are its binary half. And this file
# ALREADY hard-fails on a missing dev dependency (`node_modules`, above) with
# "we don't auto-install — that's the dev's choice". Same policy, same class.
#
# BUT NOT UNCONDITIONALLY — the white-label bundle is `git archive HEAD`
# (`scripts/build-whitelabel-zip.sh:72`), so ADOPTERS receive this script and the
# e2e specs. Hard-failing a fresh adopter clone on a browser they never asked for
# is a hostile first run, and `check-whitelabel-build.sh` exists precisely because
# that first run must work.
#
# So: MANDATORY BY DEFAULT, ESCAPABLE BY INTENT. `OPENWOP_CI_E2E=0` opts out and
# the error names it. A silent skip and an explicit opt-out are not the same
# thing — only the first was the defect this phase set out to remove.
e2e_optout=0; [ "${OPENWOP_CI_E2E:-}" = "0" ] && e2e_optout=1
if [ "$e2e_optout" = "1" ]; then
  e2e_run=0
  e2e_blocked="explicitly disabled via OPENWOP_CI_E2E=0"
elif [ "$e2e_explicit" = "0" ]; then
  e2e_run=1   # default: the browser lane runs, and a blocker below is FATAL
fi

if [ "$e2e_run" = "1" ]; then
  # ── PORT SAFETY (ADR 0509 Phase 2.5). Read before changing any of this. ──
  #
  # This block used to hard-code :8080 and end with
  #     lsof -iTCP:8080 -t | xargs kill -9
  # which is not "kill my backend" — it is "kill whatever owns the port". That was
  # tolerable while the lane was opt-in and run deliberately. It is NOT tolerable in
  # a merge gate: `npm run ci` is also the pre-push hook, several sessions share this
  # machine, and a developer's own dev backend normally holds :8080 — so promoting
  # this step would have made every gate run SIGKILL somebody's dev server.
  #
  # Worse, the readiness probe could not tell its own backend from a pre-existing
  # one: anything already listening on :8080 with the test seams answers login-201,
  # so the probe passed and the whole suite ran against A DIFFERENT BUILD. That is
  # the same defect `playwright.config.ts` already fixed one layer up by turning
  # `reuseExistingServer` off — "a green suite that never executed your code".
  #
  # Three rules now:
  #   1. Pick a FREE port (override with OPENWOP_CI_E2E_BACKEND_PORT).
  #   2. REFUSE to run if it is occupied, rather than adopting the occupant.
  #   3. Kill ONLY the PID we started. Never a port sweep.
  if [ -n "$e2e_blocked" ]; then
    # Only reachable on the EXPLICIT path — the auto path already set e2e_run=0.
    echo "error: cannot run the e2e lane — $e2e_blocked" >&2
    echo "  The browser lane is MANDATORY by default (ADR 0509 Phase 4): a gate that" >&2
    echo "  silently skips it can go green having never opened a browser." >&2
    echo "  Two ways forward:" >&2
    echo "    1. install it:  npx playwright install chromium" >&2
    echo "    2. opt out ON PURPOSE:  OPENWOP_CI_E2E=0 npm run ci" >&2
    echo "  Refusing to adopt an existing server: it would run the suite against a" >&2
    echo "  DIFFERENT build and report it green (the reason playwright.config.ts" >&2
    echo "  keeps reuseExistingServer off)." >&2
    exit 1
  fi
  step "frontend: e2e (Playwright — a11y/focus/smoke; boots the backend on :$E2E_PORT_BE)"
  # The suite outgrew its backend-less design (#2344): modal/collab/feature-route
  # specs drive test/login through the Vite proxy. Boot the built backend with
  # the exact test-seam env documented in e2e/support/session.ts, gate on a real
  # login-201 readiness probe, and always tear it down.
  #
  # PACKS MUST BE DETERMINISTIC (H33, 2026-08-16). `node lib/index.js` is an
  # ENTRY-POINT boot, so without `OPENWOP_MOUNT_LOCAL_PACKS=false` it re-points
  # every `~/.openwop-packs` symlink at THIS checkout (the CLAUDE.md pack hazard,
  # and the reason `packs:prune` found 202 dangling links after two worktrees
  # were removed) — and it READS that shared, mutable directory as the
  # registry-install root of the workflow-chain gallery. The `/builder` visual
  # snapshot promoted to this gate (DSYS-4) renders that gallery, and the gallery
  # orders chains by ROOT (registry dir first, in-tree `examples/` second), so
  # its pixels were a function of whatever the machine held at the moment: the
  # baseline recorded on the morning of 2026-08-16 failed on plain `main` the
  # same afternoon (+438px, 1 973 696 px, same tiles reordered), reproduced in
  # two worktrees, zero source difference. A pixel baseline over machine state is
  # not a regression detector. So: the boot gets its OWN pack dir holding THIS
  # checkout's vendored `packs/` (symlinks — byte-identical to the tree under
  # test; the same construction the conformance runner uses), and never touches
  # `~/.openwop-packs`. The chain gallery then comes from `examples/` alone and
  # is a function of the commit.
  #
  # ADR 0626 P2 — "a function of the commit" WAS THE REMAINING PROBLEM, not the
  # end state. Every chain pack under `examples/` renders a gallery card, so any
  # feature team that adds a chain OR merely rewords one reflows the page and
  # invalidates the baseline. Measured: 15959px (2026-08-16 baseline) → 17598px
  # after three added packs, then → 17946px one day later because #3617/#3621
  # gave `people-hr` an extra sentence and two params. Nobody re-recorded,
  # because this lane is `@advisory` and the gate exits 0 while it is red — so it
  # sat red for ~2 weeks with the diagnosis already written down.
  #
  # So the gallery is now a function of the SPEC: the boot points at the pinned
  # fixture beside the spec and drops the in-tree examples root. Adding or
  # rewording a chain no longer touches these pixels; changing the fixture is a
  # deliberate edit to a visual contract, which is what a baseline should track.
  # The fixture is small on purpose — three packs, ~12 KB — so the recorded PNGs
  # stay small and a real regression is visible in the diff rather than lost in a
  # 17 000px page.
  E2E_PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/owp-e2e-packs.XXXXXX")"
  e2e_packs_mounted=0
  for p in "$ROOT"/packs/*/; do
    p="${p%/}"
    [ -f "$p/pack.json" ] || continue
    ln -s "$p" "$E2E_PACK_DIR/$(basename "$p")" 2>/dev/null && e2e_packs_mounted=$((e2e_packs_mounted + 1))
  done
  # Report the COUNT: zero means every pack-node path is about to fail for an
  # environmental reason, and that must be legible here, not inferred from red.
  echo "  packs: mounted $e2e_packs_mounted vendored pack(s) into $E2E_PACK_DIR (deterministic; not ~/.openwop-packs)"
  if [ "$e2e_packs_mounted" -eq 0 ]; then
    echo "error: no vendored packs under $ROOT/packs — the e2e backend would boot without node packs" >&2
    exit 1
  fi
  (
    cd "$ROOT/backend/typescript"
    OPENWOP_TEST_AUTH_ENABLED=true \
    OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true \
    OPENWOP_DEMO_MODE=true \
    OPENWOP_STORAGE_DSN=memory:// \
    OPENWOP_MOUNT_LOCAL_PACKS=false \
    OPENWOP_PACK_DIR="$E2E_PACK_DIR" \
    OPENWOP_WORKFLOW_CHAIN_PACKS_DIR="$ROOT/frontend/react/e2e/fixtures/chain-packs" \
    OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0 \
    OPENWOP_CORS_ORIGINS=http://localhost:"$E2E_PORT_FE" \
    OPENWOP_SESSION_SECRET=local-ci-session-secret-at-least-32-characters-long \
    PORT="$E2E_PORT_BE" node lib/index.js > /tmp/openwop-ci-e2e-backend.log 2>&1 &
    echo $! > /tmp/openwop-ci-e2e-backend.pid
  )
  E2E_BE_PID="$(cat /tmp/openwop-ci-e2e-backend.pid 2>/dev/null || true)"
  e2e_ready=0
  for _ in $(seq 1 45); do
    # If our own process died, stop waiting — otherwise we would keep probing and
    # could be answered by something else that appeared on the port meanwhile.
    if [ -n "$E2E_BE_PID" ] && ! kill -0 "$E2E_BE_PID" 2>/dev/null; then break; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      http://127.0.0.1:"$E2E_PORT_BE"/v1/host/openwop-app/test/login \
      -H 'content-type: application/json' \
      -d '{"email":"ready@ci.local","tenantId":"ci-readiness"}' || true)
    if [ "$code" = "201" ]; then e2e_ready=1; break; fi
    sleep 2
  done
  if [ "$e2e_ready" != "1" ]; then
    echo "error: e2e backend never became ready on :$E2E_PORT_BE (last code: ${code:-none})" >&2
    tail -60 /tmp/openwop-ci-e2e-backend.log >&2 || true
    [ -n "$E2E_BE_PID" ] && kill "$E2E_BE_PID" 2>/dev/null || true
    rm -rf "$E2E_PACK_DIR"
    exit 1
  fi
  e2e_rc=0
  # TWO PASSES (ADR 0509 Phase 2). The parallel pass excludes `@serial`; the serial
  # pass runs those at --workers=1. `collab.spec.ts` is the only member: it passes
  # alone and fails under load because it drives two live WebSocket clients. It is
  # QUARANTINED, NOT SKIPPED — a quarantine that stops a test executing is
  # indistinguishable from deleting it a few months later.
  # The proxy target names the transient backend; the browser stays on SAME-ORIGIN
  # `/api`. That lets the test-login cookie ride from `page.request` to the SPA.
  # An absolute backend URL makes the app cross-origin and silently splits the
  # authenticated page from its fixtures (see e2e/support/session.ts).
  ( cd "$ROOT/frontend/react" \
      && OPENWOP_E2E_PORT="$E2E_PORT_FE" \
         OPENWOP_DEV_PROXY_TARGET="http://localhost:$E2E_PORT_BE" \
         VITE_OPENWOP_BASE_URL="/api" \
         VITE_OPENWOP_SSE_BASE_URL="http://localhost:$E2E_PORT_BE" \
         npm run test:e2e ) || e2e_rc=$?
  # The @serial/@advisory pass is ADVISORY — it runs, it is reported, it does NOT
  # fail the gate.
  #
  # TWO MEMBERSHIPS, TWO DIFFERENT REASONS, and conflating them would rot the
  # lane. `@serial` = "correct, but needs the machine to itself" (collab drives
  # two live WebSocket clients). `@advisory` = a visual contract that still runs
  # and reports while it earns promotion stability evidence. `/builder` now uses
  # its own pinned chain-pack fixture, so an intentional layout or fixture change
  # may re-record its baseline after visual review; it must never be re-recorded
  # merely to erase an unexplained red. `collab.spec.ts` remains advisory because
  # it fails deterministically under load (measured around load average ~130 with
  # peer suites running), not because retries could absorb a flake. A merge gate
  # runs precisely when the machine is busy, so blocking on it would redden the
  # gate for everyone exactly when they are working.
  #
  # It still EXECUTES, and its outcome is ledgered, so "is collab actually passing?"
  # stays a decidable question rather than quietly rotting. What it is not, is a
  # promise the gate enforces.
  e2e_serial_rc=0
  ( cd "$ROOT/frontend/react" \
      && OPENWOP_E2E_PORT="$E2E_PORT_FE" \
         OPENWOP_DEV_PROXY_TARGET="http://localhost:$E2E_PORT_BE" \
         VITE_OPENWOP_BASE_URL="/api" \
         VITE_OPENWOP_SSE_BASE_URL="http://localhost:$E2E_PORT_BE" \
         npm run test:e2e:serial ) || e2e_serial_rc=$?
  if [ "$e2e_serial_rc" != "0" ]; then
    printf '\n\033[33m⚠ advisory: the @serial/@advisory e2e pass (collab, builder-snapshot) FAILED — not failing THIS step.\033[0m\n'
    printf '  Deliberately non-fatal here. It is NOT a promise about the whole gate —\n'
    printf '  a failing collab can leave state behind; see ADR 0509 Phase 4. Check with:\n'
    printf '    npm run ci:e2e-report\n'
  fi
  # ONLY our own PID. The previous port sweep is what made this unsafe to promote.
  if [ -n "$E2E_BE_PID" ]; then
    kill "$E2E_BE_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$E2E_BE_PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$E2E_BE_PID" 2>/dev/null && kill -9 "$E2E_BE_PID" 2>/dev/null || true
  fi
  rm -rf "$E2E_PACK_DIR"
  # PROCESS EXIT IS NOT PORT RELEASE. `kill` returns before the socket is freed,
  # and Playwright's webServer is a separate child besides. The next stage starts
  # immediately, so wait for the ports themselves to go quiet — this is the exact
  # window that took the gate down.
  for port in "$E2E_PORT_BE" "$E2E_PORT_FE"; do
    for _ in $(seq 1 15); do
      gate_port_in_use "$port" || break
      sleep 1
    done
    if gate_port_in_use "$port"; then
      # FATAL, not a warning. Continuing here is exactly the bug this loop exists
      # to prevent: the next stage collides and dies on "port already used", and a
      # warning nobody reads is not a fix. 15s is generous for a socket to close;
      # if it has not, something is genuinely still holding it and the next stage
      # cannot succeed anyway. Fail where the cause is, not two stages later.
      echo "error: :$port is STILL HELD after the e2e stage (waited 15s)." >&2
      echo "  A later stage would collide on it and report a confusing failure." >&2
      echo "  Something outlived teardown — check for an orphaned vite/node child." >&2
      exit 1
    fi
  done
  e2e_ledger_outcome="ran:pass;serial=$([ "$e2e_serial_rc" = "0" ] && echo pass || echo FAIL)"
  [ "$e2e_rc" = "0" ] || e2e_ledger_outcome="ran:fail"
  [ "$e2e_rc" = "0" ] || { ledger_append "${OPENWOP_CI_E2E_LEDGER:-$ROOT/.openwop-ci-e2e-ledger}" "$e2e_ledger_outcome"; exit "$e2e_rc"; }
else
  # LOUD skip — names the exact blocker and how to clear it, so "green" is never
  # mistaken for "covered". This is the honest half of the Phase 3 compromise:
  # the auto path is a gate for machines that can run it, not a guarantee.
  # Only reachable via an EXPLICIT OPENWOP_CI_E2E=0. Still loud: an intentional
  # opt-out is fine, but it must never read as "covered".
  skip "frontend e2e — ${e2e_blocked:-opted out}; the browser lane did NOT run"
  e2e_ledger_outcome="skipped:${e2e_blocked:-forced-off}"
fi

# ── PHASE 4b: MAKE THE ESCALATION CRITERION DECIDABLE ────────────────────────
# Phase 4's stated gate was "green across a meaningful number of merges" — which
# was never defined, never instrumented, and never recorded. A criterion nobody
# can evaluate is never discharged; it just sits there making the half-measure
# look like progress. That is the failure this ADR warned about, committed by the
# ADR itself.
#
# So every gate run appends one line here. It answers the only two questions that
# decide whether promotion is real coverage or theatre: did the browser lane
# actually RUN, and if not, WHY. `npm run ci:e2e-report` summarises it.
#
# Local and gitignored — this is a developer's own history, not shared state, and
# certainly not something to commit.
e2e_ledger="${OPENWOP_CI_E2E_LEDGER:-$ROOT/.openwop-ci-e2e-ledger}"
ledger_append "$e2e_ledger" "${e2e_ledger_outcome:-unset}"

if [ "${OPENWOP_CI_E2E_ROUTES:-0}" = "1" ]; then
  step "frontend: e2e routes (live — boots a backend, render-smokes every feature route)"
  bash "$ROOT/scripts/e2e-routes.sh"
else
  skip "frontend e2e routes (set OPENWOP_CI_E2E_ROUTES=1; boots a backend + needs Chromium)"
fi

# CSP runtime gate (CC-4): the hosted ci.yml runs check:csp-runtime, but this
# local mirror previously omitted it, so the enforcing-CSP check ran NOWHERE
# while hosted Actions is down. It needs a browser — so rather than hiding it
# behind an opt-in flag, AUTO-DETECT Chromium and run it whenever a browser is
# available (still forceable via OPENWOP_CI_E2E=1; only skipped when no browser).
chromium_available() {
  command -v google-chrome >/dev/null 2>&1 && return 0
  command -v chromium >/dev/null 2>&1 && return 0
  command -v chromium-browser >/dev/null 2>&1 && return 0
  # Playwright-managed Chromium (linux + mac cache locations).
  ls -d "$HOME/.cache/ms-playwright/chromium-"* >/dev/null 2>&1 && return 0
  ls -d "$HOME/Library/Caches/ms-playwright/chromium-"* >/dev/null 2>&1 && return 0
  return 1
}
if [ "${OPENWOP_CI_E2E:-0}" = "1" ] || chromium_available; then
  step "frontend: CSP runtime (enforcing-CSP, all routes — Chromium detected)"
  ( cd "$ROOT/frontend/react" && npm run check:csp-runtime )
else
  skip "frontend CSP runtime (no Chromium found; install Playwright Chromium or set OPENWOP_CI_E2E=1)"
fi

# Dependency advisory gate (CC-3): surface known CVEs in the production
# dependency trees. Two tiers:
#   - HIGH/CRITICAL → ALWAYS BLOCKING. A high+ CVE in a prod dep is a real
#     deploy risk; it must not ship green. (This is the genuine CVE gate that
#     was previously missing.)
#   - MODERATE → advisory by default (|| true) so a newly-filed moderate
#     advisory — e.g. the observability-only @opentelemetry chain — doesn't
#     block a release out of nowhere. Set OPENWOP_CI_AUDIT_STRICT=1 to make the
#     moderate tier blocking too.
audit_strict="${OPENWOP_CI_AUDIT_STRICT:-0}"
step "deps: npm audit (production) — high/critical blocking, with expiring exceptions"
# Was a bare `npm audit --omit=dev --audit-level=high`. That is right until an
# advisory has NO fix — then the gate is red forever, and a permanently-red gate
# gets bypassed or quietly lowered, which is worse than the advisory. It is now a
# checker with an explicit, dated, justified exception list
# (scripts/audit-exceptions.json): an unexcepted high/critical still blocks, and
# so does an EXPIRED or a STALE exception, so the list cannot decay into a
# suppression file. See scripts/check-audit.mjs for why `npm audit fix` was the
# wrong answer here — it reports zero vulnerabilities while breaking every glob.
node "$ROOT/scripts/check-audit.mjs"
step "deps: npm audit (production) — moderate (advisory unless OPENWOP_CI_AUDIT_STRICT=1)"
for d in backend/typescript frontend/react; do
  if [ "$audit_strict" = "1" ]; then
    ( cd "$ROOT/$d" && npm audit --omit=dev --audit-level=moderate )
  else
    ( cd "$ROOT/$d" && npm audit --omit=dev --audit-level=moderate || true )
  fi
done

# DATE-BOMB lane. A test mixing a fixed-date fixture with a real-clock read passes
# until a calendar date, then fails long after the commit that armed it and
# implicates whoever is nearest (#2623). Advancing the clock fires that class in
# CI instead.
#
# THE FRONTEND ARM IS NOT OPT-IN ANY MORE (2026-09-01). The opt-in was justified
# by "it doubles suite time and the class is rare", and both halves were measured
# false for this workspace:
#
#   - COST. The frontend sweep is one extra frontend suite: 69.45s, against
#     66.49s for the normal frontend run in the same gate. On a ~20-minute gate
#     that is ~6%. "Doubles suite time" is true of the BACKEND arm (14.5k tests),
#     which is why that one stays opt-in below.
#   - RARITY. On 2026-09-01 `PublicBookingManagePage.test.tsx` detonated AGAIN —
#     the same file whose 2026-08-18 detonation is the reason this lane exists
#     (H72/H74, cited by name in `src/test/clock-shift.ts`). It had even been
#     PARTIALLY fixed: fake timers were enabled for the whole describe block but
#     `setSystemTime` was only called inside one helper, so the two tests that
#     never called it ran on the real clock. A partial fix to a time bomb resets
#     the fuse rather than removing it, and leaves the file grepping as fixed.
#
# So the lane built to catch this class was present, correct, and OFF while the
# exact defect it was built for recurred in the exact file that motivated it.
# An opt-in gate for a recurring class is a gate whose default is the failure.
step "frontend: date-bomb sweep (clock advanced ${OPENWOP_CLOCKSHIFT_DAYS:-365} days)"
( cd "$ROOT/frontend/react" && OPENWOP_CI_CLOCKSHIFT=1 npm run test )

# NON-VACUITY FLOOR, and it runs unconditionally BECAUSE the sweep above now
# does. A sweep that runs and asserts nothing is the next failure in this
# sequence — the setup file could be dropped from `setupFiles`, or the env var
# renamed, and the suite would still go green under a step named "date-bomb
# sweep". Cheap: one probe test per workspace, not a suite.
step "date-bomb sweep: the clock is really shifted (non-vacuity)"
node "$ROOT/scripts/check-clockshift-armed.mjs"

# The BACKEND arm stays opt-in — 14.5k tests is a real doubling.
if [ "${OPENWOP_CI_CLOCKSHIFT:-0}" = "1" ]; then
  step "backend: date-bomb sweep (clock advanced ${OPENWOP_CLOCKSHIFT_DAYS:-365} days)"
  ( cd "$ROOT/backend/typescript" && OPENWOP_CI_CLOCKSHIFT=1 OPENWOP_SKIP_TESTCONTAINERS=1 npm run test )
else
  skip "date-bomb sweep, BACKEND (set OPENWOP_CI_CLOCKSHIFT=1; the frontend arm above always runs)"
fi

if [ "${OPENWOP_CI_LIVE:-0}" = "1" ]; then
  step "backend: live pgvector / pg-sql / opensearch (testcontainers)"
  ( cd "$ROOT/backend/typescript" && OPENWOP_PGVECTOR_LIVE=1 npm run test -- test/pgvector-live.test.ts )
  ( cd "$ROOT/backend/typescript" && OPENWOP_PG_SQL_LIVE=1 npm run test -- test/pg-sql-live.test.ts )
  ( cd "$ROOT/backend/typescript" && OPENWOP_OPENSEARCH_LIVE=1 npm run test -- test/opensearch-live.test.ts )
  # H59 — the STORAGE adapter itself, against a real Postgres.
  #
  # This file existed and ran in NO lane: the suite step above sets
  # OPENWOP_SKIP_TESTCONTAINERS=1 unconditionally, this block named only the
  # three *-live specs, and the hosted workflow has been disabled since
  # 2026-07-21. So the production adapter's dispatch outbox (FOR UPDATE SKIP
  # LOCKED), ADR 0549 idempotency ledger (lease/reclaim/CAS) and ADR 0551
  # workspace CAS were witnessed by nothing that executes — while
  # `storage-postgres.test.ts` ran a hand-written pg-mem DOUBLE with no lease,
  # no reclaim, no CAS and a no-op release.
  #
  # OPENWOP_STORAGE_PARITY_LIVE=1 hard-requires Docker, matching the three
  # specs above: without it the file skips, and a skip inside a lane reads as a
  # pass — which is the defect being closed, not a style preference.
  step "backend: live storage-adapter parity (outbox / idempotency ledger / workspace CAS)"
  ( cd "$ROOT/backend/typescript" && OPENWOP_STORAGE_PARITY_LIVE=1 npm run test -- test/storage-adapter-parity-testcontainers.test.ts )
else
  skip "backend live adapters + storage parity (set OPENWOP_CI_LIVE=1; needs Docker)"
fi

if [ "${OPENWOP_CI_LIVE:-0}" = "1" ]; then
  step "registry parity: examples/*-packs vs packs.openwop.dev (day-1 UX P10/E4)"
  bash "$ROOT/scripts/check-registry-parity.sh"
else
  skip "registry parity check (set OPENWOP_CI_LIVE=1; needs network)"
fi

# ADR 0550 P2 Lane 2 — conformance against the RELEASE ARTIFACT, not source.
#
# Deliberately NOT in the default gate. `npm run ci` is THE merge gate with
# hosted Actions disabled, so it must stay runnable on a machine without a
# Docker daemon; making it Docker-dependent is a worse failure than this lane
# running less often. Cost is not the reason — MEASURED 2026-08-13: ~16-20s for
# a warm rebuild after a real source change, once .dockerignore cut the context
# from 549M to 412kB.
#
# The `skip` line matters as much as the step: a lane nobody invokes is a gate
# that cannot fail, and printing its absence on every ordinary run is how this
# repo keeps that visible.
# NOT on OPENWOP_CI_LIVE yet, and the reason is recorded rather than hidden.
#
# MEASURED 2026-08-13 against the image: 418 files collected (no collection
# loss), 2541 passed, **16 failed across 10 files**. Those failures are NOT yet
# attributed. Every one identified so far is callback-shaped — the compat
# provider, the OIDC issuer, the webhook subscriber — i.e. scenarios where the
# HOST must call back into the suite. In-process that is free loopback; from a
# container 127.0.0.1 is the container itself, so the call cannot land. That is
# an environment gap, not evidence of non-conformance.
#
# Wiring a red lane into ci:full would block every unrelated PR, which is the
# same reasoning ADR 0550 P1 used for its quarantine — and reporting these as
# host failures would repeat the misattribution that quarantine cost two days.
# So the lane is opt-in until the callback path is solved (container→host
# reachability) and each failure is individually attributed to host or harness.
if [ "${OPENWOP_CI_RELEASE_CONFORMANCE:-0}" = "1" ]; then
  step "conformance: release artifact (container boot, ADR 0550 P2 Lane 2)"
  bash "$ROOT/scripts/release-conformance.sh"
else
  skip "release-artifact conformance (set OPENWOP_CI_RELEASE_CONFORMANCE=1; needs Docker — 1 remaining, dispositioned: webhook-signed-delivery pins a 127.0.0.1 subscriber the container cannot reach, ADR 0550 P2)"
fi

# H101 — the LAST thing the gate does is check it tested one tree. A green whose
# inputs moved underneath it is worse than a red: it is a claim about a commit
# that was never in the state this run measured. Deliberately FATAL — refusing the
# ledger row stops the false record persisting, but only a non-zero exit stops the
# operator believing the green.
if ! tree_unchanged; then
  printf '\n\033[31m✗ GATE VOID — the working tree changed while this run was in progress.\033[0m\n' >&2
  printf '  Steps ran against different tree states, so the result describes no commit.\n' >&2
  printf '  Nothing here is evidence for or against the change. Commit or stash the\n' >&2
  printf '  edit and re-run from a settled tree (H101).\n' >&2
  exit 1
fi

printf '\n\033[1;32m✅ local CI gate passed\033[0m\n'
