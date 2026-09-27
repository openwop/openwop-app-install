#!/usr/bin/env bash
#
# preflight-suite — refuse to start a test suite into a machine that is already
# running one from another checkout of this repo.
#
# WHY THIS EXISTS (measured 2026-08-10, not theorised)
#
# CLAUDE.md has told us for weeks to "avoid running two full backend suites
# concurrently ... serialise for speed and signal quality". Nothing enforced it,
# and nothing made a violation VISIBLE — a parallel session's fleet is invisible
# from inside your own session unless you go looking with `ps`. So the rule was
# broken routinely and silently, including by me.
#
# What that costs, measured on this machine (10 cores / 32 GB):
#
#   ONE backend vitest fleet          free RAM floor 57 MB, macOS compressor
#                                     +4.46 GB (peak 9.59 GB), 67,614 swapins /
#                                     39,209 swapouts in 11 minutes, load1 24.5
#   FOUR concurrent fleets            load1 120-144, compressor 9.3 GB, 27 forked
#     (2 peer + 2 mine, observed)     workers competing for 10 cores
#
# A single suite already leaves the machine with essentially no memory headroom.
# A second one has to fork fresh node heaps into that, which is exactly the
# documented failure signature: "Failed to start forks worker ... Timeout waiting
# for worker to respond" — a worker that missed its startup budget, not a failed
# assertion.
#
# THE REAL DAMAGE IS TO THE SIGNAL, NOT THE CLOCK. Three weeks of flake
# hypotheses (worker cap; external load; concurrent suites) were each tested
# WITHOUT observing what other sessions were doing, so no result could replicate
# — the controlling variable was never held. A red run under contention is not
# evidence, and neither is a green one. This script's job is to make the
# condition observable BEFORE a run, so a result can be trusted afterwards.
#
# It is deliberately advisory-by-default: it prints and exits 0 unless asked to
# block. A gate that hard-fails on a heuristic would be worse than the problem.
#
# CORRECTED 2026-09-11 — it used to answer a QUESTION IT HAD NOT ASKED. On finding
# no competing worktree it printed "this checkout has the machine to itself": a
# claim about the MACHINE, from a search of worktrees of THIS CLONE. Those are
# different populations, and the gap is exactly where the thing it exists to catch
# lives — another project's fleet is invisible to it BY CONSTRUCTION (the repo_id
# test below excludes unrelated checkouts on purpose, and should).
#
# MEASURED, same session, twice: it reported "this checkout has the machine to
# itself" at load1 40.85 and again at 72.27 on a 10-core box. Both times a suite
# started on that reading, and both times the resulting red was contention that
# was then diagnosed as a code defect — once for ~a day. The tool did not merely
# fail to help; its answer pointed the investigation the wrong way, which is worse
# than silence and is the one property an advisory check must never have.
#
# It now corroborates against load before making the quiet claim, and when load
# contradicts it, says plainly what it searched and what it therefore cannot know.
# The competitor verdict and every exit code are UNCHANGED: --check and --wait
# still act on same-repo worktrees only, because a heuristic about foreign load is
# not something to block a suite on. The fix is to the CLAIM, not the gate.
#
#   scripts/preflight-suite.sh              report; always exit 0
#   scripts/preflight-suite.sh --check      exit 1 if a competing fleet is found
#   scripts/preflight-suite.sh --wait[=N]   block until clear (default 3600s)
#   scripts/preflight-suite.sh --wait-load[=L]   ALSO block until load1 < L
#
# --wait-load is OPT-IN and changes NO default. The header above is emphatic that
# foreign load must not gate a suite, and that stands: a heuristic about load you
# cannot attribute is not something to fail someone's gate on. But a CALLER who has
# already decided to wait is in a different position from the tool deciding for them
# — and that caller had to hand-roll the same `until load1 < N` loop every time.
# MEASURED 2026-09-19: three full-gate runs were queued behind a peer's fleet on this
# box, each with a bespoke wait loop pasted into the command line. This makes the
# supported form one flag. Default L is half the CPU count (5 on this 10-core box).
# Without --wait-load, every exit code and message is byte-identical to before.
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=report
WAIT_MAX=3600
WAIT_LOAD=          # empty = the load gate is OFF (the default, deliberately)

for arg in "$@"; do
  case "$arg" in
    --check)   MODE=check ;;
    --wait)    MODE=wait ;;
    --wait=*)  MODE=wait; WAIT_MAX="${arg#--wait=}" ;;
    --wait-load)   WAIT_LOAD=default ;;
    --wait-load=*) WAIT_LOAD="${arg#--wait-load=}" ;;
    -h|--help) sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "preflight-suite: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

# The identity of "this repo" is the common git dir, so every worktree of the
# same clone resolves to one value and an unrelated checkout does not.
repo_id() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }
MY_REPO="$(repo_id "$ROOT")"
MY_ROOT="$(cd "$ROOT" && pwd -P)"

pagesize=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)
free_mb() { vm_stat 2>/dev/null | awk -F: -v p="$pagesize" '/Pages free/{gsub(/[ .]/,"",$2); print int($2*p/1048576)}'; }
# SWAP HEADROOM — added 2026-09-16 (ADR 0705) after TWO memory kills in one
# evening, both starting from a preflight that had just called the machine
# quiet. The worse one read `load1 4.10 . free 804 MB . none - the machine
# agrees` with swap at 11483/12288 MB used, and died eight minutes later
# without producing a single lane summary.
#
# CORRECTED the same hour: the first version of this comment said FOUR, and
# that number was wrong in a way worth keeping. A third run died at 14:16Z and
# I attributed it to memory too — it was a peer running `pkill -f vitest` to
# stop a stray run of their own, on a shared box, with a pattern that matched
# every session's vitest. The harness had TOLD me the difference (two
# notifications said "stopped because the system is running low on memory";
# that one said only "failed with exit code 144") and I collapsed it.
#
# The evidence I offered myself was worse than merely thin: I ran `pgrep
# vitest`, found none, and read that as "no competitor". The absence was the
# CONSEQUENCE of the kill, not the context for it. Measuring the aftermath and
# describing it as the cause is available to anyone diagnosing a dead run, so:
# a kill with no memory message from the harness is not a memory kill.
#
# WHY `free_mb` ABOVE COULD NOT HAVE CAUGHT IT. `vm_stat` "Pages free" excludes
# everything the compressor holds and everything purgeable, so on macOS it reads
# small on a healthy machine and small on a dying one. It is not a floor anything
# can threshold against, and this file has been printing it as if it were.
#
# The script's OWN HEADER (see the 2026-08-10 measurements above) already names
# the signal: `+4.46 GB compressor, 67,614 swapins / 39,209 swapouts in 11 min`.
# The header knew; the check never grew it.
swap_free_mb() {
  if [ -n "${OPENWOP_PREFLIGHT_SWAPFREE_MB:-}" ]; then printf '%s' "$OPENWOP_PREFLIGHT_SWAPFREE_MB"; return; fi
  sysctl -n vm.swapusage 2>/dev/null | sed -n 's/.*free = \([0-9.]*\)M.*/\1/p' | cut -d. -f1
}
# OPENWOP_PREFLIGHT_LOAD1 is a TEST SEAM, and it is deliberately narrow: it feeds
# the advisory wording below and nothing else. Competitor detection never reads
# it, so it cannot be used to hide a real contending worktree — only to exercise
# the two message branches deterministically, which is the only way the busy arm
# gets observed on a quiet CI machine.
load1()   { printf '%s' "${OPENWOP_PREFLIGHT_LOAD1:-$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')}"; }
ncpu()    { sysctl -n hw.ncpu 2>/dev/null || echo 8; }

# --wait-load's threshold. `default` resolves to half the CPU count; anything else
# is taken literally so a caller can be stricter or looser than the default.
load_threshold() {
  if [ "$WAIT_LOAD" = default ]; then awk -v c="$(ncpu)" 'BEGIN{ printf "%.1f", c / 2 }'; else printf '%s' "$WAIT_LOAD"; fi
}
# TRUE when the load gate is satisfied — which includes the case where it is OFF,
# so the wait loop below reads the same whether or not the caller opted in.
load_ok() {
  [ -z "$WAIT_LOAD" ] && return 0
  awk -v l="$(load1)" -v t="$(load_threshold)" 'BEGIN{ exit !(l + 0 < t + 0) }'
}

# Find heavy PARENT processes (not the forked workers) whose working directory
# belongs to this repo but to a DIFFERENT worktree than the one we are in.
# Matching on cwd rather than argv is what keeps this from flagging its own
# invoking shell — a self-match already cost me a bogus reading tonight.
#
# WHAT COUNTS AS A COMPETITOR (H36, 2026-08-16). Originally only a vitest parent
# — and a full `npm run ci` spends its last ~8 minutes in lanes that are NOT
# vitest (the frontend build, then Playwright with a live backend on :8080 and a
# Vite dev server). MEASURED: a peer ran `preflight-suite --wait`, read
# "→ clear after 60s", and started a full gate while mine was in its e2e lane;
# both then shared 10 cores. So the pattern now also matches the gate's own
# parent (`scripts/ci.sh`, which is alive for every lane) and a Playwright run.
# The cwd/worktree test below is unchanged, so our own gate is still excluded.
COMPETITOR_ARGV='(vitest\.mjs|[/.]bin/vitest) run|scripts/ci\.sh( |$)|playwright[^ ]* test'
find_competitors() {
  local pid cwd wt_root
  # shellcheck disable=SC2009  # pgrep -f would match this script's own argv
  # `-ww`: macOS ps truncates `command=` at 132 columns EVEN WHEN PIPED, so a
  # long worktree path can push the matching token past the cut. Two w's = no
  # limit. And the self-exclusion below is "the COMMAND is grep", not "the line
  # contains grep": the gate's own Playwright invocation is
  # `playwright test --grep-invert @serial`, which a bare `grep -v grep` drops —
  # measured while writing the H36 test; the real e2e lane was invisible.
  ps -ww -Ao pid=,command= 2>/dev/null \
    | grep -E "$COMPETITOR_ARGV" \
    | grep -vE '^ *[0-9]+ +(/[^ ]*/)?grep( |$)' \
    | awk '{print $1}' \
    | while read -r pid; do
        cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | tail -1)
        [ -n "$cwd" ] || continue
        wt_root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || continue
        [ "$(repo_id "$cwd")" = "$MY_REPO" ] || continue
        [ "$(cd "$wt_root" && pwd -P)" = "$MY_ROOT" ] && continue   # our own run
        printf '%s\t%s\t%s\n' "$pid" "$(ps -o etime= -p "$pid" | tr -d ' ')" "$wt_root"
      done \
    | awk -F'\t' '!seen[$3]++'   # one line per competing WORKTREE (a gate is ci.sh + npm + vitest + …)
}

report_once() {
  local found; found="$(find_competitors)"
  local n; n=$(printf '%s' "$found" | grep -c . || true)
  local swapfree; swapfree="$(swap_free_mb)"
  printf '  machine   : load1 %s · free %s MB · swap free %s MB\n' "$(load1)" "$(free_mb)" "${swapfree:-?}"
  # A WARNING, NEVER A REFUSAL. Refusing to run above a threshold was weighed and
  # rejected (it moves the flake, and the bypass flag becomes default-on); nothing
  # here re-proposes it. This says what the load1 arm says, for the failure mode
  # that actually killed two runs (see the header note — a third was a peer's pkill).
  #
  # AND IT IS NOT A PREDICTOR — the evidence got WORSE for the threshold, not
  # better. Four full-lane samples on this box, 2026-09-16:
  #
  #     598 MB headroom  -> PASSED 2026 files
  #     805 MB           -> KILLED
  #     934 MB           -> PASSED 2035 files
  #    1588 MB           -> KILLED          (the highest headroom of the day)
  #
  # The 1024 MB trigger below would have fired on NEITHER kill and on BOTH
  # passes. In this sample it is anti-correlated, so treat the number as the
  # trigger for a REMINDER and nothing else; it is emphatically not a forecast,
  # and it will miss kills — the 1588 MB one it missed is the one it would most
  # have helped with. Raising it is not obviously right either: a threshold that
  # always fires is a message nobody reads. The
  # threshold is a TRIPWIRE — it tells you which explanation to reach for when a
  # run dies — not a forecast of whether it will. Stating it as a forecast would
  # have been the same error this check exists to catch: a number presented as
  # more than it can carry.
  #
  # And it needs its OWN wording, because a memory kill is NOT a red: it produces
  # no exit line, no lane summaries and zero failures, which reads as "nothing
  # happened" rather than "this did not run". That ambiguity cost two misreadings
  # in the session that added this.
  if [ -n "$swapfree" ] && [ "$swapfree" -lt 1024 ] 2>/dev/null; then
    printf '  memory    : swap headroom is %s MB. If this run DIES, suspect memory before your diff.\n' "$swapfree"
    printf '              A kill leaves NO exit line, NO lane summaries and ZERO reds, so it reads\n'
    printf '              like nothing happened. It is not a verdict on your diff.\n'
    printf '              NOT A PREDICTION — a reminder, not a forecast, and it MISSES kills.\n'
    printf '              MEASURED 2026-09-16, four full lanes on this box: 598 MB PASSED,\n'
    printf '              805 MB killed, 934 MB PASSED, 1588 MB killed. This threshold would have\n'
    printf '              fired on neither kill and on both passes. Headroom does not order the\n'
    printf '              outcomes; seeing this line only tells you which explanation to check.\n'
  fi
  if [ "$n" -eq 0 ]; then
    # SCOPE OF THIS ANSWER (correction 2026-09-11 — see the header note). What was
    # searched is worktrees of THIS clone. What used to be claimed was the machine.
    local l1 cores
    l1="$(load1)"; cores="$(ncpu)"
    if awk -v l="$l1" -v c="$cores" 'BEGIN{ exit !(l + 0 >= c + 0) }'; then
      printf '  competing : none from this repo — but load1 %s on %s cores says the machine is BUSY\n' "$l1" "$cores"
      printf '              Something this check CANNOT SEE is running: another project'"'"'s suite,\n'
      printf '              another clone, or non-repo work. It searches worktrees of this clone\n'
      printf '              only, so it has no basis to call the machine quiet — and does not.\n'
      printf '              A red from a run started now is not evidence. Re-run it quiet first.\n'
      return 0
    fi
    printf '  competing : none — no suite from another worktree of this clone, and load1 %s on %s cores agrees\n' "$l1" "$cores"
    return 0
  fi
  printf '  competing : %d suite(s) from another worktree of this repo\n' "$n"
  printf '%s\n' "$found" | while IFS=$'\t' read -r pid et wt; do
    [ -n "$pid" ] && printf '      pid %-7s up %-9s %s\n' "$pid" "$et" "$wt"
  done
  return 1
}

printf '\n\033[1m▶ preflight-suite\033[0m\n'

# --wait-load on its own implies waiting: asking to block on load and then not
# blocking would be a silent no-op, the failure mode this repo keeps rediscovering.
if [ -n "$WAIT_LOAD" ] && [ "$MODE" = report ]; then MODE=wait; fi

if [ "$MODE" = wait ]; then
  waited=0
  while [ "$waited" -lt "$WAIT_MAX" ]; do
    if report_once; then
      if load_ok; then printf '  → clear after %ss\n\n' "$waited"; exit 0; fi
      printf '  → this repo is clear, but load1 %s is not below %s (--wait-load)\n' "$(load1)" "$(load_threshold)"
    fi
    printf '  → waiting 60s (%ss/%ss elapsed)\n' "$waited" "$WAIT_MAX"
    sleep 60; waited=$((waited + 60))
  done
  printf '  → still contended after %ss; giving up. Results from a run started now are NOT evidence.\n\n' "$WAIT_MAX"
  exit 1
fi

if report_once; then
  printf '\n'
  exit 0
fi

cat <<'EOF'

  Serialise, per CLAUDE.md § "Working in parallel sessions". A suite started now
  can fail with "Failed to start forks worker ... Timeout waiting for worker to
  respond" — worker STARVATION, which reads exactly like a real failure and is
  not. Equally: a green run under contention does not clear your diff either.

  Wait for it:   scripts/preflight-suite.sh --wait
EOF
printf '\n'

[ "$MODE" = check ] && exit 1
exit 0
