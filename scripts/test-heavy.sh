#!/usr/bin/env bash
# Behaviour test for scripts/heavy.sh (ADR 1166 D2 — the machine-wide slot).
#
# The slot exists because two heavy steps at once turn real work into false
# reds, so the things that matter are exactly the ones a happy-path test would
# miss: does a second step WAIT, does a waiting step ever run when told to give
# up, is a crashed holder replaced, and is the command's exit code passed
# through. Each arm below failed once in reasoning before it was written down.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/heavy-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }

HEAVY="$ROOT/scripts/heavy.sh"
export OPENWOP_HEAVY_SLOT_DIR="$TMP/slot"
export OPENWOP_HEAVY_QUEUE_DIR="$TMP/queue"
export OPENWOP_HEAVY_POLL=1       # 1 s polls keep the test short
unset OPENWOP_HEAVY_MIN_SWAP_MB OPENWOP_HEAVY_MAX_WAIT

echo "heavy.sh: the slot serialises, survives a crash, and never silently skips"

# 1. A plain step runs and passes its exit code through.
bash "$HEAVY" t:first -- true 2>/dev/null
[ $? -eq 0 ] && ok "runs a command" || bad "runs a command"
bash "$HEAVY" t:exit -- false 2>/dev/null
[ $? -eq 1 ] && ok "passes the command's exit code (false -> 1)" || bad "passes the command's exit code"
bash "$HEAVY" t:exit7 -- bash -c 'exit 7' 2>/dev/null
[ $? -eq 7 ] && ok "passes an arbitrary exit code (exit 7 -> 7)" || bad "passes an arbitrary exit code"

# 2. The slot is released after the step, so the next one does not wait.
[ -d "$OPENWOP_HEAVY_SLOT_DIR" ] && bad "slot released after the command" || ok "slot released after the command"

# 3. A second step WAITS for the first. This is the whole point: a slot that
#    does not serialise is worse than none, because it looks like a guard.
start=$(date +%s)
bash "$HEAVY" t:holder -- sleep 3 2>/dev/null &
holder=$!
sleep 0.5
bash "$HEAVY" t:waiter -- true 2>/dev/null
waited=$(( $(date +%s) - start ))
wait "$holder"
if [ "$waited" -ge 2 ]; then ok "a second step waits for the holder (${waited}s)"; else bad "a second step waits for the holder (only ${waited}s)"; fi

# 4. --max-wait gives up and does NOT run the command.
bash "$HEAVY" t:holder2 -- sleep 4 2>/dev/null &
holder2=$!
sleep 0.5
marker="$TMP/must-not-exist"
bash "$HEAVY" --max-wait 1 t:impatient -- touch "$marker" 2>/dev/null
rc=$?
wait "$holder2"
[ "$rc" -eq 75 ] && ok "gives up with exit 75 when the wait is exceeded" || bad "gives up with exit 75 (got $rc)"
[ -e "$marker" ] && bad "the command did NOT run after giving up" || ok "the command did NOT run after giving up"

# 5. A crashed holder is replaced, not waited on forever.
mkdir -p "$OPENWOP_HEAVY_SLOT_DIR"
printf 'owner=dead:crashed\npid=999999\nhost=test\nstarted=2026-01-01T00:00:00Z\ncommand=sleep 999\n' > "$OPENWOP_HEAVY_SLOT_DIR/owner"
bash "$HEAVY" --max-wait 20 t:after-crash -- true 2>"$TMP/crash.err"
[ $? -eq 0 ] && ok "replaces a stale slot whose pid is dead" || bad "replaces a stale slot whose pid is dead"
grep -q "stale slot" "$TMP/crash.err" && ok "says it replaced a stale slot" || bad "says it replaced a stale slot"

# 6. A live holder is never stolen, even by a waiter that then gives up.
bash "$HEAVY" t:live -- sleep 2 2>/dev/null &
live=$!
sleep 0.5
bash "$HEAVY" --max-wait 1 t:polite -- true 2>/dev/null
rc=$?
kill -0 "$live" 2>/dev/null && ok "a live holder is left running" || bad "a live holder is left running"
[ "$rc" -eq 75 ] && ok "a live holder is waited on, not stolen" || bad "a live holder is waited on, not stolen"
wait "$live"

# 7. Swap: below the floor it waits; the floor is overridable so the test does
#    not depend on this machine's swap state.
start=$(date +%s)
OPENWOP_HEAVY_MIN_SWAP_MB=99999999 bash "$HEAVY" --max-wait 2 t:swap -- true 2>"$TMP/swap.err"
rc=$?
if [ "$rc" -eq 75 ] && grep -q "swap" "$TMP/swap.err"; then ok "waits for free swap below the floor"; else bad "waits for free swap below the floor (rc=$rc)"; fi
OPENWOP_HEAVY_MIN_SWAP_MB=0 bash "$HEAVY" t:swap0 -- true 2>/dev/null
[ $? -eq 0 ] && ok "runs at a zero swap floor" || bad "runs at a zero swap floor"

# 8. --status reports the holder and the queue.
bash "$HEAVY" t:status -- sleep 2 2>/dev/null &
sholder=$!
sleep 0.5
out=$(bash "$HEAVY" --status 2>&1)
wait "$sholder"
case "$out" in *"holder: t:status"*) ok "--status names the holder" ;; *) bad "--status names the holder" ;; esac
case "$out" in *"swap free:"*) ok "--status reports swap" ;; *) bad "--status reports swap" ;; esac

# 9. Usage errors never run the command and never take the slot.
bash "$HEAVY" notanowner -- true >/dev/null 2>&1
[ $? -eq 64 ] && ok "refuses an owner without <session>:<step>" || bad "refuses an owner without <session>:<step>"
bash "$HEAVY" t:no-command >/dev/null 2>&1
[ $? -eq 64 ] && ok "refuses a missing command" || bad "refuses a missing command"

echo
if [ "$fail" -eq 0 ]; then echo "heavy.sh: ${pass}/${pass} passed"; else echo "heavy.sh: ${pass} passed, ${fail} FAILED"; fi
[ "$fail" -eq 0 ]
