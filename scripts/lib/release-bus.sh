# release-bus.sh — shell side of the cross-machine release bus (ADR 0991).
# Source it; every function is ADVISORY and returns 0 whatever happens, so a
# caller under `set -euo pipefail` can never be changed by it. Output goes to
# stderr, so a caller's stdout stays its own.
#
#   release_bus <command> [args…]          run scripts/lib/release-bus.mjs
#   release_bus_hold <id> <kind> [args…]   claim, and release + publish the end on EXIT
#   release_bus_acquire_hold <id> <kind> [args…]
#                                          the same, but `acquire`: queue behind a live
#                                          lease on the same --targets first (ADR 0991 D9)
#   release_bus_targets backend|frontend…  the target ids for this deploy.env, comma-joined
#
# The EXIT hook CHAINS onto the caller's existing EXIT trap (the train lock and
# deploy.sh's build cancel live there) instead of replacing it, and never calls
# `exit`, so the caller's exit status is the one bash reports.

_RELEASE_BUS_MJS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-bus.mjs"

release_bus() {
  [ "${OPENWOP_RELEASE_BUS:-on}" = "off" ] && return 0
  command -v node >/dev/null 2>&1 || return 0
  node "$_RELEASE_BUS_MJS" "$@" >&2 2>&1 || true
  return 0
}

# release_bus_targets backend|frontend…
# The ids of the servers this deploy.env points at. Derived, never typed, so two
# checkouts deploying to the same service always name it the same way. A half
# whose deploy.env values are unset contributes nothing (and nothing waits on it).
release_bus_targets() {
  local out=() half
  for half in "$@"; do
    case "$half" in
      backend)
        if [ -n "${OPENWOP_DEPLOY_PROJECT:-}" ] && [ -n "${OPENWOP_DEPLOY_SERVICE:-}" ]; then
          out+=("run:${OPENWOP_DEPLOY_PROJECT}/${OPENWOP_DEPLOY_REGION:-us-central1}/${OPENWOP_DEPLOY_SERVICE}")
        fi ;;
      frontend)
        if [ -n "${OPENWOP_DEPLOY_FIREBASE_PROJECT:-}" ] && [ -n "${OPENWOP_DEPLOY_HOSTING_TARGET:-}" ]; then
          out+=("hosting:${OPENWOP_DEPLOY_FIREBASE_PROJECT}/${OPENWOP_DEPLOY_HOSTING_TARGET}")
        fi ;;
    esac
  done
  local IFS=,
  printf '%s' "${out[*]-}"
}

# release_bus_hold <id> <kind> <end-event-json-fn> [claim args…]
# <end-event-json-fn> is a function the hook calls with the exit status; it
# prints the JSON of the end event (or nothing).
release_bus_hold() { _release_bus_hold claim "$@"; }
# release_bus_acquire_hold: the same, but it may WAIT (bounded, fail-open) for a
# live lease on one of its --targets. See release-bus.mjs `acquire`.
release_bus_acquire_hold() { _release_bus_hold acquire "$@"; }

_release_bus_hold() {
  local verb="$1"; shift
  _RELEASE_BUS_ID="$1"; _RELEASE_BUS_END_FN="$3"
  local kind="$2"; shift 3
  # The EXIT hook goes in BEFORE the claim: an acquire can wait, and a deploy
  # interrupted while queued must still take its waiting entry off the bus.
  local prev
  prev="$(trap -p EXIT)"
  prev="${prev#trap -- }"
  prev="${prev% EXIT}"
  if [ -n "$prev" ]; then eval "_RELEASE_BUS_PREV_EXIT=$prev"; else _RELEASE_BUS_PREV_EXIT=""; fi
  # shellcheck disable=SC2064 # expand the previous trap now; it is fixed text
  trap "_release_bus_rc=\$?; ${_RELEASE_BUS_PREV_EXIT:+$_RELEASE_BUS_PREV_EXIT; }_release_bus_on_exit \"\$_release_bus_rc\"" EXIT
  release_bus "$verb" --id "$_RELEASE_BUS_ID" --kind "$kind" "$@"
}

_release_bus_on_exit() {
  local rc="$1" ev=""
  if [ -n "${_RELEASE_BUS_END_FN:-}" ]; then ev="$("$_RELEASE_BUS_END_FN" "$rc" 2>/dev/null || true)"; fi
  [ -n "$ev" ] && release_bus publish "$ev"
  [ -n "${_RELEASE_BUS_ID:-}" ] && release_bus release --id "$_RELEASE_BUS_ID"
  return 0
}

# JSON-safe string for the hooks' event bodies.
release_bus_json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1" 2>/dev/null || printf '""'; }
