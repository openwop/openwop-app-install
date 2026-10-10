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
#   scripts/preflight-suite.sh --wait[=N]   block until clear (default 3600s), then CLAIM
#   scripts/preflight-suite.sh --wait-load[=L]   ALSO block until load1 < L
#   scripts/preflight-suite.sh --wait-foreign    ALSO block while another PROJECT runs a suite
#   scripts/preflight-suite.sh --ci         what `npm run ci` runs first (below)
#   scripts/preflight-suite.sh --release    drop the claim our parent holds
#   scripts/preflight-suite.sh --wait-claim[=N]  block while ANOTHER worktree's
#                               gate holds the claim (default 3600s); never claims
#
# `npm run ci` WAITS BY DEFAULT (2026-09-28). `scripts/ci.sh` enters `--ci` by
# exec (`--ci-exec`, before it does anything else — so a waiting gate is not a
# `scripts/ci.sh` process and no detector mistakes it for a running suite): it
# queues behind any live suite from another checkout of this repo (any worktree,
# detached ones under /tmp included; matched by git common dir), printing on EVERY
# poll who it is waiting on (worktree, pid, and the lane: gate / backend vitest /
# frontend vitest / e2e), and takes the claim (below) for ci.sh when clear.
#   OPENWOP_CI_WAIT_MAX_MIN=N   give up waiting after N minutes (default 90) and
#                               PROCEED under a loud "running CONTENDED — reds are
#                               not evidence" banner (DEBT-3). It never fails.
#   OPENWOP_CI_NO_WAIT=1        skip the wait; the competitor list still prints.
#   OPENWOP_CI_WAIT_FOREIGN=0   do not wait on suites from OTHER projects (below).
#   OPENWOP_CI_WAIT_LOAD_PER_CORE=N   wait while load1 >= N × cores (default 1.5;
#                               0 = off). Same cap, same banner, never fails.
#   OPENWOP_CI_FOREIGN_CPU_FLOOR=P    a foreign repo's suites count only while their
#                               process trees sum to >= P %CPU (default 20).
# ci.sh releases the claim when it exits (pass, fail or Ctrl-C). A claim whose
# holder died (a killed shell) is stale and is recovered by the next waiter.
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
# --ci ALSO WAITS ON THE MACHINE, NOT ONLY THIS REPO (2026-09-29). The 09-11
# correction above made the report honest about what it could not see; it did
# not make the gate WAIT on it, and the paragraph above says foreign load must
# not gate a suite. MEASURED: another project's 12-worker vitest fleet
# (/Users/david/dev/myndhyve-sec) drove load1 to 230 and reddened a gate here on
# timeouts, and nothing named it. So `--ci` now, by default:
#   * lists every vitest / Playwright run on the box whose cwd is OUTSIDE this
#     repo's worktrees (another project, another clone), naming its repo path,
#     and WAITS on them (--wait-foreign). It never CLAIMS for them: they do not
#     run this script, the claim is this repo's, and a foreign process cannot
#     wait on it, so no cycle through the claim exists.
#   * waits while load1 >= 1.5 × cores (--wait-load), whatever its source.
# Both are evaluated ONLY in the wait loop, BEFORE the claim is taken, and only
# once this repo is clear. So a running gate never blocks itself on the load it
# drives (it passed the check before it started), and a peer of this repo queued
# behind it waits on its CLAIM, not on load. When that gate ends, the peer can
# wait a little longer while load1 (a 1-minute average) decays below the
# threshold. That is harmless, and it is the only way this repo's own load reaches the load wait.
# Both are bounded by OPENWOP_CI_WAIT_MAX_MIN and end in the same CONTENDED
# banner, so a foreign fleet or a stuck load can delay a gate but never fail it.
# Both have opt-outs (above). Report mode and --check are UNCHANGED: they print
# the foreign list, and their verdicts still count this repo's suites only.
#
# THE CLAIM (2026-09-28). Two `--wait` loops that poll the same clear minute
# used to BOTH exit 0 and both start a suite: the detector sees a suite only once
# it is running, and there is a window between "clear" and "visible" that nothing
# held. Twice in one day a peer and I were each queued behind the same fleet with
# nothing to break the tie but luck. So when `--wait` clears it now CLAIMS the
# machine for its caller: an atomic `mkdir` of `<git-common-dir>/preflight-suite.claim`
# recording the claimant pid (the process that goes on to run the suite — our
# parent, e.g. the `( preflight --wait && npm run ci )` subshell), its start time,
# and its worktree. It then re-checks after a short jitter and backs off if a
# suite appeared. The claim lasts exactly as long as the claimant: a waiter that
# finds it held by a LIVE claimant keeps waiting and names it like a competitor;
# one held by a DEAD claimant (or a reused pid — the start time must match) is
# stale and is recovered. A claim from THIS worktree is our own and never blocks.
# --check reports a live foreign claim exactly as it reports a competitor. The
# report mode `npm run ci` runs is unchanged except that it names a claim.
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE=report
# `--ci-exec <ci.sh> [args…]` — how ci.sh enters the wait (see the header): this
# process IS the gate. It waits and claims under ITS OWN pid, then `exec`s back
# into ci.sh, which keeps that pid (and its start time), so the claim stays valid
# for the whole run. While it waits its argv is THIS script, not `scripts/ci.sh`,
# so a WAITING gate never matches COMPETITOR_ARGV — for this version of the
# detector or the one before it. (With the wait inside ci.sh, two waiting gates
# each saw the other's `scripts/ci.sh` as a running suite: a deadlock until the cap.)
EXEC_TARGET=""
EXEC_ARGS=()
if [ "${1:-}" = --ci-exec ]; then
  # The target comes from the ENVIRONMENT: were it an argument, this waiting
  # process's argv would contain `…/scripts/ci.sh` and match COMPETITOR_ARGV.
  EXEC_TARGET="${OPENWOP_CI_EXEC_TARGET:?--ci-exec needs OPENWOP_CI_EXEC_TARGET (the ci.sh path)}"; shift
  unset OPENWOP_CI_EXEC_TARGET
  EXEC_ARGS=("$@"); set -- --ci
fi
WAIT_MAX=3600
WAIT_LOAD=          # empty = the load gate is OFF (the default, deliberately)
WAIT_FOREIGN=       # empty = other projects' suites are REPORTED, never waited on

for arg in "$@"; do
  case "$arg" in
    --check)   MODE=check ;;
    --wait)    MODE=wait ;;
    --wait=*)  MODE=wait; WAIT_MAX="${arg#--wait=}" ;;
    --wait-load)   WAIT_LOAD=default ;;
    --wait-load=*) WAIT_LOAD="${arg#--wait-load=}" ;;
    --wait-foreign) WAIT_FOREIGN=1 ;;
    --ci)      MODE=ci ;;
    --release) MODE=release ;;
    --wait-claim)   MODE=wait-claim ;;
    --wait-claim=*) MODE=wait-claim; WAIT_MAX="${arg#--wait-claim=}" ;;
    -h|--help) sed -n '/^#   scripts\/preflight-suite.sh  /,/^set -uo pipefail/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "preflight-suite: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

# The identity of "this repo" is the common git dir, so every worktree of the
# same clone resolves to one value and an unrelated checkout does not.
repo_id() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }
MY_REPO="$(repo_id "$ROOT")"
MY_ROOT="$(cd "$ROOT" && pwd -P)"

# ── the claim ───────────────────────────────────────────────────────────────
# Test seams (narrow, documented): OPENWOP_PREFLIGHT_CLAIM_DIR relocates the
# claim so the self-test never touches the real one; OPENWOP_PREFLIGHT_POLL_S and
# OPENWOP_PREFLIGHT_JITTER_S shorten the waits. OPENWOP_PREFLIGHT_CLAIMANT_PID lets
# a caller whose suite runs in a process other than our parent name it.
CLAIM_DIR="${OPENWOP_PREFLIGHT_CLAIM_DIR:-${MY_REPO:-$ROOT/.git}/preflight-suite.claim}"
POLL_S="${OPENWOP_PREFLIGHT_POLL_S:-60}"
CLAIMANT_PID="${OPENWOP_PREFLIGHT_CLAIMANT_PID:-$PPID}"
[ -n "$EXEC_TARGET" ] && CLAIMANT_PID=$$   # we become the gate (exec keeps the pid)
proc_start() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }

# Prints "pid<TAB>started<TAB>worktree" for a claim held by a LIVE claimant in
# ANOTHER worktree. Recovers a stale claim (dead claimant, or a pid reused by a
# process that started at a different time) and prints nothing for it.
foreign_claim() {
  [ -d "$CLAIM_DIR" ] || return 0
  local pid="" started="" wt=""
  # ONE file, written to a temp name and renamed in: a reader sees all three
  # fields or none. (Three separate files let a peer read the pid before the
  # start time existed, judge the claim stale, delete it and take it too —
  # MEASURED at load 87: two waiters both proceeded.)
  # Redirection can fail before read assigns anything (Bash 5 + nounset).
  # Suppress the open failure too; an unpublished claim must still block.
  IFS=$'\t' read -r pid started wt 2>/dev/null < "$CLAIM_DIR/info" || true
  case "$pid" in ''|0|*[!0-9]*) pid="" ;; esac
  if [ -z "$pid" ] || [ -z "$started" ] || [ -z "$wt" ]; then
    # Mid-write by a peer that JUST took it (mkdir, then the files): young means
    # live. An empty claim older than a minute is debris from a killed writer.
    if [ -n "$(find "$CLAIM_DIR" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rm -rf "$CLAIM_DIR"; fi
    [ -d "$CLAIM_DIR" ] && printf '%s	%s	%s
' '?' '-' '(claim being written)'
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null || [ "$(proc_start "$pid")" != "$started" ]; then
    rm -rf "$CLAIM_DIR"   # stale: the claimant is gone
    return 0
  fi
  [ "$wt" = "$MY_ROOT" ] && return 0   # our own claim never blocks us
  printf '%s	%s	%s
' "$pid" "$started" "$wt"
}

# Atomically take the claim for CLAIMANT_PID. 0 = taken (or already ours).
take_claim() {
  foreign_claim >/dev/null   # recovers a stale one first
  if mkdir "$CLAIM_DIR" 2>/dev/null; then
    # Do not hand off a claim unless its complete tuple was published. A failed
    # write/rename leaves young debris for the same bounded stale recovery.
    if printf '%s\t%s\t%s\n' "$CLAIMANT_PID" "$(proc_start "$CLAIMANT_PID")" "$MY_ROOT" > "$CLAIM_DIR/.info.$$" \
      && mv -f "$CLAIM_DIR/.info.$$" "$CLAIM_DIR/info"; then
      return 0
    fi
    return 1
  fi
  [ "$(claim_field 3)" = "$MY_ROOT" ]
}
claim_field() { cut -f"$1" "$CLAIM_DIR/info" 2>/dev/null; }
release_claim() {
  [ "$(claim_field 3)" = "$MY_ROOT" ] && [ "$(claim_field 1)" = "$CLAIMANT_PID" ] && rm -rf "$CLAIM_DIR"
  return 0
}

pagesize=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)
# Linux fallbacks (ADR 0863): on Linux (a hosted-CI revival, an adopter) there
# is no sysctl hw.*/vm.*, no vm_stat, and /proc carries the same readings.
free_mb() {
  if [ -r /proc/meminfo ]; then awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo; return; fi
  vm_stat 2>/dev/null | awk -F: -v p="$pagesize" '/Pages free/{gsub(/[ .]/,"",$2); print int($2*p/1048576)}'
}
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
  if [ -r /proc/meminfo ]; then awk '/^SwapFree:/{print int($2/1024)}' /proc/meminfo; return; fi
  sysctl -n vm.swapusage 2>/dev/null | sed -n 's/.*free = \([0-9.]*\)M.*/\1/p' | cut -d. -f1
}
# OPENWOP_PREFLIGHT_LOAD1 is a TEST SEAM, and it is deliberately narrow: it feeds
# the advisory wording below and nothing else. Competitor detection never reads
# it, so it cannot be used to hide a real contending worktree — only to exercise
# the two message branches deterministically, which is the only way the busy arm
# gets observed on a quiet CI machine.
# OPENWOP_PREFLIGHT_LOAD1_FILE is the same seam, re-read on every call, so a test
# can drop the load while a waiter polls.
load1()   {
  if [ -n "${OPENWOP_PREFLIGHT_LOAD1_FILE:-}" ]; then cat "$OPENWOP_PREFLIGHT_LOAD1_FILE"; return; fi
  printf '%s' "${OPENWOP_PREFLIGHT_LOAD1:-$( { sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg 2>/dev/null; } | tr -d '{}' | awk '{print $1}')}"
}
ncpu()    { sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 8; }

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
# The Playwright TEST RUNNER only (2026-09-30): the `@playwright/test` CLI, the
# `.bin/playwright` shim, or a bare `playwright test` (npm's `sh -c`). Never the
# bare word — every Playwright-MCP browser and `.playwright-mcp` profile carries
# it in its argv, and a Claude session's MCP runs from a repo cwd.
PLAYWRIGHT_RUNNER='(@playwright/test/cli\.js|playwright(-core)?/cli\.js|test-cli\.js|(^|[ /.])playwright) test( |$)'
COMPETITOR_ARGV="(vitest\\.mjs|[/.]bin/vitest) run|scripts/ci\\.sh( |\$)|$PLAYWRIGHT_RUNNER"
# The lane a matched process is in — cheap, from its argv and cwd only.
lane_of() {
  local cmd; cmd="$(ps -ww -o command= -p "$1" 2>/dev/null)"
  case "$cmd" in
    *playwright*) printf 'e2e' ;;
    *vitest*) case "$2" in */frontend/*) printf 'frontend vitest' ;; *) printf 'backend vitest' ;; esac ;;
    *) printf 'gate' ;;
  esac
}
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
        printf '%s\t%s\t%s\t%s\n' "$pid" "$(ps -o etime= -p "$pid" | tr -d ' ')" "$wt_root" "$(lane_of "$pid" "$cwd")"
      done \
    | awk -F'\t' '
        # One line per competing WORKTREE (a gate is ci.sh + npm + vitest + …),
        # carrying every lane seen in it, so a waiter can read WHERE a peer is.
        { if (!($3 in first)) { first[$3] = $1 "\t" $2; order[++n] = $3 }
          if (index(" " lanes[$3] " ", " " $4 " ") == 0) lanes[$3] = (lanes[$3] ? lanes[$3] ", " : "") $4 }
        END { for (i = 1; i <= n; i++) printf "%s\t%s\t%s\n", first[order[i]], order[i], lanes[order[i]] }'
}

# Suites from OUTSIDE this repo: another project, or another clone of this one.
# vitest and Playwright only, never a `scripts/ci.sh` (another project's gate
# script is not ours to read, and its suites match on their own). Named by the
# repo toplevel (or the cwd when it is not a git checkout), one line per path.
#
# CORRECTED 2026-09-30 (#4264 follow-up): only BUSY test RUNNERS count. #4264 also took
# a bare `vitest` / `vitest --…` as a run, and waited on anything matched. An
# editor's `vitest` watchers idle for hours: 22 of them in one project, ~5% CPU
# each, could hold a gate for the full 90-minute cap while doing nothing. So:
#   * vitest counts only with the `run` subcommand or `--run`. Anything else is
#     watch mode (vitest's default), whatever flags it carries;
#   * Playwright counts only as its test runner (PLAYWRIGHT_RUNNER above): the
#     first report of "22 idle watchers" was in fact Playwright-MCP Chrome
#     helpers matched on the bare word;
#   * a repo counts only while its matched processes' TREES (the forked workers
#     do the work) sum to >= OPENWOP_CI_FOREIGN_CPU_FLOOR %CPU (default 20).
FOREIGN_ARGV="(vitest\\.mjs|[/.]bin/vitest)( .*)? (run|--run)( |\$)|$PLAYWRIGHT_RUNNER"
FOREIGN_CPU_FLOOR="${OPENWOP_CI_FOREIGN_CPU_FLOOR:-20}"
# %CPU of a process plus all its descendants (ps's decaying average).
tree_cpu() {
  local c sum
  sum="$(ps -o pcpu= -p "$1" 2>/dev/null | tr -d ' ')"
  for c in $(pgrep -P "$1" 2>/dev/null); do sum="$(awk -v a="${sum:-0}" -v b="$(tree_cpu "$c")" 'BEGIN{ print a + b }')"; done
  printf '%s' "${sum:-0}"
}
find_foreign() {
  local pid cwd where
  # shellcheck disable=SC2009
  ps -ww -Ao pid=,command= 2>/dev/null \
    | grep -E "$FOREIGN_ARGV" \
    | grep -vE '^ *[0-9]+ +(/[^ ]*/)?grep( |$)' \
    | awk '{print $1}' \
    | while read -r pid; do
        cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | tail -1)
        [ -n "$cwd" ] || continue
        [ -n "$MY_REPO" ] && [ "$(repo_id "$cwd")" = "$MY_REPO" ] && continue   # this repo: find_competitors' job
        where=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || where="$cwd"
        printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$(ps -o etime= -p "$pid" | tr -d ' ')" "$where" "$(lane_of "$pid" "$cwd")" "$(tree_cpu "$pid")"
      done \
    | awk -F'\t' -v floor="$FOREIGN_CPU_FLOOR" '
        { if (!($3 in first)) { first[$3] = $1 "\t" $2; order[++n] = $3 }
          if (index(" " lanes[$3] " ", " " $4 " ") == 0) lanes[$3] = (lanes[$3] ? lanes[$3] ", " : "") $4
          cpu[$3] += $5 }
        END { for (i = 1; i <= n; i++) { w = order[i]
                if (cpu[w] + 0 >= floor + 0) printf "%s\t%s\t%s\n", first[w], w, lanes[w] " · " int(cpu[w]) "% CPU" } }'
}
# TRUE when nothing foreign blocks — including when --wait-foreign is off. Reads
# the list report_once just printed, so a poll scans the process table once.
FOREIGN_FOUND=""
foreign_ok() { [ -z "$WAIT_FOREIGN" ] || [ -z "$FOREIGN_FOUND" ]; }

report_once() {
  local found; found="$(find_competitors)"
  local claim; claim="$(foreign_claim)"
  if [ -n "$claim" ]; then
    found="$(printf '%s\n%s' "$found" "$(printf '%s' "$claim" | awk -F'\t' '{ printf "%s\tclaimed\t%s\n", $1, $3 }')" | grep .)"
  fi
  local n; n=$(printf '%s' "$found" | grep -c . || true)
  local swapfree; swapfree="$(swap_free_mb)"
  printf '  machine   : load1 %s · free %s MB · swap free %s MB\n' "$(load1)" "$(free_mb)" "${swapfree:-?}"
  FOREIGN_FOUND="$(find_foreign)"
  if [ -n "$FOREIGN_FOUND" ]; then
    printf '  elsewhere : %d suite(s) from OUTSIDE this repo%s\n' "$(printf '%s\n' "$FOREIGN_FOUND" | grep -c .)" \
      "$([ -n "$WAIT_FOREIGN" ] && printf ' — waiting on them (never claiming for them)')"
    printf '%s\n' "$FOREIGN_FOUND" | while IFS=$'\t' read -r pid et wt lanes; do
      [ -n "$pid" ] && printf '      pid %-7s up %-9s %s%s\n' "$pid" "$et" "$wt" "${lanes:+  [${lanes}]}"
    done
  fi
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
      printf '              Something this check CANNOT SEE is running: a suite shape it does not\n'
      printf '              match, or non-test work. It lists vitest and Playwright runs only, so it\n'
      printf '              has no basis to call the machine quiet — and does not.\n'
      printf '              A red from a run started now is not evidence. Re-run it quiet first.\n'
      return 0
    fi
    printf '  competing : none — no suite from another worktree of this clone, and load1 %s on %s cores agrees\n' "$l1" "$cores"
    return 0
  fi
  printf '  competing : %d suite(s) from another worktree of this repo\n' "$n"
  printf '%s\n' "$found" | while IFS=$'\t' read -r pid et wt lanes; do
    [ -n "$pid" ] && printf '      pid %-7s up %-9s %s%s\n' "$pid" "$et" "$wt" "${lanes:+  [${lanes}]}"
  done
  return 1
}

[ "$MODE" = wait-claim ] || printf '\n\033[1m▶ preflight-suite\033[0m\n'

if [ "$MODE" = release ]; then release_claim; exit 0; fi

# --wait-claim (ADR 0863 D8): what a full backend vitest run outside a gate
# calls first (test/setup/queueBehindGate.ts). Gates already wait for a running
# vitest. The other direction was open: a bare full suite started mid-gate
# shared the machine with it, and the gate's reds stopped being evidence.
# It waits on the CLAIM only, never on competing processes, and never claims.
# A claim is held only by a gate that has finished waiting and is running, so
# two waiters cannot wait on each other. (Waiting on processes would: a waiting
# vitest IS a `vitest run` process, and two of them would block each other
# until the cap.) Gives up after N seconds with exit 1; the caller proceeds.
if [ "$MODE" = wait-claim ]; then
  waited=0
  while :; do
    held="$(foreign_claim)"
    [ -z "$held" ] && { [ "$waited" -gt 0 ] && printf '  → the gate finished after %ss; starting\n\n' "$waited"; exit 0; }
    [ "$waited" -ge "$WAIT_MAX" ] && { printf '  → still held after %ss; starting anyway. Results are NOT evidence (DEBT-3).\n\n' "$WAIT_MAX"; exit 1; }
    IFS=$'\t' read -r pid started wt <<<"$held"
    printf '⏳ a gate is running in %s (pid %s); this full suite waits for it (%ss/%ss). OPENWOP_VITEST_NO_WAIT=1 skips.\n' "$wt" "$pid" "$waited" "$WAIT_MAX"
    sleep "$POLL_S"; waited=$((waited + POLL_S))
  done
fi

# --ci: the gate's own entry (see the header). Everything the operator needs to
# read a long wait is printed by report_once on each poll; the cap never fails.
# Every way out of --ci: hand over to the gate when we were exec'd into by it.
ci_done() {
  if [ -n "$EXEC_TARGET" ]; then
    exec env OPENWOP_CI_PREFLIGHT_DONE=1 bash "$EXEC_TARGET" ${EXEC_ARGS[@]+"${EXEC_ARGS[@]}"}
  fi
  exit 0
}
if [ "$MODE" = ci ]; then
  if [ "${OPENWOP_CI_NO_WAIT:-}" = 1 ]; then
    report_once || true
    printf '  → OPENWOP_CI_NO_WAIT=1: not waiting. If anything is listed above, this run is CONTENDED.\n\n'
    ci_done
  fi
  cap_s="$(awk -v m="${OPENWOP_CI_WAIT_MAX_MIN:-90}" 'BEGIN{ s = int(m * 60); print (s < 1 ? 1 : s) }')"
  # The claimant is OUR caller (ci.sh), not this process: the child --wait would
  # otherwise record us, and we exit at once, leaving a claim that is stale on birth.
  ci_args=(--wait="$cap_s")
  [ "${OPENWOP_CI_WAIT_FOREIGN:-1}" = 0 ] || ci_args+=(--wait-foreign)
  per_core="${OPENWOP_CI_WAIT_LOAD_PER_CORE:-1.5}"
  if awk -v n="$per_core" 'BEGIN{ exit !(n + 0 > 0) }'; then
    ci_args+=(--wait-load="$(awk -v n="$per_core" -v c="$(ncpu)" 'BEGIN{ printf "%.1f", n * c }')")
  fi
  if OPENWOP_PREFLIGHT_CLAIMANT_PID="$CLAIMANT_PID" bash "$0" "${ci_args[@]}"; then ci_done; fi
  printf '\033[33m⚠ running CONTENDED (DEBT-3):\033[0m waited %ss (OPENWOP_CI_WAIT_MAX_MIN=%s) and the box\n' "$cap_s" "${OPENWOP_CI_WAIT_MAX_MIN:-90}"
  printf '   is STILL contended: another checkout of this repo, another project'"'"'s suite, or load\n'
  printf '   (the last poll above says which). Proceeding anyway, as asked.\n'
  printf '   A red from this run is not evidence of a regression: re-run it quiet first.\n\n'
  ci_done
fi

# --wait-load / --wait-foreign on their own imply waiting: asking to block on load and then not
# blocking would be a silent no-op, the failure mode this repo keeps rediscovering.
if { [ -n "$WAIT_LOAD" ] || [ -n "$WAIT_FOREIGN" ]; } && [ "$MODE" = report ]; then MODE=wait; fi

if [ "$MODE" = wait ]; then
  waited=0
  # Release a claim we took but never handed to the caller (killed, gave up).
  HANDED=0
  trap '[ "$HANDED" = 1 ] || release_claim' EXIT
  while [ "$waited" -lt "$WAIT_MAX" ]; do
    # The caller that would run the suite is gone (a killed gate): nobody is
    # waiting for our answer, so stop, rather than poll on and later claim the
    # machine for a dead pid.
    if ! kill -0 "$CLAIMANT_PID" 2>/dev/null; then
      printf '  → the caller (pid %s) has exited; stopping the wait\n\n' "$CLAIMANT_PID"; exit 1
    fi
    if report_once; then
      if ! foreign_ok; then
        printf '  → this repo is clear, but a suite from another project is running (--wait-foreign)\n'
      elif load_ok; then
        if take_claim; then
          # Re-check after a short jitter: a suite that started in the same
          # instant as our "clear" is now visible, and we back off to it.
          sleep "${OPENWOP_PREFLIGHT_JITTER_S:-$(( (RANDOM % 3) + 1 ))}"
          if [ -z "$(find_competitors)" ]; then
            HANDED=1
            printf '  → clear after %ss; claimed for pid %s (%s) until it exits\n\n' "$waited" "$CLAIMANT_PID" "$MY_ROOT"
            exit 0
          fi
          release_claim
          printf '  → a suite appeared while claiming; released the claim\n'
        else
          printf '  → lost the claim to a concurrent waiter\n'
        fi
      else
        printf '  → this repo is clear, but load1 %s is not below %s (--wait-load)\n' "$(load1)" "$(load_threshold)"
      fi
    fi
    printf '  → waiting %ss (%ss/%ss elapsed)\n' "$POLL_S" "$waited" "$WAIT_MAX"
    sleep "$POLL_S"; waited=$((waited + POLL_S))
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
