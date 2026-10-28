# ADR 0974 — tell the Tracegate broker about this script's work, in OBSERVE mode.
#
# P2 (2026-10-25): every class but `daemon` registers with `--yield` (broker
# invariant I11). It still waits for nothing, but the background daemon's
# preemptible lease yields to it, which retires the daemon's own mid-batch polling.
# OPENWOP_BROKER_YIELD=off registers without it.
#
# The broker (vendored: scripts/vendor/tracegate-ci) grants an observed job at once
# and records whether it WOULD have waited, behind whom, and how far the machine
# ran over its cpu budget. Nothing here waits, gates or changes what runs; the
# eight existing coordination mechanisms (claim dir, train lock, freeze, daemon
# lock, PAUSE, vlock, process detection, the release queue) stay in charge. A
# week of `node scripts/vendor/tracegate-ci/src/broker/main.mjs observed` is the
# evidence for retiring any of them, one at a time, by the user's decision.
#
#   broker_observe <class> <tokens|gate> <label>
#     class   deploy | gate | train | measure | adhoc | daemon
#     tokens  a number, or `gate` for what a gate's vitest uses (cores − 1)
#
# Never blocks and never fails: the observer starts detached, watches $$ (the
# calling script), and exits when it does. OPENWOP_BROKER_OBSERVE=off disables it.
# It exports OPENWOP_BROKER_OBSERVED=1, so a gate run INSIDE a train is not
# registered twice (it would read as waiting behind its own train).
broker_observe() {
  [ "${OPENWOP_BROKER_OBSERVE:-on}" = off ] && return 0
  [ -n "${OPENWOP_BROKER_OBSERVED:-}" ] && return 0
  local tokens="${2:-1}"
  if [ "$tokens" = gate ]; then tokens=$(( $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2) - 1 )); fi
  case "$tokens" in ''|*[!0-9]*|0) tokens=1 ;; esac
  local yield=()
  [ "$1" != daemon ] && [ "${OPENWOP_BROKER_YIELD:-on}" != off ] && yield=(--yield)
  ( cd "$ROOT" 2>/dev/null && TRACEGATE_HOST="${OPENWOP_TRACEGATE_HOST:-}" nohup node "$ROOT/scripts/vendor/tracegate-ci/src/broker/main.mjs" observe \
      --quiet --class "$1" --tokens "$tokens" --label "${3:-$1}" ${yield[@]+"${yield[@]}"} --watch-pid $$ </dev/null >/dev/null 2>&1 & ) 2>/dev/null || true
  export OPENWOP_BROKER_OBSERVED=1
  return 0
}
