#!/usr/bin/env bash
# ADR 1166 D2 — the machine-wide heavy-step slot.
#
# One heavy step at a time across every repo on this Mac. Heavy means npm ci,
# tsc, a frontend build, or a vitest of more than about five files: run enough
# of those together and the machine swaps, and swap pressure turns real work
# into false reds (2026-11-27: two npm ci + a frontend tsc + a vitest pushed
# free swap to 718 MB within the hour the rule was announced).
#
# Usage:
#   bash scripts/heavy.sh <session>:<step> -- <command...>
#   bash scripts/heavy.sh --status
#
# The slot is host-wide, not repo-wide: every checkout of every repo on this
# machine shares it. A waiter also waits for >= 1 GB of free swap, because a
# free slot on a machine with no swap is not free.
#
# Exit codes:
#   0..125  the command's own exit code, passed through
#   75      gave up waiting (--max-wait) and did NOT run the command
#   64      usage error; 69 the slot directory is unusable
#
# Environment:
#   OPENWOP_HEAVY_SLOT_DIR     held-slot directory   (default ~/.openwop-heavy-slot)
#   OPENWOP_HEAVY_QUEUE_DIR    waiter tickets        (default ~/.openwop-heavy-queue)
#   OPENWOP_HEAVY_MIN_SWAP_MB  free swap to require  (default 1024)
#   OPENWOP_HEAVY_MAX_WAIT     seconds to wait       (default 14400 = 4 h; 0 = forever)
#   OPENWOP_HEAVY_POLL         poll interval seconds (default 10)
#
# A slot whose owner pid is dead is stale and is replaced: a crashed step must
# not block the machine forever. Never kill the holder; wait, or investigate it.
set -uo pipefail

SLOT_DIR="${OPENWOP_HEAVY_SLOT_DIR:-$HOME/.openwop-heavy-slot}"
QUEUE_DIR="${OPENWOP_HEAVY_QUEUE_DIR:-$HOME/.openwop-heavy-queue}"
MIN_SWAP_MB="${OPENWOP_HEAVY_MIN_SWAP_MB:-1024}"
MAX_WAIT="${OPENWOP_HEAVY_MAX_WAIT:-14400}"
POLL="${OPENWOP_HEAVY_POLL:-10}"
OWNER_FILE="$SLOT_DIR/owner"
TICKET=""

say() { printf 'heavy: %s\n' "$*" >&2; }
die() { say "$*"; exit "$2"; }

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 64
}

# Free swap in whole MB. A machine with no swap at all reports "none", which is
# not a reason to wait forever.
free_swap_mb() {
  if command -v sysctl >/dev/null 2>&1 && sysctl -n vm.swapusage >/dev/null 2>&1; then
    sysctl -n vm.swapusage | sed -n 's/.*free = \([0-9.][0-9.]*\)M.*/\1/p' | cut -d. -f1
    return 0
  fi
  if [ -r /proc/meminfo ]; then
    local kb total
    kb=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo 2>/dev/null)
    total=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null)
    if [ "${total:-0}" = "0" ]; then echo none; else echo $(( ${kb:-0} / 1024 )); fi
    return 0
  fi
  echo none
}

swap_ok() {
  local free
  free=$(free_swap_mb)
  # No swap configured, or a platform we cannot read: do not wait on a number
  # we do not have. Say nothing and let the command run.
  case "$free" in ''|none|*[!0-9]*) return 0 ;; esac
  [ "$free" -ge "$MIN_SWAP_MB" ]
}

owner_pid() { sed -n 's/^pid=//p' "$OWNER_FILE" 2>/dev/null | head -1; }
owner_field() { sed -n "s/^$1=//p" "$OWNER_FILE" 2>/dev/null | head -1; }

slot_live() {
  [ -d "$SLOT_DIR" ] || return 1
  local pid
  pid=$(owner_pid)
  # No owner file yet (a slot being created) counts as live for one poll.
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null
}

print_status() {
  local free
  free=$(free_swap_mb)
  echo "heavy slot: $SLOT_DIR"
  if [ -d "$SLOT_DIR" ] && slot_live; then
    echo "holder: $(owner_field owner) (pid $(owner_pid), host $(owner_field host), since $(owner_field started))"
    echo "command: $(owner_field command)"
  elif [ -d "$SLOT_DIR" ]; then
    echo "holder: STALE (pid $(owner_pid) is not running; the next waiter replaces it)"
  else
    echo "holder: free"
  fi
  echo "swap free: ${free} MB (need >= ${MIN_SWAP_MB} MB)"
  echo "waiting: $(find "$QUEUE_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"
  find "$QUEUE_DIR" -type f 2>/dev/null | sort | head -10 | while read -r t; do
    echo "  $(cat "$t" 2>/dev/null)"
  done
}

# --- argument parsing -------------------------------------------------------
if [ "$#" -eq 0 ]; then usage; fi
case "$1" in
  -h|--help) usage ;;
  --status) print_status; exit 0 ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --max-wait) MAX_WAIT="${2:?--max-wait needs seconds}"; shift 2 ;;
    --min-swap-mb) MIN_SWAP_MB="${2:?--min-swap-mb needs MB}"; shift 2 ;;
    --) shift; break ;;
    -*) say "unknown option: $1"; usage ;;
    *) break ;;
  esac
done

[ "$#" -gt 0 ] || { say "missing <session:step>"; usage; }
OWNER="$1"; shift
[ "$#" -gt 0 ] && [ "$1" = "--" ] && shift
[ "$#" -gt 0 ] || { say "missing command after --"; usage; }

case "$OWNER" in
  *:*) ;;
  *) say "the owner must read <session>:<step>, got '$OWNER'"; usage ;;
esac

# --- acquire ----------------------------------------------------------------
mkdir -p "$QUEUE_DIR" 2>/dev/null || die "cannot create queue dir $QUEUE_DIR" 69
case "$SLOT_DIR" in /*) ;; *) die "slot dir must be absolute: $SLOT_DIR" 69 ;; esac
SLOT_PARENT=$(dirname "$SLOT_DIR")
mkdir -p "$SLOT_PARENT" 2>/dev/null || die "cannot create $SLOT_PARENT" 69

TICKET="$QUEUE_DIR/$(date +%s)-$$"
printf '%s waiting since %s\n' "$OWNER" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$TICKET"
release_ticket() { [ -n "$TICKET" ] && rm -f "$TICKET"; }
trap 'release_ticket' EXIT

START=$(date +%s)
waited_for=""
while :; do
  # A dead holder is stale: take the slot rather than block the machine.
  if [ -d "$SLOT_DIR" ] && ! slot_live; then
    say "replacing stale slot (owner $(owner_field owner) pid $(owner_pid) is not running)"
    rm -rf "$SLOT_DIR"
  fi
  if [ ! -d "$SLOT_DIR" ] && swap_ok \
     && [ "$(ls "$QUEUE_DIR" 2>/dev/null | sort | head -1)" = "$(basename "$TICKET")" ]; then
    if mkdir "$SLOT_DIR" 2>/dev/null; then
      printf 'owner=%s\npid=%s\nhost=%s\nstarted=%s\ncommand=%s\n' \
        "$OWNER" "$$" "$(hostname -s 2>/dev/null || hostname)" \
        "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" > "$OWNER_FILE"
      break
    fi
  fi

  if ! swap_ok; then
    want="swap (free $(free_swap_mb) MB < ${MIN_SWAP_MB} MB)"
  elif [ -d "$SLOT_DIR" ] && slot_live; then
    want="holder $(owner_field owner) pid $(owner_pid)"
  else
    want="turn in the queue"
  fi
  if [ "$want" != "$waited_for" ]; then say "waiting for $want"; waited_for="$want"; fi

  if [ "$MAX_WAIT" != "0" ] && [ $(( $(date +%s) - START )) -ge "$MAX_WAIT" ]; then
    say "gave up after ${MAX_WAIT}s waiting for $want — the command did NOT run"
    exit 75
  fi
  sleep "$POLL"
done

say "acquired ($OWNER, waited $(( $(date +%s) - START ))s)"

# --- run --------------------------------------------------------------------
cleanup() {
  # Only release a slot this process still owns (a stale-steal may have moved it).
  if [ -f "$OWNER_FILE" ] && [ "$(owner_pid)" = "$$" ]; then rm -rf "$SLOT_DIR"; fi
  release_ticket
}
trap 'cleanup' EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

"$@"
rc=$?
say "released ($OWNER, exit $rc, ran $(( $(date +%s) - START ))s including wait)"
exit "$rc"
