#!/usr/bin/env bash
#
# Tests for scripts/preflight-suite.sh.
#
# An untested guard is a guard nobody should trust — the same reason
# test-deploy-gates.sh exists. This repo has already shipped FIVE entry guards
# that never ran, two of them merge gates that could not fail, so a detector
# whose passing arm has never been observed does not get to merge.
#
# Both arms assert on the SET of worktrees the detector names, never on a count.
# That matters: a real parallel suite may legitimately be running while these
# tests execute (that is the very condition the script exists for), so a
# count-based assertion would be flaky by construction.
#
#   arm 1  a vitest process in ANOTHER worktree of this repo  -> detected
#   arm 2  a vitest process in THIS worktree (our own run)    -> NOT detected
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PF="$ROOT/scripts/preflight-suite.sh"
TMP="$(mktemp -d)"
FAKE_WT="$TMP/fake-worktree"
declare -a PIDS=()
LAST_PID=""   # macOS ships bash 3.2: no ${arr[-1]}
fails=0

cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "${p:-}" ] && kill "$p" 2>/dev/null; done
  git -C "$ROOT" worktree remove --force "$FAKE_WT" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fails=$((fails + 1)); }

# A stand-in for a vitest parent process: argv must match the detector's pattern
# and it must stay alive with a known cwd. Sleeping node does both.
make_fake_vitest() {
  local wt="$1" bindir="$TMP/nm/node_modules/.bin"
  mkdir -p "$bindir"
  cat > "$bindir/vitest" <<'JS'
setTimeout(() => {}, 600000);
JS
  ( cd "$wt" && exec node "$bindir/vitest" run ) &
  LAST_PID="$!"
  PIDS+=("$LAST_PID")
  # Wait for it to be observable in ps rather than guessing with a fixed sleep.
  for _ in $(seq 1 40); do
    ps -o command= -p "$LAST_PID" 2>/dev/null | grep -q 'bin/vitest run' && return 0
    sleep 0.25
  done
  return 1
}

# H36 — the two NON-vitest shapes a full gate wears: its own parent
# (`bash …/scripts/ci.sh`, alive for every lane) and a Playwright run. Both are
# stand-ins with the matching argv, sleeping with a known cwd.
make_fake_cish() {
  local wt="$1" dir="$TMP/fake-gate/scripts"
  mkdir -p "$dir"
  # Reap the sleep on TERM: an orphaned `sleep 600` holds any pipe this test's
  # stdout is attached to (e.g. `| tail`) open until it exits.
  printf 'sleep 600 & c=$!; trap '"'"'kill $c 2>/dev/null; exit 0'"'"' TERM INT; wait $c\n' > "$dir/ci.sh"
  ( cd "$wt" && exec bash "$dir/ci.sh" ) &
  LAST_PID="$!"; PIDS+=("$LAST_PID")
  for _ in $(seq 1 40); do
    ps -o command= -p "$LAST_PID" 2>/dev/null | grep -q 'scripts/ci.sh' && return 0
    sleep 0.25
  done
  return 1
}
make_fake_playwright() {
  local wt="$1" cli="$TMP/nm/node_modules/@playwright/test/cli.js"
  mkdir -p "$(dirname "$cli")"
  printf 'setTimeout(() => {}, 600000);\n' > "$cli"
  ( cd "$wt" && exec node "$cli" test --grep-invert @serial ) &
  LAST_PID="$!"; PIDS+=("$LAST_PID")
  for _ in $(seq 1 40); do
    ps -o command= -p "$LAST_PID" 2>/dev/null | grep -q 'playwright/test/cli.js test' && return 0
    sleep 0.25
  done
  return 1
}

printf '\n\033[1m▶ test-preflight-suite\033[0m\n'

# --- arm 1: a suite in another worktree of this repo is detected ----------------
git -C "$ROOT" worktree add -q --detach "$FAKE_WT" HEAD 2>/dev/null \
  || { echo "  could not create a scratch worktree; aborting" >&2; exit 2; }

make_fake_vitest "$FAKE_WT" || { bad "fake vitest never became visible in ps"; exit 1; }

out="$("$PF" 2>&1)"; rc=$?
if grep -q "$FAKE_WT" <<<"$out"; then
  ok "detects a suite running in another worktree"
else
  bad "MISSED a suite in another worktree — the guard cannot fire"
  printf '%s\n' "$out" | sed 's/^/      /'
fi
[ "$rc" -eq 0 ] && ok "report mode exits 0 even when contended" \
                || bad "report mode should always exit 0 (got $rc)"

"$PF" --check >/dev/null 2>&1; rc=$?
[ "$rc" -eq 1 ] && ok "--check exits 1 when contended" \
                || bad "--check should exit 1 when contended (got $rc)"

# (the fake worktree stays until the H36 arms below are done with it)

# --- arm 1b/1c (H36): the gate's NON-vitest lanes are competitors too ---------
# A full `npm run ci` is vitest for ~20 min and then a frontend build + Playwright
# for ~8 more; the parent `scripts/ci.sh` is alive throughout. Before H36 the
# detector saw only vitest, and a peer read "clear" while a gate was in its e2e
# lane. Each shape is checked ALONE (the vitest fake is killed first) so a pass
# here cannot be the vitest arm passing twice.
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null
make_fake_cish "$FAKE_WT" || { bad "fake scripts/ci.sh never became visible in ps"; exit 1; }
out="$("$PF" 2>&1)"
if grep -q "$FAKE_WT" <<<"$out"; then
  ok "detects a peer gate by its PARENT scripts/ci.sh (every lane, not just vitest)"
else
  bad "missed a peer scripts/ci.sh in another worktree"; printf '%s\n' "$out" | sed 's/^/      /'
fi
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null
make_fake_playwright "$FAKE_WT" || { bad "fake playwright never became visible in ps"; exit 1; }
out="$("$PF" 2>&1)"
if grep -q "$FAKE_WT" <<<"$out"; then
  ok "detects a peer Playwright run (the gate's e2e lane)"
else
  bad "missed a peer playwright test in another worktree"; printf '%s\n' "$out" | sed 's/^/      /'
fi
# One line per WORKTREE even when a gate is ci.sh + vitest + playwright at once.
make_fake_cish "$FAKE_WT" >/dev/null || true
out="$("$PF" 2>&1)"
n_lines=$(printf '%s' "$out" | grep -c "$FAKE_WT" || true)
[ "$n_lines" -eq 1 ] && ok "reports ONE competitor per worktree, not one per process ($n_lines line)" \
                     || bad "expected 1 line for the fake worktree, got $n_lines"
for p in "${PIDS[@]:-}"; do [ -n "${p:-}" ] && kill "$p" 2>/dev/null; done
for p in "${PIDS[@]:-}"; do [ -n "${p:-}" ] && wait "$p" 2>/dev/null; done
PIDS=()
git -C "$ROOT" worktree remove --force "$FAKE_WT" 2>/dev/null

# --- arm 2: OUR OWN suite is not counted as competition -------------------------
# The self-match is not hypothetical: an earlier version of this detector matched
# its own invoking shell and reported a competitor that did not exist.
make_fake_vitest "$ROOT" || { bad "self fake vitest never became visible in ps"; exit 1; }

out="$("$PF" 2>&1)"
if grep -q "$(cd "$ROOT" && pwd -P)" <<<"$out"; then
  bad "counted OUR OWN worktree's suite as competition (self-match regression)"
  printf '%s\n' "$out" | sed 's/^/      /'
else
  ok "excludes a suite running in this worktree"
fi

# --- arms 4+5: the CLEAR path CLAIMS ONLY WHAT IT SEARCHED -----------------------
# The 2026-09-11 correction. With no competing worktree the script used to print
# "this checkout has the machine to itself" — a claim about the MACHINE derived
# from a search of worktrees of THIS CLONE. It said exactly that at load1 40.85
# and again at 72.27 on a 10-core box, and both times sent a real investigation
# after a code defect that was contention.
#
# Both arms stub `ps` so the detector deterministically finds no competitor —
# otherwise these are unobservable whenever a real suite is running, which is
# precisely when a guard's unseen branch rots. Load is driven through the
# narrow OPENWOP_PREFLIGHT_LOAD1 seam, which feeds the WORDING only.
PSSTUB="$TMP/psstub"; mkdir -p "$PSSTUB"
printf '#!/bin/sh\nexit 0\n' > "$PSSTUB/ps"; chmod +x "$PSSTUB/ps"
CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)

out="$(PATH="$PSSTUB:$PATH" OPENWOP_PREFLIGHT_LOAD1=$((CORES * 8)) "$PF" 2>&1)"
if grep -qi 'machine to itself' <<<"$out"; then
  bad "claims the machine to itself at load1 $((CORES * 8)) on $CORES cores"
  printf '%s\n' "$out" | sed 's/^/      /'
elif grep -q 'BUSY' <<<"$out" && grep -q 'CANNOT SEE' <<<"$out"; then
  ok "high load with no same-repo competitor: names what it did NOT search"
else
  bad "busy branch produced neither the old claim nor the new caveat"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

out="$(PATH="$PSSTUB:$PATH" OPENWOP_PREFLIGHT_LOAD1=0.05 "$PF" 2>&1)"
if grep -q 'load1 0.05' <<<"$out" && grep -q 'agrees' <<<"$out"; then
  ok "genuinely quiet machine: says so, and cites the load it checked"
else
  bad "quiet branch did not corroborate with load"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# The seam must not be able to hide a REAL competitor. Asserted STRUCTURALLY
# rather than by timing: the detector must never read it. A runtime arm here
# would depend on a fake process winning a race, and a test that can pass for
# the wrong reason is how a seam like this turns into a mute button.
if sed -n '/^find_competitors()/,/^}/p' "$PF" | grep -q 'OPENWOP_PREFLIGHT_LOAD1'; then
  bad "find_competitors reads the load seam — it could then be used to hide a real suite"
else
  ok "the load seam is unreachable from competitor detection (structural)"
fi

# --- arm 3: the CLEAR path ------------------------------------------------------
# Only observable when nothing else is really running, so it is opportunistic —
# but it SKIPS OUT LOUD rather than silently, because a branch nobody has ever
# seen execute is precisely where this repo hides its broken guards.
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null
if [ -n "$("$PF" 2>&1 | grep 'competing : none')" ]; then
  "$PF" --check >/dev/null 2>&1 && ok "--check exits 0 when the machine is clear" \
                                || bad "--check should exit 0 when clear"
else
  printf '  \033[33m↷\033[0m SKIPPED the clear-path arm: a real suite from another\n'
  printf '      worktree is running right now, so "no competitors" cannot be\n'
  printf '      observed. Re-run this on a quiet machine to cover it.\n'
fi

printf '\n'
if [ "$fails" -eq 0 ]; then
  printf '\033[32m✓ preflight-suite: all arms pass\033[0m\n\n'
  exit 0
fi
printf '\033[31m✗ preflight-suite: %d assertion(s) failed\033[0m\n\n' "$fails"
exit 1
