#!/usr/bin/env bash
# Behaviour test for scripts/lib/ci-claims.sh and the two readers that honour it
# (user decision 2026-10-26): a merge train's machine-wide marker makes
# `preflight-suite.sh --wait-foreign` in ANOTHER repo wait, and makes the
# Tracegate daemon's gate_live yield, from the train's claim through its installs.
#
# Hermetic: markers live in a temp OPENWOP_CI_CLAIMS_DIR, the preflight claim in
# a temp dir, its scans see only this script's descendants
# (OPENWOP_PREFLIGHT_TEST_ANCESTOR) and its load reads a fixed value.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ci-claims-test.XXXXXX")"
export OPENWOP_CI_CLAIMS_DIR="$TMP/claims"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; rm -rf "$TMP"; }
trap cleanup EXIT
pass=0; fail=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
# shellcheck source=lib/ci-claims.sh
. "$ROOT/scripts/lib/ci-claims.sh"

# A stand-in train in ANOTHER repo: a live process whose marker names that repo.
OTHER="$TMP/other-repo"; mkdir -p "$OTHER"; git -C "$OTHER" init -q
sleep 120 & TRAIN_PID=$!; PIDS+=("$TRAIN_PID")
( cd "$OTHER" && CI_CLAIM_PID="$TRAIN_PID" ci_claim_publish installing "#1 #2" )

echo "▶ ci-claims: markers"
live="$(ci_claims_live)"
grep -q "^$TRAIN_PID	" <<<"$live" && grep -q 'train installing #1 #2' <<<"$live" \
  && ok "a live train's marker is listed with its phase" || bad "live marker not listed: $live"
[ -z "$(ci_claims_live "$(git -C "$OTHER" rev-parse --path-format=absolute --git-common-dir)")" ] \
  && ok "its own repo is excluded when asked" || bad "own-repo exclusion failed"
# An unavailable start-time read must preserve a live marker. This is the
# preflight self-test's empty-ps arm; the old reader deleted the real gate's
# machine-wide marker and let the daemon restart beside its backend suite.
PS_EMPTY="$TMP/ps-empty"; mkdir -p "$PS_EMPTY"
printf '#!/bin/sh\nexit 0\n' > "$PS_EMPTY/ps"; chmod +x "$PS_EMPTY/ps"
live="$(PATH="$PS_EMPTY:$PATH" ci_claims_live)"
if grep -q "^$TRAIN_PID"$'\t' <<<"$live" && [ -f "$OPENWOP_CI_CLAIMS_DIR/$TRAIN_PID.claim" ]; then
  ok "an empty ps read preserves and reports the live marker"
else
  bad "an empty ps read erased or hid the live marker"
fi
# A reused pid: same pid alive, but the recorded start time is not its own.
sleep 120 & REUSED=$!; PIDS+=("$REUSED")
printf 'pid=%s\nstarted=Thu Jan  1 00:00:00 1970\ncommon=/x\nworktree=/x\nphase=installing\nlabel=\nat=x\n' "$REUSED" > "$OPENWOP_CI_CLAIMS_DIR/$REUSED.claim"
# A dead pid.
sleep 0 & DEAD=$!; wait "$DEAD" 2>/dev/null
printf 'pid=%s\nstarted=x\ncommon=/x\nworktree=/x\nphase=installing\nlabel=\nat=x\n' "$DEAD" > "$OPENWOP_CI_CLAIMS_DIR/$DEAD.claim"
live="$(ci_claims_live)"
! grep -q "^$REUSED	" <<<"$live" && [ ! -f "$OPENWOP_CI_CLAIMS_DIR/$REUSED.claim" ] \
  && ok "a reused pid (start time differs) does not keep a marker alive, and it is removed" || bad "reused-pid marker survived"
! grep -q "^$DEAD	" <<<"$live" && [ ! -f "$OPENWOP_CI_CLAIMS_DIR/$DEAD.claim" ] \
  && ok "a dead train's marker is ignored and removed" || bad "dead marker survived"

echo "▶ ci-claims: preflight --wait-foreign waits on another repo's train, then clears"
export OPENWOP_PREFLIGHT_TEST_ANCESTOR=$$ OPENWOP_PREFLIGHT_CLAIM_DIR="$TMP/claim" OPENWOP_PREFLIGHT_LOAD1=0.05 OPENWOP_PREFLIGHT_POLL_S=1
( cd "$ROOT" && bash scripts/preflight-suite.sh --wait --wait-foreign > "$TMP/wait.out" 2>&1; echo "rc=$?" >> "$TMP/wait.out" ) & W=$!; PIDS+=("$W")
for _ in $(seq 1 40); do grep -q 'another project is running' "$TMP/wait.out" 2>/dev/null && break; sleep 0.25; done
if grep -q 'another project is running' "$TMP/wait.out" && grep -q "pid $TRAIN_PID" "$TMP/wait.out" && ! grep -q '^rc=' "$TMP/wait.out"; then
  ok "a train installing in another repo holds the wait (and is named)"
else bad "the wait did not hold on the other repo's train: $(tr '\n' '|' < "$TMP/wait.out" | cut -c1-300)"; fi
# The train dies mid-install with no chance to clean up (SIGKILL): its marker stays
# on disk saying "installing", and must stop blocking once its pid is gone.
kill -KILL "$TRAIN_PID" 2>/dev/null; wait "$TRAIN_PID" 2>/dev/null
[ -f "$OPENWOP_CI_CLAIMS_DIR/$TRAIN_PID.claim" ] || bad "setup: the killed train's marker was already gone, so the arm below proves nothing"
for _ in $(seq 1 40); do grep -q '^rc=' "$TMP/wait.out" && break; sleep 0.25; done
grep -q '^rc=0' "$TMP/wait.out" && ok "...and clears once that train is SIGKILLed mid-install (its marker left on disk)" || bad "the wait did not clear: $(tail -3 "$TMP/wait.out" | tr '\n' '|')"
kill "$W" 2>/dev/null

echo "▶ ci-claims: the daemon yields to a train in any repo"
sleep 120 & T2=$!; PIDS+=("$T2"); ( cd "$OTHER" && CI_CLAIM_PID="$T2" ci_claim_publish claimed "#3" )
d="$(cat "$ROOT/scripts/tracegate-daemon.sh")"
fn="$(sed -n '/^gate_live() {$/,/^}$/p' <<<"$d")"
if bash -c "COMMON=$TMP/none; . '$ROOT/scripts/lib/ci-claims.sh'; pgrep() { return 1; }; $fn
gate_live" ; then ok "gate_live is true while a train's marker is live (no claim, no train process here)"; else bad "gate_live ignored the marker"; fi
kill "$T2" 2>/dev/null; wait "$T2" 2>/dev/null
if bash -c "COMMON=$TMP/none; . '$ROOT/scripts/lib/ci-claims.sh'; pgrep() { return 1; }; $fn
gate_live"; then bad "gate_live stayed true after the train ended"; else ok "...and false once it ends (the arm is not vacuous)"; fi

echo "▶ ci-claims: merge-train publishes before it installs"
mt="$(cat "$ROOT/scripts/merge-train.sh")"
claim_line="$(grep -n 'claim_train_lock "\$TRAIN_LOCK"' <<<"$mt" | cut -d: -f1)"
pub_line="$(grep -n '^ci_claim_publish claimed' <<<"$mt" | cut -d: -f1)"
[ -n "$pub_line" ] && [ -n "$claim_line" ] && [ "$pub_line" -gt "$claim_line" ] \
  && ok "the train publishes its marker right after it takes its lock" || bad "no marker after the train lock"
body="$(sed -n '/^ensure_deps() {$/,/^}$/p' <<<"$mt")"
first_pub="$(grep -n 'ci_claim_publish installing' <<<"$body" | head -1 | cut -d: -f1)"
first_ci="$(grep -nE 'npm(@[0-9.]+)? ci' <<<"$body" | head -1 | cut -d: -f1)"
[ -n "$first_pub" ] && [ -n "$first_ci" ] && [ "$first_pub" -lt "$first_ci" ] \
  && ok "ensure_deps marks the train 'installing' before its first npm ci" || bad "installing marker missing or after npm ci"

echo
echo "== ci-claims: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
