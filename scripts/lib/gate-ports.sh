# shellcheck shell=bash
#
# Port + process helpers shared by `ci.sh` and `e2e-routes.sh`.
#
# These were duplicated in both scripts, and BOTH copies carried the same defect:
# `lsof … >/dev/null 2>&1` returns non-zero identically for "the port is free"
# and "lsof is missing / permission-denied", so an environment without a usable
# lsof believed EVERY port was free and three protections became no-ops at once.
# One copy is also one place to test — see `scripts/test-gate-tooling.sh`, which
# is the set of hand-probes that found these defects, kept as assertions
# (`docs/steward/CODEBASE-ASSESSMENT.md` § Merge-gate tooling, GATE-1/GATE-4/GATE-5).

# Prove lsof actually works, ONCE, rather than mis-reading its failure as "free"
# in four places. Absence of evidence is not evidence of absence.
gate_require_lsof() {
  if ! lsof -nP -iTCP -sTCP:LISTEN >/dev/null 2>&1 && ! command -v lsof >/dev/null 2>&1; then
    echo "error: lsof is unavailable — port-collision protection cannot function." >&2
    echo "  Install lsof, or set OPENWOP_CI_E2E=0 to skip the browser lane." >&2
    return 1
  fi
  return 0
}

# True when something is LISTENING on $1. Call only after gate_require_lsof.
gate_port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# Echo the first free port at or above $1. Returns non-zero (echoing the START
# port) when the scan is exhausted, so callers can distinguish "found one" from
# "gave up" — without that, an exhausted scan silently returns a BUSY port and
# the readiness probe is then answered by the OCCUPANT.
gate_pick_free_port() {
  local p="$1" tries=0
  while gate_port_in_use "$p"; do
    p=$((p + 1)); tries=$((tries + 1))
    if [ "$tries" -gt 40 ]; then echo "$1"; return 1; fi
  done
  echo "$p"
}

# True when pid $1 is $2, or any DESCENDANT of $2.
#
# The first version of this check used `pgrep -P` — direct children only — while
# the real chain is three deep: a backgrounded subshell runs `npm`, which spawns
# the server that binds. The listener is a GRANDCHILD, so the guard refused its
# own server and would have failed every `ci:full` run. Walk the chain.
gate_is_descendant_of() {
  local pid="$1" ancestor="$2" hops=0
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ] && [ "$hops" -lt 12 ]; do
    [ "$pid" = "$ancestor" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    hops=$((hops + 1))
  done
  return 1
}

# Refuse to reuse a server on $1 unless EVERY listener there descends from $2.
#
# Every listener, not `head -1`: a dual-stack bind reports several pids, and
# picking one at random could vouch for a foreign process by luck. Adopting an
# occupant would run the suite against a DIFFERENT BUILD and report it green,
# which is the defect `reuseExistingServer:false` exists to prevent.
gate_assert_port_owned_by() {
  local port="$1" owner="$2" listeners lp
  listeners="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  if [ -z "$listeners" ]; then
    echo "error: nothing is listening on :$port — our server never bound." >&2
    return 1
  fi
  for lp in $listeners; do
    if ! gate_is_descendant_of "$lp" "$owner"; then
      echo "error: :$port is held by pid $lp, which is NOT ours (job pid $owner)." >&2
      echo "  Refusing to reuse it — the suite would run against a different build." >&2
      return 1
    fi
  done
  return 0
}

# Every descendant of $1 (depth-first), then $1 itself, one PID per line.
gate_tree_pids() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do gate_tree_pids "$c"; done
  printf '%s\n' "$1"
}

# SIGTERM a process and its WHOLE subtree (ADR 0863). The tree is snapshotted
# before any signal is sent, because a child whose parent dies first is
# re-parented to init and drops out of `pgrep -P`.
#
# This matters because `pkill -P <wrapper>` reaches only direct children, so it
# leaves Vite behind on Linux. There `npm run dev` runs its script through
# `sh -c`, which adds a level between npm and Vite and does not forward npm's
# SIGTERM. The leak did not happen on macOS, where /bin/sh execs the last command
# in place, so it surfaced only on the ADR 0863 Linux pilot.
gate_kill_tree() {
  local pids; pids="$(gate_tree_pids "$1")"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
}
