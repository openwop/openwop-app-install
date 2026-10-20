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

# Contention FIRST, before anything else runs. Since 2026-09-28 this gate WAITS
# by default behind any live suite from another checkout of this repo, under an
# atomic claim (see `scripts/preflight-suite.sh --help`). It waits by `exec`ing
# INTO preflight-suite.sh, which execs back here when clear (or after the
# OPENWOP_CI_WAIT_MAX_MIN cap, under a DEBT-3 banner; OPENWOP_CI_NO_WAIT=1 skips
# it). The exec is the point: while waiting, this process is NOT `scripts/ci.sh`,
# so another session's detector — this version or the previous one — cannot
# mistake a WAITING gate for a running suite. The first version waited inside
# this script and two waiting gates deadlocked on each other's argv.
if [ -z "${OPENWOP_CI_PREFLIGHT_DONE:-}" ]; then
  # The gate's path travels in the ENVIRONMENT, not argv: an argv holding
  # `…/scripts/ci.sh` would match the detector's pattern all over again.
  OPENWOP_CI_EXEC_TARGET="$ROOT/scripts/ci.sh" exec bash "$ROOT/scripts/preflight-suite.sh" --ci-exec "$@"
fi

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
# Every step banner carries the gate's elapsed time (ADR 0863), so a log answers
# "where did the time go" without anyone having to re-run with timestamps.
CI_T0=$(date +%s)
step() { printf '\n\033[1m▶ %s\033[0m \033[2m[+%ss]\033[0m\n' "$*" "$(( $(date +%s) - CI_T0 ))"; }
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
# The claim preflight-suite.sh took for this pid (above) is RELEASED however this gate
# ends — pass, fail, or Ctrl-C/TERM. MEASURED: bash already runs the EXIT trap
# when TERM kills this script (removing the TERM line below leaves the self-test
# green), so the INT/TERM lines are explicit belt-and-braces, not load-bearing.
# ── Background lanes (ADR 0863 D6) ────────────────────────────────────────────
# A lane that mostly WAITS, or uses one core, runs beside a CPU-heavy lane
# instead of in front of it. `bg_lane_start <name> <fn>` runs <fn> in the
# background with its output in a temp log; `bg_lane_join <name>` waits, replays
# the log whole (so the gate log reads as if it ran in line) and fails the gate
# with the lane's exit code. Every live lane is killed with its whole subtree on
# any exit, so a red or interrupted gate never leaves a suite running behind it.
# OPENWOP_CI_SERIAL_LANES=1 runs each lane in line at its start point instead.
# Plain variables, not arrays: macOS ships bash 3.2.
# shellcheck source=lib/gate-ports.sh
. "$ROOT/scripts/lib/gate-ports.sh"
BG_LANES=""   # space-separated name:pid:log
bg_lane_start() { # bg_lane_start <name> <fn>
  local name="$1" fn="$2" log
  if [ "${OPENWOP_CI_SERIAL_LANES:-0}" = 1 ]; then "$fn"; return; fi
  log="$(mktemp "${TMPDIR:-/tmp}/owp-ci-lane-$name.XXXXXX")"
  # The lane times itself (ADR 0880 step 4): once Tracegate shrinks the vitest
  # lanes, a background lane can become the critical path, and the join line
  # below says which one and by how much.
  # An EXIT trap, never `"$fn" || rc=$?`: a `||` would switch off `set -e` inside
  # the lane, and a lane that failed mid-way would then report green.
  ( _s=$(date +%s); trap 'echo "  (background lane '"$name"' ran $(( $(date +%s) - _s ))s)"' EXIT; "$fn" ) > "$log" 2>&1 < /dev/null &
  BG_LANES="$BG_LANES $name:$!:$log"
  echo "  running in the background: $name (pid $!, log $log)"
}
bg_lane_join() { # bg_lane_join <name>
  local e pid log rc=0 rest=""
  for e in $BG_LANES; do
    if [ "${e%%:*}" = "$1" ]; then pid="${e#*:}"; log="${pid#*:}"; pid="${pid%%:*}"
    else rest="$rest $e"; fi
  done
  [ -n "${pid:-}" ] || return 0   # serial mode: it already ran in line
  local t0; t0=$(date +%s)
  wait "$pid" || rc=$?
  BG_LANES="$rest"
  cat "$log"; rm -f "$log"
  echo "  (the gate waited $(( $(date +%s) - t0 ))s for background lane $1 at this join)"
  [ "$rc" -eq 0 ] || { echo "background lane '$1' FAILED (exit $rc)"; exit "$rc"; }
}
bg_lanes_live() { # print the names of background lanes still running
  local e pid out=""
  for e in $BG_LANES; do pid="${e#*:}"; pid="${pid%%:*}"; kill -0 "$pid" 2>/dev/null && out="$out ${e%%:*}"; done
  echo "${out# }"
}
bg_lanes_kill() {
  local e pid
  for e in $BG_LANES; do pid="${e#*:}"; gate_kill_tree "${pid%%:*}"; rm -f "${pid#*:}"; done
  BG_LANES=""
}
trap 'rc=$?; bg_lanes_kill; bash "$ROOT/scripts/preflight-suite.sh" --release >/dev/null 2>&1; [ "$rc" -ne 0 ] && ci_load_note; exit $rc' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# (The contention wait ran at the top of this script — see there.)

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
  lockcheck_log="$(mktemp "${TMPDIR:-/tmp}/openwop-ci-lockcheck.XXXXXX")"
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

# openwop#1763 `cors-preflight-admits` — the preflight allow-list's spec half is
# GENERATED from the pinned OpenAPI (both majors); a stale snapshot fails here.
step "cors preflight: allow-list spec half matches the pinned OpenAPI"
node "$ROOT/scripts/gen-cors-request-headers.mjs" --check

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

step "custom-domain edge script: plan/apply/verify against a stub gcloud (ADR 0906 P3)"
# Pure shell, no network: the real gcloud is never reached. `apply` creates billable
# resources, so its confirmation guard and idempotence are asserted here, not trusted.
bash "$ROOT/scripts/test-custom-domain-edge.sh" </dev/null

step "deploy gates + contention detector: started in the BACKGROUND, joined after backend vitest (ADR 0863 D6)"
# The deploy-gate suite: pure shell + fixture repos + a local stub, needing no build.
# These two scripts are the last thing between a stale worktree and production;
# an untested guard is a guard nobody should trust. The suite is written around
# failure modes that HAVE happened (deploying a worktree behind origin/main) or
# would silently defeat the guard if they regressed (an unstamped deploy reading
# as a pass; a broken backend locking the operator out of the fix).
#
# ADR 0863 D6 — why these run beside the backend lane instead of before it.
# MEASURED on the 2026-10-08 gate log: they were 148 s of a 3,128 s gate, run
# serially, and they are mostly WAITING — test-preflight-suite.sh is ~50 arms of
# fixed 2–4 s polls (190 s wall for 56 s CPU at load 66), test-deploy-gates.sh
# 101 s wall for 65 s CPU. Spread over a 30-minute vitest lane that CPU is noise,
# and the wall time disappears. They need no build and touch only their own temp
# fixtures, dynamically picked ports and fake worktrees (the preflight harness
# already tolerates a real suite running beside it — it asserts on SETS, and
# skips its one clear-path arm when it cannot be observed). The cost is latency:
# a red here is reported after backend vitest rather than before it. Their
# output is replayed whole at the join, so the log reads as it did serially.
# OPENWOP_CI_SERIAL_LANES=1 restores the old in-line order for every such lane.
run_selftests() {
  set -e
  echo "▶ deploy gates: preflight + verify actually refuse (ADR 0518 / ADR 0530)"
  bash "$ROOT/scripts/test-deploy-gates.sh"
  node --test --test-concurrency=1 "$ROOT/scripts/test-owned-deploy.mjs"
  echo
  echo "▶ guard: the contention detector actually fires (preflight-suite)"
  bash "$ROOT/scripts/test-preflight-suite.sh"
  echo
  echo "▶ Tracegate: the predictor reuses only what it may, and runs what it must (ADR 0880)"
  node "$ROOT/scripts/test-tracegate.mjs"
  echo
  echo "▶ payload ratchet: a subset run never judges an admission stale (ADR 0702 × ADR 0880)"
  node --test "$ROOT/scripts/test-audit-event-payloads.mjs"
  echo
  echo "▶ merge-train: a red train bisects itself and lands the green PRs (ADR 0880 P0)"
  bash "$ROOT/scripts/test-merge-train-bisect.sh"
  echo
  echo "▶ /qualify-live runner: outcomes stay honest and keys rotate (loopback fake host, no key, no spend)"
  # build-whitelabel-zip.sh strips .claude/ (steward meta) but ships this script, so a white-label tree has no skill to test.
  if [ -f "$ROOT/.claude/skills/qualify-live/qualify.test.mjs" ]; then
    node --test "$ROOT/.claude/skills/qualify-live/qualify.test.mjs"
  else
    echo "qualify-live selftest skipped: .claude/ not in this tree (white-label bundle)"
  fi
}
bg_lane_start selftests run_selftests

step "frontend: lint + build + unit-test types — BACKGROUND, joined before backend vitest (ADR 0863 D7)"
# ADR 0863 D7 — the backend preamble below (typecheck, distributions, esbuild
# build, the shutdown and e2e-wiring probes) is ~2 minutes of mostly ONE busy
# core. These three frontend steps (~125–170 s: two single-threaded tsc passes,
# eslint, a vite build) need nothing it produces: the default distribution
# writes no file (gen-distribution.mjs `prebuild` is a no-op for it, and
# vite.config.ts derives the registry in memory). So they use the idle cores
# now instead of running after backend vitest. They are joined BEFORE backend
# vitest, not after it: a frontend lint or type error still fails the gate in
# its first minutes, and backend vitest — which keeps all 7 workers busy — never
# shares the box with them.
# The three also run beside EACH OTHER. MEASURED one after another: 181 s here,
# while the preamble finished at +98 s, so backend vitest waited ~100 s for them.
# None writes what another reads (no tsc pass is incremental; lint writes
# nothing), so the lane takes roughly the build's ~80 s.
run_frontend_static() ( # a subshell: the serial fallback must not leave ci.sh in frontend/react
  local dir rc=0 n p p1 p2 p3
  dir="$(mktemp -d "${TMPDIR:-/tmp}/owp-ci-fe-static.XXXXXX")"
  trap 'rm -rf "$dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  cd "$ROOT/frontend/react" || return 1
  fe_static_one() { # fe_static_one <log> <title> <npm args...>
    local log="$1" title="$2"; shift 2
    { echo "▶ frontend: $title"; npm "$@"; } > "$log" 2>&1 < /dev/null
  }
  fe_static_one "$dir/1" "lint (eslint, zero warnings)" run lint -- --max-warnings=0 & p1=$!
  fe_static_one "$dir/2" "build (tsc + token/CSS checks + vite + bundle budget)" run build & p2=$!
  fe_static_one "$dir/3" "unit-test types (shrink-only ratchet — tests are excluded from the build's tsc)" run check:test-types & p3=$!
  for n in 1 2 3; do
    eval "p=\$p$n"
    if wait "$p"; then :; else rc=$?; echo "frontend static step $n FAILED (exit $rc)" >> "$dir/$n"; fi
    cat "$dir/$n"; echo
  done
  rm -rf "$dir"
  return "$rc"
)
bg_lane_start frontend-static run_frontend_static

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
# The /update-cli gap measure: non-vacuous, counts composed CLI paths, refuses a
# missing CLI checkout (reads source only; ~1 s).
bash "$ROOT/scripts/test-cli-route-coverage.sh"

step "frontend: lint + build + unit-test types — background result (ADR 0863 D7)"
bg_lane_join frontend-static

# ── ADR 0880 — Tracegate: run only the test files a change can affect ────────
# Every recorded run deposits per-file FOOTPRINTS (functions executed, modules
# loaded, repo files read) in a ledger shared by every worktree. A file whose
# footprint is untouched since its last green run can reuse that verdict.
#   shadow   (until a lane clears the entry bar) run EVERYTHING; print what could
#            have been reused, and log any file predicted reusable that FAILED.
#   enforce  run only the files that need it, plus a random 5% AUDIT of reuses.
#            An audited file that fails is a MISS and suspends enforcement for
#            that lane for 14 days, by itself.
# OPENWOP_TRACEGATE=off|shadow|enforce|auto (default auto; per lane:
# OPENWOP_TRACEGATE_BACKEND / _FRONTEND). `node scripts/tracegate.mjs status`
# shows the ledger and the entry bar. NOTHING here can turn a red lane green:
# if Tracegate itself fails, the lane runs whole and records nothing.
TG="$ROOT/scripts/tracegate.mjs"
CI_HEAD_AT_START="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
TG_MISSES=() # filled by tg_end from the lane's report (tg_recheck_misses)
tg_begin() { # tg_begin <lane> → TG_LANE TG_MODE TG_RUN TG_ARGS
  TG_LANE="$1"; TG_RUN=""; TG_ARGS=()
  TG_MODE="$(node "$TG" mode --lane "$1" 2>/dev/null || echo off)"
  [ "$TG_MODE" = off ] && return 0
  TG_RUN="$(mktemp -d "${TMPDIR:-/tmp}/owp-tracegate-$1.XXXXXX")"
  if ! node "$TG" select --lane "$1" --run "$TG_RUN" --mode "$TG_MODE"; then
    printf '\033[33mtracegate: selection failed — running the whole %s lane, recording nothing.\033[0m\n' "$1"
    rm -rf "$TG_RUN"; TG_RUN=""; TG_MODE=off; return 0
  fi
  if [ "$TG_MODE" = enforce ]; then
    while IFS= read -r f; do [ -n "$f" ] && TG_ARGS+=("$f"); done < "$TG_RUN/selected.txt"
  fi
}
tg_end() { # report now (cheap, prints in place); ingest in the BACKGROUND
  [ -n "$TG_RUN" ] || return 0
  node "$TG" report --lane "$TG_LANE" --run "$TG_RUN" || echo "tracegate: report failed (ignored)"
  # Mapping and hashing thousands of footprints takes minutes (55 s for the
  # frontend's 999 files) and nothing downstream needs it, so it is joined at the
  # very end. It never fails the gate. If the gate goes red first, the EXIT trap
  # kills it and nothing is recorded — `report` above has already dropped the
  # footprints of any file that failed, which is the part that matters.
  TG_MISSES=()
  if [ -f "$TG_RUN/misses.txt" ]; then while IFS= read -r f; do [ -n "$f" ] && TG_MISSES+=("$f"); done < "$TG_RUN/misses.txt"; fi
  eval "TG_INGEST_RUN_${TG_LANE}=\"\$TG_RUN\""
  bg_lane_start "tracegate-$TG_LANE" "tg_ingest_$TG_LANE"
}
tg_ingest() { # tg_ingest <lane> <run dir> — attribute footprints only to an unmoved tree (H101)
  if tree_unchanged; then
    node "$TG" ingest --lane "$1" --run "$2" --expect-head "$CI_HEAD_AT_START" || echo "tracegate: ingest failed (ignored)"
  else
    echo "tracegate: the tree changed during this gate — no footprints recorded (H101)."
  fi
  rm -rf "$2"
  return 0
}
tg_ingest_backend() { tg_ingest backend "$TG_INGEST_RUN_backend"; }
tg_ingest_frontend() { tg_ingest frontend "$TG_INGEST_RUN_frontend"; }
# A MISS is a file predicted reusable that FAILED, and it suspends the lane for
# 14 days. A load flake used to count as one: slot 77 (2026-10-14) lost the
# frontend lane to "Failed to fetch dynamically imported module" at load 11.8 in
# a file that passed 3/3 alone at the same tree. So each miss is re-run ONCE,
# alone, at this tree. A footprint hole is a deterministic function of the tree,
# so it fails again and stays a MISS. One that passes is triaged a flake (the
# ledger says so). The gate stays RED either way: the file did fail here.
tg_recheck_misses() { # tg_recheck_misses <lane> <lane dir> [VAR=value…] — after tg_end, lane red
  local ln="$1" dir="$2" f rel h log; shift 2
  [ "${#TG_MISSES[@]}" -gt 0 ] || return 0
  h="$(git -C "$ROOT" rev-parse HEAD | cut -c1-12)" # the ledger's head key
  for f in "${TG_MISSES[@]}"; do
    rel="${f#"$dir"/}"
    echo "tracegate ($ln): re-running the MISS $rel alone at $h …"
    log="$(mktemp "${TMPDIR:-/tmp}/owp-tg-recheck.XXXXXX")"
    if ( cd "$ROOT/$dir" && env ${@+"$@"} npm run test -- "$rel" ) > "$log" 2>&1; then
      node "$TG" triage --lane "$ln" --file "$f" --head "$h" --verdict flake || true
      echo "tracegate ($ln): $rel PASSED alone at this tree, so it was a flake, not a footprint hole; it does not suspend the lane. The gate is still red: fix or quarantine the flake."
    else
      printf '\033[31mtracegate (%s): %s FAILS alone at this tree too, so it is a real MISS (a recorder hole, P0). The lane stays suspended. Log: %s\033[0m\n' "$ln" "$rel" "$log"
    fi
  done
  TG_MISSES=()
}
# Run a lane's vitest under Tracegate. bash 3.2 (macOS) + `set -u` rejects an
# empty "${arr[@]}", hence the ${arr[@]+…} form.
tg_vitest() { # tg_vitest <lane dir> [VAR=value…] — runs `npm run test` with the selection
  local dir="$1"; shift
  if [ "$TG_MODE" = enforce ] && [ "${#TG_ARGS[@]}" -eq 0 ]; then
    echo "tracegate: every $TG_LANE verdict is reusable at this tree — no file needs to run."
    return 0
  fi
  ( cd "$ROOT/$dir" && env "$@" OPENWOP_TRACEGATE_RECORD="$TG_RUN" npm run test -- ${TG_ARGS[@]+"${TG_ARGS[@]}"} )
}

step "backend: vitest (OPENWOP_SKIP_TESTCONTAINERS=1, as in CI)"
# ADR 0702 — the event-payload recorder rides ALONG with this run. The samples
# are free: this lane already exercises every emit path, and the recorder is one
# comparison per append, hoisted to module load and off unless the var is set.
# Building a second lane to produce the same events would have cost 20 minutes
# and measured slightly different code.
OPENWOP_PAYLOAD_AUDIT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/owp-payload-audit.XXXXXX")"
# ADR 0880 — under enforce, the payload recorder sees only the files that ran.
# A subset cannot invent a NEW violating type: what it can miss lives in code no
# selected file executes, i.e. unchanged code.
# CORRECTED 2026-10-14: this used to say a subset "cannot invent a red". It can,
# through the STALE check: a type sampled valid by a file that ran, whose only
# violating emitter was reused, reads as fixed. Slot 71 went red that way on
# `runOrchestrator.decided`. So under enforce the stale check is skipped
# (`--no-stale`, below) and a FULL run judges it: the gate runs the lane full
# when its last complete full run is > 24 h old (ADR 0880 D5 correction; the
# daemon nightly that was meant to do this had never completed).
tg_begin backend
BE_TG_MODE="$TG_MODE"
be_rc=0
tg_vitest backend/typescript OPENWOP_SKIP_TESTCONTAINERS=1 OPENWOP_PAYLOAD_AUDIT="$OPENWOP_PAYLOAD_AUDIT_DIR" || be_rc=$?
tg_end
[ "$be_rc" -eq 0 ] || { tg_recheck_misses backend backend/typescript OPENWOP_SKIP_TESTCONTAINERS=1; echo "backend vitest FAILED (exit $be_rc)"; exit "$be_rc"; }

step "deploy gates + contention detector: background result (ADR 0863 D6)"
bg_lane_join selftests

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
PA_ARGS=(--ratchet)
[ "$BE_TG_MODE" = enforce ] && PA_ARGS+=(--no-stale) # a subset cannot prove staleness (see the backend vitest step)
OPENWOP_PAYLOAD_AUDIT="$OPENWOP_PAYLOAD_AUDIT_DIR" node "$ROOT/scripts/audit-event-payloads.mjs" "${PA_ARGS[@]}" 2>&1 | tail -20
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
# ADR 0880 — a FULL backend run whose stale check just passed is the backstop's
# evidence; without it the next gate runs the lane full again.
if [ "$BE_TG_MODE" = shadow ]; then node "$TG" full-done --lane backend || echo "tracegate: full-done failed (ignored)"; fi

# ADR 0812 P3c — the TARGET MAJOR 1 lane that used to run here is gone with
# major 1. It ran the full suite at major 1, where every `v2-*` scenario records
# `inapplicable` (#3644). The major-2 lane below is now the ONE conformance gate:
# it runs the same suite at major 2 and ratchets it BOTH ways against an explicit
# known-red list. An unlisted red fails, and so does a listed file that has gone
# green (a stale entry is a lie about the wire). `conformance/quarantine.json` is
# still honoured if an entry is ever re-added; see the real state with
#   ( cd backend/typescript && OPENWOP_CONFORMANCE_NO_QUARANTINE=1 npm run test:conformance )
step "backend: conformance at TARGET MAJOR 2 (ratchet — scripts/conformance-v2-known-red.txt) — BACKGROUND, joined before the date-bomb sweep (ADR 0863 D6)"
# ADR 0863 D6 — this lane runs `--no-file-parallelism`: one scenario file at a
# time against one in-process host, so it holds about ONE core for ~5 minutes
# (312 s on the 2026-10-08 gate). The frontend lane below is ~9 minutes of
# work that needs nothing from it, so it runs beside that lane. Its host picks
# its own port (conformance/port.js) and runs from src/ via tsx, so nothing the
# frontend lane builds or boots can reach it. It is joined BEFORE the date-bomb
# sweep, the one frontend step already known to red under load (see there).
run_conformance_m2() { cd "$ROOT" && bash scripts/check-conformance-major2.sh; }
bg_lane_start conformance-m2 run_conformance_m2

step "frontend: live-fetch allowlist (shrink-only — ADR 0661)"
node "$ROOT/scripts/check-live-fetch-allowlist.mjs"

step "guard: the live-fetch guard actually fires (ADR 0661)"
bash "$ROOT/scripts/test-live-fetch-guard.sh"

step "frontend: vitest"
# ADR 0661 phase 2 — WITNESS every allowlisted live fetch during the suite we are
# already running, so the stale-entry check below costs no extra run. The guard
# appends one line per allowed call; the checker aggregates after.
LIVE_FETCH_AUDIT="$(mktemp "${TMPDIR:-/tmp}/owp-live-fetch-audit.XXXXXX")"
tg_begin frontend
FE_TG_MODE="$TG_MODE"
FE_TG_ARGS=(${TG_ARGS[@]+"${TG_ARGS[@]}"}) # the date-bomb sweep re-runs this selection (ADR 0918)
fe_rc=0
# The frontend suite shares the machine with whatever background lane is still
# live here: conformance-m2 (~450 s, started just before this step) and the
# backend Tracegate ingest. Slot 77 (2026-10-14) went red three times on three
# DIFFERENT async UI tests (each 3/3 green alone), all with frontend vitest at
# full width beside conformance-m2. The same tree went green with
# OPENWOP_CI_SERIAL_LANES=1 at similar load. So while a background lane is live
# the suite runs narrower instead of losing the overlap altogether. The overlap
# is old (ADR 0863 D6); Tracegate made the backend lane short enough that it now
# lands on the frontend run's start.
FE_CAP=()
FE_BG_LIVE="$(bg_lanes_live)"
if [ -n "$FE_BG_LIVE" ]; then
  FE_CAP=(VITEST_MAX_WORKERS="${OPENWOP_CI_FE_WORKERS_BESIDE_BG:-4}")
  echo "frontend vitest: capped at ${OPENWOP_CI_FE_WORKERS_BESIDE_BG:-4} workers while background lane(s) run: $FE_BG_LIVE (OPENWOP_CI_FE_WORKERS_BESIDE_BG sets it; OPENWOP_CI_SERIAL_LANES=1 removes the overlap)"
fi
FE_T0=$(date +%s)
tg_vitest frontend/react OPENWOP_LIVE_FETCH_AUDIT="$LIVE_FETCH_AUDIT" ${FE_CAP[@]+"${FE_CAP[@]}"} || fe_rc=$?
FE_SECS=$(( $(date +%s) - FE_T0 ))
echo "  (frontend vitest ran ${FE_SECS}s${FE_BG_LIVE:+ with a worker cap, beside: $FE_BG_LIVE})"
tg_end
[ "$fe_rc" -eq 0 ] || { tg_recheck_misses frontend frontend/react; echo "frontend vitest FAILED (exit $fe_rc)"; exit "$fe_rc"; }

step "frontend: live-fetch allowlist has no STALE entries (ADR 0661 phase 2)"
if [ "$FE_TG_MODE" = enforce ]; then
  # A stale entry is an allowlisted fetch NO test makes — provable only from a
  # FULL run. Under enforce only a subset ran, so judging here would red every
  # gate. A FULL run judges it: the gate runs the lane full when its last
  # complete full run is > 24 h old (ADR 0880 D5 correction).
  echo "↷ skipped: Tracegate ran a subset of the frontend lane; a full run checks stale entries (one runs in a gate once the last is > 24 h old)."
else
  node "$ROOT/scripts/check-live-fetch-stale.mjs" "$LIVE_FETCH_AUDIT"
  # `full-done --lane frontend` is recorded AFTER the date-bomb sweep, not here
  # (ADR 0918): it licenses the next 24 h of gates to sweep only their selection,
  # so it must mean the WHOLE sweep passed too.
fi
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
      http://127.0.0.1:"$E2E_PORT_BE"/host/openwop-app/test/login \
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
step "deps: npm audit (backend+frontend production; desktop all deps) — high/critical blocking, with expiring exceptions"
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
step "backend: conformance at TARGET MAJOR 2 — background result (ADR 0863 D6)"
bg_lane_join conformance-m2

step "frontend: date-bomb sweep (clock advanced ${OPENWOP_CLOCKSHIFT_DAYS:-365} days)"
# CONFIRM A RED IN ISOLATION (2026-09-29). This second full run of the suite reds
# 1-2 files on unrelated diffs — MEASURED five times, five different files (e.g.
# `CanvasPresentPage.test.tsx`, `e2eLaneWiring.test.ts`), each passing ALONE under
# the same shift and passing un-shifted earlier in the same gate. That is
# cross-file interference inside a 840-file parallel run, not a date bomb, and it
# made `npm run ci` red on work that could not have caused it.
#
# A real date bomb is a property of ONE test and fires deterministically when run
# alone under the shifted clock. So a red here is re-run file-by-file, isolated,
# under the SAME shift, and the gate fails if any file fails again — detection
# is preserved; only interference is filtered. It stays FAIL-CLOSED when no
# failing file can be named (a crash) or when more than 5 files fail (a mass
# failure is not interference).
# The X's must END the template. BSD mktemp (macOS) only substitutes a trailing
# run, so `…XXXXXX.json` was created LITERALLY under that name: every gate on
# the machine shared one file, and a run killed mid-sweep left it behind, after
# which every later gate died here with "mkstemp failed … File exists" — green
# through 3,700 test files and red on a temp name (seen 2026-10-01).
#
# ADR 0918 — THE SWEEP FOLLOWS THE FRONTEND LANE'S SELECTION. Under enforce it
# shifts the clock for the files Tracegate ran (must-run + audit), not all ~1,055.
# A NEW bomb rides a changed test or changed code a test executes, so it is in
# the selection. An UNCHANGED file whose bomb date drifts into the 365-day window
# is caught the day it does: the lane runs FULL in a gate at least once every
# 24 h, and the sweep runs whole with it, ~364 days before the bomb goes off.
SWEEP_ARGS=()
if [ "$FE_TG_MODE" = enforce ]; then SWEEP_ARGS=(${FE_TG_ARGS[@]+"${FE_TG_ARGS[@]}"}); fi
SWEEP_JSON="$(mktemp "${TMPDIR:-/tmp}/owp-clockshift-sweep.XXXXXX")"
if [ "$FE_TG_MODE" = enforce ] && [ "${#SWEEP_ARGS[@]}" -eq 0 ]; then
  echo "date-bomb sweep: Tracegate selected no frontend file at this tree, so there is nothing to shift (the whole sweep runs with the next FULL frontend lane, ≤ 24 h)."
elif [ "$FE_TG_MODE" = enforce ]; then
  echo "date-bomb sweep: the frontend lane's selection — ${#SWEEP_ARGS[@]} file(s); the whole sweep runs with the next FULL lane (ADR 0918)."
fi
if [ "$FE_TG_MODE" = enforce ] && [ "${#SWEEP_ARGS[@]}" -eq 0 ]; then
  :
elif ! ( cd "$ROOT/frontend/react" && OPENWOP_CI_CLOCKSHIFT=1 npm run test -- --reporter=default --reporter=json --outputFile="$SWEEP_JSON" ${SWEEP_ARGS[@]+"${SWEEP_ARGS[@]}"} ); then
  sweep_failed="$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const root = process.argv[2] + "/";
    for (const t of r.testResults ?? []) if (t.status === "failed") console.log(t.name.startsWith(root) ? t.name.slice(root.length) : t.name);
  ' "$SWEEP_JSON" "$ROOT/frontend/react" 2>/dev/null || true)"
  sweep_n="$(printf '%s' "$sweep_failed" | grep -c . || true)"
  if [ "$sweep_n" -eq 0 ] || [ "$sweep_n" -gt 5 ]; then
    echo "date-bomb sweep: ${sweep_n} failing file(s) identified — not confirmable in isolation; failing closed." >&2
    rm -f "$SWEEP_JSON"; exit 1
  fi
  echo "date-bomb sweep: ${sweep_n} file(s) red in the parallel run — confirming each ALONE under the same clock shift:"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ( cd "$ROOT/frontend/react" && OPENWOP_CI_CLOCKSHIFT=1 node node_modules/vitest/vitest.mjs run "$f" > /dev/null 2>&1 ); then
      echo "  interference (passes alone under the shift): $f"
    else
      echo "  CONFIRMED date-bomb / deterministic failure: $f" >&2
      ( cd "$ROOT/frontend/react" && OPENWOP_CI_CLOCKSHIFT=1 node node_modules/vitest/vitest.mjs run "$f" ) || true
      rm -f "$SWEEP_JSON"; exit 1
    fi
  done <<< "$sweep_failed"
fi
rm -f "$SWEEP_JSON"
# The lane AND the whole sweep passed: only now may the next 24 h of gates enforce.
if [ "$FE_TG_MODE" = shadow ]; then node "$TG" full-done --lane frontend || echo "tracegate: full-done failed (ignored)"; fi

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

# ADR 0880 — collect the background Tracegate ingests (they never fail the gate).
step "tracegate: footprints recorded (background result)"
bg_lane_join tracegate-backend
bg_lane_join tracegate-frontend

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
