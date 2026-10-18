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

# HERMETIC (2026-09-30, #4264 follow-up). ci.sh runs this harness INSIDE the gate,
# so the caller's environment reaches every preflight this file spawns. The
# documented opt-out `OPENWOP_CI_WAIT_FOREIGN=0 npm run ci` therefore switched the
# foreign wait OFF inside the arms that assert it, and the gate's own guard went
# red on a correct script. Scrub every knob of the script under test — and its
# test seams — before anything runs; each arm sets exactly what it needs. The
# harness's own knobs (OPENWOP_PREFLIGHT_TEST_*) are kept.
for v in $(env | grep -oE '^OPENWOP_(CI|PREFLIGHT)_[A-Z0-9_]+' | grep -v '^OPENWOP_PREFLIGHT_TEST_'); do unset "$v"; done
# `--print-env-probe`: print what survived the scrub and stop (the hermetic arm).
if [ "${1:-}" = --print-env-probe ]; then env | grep -E '^OPENWOP_(CI|PREFLIGHT)_' | grep -v '^OPENWOP_PREFLIGHT_TEST_'; exit 0; fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PF="$ROOT/scripts/preflight-suite.sh"
TMP="$(mktemp -d)"
FAKE_WT="$TMP/fake-worktree"
declare -a PIDS=()
LAST_PID=""   # macOS ships bash 3.2: no ${arr[-1]}
fails=0
# GATE-CLAIM-1: this harness runs INSIDE the gate, whose claim lives in the git
# common dir every worktree here shares. No arm may reach it: the default is a
# scratch dir, and an arm that needs a claim names its own.
SAFE_CLAIM="$TMP/claim-default"
export OPENWOP_PREFLIGHT_CLAIM_DIR="$SAFE_CLAIM"

# Kill a process AND all its descendants (a waiter subshell → preflight --ci →
# its own --wait child). `pkill -P` reaches one level only, and an orphaned
# grandchild waiter would poll on for an hour.
kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill "$1" 2>/dev/null; }
cleanup() {
  [ -n "${WATCHDOG:-}" ] && kill_tree "$WATCHDOG"
  for p in "${PIDS[@]:-}"; do [ -n "${p:-}" ] && kill_tree "$p"; done
  git -C "$ROOT" worktree remove --force "$FAKE_WT" 2>/dev/null
  git -C "$ROOT" worktree remove --force "$TMP/claim-worktree" 2>/dev/null
  git -C "$ROOT" worktree remove --force "$TMP/wt2" 2>/dev/null
  git -C "$ROOT" worktree remove --force "$TMP/wt3" 2>/dev/null
  git -C "$ROOT" worktree remove --force "$TMP/wt4" 2>/dev/null
  git -C "$ROOT" worktree remove --force "$TMP/wt5" 2>/dev/null
  [ -n "${TMPWT:-}" ] && git -C "$ROOT" worktree remove --force "$TMPWT" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
# Every dummy process this test spawns without its own `cd` inherits THIS cwd,
# so it is the scratch dir, never the caller's checkout (a run started from the
# shared checkout once left dummies there that peers' detectors could see).
cd "$TMP" || exit 2
# HARD WATCHDOG: the whole file normally takes ~25s; a hang must fail fast and
# loud instead of lingering. A signal alone is NOT enough: bash defers a trap
# until the foreground command returns, and the hang IS a foreground command.
# So the watchdog kills this script's other children first (which unblocks it),
# then signals it. The EXIT trap still reaps everything.
WATCHDOG_S="${OPENWOP_PREFLIGHT_TEST_TIMEOUT_S:-240}"
(
  me="$(sh -c 'echo $PPID')"   # bash 3.2 has no $BASHPID
  sleep "$WATCHDOG_S"
  touch "$TMP/.hung"
  for c in $(pgrep -P $$ 2>/dev/null); do [ "$c" = "$me" ] || kill_tree "$c"; done
  kill -USR1 $$ 2>/dev/null
) >/dev/null 2>&1 &
WATCHDOG=$!
trap 'printf "\n  \033[31m✗ HUNG: test-preflight-suite exceeded %ss — failing\033[0m\n" "$WATCHDOG_S"; exit 1' USR1

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

# --- arm 0: HERMETIC — a caller's opt-out env cannot reach the arms -------------
probe="$(env OPENWOP_CI_WAIT_FOREIGN=0 OPENWOP_CI_WAIT_LOAD_PER_CORE=0 OPENWOP_CI_NO_WAIT=1 \
  OPENWOP_CI_FOREIGN_CPU_FLOOR=0 OPENWOP_PREFLIGHT_LOAD1=99 bash "$ROOT/scripts/test-preflight-suite.sh" --print-env-probe 2>&1)"
if [ -z "$probe" ]; then
  ok "hermetic: a caller's OPENWOP_CI_*/OPENWOP_PREFLIGHT_* opt-outs are scrubbed before any arm"
else
  bad "a caller's env survives into the harness (the #4264 opt-out red):"; printf '%s\n' "$probe" | sed 's/^/      /'
fi

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
# Worktrees of THIS repo share its git common dir wherever they live — here under
# /var/folders (mktemp), a path class #4216 once misread — so they must stay on the
# same-repo competitor path, never be listed as another project's suite.
elsewhere_block() { awk '/^  elsewhere :/{on=1; next} /^  [a-z]/{on=0} on' <<<"$1"; }
if grep -qF "$(cd "$FAKE_WT" && pwd -P)" <<<"$(elsewhere_block "$out")"; then
  bad "a worktree of THIS repo under $(dirname "$TMP") was listed as ANOTHER project"
else
  ok "a worktree of this repo under a temp dir is same-repo, not 'elsewhere'"
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

# --- arm 1d (2026-10-15): a STOPPED suite is reported, never waited on --------
# Slot 95r''' waited 68 min on a peer's SIGSTOPped probe while the probe waited
# on the gate. Asserted by BLOCK, not by exit code: a real peer suite may be
# running while this executes. Then SIGCONT, and the same process must compete
# again, so the arm cannot pass by never seeing the fake at all.
competing_block() { awk '/^  competing :/{on=1; next} /^  [a-z]/{on=0} on' <<<"$1"; }
stopped_block()   { awk '/^  stopped   :/{on=1; next} /^  [a-z]/{on=0} on' <<<"$1"; }
make_fake_vitest "$FAKE_WT" || { bad "fake vitest never became visible in ps"; exit 1; }
STOPPED_PID="$LAST_PID"
kill -STOP "$STOPPED_PID"
for _ in $(seq 1 20); do ps -o stat= -p "$STOPPED_PID" | grep -q T && break; sleep 0.25; done
out="$("$PF" 2>&1)"
if grep -q "$FAKE_WT" <<<"$(competing_block "$out")"; then
  bad "a STOPPED suite is still listed as competing (the 95r''' deadlock)"; printf '%s\n' "$out" | sed 's/^/      /'
else
  ok "a STOPPED suite in another worktree is not a competitor"
fi
if grep -q "$FAKE_WT" <<<"$(stopped_block "$out")"; then
  ok "a STOPPED suite is still reported, on its own 'stopped' line"
else
  bad "a STOPPED suite vanished from the report"; printf '%s\n' "$out" | sed 's/^/      /'
fi
kill -CONT "$STOPPED_PID"
for _ in $(seq 1 20); do ps -o stat= -p "$STOPPED_PID" | grep -q T || break; sleep 0.25; done
out="$("$PF" 2>&1)"
if grep -q "$FAKE_WT" <<<"$(competing_block "$out")"; then
  ok "the same suite, CONTinued, competes again"
else
  bad "a CONTinued suite is not detected"; printf '%s\n' "$out" | sed 's/^/      /'
fi
kill "$STOPPED_PID" 2>/dev/null; wait "$STOPPED_PID" 2>/dev/null
PIDS=()
git -C "$ROOT" worktree remove --force "$FAKE_WT" 2>/dev/null

# The same under /tmp (-> /private/tmp: lsof reports the realpath).
TMPWT="$(mktemp -d /tmp/pf-wt.XXXXXX)"; rmdir "$TMPWT"
if git -C "$ROOT" worktree add -q --detach "$TMPWT" HEAD 2>/dev/null; then
  make_fake_vitest "$TMPWT" >/dev/null || bad "fake vitest in the /tmp worktree never visible"
  out="$("$PF" 2>&1)"
  if grep -q "competing" <<<"$out" && grep -qF "$(basename "$TMPWT")" <<<"$out" \
     && ! grep -qF "$(basename "$TMPWT")" <<<"$(elsewhere_block "$out")"; then
    ok "a worktree of this repo under /tmp is a same-repo competitor, not 'elsewhere'"
  else
    bad "a /tmp worktree of this repo was misread"; printf '%s\n' "$out" | sed 's/^/      /'
  fi
  kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null
  git -C "$ROOT" worktree remove --force "$TMPWT" 2>/dev/null
else
  bad "could not create a /tmp worktree"
fi

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
# Done with it: left alive, it is a real competitor to the OTHER worktrees the
# claim arms below create.
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null

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
CORES=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 8)   # same source as preflight-suite.sh ncpu() (ADR 0863: Linux)

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

# --- GATE-CLAIM-1: a claim is stale only on POSITIVE evidence -------------------
# The arms above run with a `ps` that prints nothing. Before the fix, a live
# claim whose start time could not be read was judged stale and DELETED, and
# inside the gate that claim was the gate's own. A live claimant whose start
# time `ps` cannot report must keep its claim; a live pid whose start time is
# readable and DIFFERENT (a reused pid) must still be recovered.
REG="$TMP/claim-reg"; sleep 300 & LIVE_R=$!; PIDS+=("$LIVE_R")
mkdir -p "$REG"; printf '%s\t%s\t%s\n' "$LIVE_R" "$(/bin/ps -o lstart= -p "$LIVE_R" | sed 's/^ *//;s/ *$//')" "$(cd "$ROOT" && pwd -P)" > "$REG/info"
PATH="$PSSTUB:$PATH" OPENWOP_PREFLIGHT_CLAIM_DIR="$REG" OPENWOP_PREFLIGHT_LOAD1=0.05 "$PF" >/dev/null 2>&1
[ -f "$REG/info" ] && ok "a live claim whose start time ps cannot read is KEPT (not judged stale)" \
                   || bad "a live claim was deleted because ps printed nothing for its claimant"
printf '%s\t%s\t%s\n' "$LIVE_R" "Thu Jan  1 00:00:00 1970" "/elsewhere/peer-worktree" > "$REG/info"
OPENWOP_PREFLIGHT_CLAIM_DIR="$REG" OPENWOP_PREFLIGHT_LOAD1=0.05 "$PF" --check >/dev/null 2>&1
[ ! -d "$REG" ] && ok "...and a live pid with a DIFFERENT start time (reused pid) is still recovered" \
                || bad "a reused pid's claim was not recovered"
kill "$LIVE_R" 2>/dev/null; wait "$LIVE_R" 2>/dev/null; rm -rf "$REG"

# The seam must not be able to hide a REAL competitor. Asserted STRUCTURALLY
# rather than by timing: the detector must never read it. A runtime arm here
# would depend on a fake process winning a race, and a test that can pass for
# the wrong reason is how a seam like this turns into a mute button.
if sed -n '/^find_competitors()/,/^}/p' "$PF" | grep -q 'OPENWOP_PREFLIGHT_LOAD1'; then
  bad "find_competitors reads the load seam — it could then be used to hide a real suite"
else
  ok "the load seam is unreachable from competitor detection (structural)"
fi

# --- arms 6+7: THE CLAIM (2026-09-28) --------------------------------------------
# Two `--wait` loops that clear in the same poll used to BOTH start a suite. Each
# waiter below runs in its own worktree (a copy of THIS script placed in a scratch
# worktree, so the two have distinct identities), against a box made clear by the
# ps stub (the listing only — `ps -p` still answers, for liveness), with the claim
# relocated to a scratch dir so no real peer ever sees a test claim.
CLAIM_TMP="$TMP/claim"
PSSTUB2="$TMP/psstub2"; mkdir -p "$PSSTUB2"
cat > "$PSSTUB2/ps" <<'SH'
#!/bin/sh
case " $* " in *" -Ao "*) exit 0 ;; esac
exec /bin/ps "$@"
SH
chmod +x "$PSSTUB2/ps"
CLAIM_WT="$TMP/claim-worktree"
git -C "$ROOT" worktree add -q --detach "$CLAIM_WT" HEAD 2>/dev/null || { bad "could not create the claim worktree"; }
cp "$PF" "$CLAIM_WT/scripts/preflight-suite.sh"
# A claim's mkdir is visible BEFORE its atomically renamed info. Exercise that
# publication window deterministically, not by hoping two waiters race there.
for info_state in missing empty truncated malformed; do
  rm -rf "$CLAIM_TMP"; mkdir "$CLAIM_TMP"
  case "$info_state" in
    empty) : > "$CLAIM_TMP/info" ;;
    truncated) printf '%s\n' "$$" > "$CLAIM_TMP/info" ;;
    malformed) printf 'not-a-pid\tstarted\t/elsewhere\n' > "$CLAIM_TMP/info" ;;
  esac
  out="$(PATH="$PSSTUB2:$PATH" OPENWOP_PREFLIGHT_CLAIM_DIR="$CLAIM_TMP" "$PF" --check 2>&1)"; rc=$?
  if [ "$rc" -eq 1 ] && [ -d "$CLAIM_TMP" ] && grep -q '(claim being written)' <<<"$out" \
     && ! grep -qE 'unbound variable|No such file or directory' <<<"$out"; then
    ok "young $info_state claim info blocks, without Bash nounset/open errors"
  else
    bad "young $info_state claim did not fail closed (rc=$rc)"; printf '%s\n' "$out" | sed 's/^/      /'
  fi
done
# An interrupted publication must not block forever: preserve the existing
# minute-old empty-claim recovery. Fixed old mtime makes this arm deterministic.
rm -rf "$CLAIM_TMP"; mkdir "$CLAIM_TMP"; touch -t 200001010000 "$CLAIM_TMP"
PATH="$PSSTUB2:$PATH" OPENWOP_PREFLIGHT_CLAIM_DIR="$CLAIM_TMP" "$PF" --check >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && [ ! -d "$CLAIM_TMP" ] && ok "aged unpublished claim is recovered" \
  || bad "aged unpublished claim was not recovered (rc=$rc)"
# A rename failure must not manufacture a successful claim/handoff. Stub only
# mv; process identity, mkdir, tuple creation and the real wait loop still run.
MVSTUB="$TMP/mvstub"; mkdir "$MVSTUB"
printf '#!/bin/sh\nexit 1\n' > "$MVSTUB/mv"; chmod +x "$MVSTUB/mv"
out="$(PATH="$MVSTUB:$PSSTUB2:$PATH" OPENWOP_PREFLIGHT_CLAIM_DIR="$CLAIM_TMP" OPENWOP_PREFLIGHT_POLL_S=1 OPENWOP_PREFLIGHT_JITTER_S=0 "$PF" --wait=1 2>&1)"; rc=$?
if [ "$rc" -eq 1 ] && [ ! -f "$CLAIM_TMP/info" ] && ! grep -q 'clear after' <<<"$out"; then
  ok "failed claim publication refuses a successful handoff"
else
  bad "failed claim publication handed off (rc=$rc)"; printf '%s\n' "$out" | sed 's/^/      /'
fi
rm -rf "$CLAIM_TMP"

# A waiter: the subshell is the CLAIMANT (the process that would run the suite).
# It records that it cleared, then lives until killed, exactly like
# `( preflight --wait && npm run ci )`.
waiter() {
  local pf="$1" tag="$2"
  ( PATH="$PSSTUB2:$PATH" OPENWOP_PREFLIGHT_CLAIM_DIR="$CLAIM_TMP" OPENWOP_PREFLIGHT_POLL_S=1 OPENWOP_PREFLIGHT_JITTER_S=1 \
      "$pf" --wait=60 > "$TMP/$tag.out" 2>&1 && touch "$TMP/$tag.cleared"; sleep 600 ) &
  LAST_PID="$!"; PIDS+=("$LAST_PID")
}
waiter "$PF" A;                              PID_A="$LAST_PID"
waiter "$CLAIM_WT/scripts/preflight-suite.sh" B; PID_B="$LAST_PID"
for _ in $(seq 1 40); do [ -e "$TMP/A.cleared" ] || [ -e "$TMP/B.cleared" ] && break; sleep 0.25; done
sleep 4   # several polls: a second waiter that could proceed would have by now
n_clear=0; [ -e "$TMP/A.cleared" ] && n_clear=$((n_clear + 1)); [ -e "$TMP/B.cleared" ] && n_clear=$((n_clear + 1))
if [ "$n_clear" -eq 1 ]; then
  ok "two concurrent --wait on a clear box: exactly ONE proceeds"
else
  bad "two concurrent --wait: $n_clear proceeded (want exactly 1)"; cat "$TMP/A.out" "$TMP/B.out" 2>/dev/null | sed 's/^/      /'
fi
if [ -e "$TMP/A.cleared" ]; then WIN=$PID_A; LOSER=B; else WIN=$PID_B; LOSER=A; fi
if grep -q 'claimed' "$TMP/$LOSER.out"; then
  ok "the waiting one names the claimant, like a competitor"
else
  bad "the waiting one did not name the claim"; sed 's/^/      /' "$TMP/$LOSER.out"
fi
# The claimant finishes (its suite ends) -> the other proceeds.
kill_tree "$WIN"; wait "$WIN" 2>/dev/null
for _ in $(seq 1 40); do [ -e "$TMP/$LOSER.cleared" ] && break; sleep 0.25; done
[ -e "$TMP/$LOSER.cleared" ] && ok "when the claimant exits, the waiting one proceeds" \
                            || { bad "the waiting one never proceeded after the claimant exited"; sed 's/^/      /' "$TMP/$LOSER.out"; }
for p in "$PID_A" "$PID_B"; do kill_tree "$p"; wait "$p" 2>/dev/null; done
rm -rf "$CLAIM_TMP"

# A STALE claim (its claimant is dead) is recovered, not waited on forever.
( exit 0 ) & DEAD="$!"; wait "$DEAD" 2>/dev/null
mkdir -p "$CLAIM_TMP"; printf '%s\tlong ago\t/elsewhere\n' "$DEAD" > "$CLAIM_TMP/info"
PATH="$PSSTUB2:$PATH" OPENWOP_PREFLIGHT_CLAIM_DIR="$CLAIM_TMP" "$PF" --check >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ ! -d "$CLAIM_TMP" ]; then
  ok "a stale claim (dead claimant) is recovered: --check exits 0 and the claim is gone"
else
  bad "stale claim not recovered (rc=$rc, claim dir $( [ -d "$CLAIM_TMP" ] && echo present || echo gone))"
fi
# ...and a LIVE foreign claim makes --check exit 1 (the polarity of the above).
sleep 600 & LIVE="$!"; PIDS+=("$LIVE")
mkdir -p "$CLAIM_TMP"; printf '%s\t%s\t/elsewhere\n' "$LIVE" "$(/bin/ps -o lstart= -p "$LIVE" | sed 's/^ *//;s/ *$//')" > "$CLAIM_TMP/info"
PATH="$PSSTUB2:$PATH" OPENWOP_PREFLIGHT_CLAIM_DIR="$CLAIM_TMP" "$PF" --check >/dev/null 2>&1; rc=$?
[ "$rc" -eq 1 ] && ok "a live foreign claim makes --check exit 1" || bad "--check ignored a live foreign claim (rc=$rc)"
kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null; rm -rf "$CLAIM_TMP"

# --- arms 8-11: `npm run ci` WAITS BY DEFAULT (`--ci`) --------------------------
export OPENWOP_PREFLIGHT_CLAIM_DIR="$CLAIM_TMP"
# Load pinned low: `--ci` also waits on load1 now (arms 13-14), and these arms test
# the claim, not the box they happen to run on.
CIENV=(env PATH="$PSSTUB2:$PATH" OPENWOP_PREFLIGHT_POLL_S=1 OPENWOP_PREFLIGHT_JITTER_S=1 OPENWOP_PREFLIGHT_LOAD1=0.05)

# 8. the gate's own entry serialises too: two concurrent `--ci`, exactly one proceeds.
rm -f "$TMP"/C.cleared "$TMP"/D.cleared
( "${CIENV[@]}" "$PF" --ci > "$TMP/C.out" 2>&1 && touch "$TMP/C.cleared"; sleep 600 ) & PID_C="$!"; PIDS+=("$PID_C")
( "${CIENV[@]}" "$CLAIM_WT/scripts/preflight-suite.sh" --ci > "$TMP/D.out" 2>&1 && touch "$TMP/D.cleared"; sleep 600 ) & PID_D="$!"; PIDS+=("$PID_D")
for _ in $(seq 1 40); do [ -e "$TMP/C.cleared" ] || [ -e "$TMP/D.cleared" ] && break; sleep 0.25; done
sleep 4
n=0; [ -e "$TMP/C.cleared" ] && n=$((n + 1)); [ -e "$TMP/D.cleared" ] && n=$((n + 1))
[ "$n" -eq 1 ] && ok "--ci: two concurrent gates, exactly ONE proceeds" \
               || { bad "--ci: $n gates proceeded (want 1)"; cat "$TMP/C.out" "$TMP/D.out" | sed 's/^/      /'; }
for p in "$PID_C" "$PID_D"; do kill_tree "$p"; wait "$p" 2>/dev/null; done
rm -rf "$CLAIM_TMP"

# A live FOREIGN claim for the next arms (a claimant in "another worktree").
sleep 600 & HOLDER="$!"; PIDS+=("$HOLDER")
hold_claim() { mkdir -p "$CLAIM_TMP"; printf '%s\t%s\t/elsewhere/peer-worktree\n' "$HOLDER" "$(/bin/ps -o lstart= -p "$HOLDER" | sed 's/^ *//;s/ *$//')" > "$CLAIM_TMP/info"; }

# 9. opt-out: skips the wait, still prints who is there.
hold_claim
# A tiny cap too, so an opt-out that stopped working reads as a red (it would
# wait the cap and print the banner) instead of hanging this test for 90 minutes.
t0=$(date +%s); out="$("${CIENV[@]}" OPENWOP_CI_NO_WAIT=1 OPENWOP_CI_WAIT_MAX_MIN=0.05 "$PF" --ci 2>&1)"; rc=$?; dt=$(( $(date +%s) - t0 ))
if [ "$rc" -eq 0 ] && [ "$dt" -lt 2 ] && grep -q 'OPENWOP_CI_NO_WAIT=1: not waiting' <<<"$out" && grep -q 'peer-worktree' <<<"$out"; then
  ok "OPENWOP_CI_NO_WAIT=1: does not wait, and still names the competitor"
else
  bad "opt-out did not behave (rc=$rc, ${dt}s)"; printf '%s\n' "$out" | sed 's/^/      /'
fi

# 10. the cap: waits, then PROCEEDS (exit 0) under the DEBT-3 banner — never fails.
t0=$(date +%s); out="$("${CIENV[@]}" OPENWOP_CI_WAIT_MAX_MIN=0.05 "$PF" --ci 2>&1)"; rc=$?; dt=$(( $(date +%s) - t0 ))
if [ "$rc" -eq 0 ] && [ "$dt" -ge 2 ] && grep -q 'running CONTENDED (DEBT-3)' <<<"$out" && grep -q 'peer-worktree' <<<"$out"; then
  ok "the wait cap proceeds under the DEBT-3 banner (rc 0 after ${dt}s), naming who it waited on each poll"
else
  bad "the cap did not proceed with the banner (rc=$rc, ${dt}s)"; printf '%s\n' "$out" | sed 's/^/      /'
fi

# 10b. a waiter whose CALLER dies (a killed gate) stops, instead of polling on for
#      an hour and later claiming the machine for a dead pid.
( "${CIENV[@]}" "$PF" --wait=600 > "$TMP/orphan.out" 2>&1 & echo $! > "$TMP/orphan.pid"
  sleep 600 >/dev/null 2>&1 & echo $! > "$TMP/caller-sleep.pid"; wait $! ) & CALLER="$!"
for _ in $(seq 1 20); do [ -s "$TMP/orphan.pid" ] && [ -s "$TMP/caller-sleep.pid" ] && break; sleep 0.25; done
ORPHAN="$(cat "$TMP/orphan.pid")"
kill "$CALLER" 2>/dev/null; wait "$CALLER" 2>/dev/null
kill "$(cat "$TMP/caller-sleep.pid")" 2>/dev/null   # the caller's sleep, NOT the waiter
for _ in $(seq 1 20); do kill -0 "$ORPHAN" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$ORPHAN" 2>/dev/null; then
  bad "a waiter kept polling after its caller died"; kill_tree "$ORPHAN"
else
  grep -q 'has exited; stopping the wait' "$TMP/orphan.out" && ok "a waiter whose caller died stops waiting" \
    || { bad "the orphaned waiter exited without saying why"; sed 's/^/      /' "$TMP/orphan.out"; }
fi
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -rf "$CLAIM_TMP"

# --- --wait-claim (ADR 0863 D8): a full vitest run outside a gate waits for a
#     RUNNING gate's claim, and only for that ---------------------------------
WCENV=(env OPENWOP_PREFLIGHT_POLL_S=1)
# W1. no claim -> starts at once and takes none.
t0=$(date +%s); "${WCENV[@]}" "$PF" --wait-claim=5 >/dev/null 2>&1; rc=$?; dt=$(( $(date +%s) - t0 ))
[ "$rc" -eq 0 ] && [ "$dt" -lt 2 ] && [ ! -d "$CLAIM_TMP" ] && ok "--wait-claim: no claim → starts at once, takes none" \
  || bad "--wait-claim with no claim: rc=$rc ${dt}s claim=$( [ -d "$CLAIM_TMP" ] && echo taken || echo none)"
# W2. a running vitest in ANOTHER worktree, and no claim -> still starts at once.
#     Waiting on processes would deadlock two waiting suites (each IS one).
if make_fake_vitest "$CLAIM_WT"; then
  FV="$LAST_PID"
  t0=$(date +%s); "${WCENV[@]}" "$PF" --wait-claim=5 >/dev/null 2>&1; rc=$?; dt=$(( $(date +%s) - t0 ))
  [ "$rc" -eq 0 ] && [ "$dt" -lt 2 ] && ok "--wait-claim ignores a peer's running vitest (claim only: two waiters cannot deadlock)" \
    || bad "--wait-claim waited on a process, not a claim (rc=$rc ${dt}s)"
  kill_tree "$FV"; wait "$FV" 2>/dev/null
else
  bad "fake vitest never became visible (W2 tests nothing)"
fi
sleep 600 & HOLDER="$!"; PIDS+=("$HOLDER")
# W3. a live foreign claim -> waits, names it, gives up at the cap with exit 1, and
#     leaves the gate's claim exactly as it was.
hold_claim; before="$(cat "$CLAIM_TMP/info")"
t0=$(date +%s); out="$("${WCENV[@]}" "$PF" --wait-claim=2 2>&1)"; rc=$?; dt=$(( $(date +%s) - t0 ))
if [ "$rc" -eq 1 ] && [ "$dt" -ge 2 ] && grep -q 'peer-worktree' <<<"$out" && grep -q 'NOT evidence' <<<"$out" \
   && [ "$(cat "$CLAIM_TMP/info" 2>/dev/null)" = "$before" ]; then
  ok "--wait-claim waits on a live gate's claim, names it, and gives up at the cap (rc 1) without touching it"
else
  bad "--wait-claim on a live claim: rc=$rc ${dt}s"; printf '%s\n' "$out" | sed 's/^/      /'
fi
# W4. the gate ends (its claimant exits) -> the waiting suite starts.
( "${WCENV[@]}" "$PF" --wait-claim=30 > "$TMP/wc.out" 2>&1; echo "rc=$?" >> "$TMP/wc.out" ) & WC="$!"
sleep 2; kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
for _ in $(seq 1 20); do kill -0 "$WC" 2>/dev/null || break; sleep 0.5; done
if grep -q '^rc=0' "$TMP/wc.out" && grep -q 'the gate finished' "$TMP/wc.out"; then
  ok "--wait-claim: when the gate exits, the waiting suite starts"
else
  bad "--wait-claim did not start after the gate exited"; sed 's/^/      /' "$TMP/wc.out"; kill_tree "$WC"
fi
rm -rf "$CLAIM_TMP"
# W5. a claim held by THIS worktree (the gate's own vitest) never waits.
sleep 600 & OWN="$!"; PIDS+=("$OWN")
mkdir -p "$CLAIM_TMP"; printf '%s\t%s\t%s\n' "$OWN" "$(/bin/ps -o lstart= -p "$OWN" | sed 's/^ *//;s/ *$//')" "$(cd "$ROOT" && pwd -P)" > "$CLAIM_TMP/info"
t0=$(date +%s); "${WCENV[@]}" "$PF" --wait-claim=5 >/dev/null 2>&1; rc=$?; dt=$(( $(date +%s) - t0 ))
[ "$rc" -eq 0 ] && [ "$dt" -lt 2 ] && [ -d "$CLAIM_TMP" ] && ok "--wait-claim: our own worktree's claim never blocks (and is left alone)" \
  || bad "--wait-claim blocked on or dropped our own claim (rc=$rc ${dt}s)"
kill "$OWN" 2>/dev/null; wait "$OWN" 2>/dev/null; rm -rf "$CLAIM_TMP"

# A MINI GATE: a stand-in `scripts/ci.sh` built from the REAL ci.sh's own entry
# block (the exec into the wait) and its trap lines — extracted, never retyped —
# beside a copy of this preflight script. After the wait it marks itself cleared
# and then: exits 0, exits 3 ("fail"), or stays running ("hang"), like a suite.
MARKS="$TMP/marks"; mkdir -p "$MARKS"
ENTRY="$(sed -n '/^if \[ -z "\${OPENWOP_CI_PREFLIGHT_DONE:-}" \]; then/,/^fi$/p' "$ROOT/scripts/ci.sh")"
TRAPS="$(grep -E "^trap '" "$ROOT/scripts/ci.sh")"
[ -n "$ENTRY" ] || bad "could not extract ci.sh's wait entry block (the arms below would test nothing)"
make_gate() { # make_gate <dir> <tag>
  mkdir -p "$1/scripts"; cp "$PF" "$1/scripts/preflight-suite.sh"
  cat > "$1/scripts/ci.sh" <<SH
ROOT="\$(cd "\$(dirname "\$0")/.." && pwd)"
$ENTRY
ci_load_note() { :; }
$TRAPS
[ -d "\${OPENWOP_PREFLIGHT_CLAIM_DIR:-/nonexistent}" ] && touch "$MARKS/$2.claimed"
touch "$MARKS/$2.cleared"
case "\${1:-}" in
  hang) sleep 600 >/dev/null 2>&1 & echo \$! > "$MARKS/$2.sleep"; wait \$! ;;
  fail) exit 3 ;;
esac
exit 0
SH
}
# The running process ENV must not leak the parent gate's "already waited" flag
# into the mini gates (this test runs inside `npm run ci`).
unset OPENWOP_CI_PREFLIGHT_DONE

# 11. ci.sh RELEASES the claim however it ends: a non-zero exit, and a TERM mid-run.
make_gate "$TMP/gateR" R
rm -f "$MARKS"/R.*
"${CIENV[@]}" bash "$TMP/gateR/scripts/ci.sh" fail >/dev/null 2>&1; rc=$?
if [ -e "$MARKS/R.claimed" ] && [ "$rc" -eq 3 ] && [ ! -d "$CLAIM_TMP" ]; then
  ok "a gate that exits NON-ZERO releases its claim (it held one while running)"
else
  bad "claim not released on a non-zero exit (claimed=$( [ -e "$MARKS/R.claimed" ] && echo y || echo n ), rc=$rc, claim $( [ -d "$CLAIM_TMP" ] && echo present || echo gone))"
fi
rm -f "$MARKS"/R.*
"${CIENV[@]}" bash "$TMP/gateR/scripts/ci.sh" hang >/dev/null 2>&1 & MINI="$!"
for _ in $(seq 1 40); do [ -e "$MARKS/R.cleared" ] && break; sleep 0.25; done
kill -TERM "$MINI" 2>/dev/null; wait "$MINI" 2>/dev/null
kill "$(cat "$MARKS/R.sleep" 2>/dev/null)" 2>/dev/null   # its "suite", or it holds our stdout
sleep 0.5
[ -e "$MARKS/R.claimed" ] && [ ! -d "$CLAIM_TMP" ] && ok "a gate killed with TERM (Ctrl-C's path) releases its claim" \
                                                   || bad "claim not released on TERM (claim $( [ -d "$CLAIM_TMP" ] && echo present || echo gone))"
rm -rf "$CLAIM_TMP"

# 12. NO DEADLOCK, and a WAITING gate is invisible (2026-09-28). The first cut
#     waited INSIDE ci.sh, so every waiting gate was a `scripts/ci.sh` process and
#     matched the detector: two waiting gates each saw the other as a running suite
#     and waited until the cap, and the previous detector (still on other
#     checkouts) saw a waiting gate as a started one. Real detection here — the
#     ps stub only SCOPES the listing to this test's own processes, so a real
#     suite elsewhere on the box cannot make the arm wait.
PSSCOPE="$TMP/psscope"; mkdir -p "$PSSCOPE"
cat > "$PSSCOPE/ps" <<SH
#!/bin/sh
case " \$* " in *" -Ao "*) /bin/ps "\$@" | grep -F "$TMP" ;; *) exec /bin/ps "\$@" ;; esac
SH
chmod +x "$PSSCOPE/ps"
WT2="$TMP/wt2"; WT3="$TMP/wt3"
git -C "$ROOT" worktree add -q --detach "$WT2" HEAD 2>/dev/null
git -C "$ROOT" worktree add -q --detach "$WT3" HEAD 2>/dev/null
make_gate "$CLAIM_WT" G1; make_gate "$WT2" G2
# The detector as it was BEFORE this change, pinned: another checkout may still run it.
OLD_PF_REV=e5ce04647
if git -C "$ROOT" show "$OLD_PF_REV:scripts/preflight-suite.sh" > "$WT3/scripts/preflight-suite.old.sh" 2>/dev/null; then HAVE_OLD=1; else HAVE_OLD=0; fi
cp "$PF" "$WT3/scripts/preflight-suite.sh"
# CPU floor 0: the stub suites below SLEEP; arm 15 tests the floor itself.
GENV=(env PATH="$PSSCOPE:$PATH" OPENWOP_PREFLIGHT_POLL_S=1 OPENWOP_PREFLIGHT_JITTER_S=1 OPENWOP_CI_WAIT_MAX_MIN=0.5 OPENWOP_PREFLIGHT_LOAD1=0.05 OPENWOP_CI_FOREIGN_CPU_FLOOR=0)
sleep 600 & HOLDER="$!"; PIDS+=("$HOLDER"); hold_claim
rm -f "$MARKS"/G1.* "$MARKS"/G2.*
( cd "$CLAIM_WT" && "${GENV[@]}" bash "$CLAIM_WT/scripts/ci.sh" hang > "$TMP/G1.out" 2>&1 ) & G1="$!"; PIDS+=("$G1")
( cd "$WT2" && "${GENV[@]}" bash "$WT2/scripts/ci.sh" hang > "$TMP/G2.out" 2>&1 ) & G2="$!"; PIDS+=("$G2")
sleep 3   # both are now WAITING, behind the held claim
if [ ! -e "$MARKS/G1.cleared" ] && [ ! -e "$MARKS/G2.cleared" ]; then
  new_out="$(cd "$WT3" && "${GENV[@]}" bash "$WT3/scripts/preflight-suite.sh" --check 2>&1)"; new_rc=$?
  if [ "$new_rc" -eq 1 ] && grep -q 'claimed' <<<"$new_out" && ! grep -qF "$CLAIM_WT" <<<"$new_out" && ! grep -qF "$WT2" <<<"$new_out"; then
    ok "two WAITING gates are invisible to the detector; only the held claim is seen"
  else
    bad "a WAITING gate was seen as a running suite (or the claim was missed)"; printf '%s\n' "$new_out" | sed 's/^/      /'
  fi
  if [ "$HAVE_OLD" = 1 ]; then
    old_out="$(cd "$WT3" && "${GENV[@]}" bash "$WT3/scripts/preflight-suite.old.sh" --check 2>&1)"; old_rc=$?
    if [ "$old_rc" -eq 0 ]; then ok "the PREVIOUS detector ($OLD_PF_REV) does not mistake a waiting gate for a started one"
    else bad "the previous detector sees a WAITING gate as a running suite"; printf '%s\n' "$old_out" | sed 's/^/      /'; fi
  else
    printf '  \033[33m↷\033[0m SKIPPED the previous-detector arm: %s is not in this clone\n' "$OLD_PF_REV"
  fi
else
  bad "a gate proceeded past a live foreign claim"
fi
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null   # the claim holder finishes
for _ in $(seq 1 40); do [ -e "$MARKS/G1.cleared" ] || [ -e "$MARKS/G2.cleared" ] && break; sleep 0.25; done
sleep 4   # a deadlock would show as NEITHER proceeding; a race as BOTH
n=0; [ -e "$MARKS/G1.cleared" ] && n=$((n + 1)); [ -e "$MARKS/G2.cleared" ] && n=$((n + 1))
if [ "$n" -eq 1 ]; then
  ok "two gates, both waiting: exactly ONE proceeds as soon as the box clears (no deadlock)"
else
  bad "two waiting gates: $n proceeded (0 = deadlocked on each other, 2 = raced)"; sed 's/^/      /' "$TMP/G1.out" "$TMP/G2.out" | tail -30
fi
if [ -e "$MARKS/G1.cleared" ]; then W=G1; L=G2; WP=$G1; else W=G2; L=G1; WP=$G2; fi
# The winner's suite ends -> the loser proceeds.
kill "$(cat "$MARKS/$W.sleep" 2>/dev/null)" 2>/dev/null; wait "$WP" 2>/dev/null
for _ in $(seq 1 40); do [ -e "$MARKS/$L.cleared" ] && break; sleep 0.25; done
[ -e "$MARKS/$L.cleared" ] && ok "when the first gate finishes, the second proceeds" \
                          || { bad "the second gate never proceeded"; sed 's/^/      /' "$TMP/$L.out" | tail -15; }
for g in "$G1" "$G2"; do kill_tree "$g"; wait "$g" 2>/dev/null; done
kill "$(cat "$MARKS/G1.sleep" 2>/dev/null)" "$(cat "$MARKS/G2.sleep" 2>/dev/null)" 2>/dev/null
git -C "$ROOT" worktree remove --force "$WT2" 2>/dev/null; git -C "$ROOT" worktree remove --force "$WT3" 2>/dev/null
rm -rf "$CLAIM_TMP"
git -C "$ROOT" worktree remove --force "$CLAIM_WT" 2>/dev/null

# --- arms 13-14: `--ci` ALSO WAITS ON THE MACHINE (2026-09-29) -----------------
# Another PROJECT's vitest fleet (myndhyve-sec, 12 workers) drove load1 to 230 and
# reddened a gate here on timeouts, invisibly. Two gates in two worktrees of this
# repo (G4, G5), a stub suite in a separate git repo, and the load through the
# re-read file seam. What each arm must prove is that the new waits can only
# DELAY: a waiter blocked on them holds no claim, never claims for them, and
# proceeds the moment they clear, whichever order the claim and they resolve in.
WT4="$TMP/wt4"; WT5="$TMP/wt5"
git -C "$ROOT" worktree add -q --detach "$WT4" HEAD 2>/dev/null
git -C "$ROOT" worktree add -q --detach "$WT5" HEAD 2>/dev/null
make_gate "$WT4" G4; make_gate "$WT5" G5
FOREIGN="$TMP/foreign-project"; mkdir -p "$FOREIGN"; git -C "$FOREIGN" init -q
FENV=("${GENV[@]}" OPENWOP_CI_WAIT_MAX_MIN=2)
claim_holder() { cut -f1 "$CLAIM_TMP/info" 2>/dev/null; }
rm -rf "$CLAIM_TMP" "$MARKS"/G4.* "$MARKS"/G5.*

# 13a. report mode NAMES another project's suite; --check's verdict is unchanged.
make_fake_vitest "$FOREIGN" || bad "fake foreign vitest never became visible in ps"
FV="$LAST_PID"
out="$(cd "$WT5" && "${GENV[@]}" bash "$WT5/scripts/preflight-suite.sh" 2>&1)"
if grep -q 'elsewhere : 1 suite' <<<"$out" && grep -q 'foreign-project' <<<"$out"; then
  ok "names a suite from ANOTHER project by its repo path"
else
  bad "another project's suite was not named"; printf '%s\n' "$out" | sed 's/^/      /'
fi
(cd "$WT5" && "${GENV[@]}" bash "$WT5/scripts/preflight-suite.sh" --check >/dev/null 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "--check still counts this repo only (a foreign suite is reported, not a verdict)" \
                || bad "--check changed verdict on a foreign suite (rc=$rc)"

# 13b. foreign suite AND a live same-repo claim: the gate waits on both, claims for
#      neither, and proceeds only when both are gone — claim first, then foreign.
sleep 600 & HOLDER="$!"; PIDS+=("$HOLDER"); hold_claim
( cd "$WT4" && "${FENV[@]}" bash "$WT4/scripts/ci.sh" hang > "$TMP/G4.out" 2>&1 ) & G4="$!"; PIDS+=("$G4")
sleep 3
[ ! -e "$MARKS/G4.cleared" ] && grep -q 'foreign-project' "$TMP/G4.out" && grep -q 'claimed' "$TMP/G4.out" \
  && ok "a gate waits behind a foreign suite AND a held claim, naming both" \
  || { bad "the gate did not wait on both (or did not name them)"; sed 's/^/      /' "$TMP/G4.out" | tail -15; }
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
sleep 3
if [ ! -e "$MARKS/G4.cleared" ] && [ ! -d "$CLAIM_TMP" ]; then
  ok "claim released, foreign suite still running: still waits, and takes NO claim meanwhile"
else
  bad "proceeded past a foreign suite, or claimed while waiting on it (cleared=$( [ -e "$MARKS/G4.cleared" ] && echo y || echo n ), claim=$(claim_holder))"
fi
grep -q 'another project is running (--wait-foreign)' "$TMP/G4.out" && ok "says it is waiting on ANOTHER project, not this repo" \
                                                              || bad "the foreign wait was not named in the poll"
kill "$FV" 2>/dev/null; wait "$FV" 2>/dev/null
for _ in $(seq 1 40); do [ -e "$MARKS/G4.cleared" ] && break; sleep 0.25; done
[ -e "$MARKS/G4.cleared" ] && ok "the foreign suite ends -> the gate proceeds (no deadlock)" \
                           || { bad "the gate never proceeded after the foreign suite ended"; sed 's/^/      /' "$TMP/G4.out" | tail -10; }

# 13c. the other order: G4 now HOLDS the claim and a foreign suite starts. G4 is
#      not re-blocked (it already passed); G5 waits on both and proceeds when both end.
make_fake_vitest "$FOREIGN" >/dev/null || bad "second fake foreign vitest never visible"; FV="$LAST_PID"
[ -d "$CLAIM_TMP" ] || bad "G4 is running without its claim"
( cd "$WT5" && "${FENV[@]}" bash "$WT5/scripts/ci.sh" hang > "$TMP/G5.out" 2>&1 ) & G5="$!"; PIDS+=("$G5")
sleep 3
[ ! -e "$MARKS/G5.cleared" ] && ok "a second gate waits behind the claim holder + a foreign suite" \
                             || bad "a second gate proceeded past a held claim"
kill "$(cat "$MARKS/G4.sleep" 2>/dev/null)" 2>/dev/null; wait "$G4" 2>/dev/null
kill "$FV" 2>/dev/null; wait "$FV" 2>/dev/null
for _ in $(seq 1 40); do [ -e "$MARKS/G5.cleared" ] && break; sleep 0.25; done
[ -e "$MARKS/G5.cleared" ] && ok "claim holder and foreign suite both end -> the second gate proceeds" \
                           || { bad "the second gate never proceeded"; sed 's/^/      /' "$TMP/G5.out" | tail -10; }
kill "$(cat "$MARKS/G5.sleep" 2>/dev/null)" 2>/dev/null; wait "$G5" 2>/dev/null
rm -rf "$CLAIM_TMP" "$MARKS"/G4.* "$MARKS"/G5.*

# 13d. opt-out: OPENWOP_CI_WAIT_FOREIGN=0 does not wait on it (it still prints).
make_fake_vitest "$FOREIGN" >/dev/null || bad "third fake foreign vitest never visible"; FV="$LAST_PID"
t0=$(date +%s); out="$(cd "$WT4" && "${FENV[@]}" OPENWOP_CI_WAIT_FOREIGN=0 bash "$WT4/scripts/preflight-suite.sh" --ci 2>&1)"; rc=$?; dt=$(( $(date +%s) - t0 ))
[ "$rc" -eq 0 ] && [ "$dt" -lt 8 ] && grep -q 'foreign-project' <<<"$out" \
  && ok "OPENWOP_CI_WAIT_FOREIGN=0: proceeds, still naming the foreign suite (${dt}s)" \
  || { bad "the foreign opt-out did not behave (rc=$rc, ${dt}s)"; printf '%s\n' "$out" | sed 's/^/      /' | tail -10; }
kill "$FV" 2>/dev/null; wait "$FV" 2>/dev/null
rm -rf "$CLAIM_TMP"

# 14. LOAD: wait while load1 >= 1.5 x cores, holding NO claim; proceed as it drops.
LOADF="$TMP/load1"; echo $((CORES * 3)) > "$LOADF"
LENV=("${FENV[@]}" OPENWOP_PREFLIGHT_LOAD1_FILE="$LOADF")
# A queued peer of this repo behind a RUNNING gate (whose suite is what drives the
# load) waits on the CLAIM: the load wait is only reached once this repo is clear.
sleep 600 & HOLDER="$!"; PIDS+=("$HOLDER"); hold_claim
out="$(cd "$WT4" && "${LENV[@]}" OPENWOP_CI_WAIT_MAX_MIN=0.05 bash "$WT4/scripts/preflight-suite.sh" --ci 2>&1)"
grep -q 'claimed' <<<"$out" && ! grep -q 'is not below' <<<"$out" \
  && ok "high load behind a held claim: the peer waits on the CLAIM, never on load" \
  || { bad "a queued peer waited on load instead of the claim"; printf '%s\n' "$out" | sed 's/^/      /' | tail -8; }
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -rf "$CLAIM_TMP"
( cd "$WT4" && "${LENV[@]}" bash "$WT4/scripts/ci.sh" hang > "$TMP/G4.out" 2>&1 ) & G4="$!"; PIDS+=("$G4")
sleep 3
if [ ! -e "$MARKS/G4.cleared" ] && [ ! -d "$CLAIM_TMP" ] && grep -q 'is not below' "$TMP/G4.out"; then
  ok "load1 $((CORES * 3)) on $CORES cores: the gate waits, and holds NO claim while it does"
else
  bad "high load: proceeded, or claimed while waiting (cleared=$( [ -e "$MARKS/G4.cleared" ] && echo y || echo n ), claim=$(claim_holder))"
  sed 's/^/      /' "$TMP/G4.out" | tail -10
fi
(cd "$WT5" && "${GENV[@]}" bash "$WT5/scripts/preflight-suite.sh" --check >/dev/null 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "a load-blocked waiter is invisible to a peer (it cannot deadlock one)" \
                || bad "a peer saw a load-blocked waiter as a competitor (rc=$rc)"
echo 0.5 > "$LOADF"
for _ in $(seq 1 40); do [ -e "$MARKS/G4.cleared" ] && break; sleep 0.25; done
[ -e "$MARKS/G4.cleared" ] && ok "load drops -> the gate proceeds and claims" \
                           || { bad "the gate never proceeded after the load dropped"; sed 's/^/      /' "$TMP/G4.out" | tail -10; }
kill "$(cat "$MARKS/G4.sleep" 2>/dev/null)" 2>/dev/null; wait "$G4" 2>/dev/null
rm -rf "$CLAIM_TMP" "$MARKS"/G4.*
echo $((CORES * 3)) > "$LOADF"
t0=$(date +%s); out="$(cd "$WT4" && "${LENV[@]}" OPENWOP_CI_WAIT_LOAD_PER_CORE=0 bash "$WT4/scripts/preflight-suite.sh" --ci 2>&1)"; rc=$?; dt=$(( $(date +%s) - t0 ))
[ "$rc" -eq 0 ] && [ "$dt" -lt 8 ] && ok "OPENWOP_CI_WAIT_LOAD_PER_CORE=0: does not wait on load (${dt}s)" \
                                   || { bad "the load opt-out did not behave (rc=$rc, ${dt}s)"; printf '%s\n' "$out" | sed 's/^/      /' | tail -8; }
rm -rf "$CLAIM_TMP"
t0=$(date +%s); out="$(cd "$WT4" && "${LENV[@]}" OPENWOP_CI_WAIT_MAX_MIN=0.05 bash "$WT4/scripts/preflight-suite.sh" --ci 2>&1)"; rc=$?; dt=$(( $(date +%s) - t0 ))
[ "$rc" -eq 0 ] && grep -q 'running CONTENDED (DEBT-3)' <<<"$out" \
  && ok "load that never drops: proceeds at the cap under the DEBT-3 banner (rc 0, ${dt}s) — never fails" \
  || { bad "the load cap did not proceed with the banner (rc=$rc)"; printf '%s\n' "$out" | sed 's/^/      /' | tail -8; }
rm -rf "$CLAIM_TMP"

# --- arm 15: only BUSY foreign suites count (2026-09-30) ------------------------
# 22 idle `vitest` watchers in one project (~5% CPU each) held gates for the whole
# cap. Three stand-ins in the foreign repo, each checked ALONE, at the DEFAULT floor:
# an idle `vitest run`, a watch-mode `vitest --config x` (no run), a busy `vitest run`.
# GENV without its floor-0 override: the DEFAULT floor is what is under test.
DENV=(env PATH="$PSSCOPE:$PATH" OPENWOP_PREFLIGHT_POLL_S=1 OPENWOP_PREFLIGHT_JITTER_S=1 OPENWOP_CI_WAIT_MAX_MIN=0.5 OPENWOP_PREFLIGHT_LOAD1=0.05)
foreign_block() { awk '/^  elsewhere :/{on=1; next} /^  [a-z]/{on=0} on' <<<"$1"; }
make_foreign_at() { # make_foreign_at <script path> <script-body> <args…> — node, cwd in the foreign repo
  local f="$1" body="$2"; shift 2
  mkdir -p "$(dirname "$f")"; printf '%s\n' "$body" > "$f"
  ( cd "$FOREIGN" && exec node "$f" "$@" ) &
  LAST_PID="$!"; PIDS+=("$LAST_PID")
  for _ in $(seq 1 40); do ps -o command= -p "$LAST_PID" 2>/dev/null | grep -qF "$f" && return 0; sleep 0.25; done
  return 1
}
make_foreign() { make_foreign_at "$TMP/nm/node_modules/.bin/vitest" "$@"; }
IDLE='setTimeout(() => {}, 600000);'
make_foreign "$IDLE" run || bad "idle foreign stub never visible"
# Linux procps `pcpu` is CPU time over the WHOLE lifetime, not macOS's decaying
# average. So a node stub sampled within a second of starting still reads its
# ~100 ms of startup as 20–40%, which is "busy". Let it settle first (ADR 0863:
# hosted CI or an adopter runs this on Linux).
[ -r /proc/loadavg ] && sleep 4
out="$(cd "$WT5" && "${DENV[@]}" bash "$WT5/scripts/preflight-suite.sh" 2>&1)"
[ -z "$(foreign_block "$out")" ] && ok "an IDLE foreign \`vitest run\` (below the CPU floor) is not waited on" \
                                 || { bad "an idle foreign suite was listed"; printf '%s\n' "$out" | sed 's/^/      /' | tail -8; }
t0=$(date +%s); out="$(cd "$WT4" && "${DENV[@]}" OPENWOP_CI_WAIT_MAX_MIN=1 bash "$WT4/scripts/preflight-suite.sh" --ci 2>&1)"; rc=$?; dt=$(( $(date +%s) - t0 ))
[ "$rc" -eq 0 ] && [ "$dt" -lt 8 ] && ok "...and --ci proceeds past it at once (${dt}s)" \
                                   || { bad "--ci waited on an idle foreign suite (rc=$rc, ${dt}s)"; printf '%s\n' "$out" | sed 's/^/      /' | tail -6; }
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null; rm -rf "$CLAIM_TMP"
make_foreign "$IDLE" --config x || bad "watch-mode foreign stub never visible"
out="$(cd "$WT5" && "${GENV[@]}" bash "$WT5/scripts/preflight-suite.sh" 2>&1)"   # floor 0: only the ARGV can exclude it
[ -z "$(foreign_block "$out")" ] && ok "a foreign \`vitest --config x\` (watch mode: no run) is never counted, even at floor 0" \
                                 || { bad "a watch-mode vitest was counted"; printf '%s\n' "$out" | sed 's/^/      /' | tail -8; }
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null
make_foreign 'const end = Date.now() + 60000; while (Date.now() < end) {}' run || bad "busy foreign stub never visible"
BUSY="$LAST_PID"; seen=0
for _ in $(seq 1 30); do   # ps's %CPU is a decaying average: give it time to climb
  out="$(cd "$WT5" && "${DENV[@]}" bash "$WT5/scripts/preflight-suite.sh" 2>&1)"
  grep -q 'foreign-project' <<<"$(foreign_block "$out")" && { seen=1; break; }
  sleep 0.5
done
[ "$seen" = 1 ] && ok "a BUSY foreign \`vitest run\` crosses the default floor and is waited on" \
                || { bad "a busy foreign suite was never counted"; printf '%s\n' "$out" | sed 's/^/      /' | tail -8; }
kill "$BUSY" 2>/dev/null; wait "$BUSY" 2>/dev/null

# --- arm 16: the Playwright TEST RUNNER only, never the bare word ---------------
# ce's correction: the "22 idle watchers" were Playwright-MCP Chrome helpers,
# matched on "playwright" in their argv. At floor 0 (so only the ARGV decides),
# an MCP-style browser and an MCP server are NOT suites; the runner is.
listed() { out="$(cd "$WT5" && "${GENV[@]}" bash "$WT5/scripts/preflight-suite.sh" 2>&1)"; grep -q 'foreign-project' <<<"$(foreign_block "$out")"; }
make_foreign_at "$TMP/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium" "$IDLE" \
  --user-data-dir="$TMP/.playwright-mcp/profile" --remote-debugging-pipe --test-type || bad "MCP-style browser stub never visible"
if listed; then bad "a Playwright-MCP-style browser (argv carries 'playwright') was counted as a suite"; printf '%s\n' "$out" | sed 's/^/      /' | tail -6
else ok "a Playwright-MCP-style browser process is NOT a suite (the bare word does not match)"; fi
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null
make_foreign_at "$TMP/nm/node_modules/@playwright/mcp/cli.js" "$IDLE" --browser chrome || bad "MCP server stub never visible"
if listed; then bad "the Playwright MCP server was counted as a suite"; printf '%s\n' "$out" | sed 's/^/      /' | tail -6
else ok "the Playwright MCP server is NOT a suite"; fi
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null
make_foreign_at "$TMP/nm/node_modules/@playwright/test/cli.js" "$IDLE" test --reporter=line || bad "playwright runner stub never visible"
if listed; then ok "the Playwright test RUNNER (@playwright/test cli.js test) is counted"
else bad "the Playwright test runner was not counted at floor 0"; printf '%s\n' "$out" | sed 's/^/      /' | tail -6; fi
out="$(cd "$WT5" && "${DENV[@]}" bash "$WT5/scripts/preflight-suite.sh" 2>&1)"
[ -z "$(foreign_block "$out")" ] && ok "...and an IDLE runner is below the default CPU floor: not counted" \
                                 || { bad "an idle Playwright runner was counted at the default floor"; printf '%s\n' "$out" | sed 's/^/      /' | tail -6; }
kill "$LAST_PID" 2>/dev/null; wait "$LAST_PID" 2>/dev/null
rm -rf "$CLAIM_TMP"; export OPENWOP_PREFLIGHT_CLAIM_DIR="$SAFE_CLAIM"
git -C "$ROOT" worktree remove --force "$WT4" 2>/dev/null; git -C "$ROOT" worktree remove --force "$WT5" 2>/dev/null

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
