#!/usr/bin/env bash
# The major-2 conformance lane as a BOTH-WAYS ratchet (#3644, ADR 0631).
#
#   bash scripts/check-conformance-major2.sh              # run the lane, then evaluate
#   OPENWOP_M2_LOG=<file> bash scripts/check-conformance-major2.sh   # evaluate an existing log (test seam)
#
# Evaluation: the set of `v2-*` scenario FILES that failed must equal the set in
# scripts/conformance-v2-known-red.txt. Unlisted red → fail (a new wire gap).
# Listed but green → fail (a stale admission; delete the line). Executed counts
# are printed beside pass counts (runbook §4.2c) so a green here is never a
# witness of nothing: zero v2 files executed is itself a failure.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# OPENWOP_M2_KNOWN_RED is a TEST seam (scripts/test-gate-tooling.sh): its synthetic
# logs must be judged against a list they control, not whatever the live list holds.
LIST="${OPENWOP_M2_KNOWN_RED:-$ROOT/scripts/conformance-v2-known-red.txt}"
LOG="${OPENWOP_M2_LOG:-}"
# #5916 — the RFC 0148 §A requirement ledger (JSONL, one disposition per row). The
# suite writes it to OPENWOP_LEDGER_PATH. OPENWOP_M2_LEDGER is the test seam that
# pairs a synthetic ledger with a synthetic log.
LEDGER="${OPENWOP_M2_LEDGER:-}"
BLOCKED_LIST="${OPENWOP_M2_KNOWN_BLOCKED:-$ROOT/scripts/conformance-v2-known-blocked.txt}"
RUN_RC=""
if [ -z "$LOG" ]; then
  LOG="$(mktemp "${TMPDIR:-/tmp}/owp-m2-lane.XXXXXX")"
  LEDGER="$LOG.ledger.jsonl"
  ( cd "$ROOT/backend/typescript" && OPENWOP_LEDGER_PATH="$LEDGER" OPENWOP_TARGET_MAJOR=2 npm run test:conformance ) > "$LOG" 2>&1
  RUN_RC=$?
  echo "  lane log: $LOG (suite exit $RUN_RC) · ledger: $LEDGER"
fi
strip() { sed 's/\x1b\[[0-9;]*m//g' "$LOG"; }
PASS=$(strip | grep -acE '✓ src/scenarios/v2-[^ ]+\.test\.ts')
RED=$(strip | grep -aoE '❯ src/scenarios/v2-[^ ]+\.test\.ts \([0-9]+ tests? \| [0-9]+ failed\)' | sed -E 's/❯ src\/scenarios\/(v2-[^ ]+)\.test\.ts.*/\1/' | sort -u)
# A leading `~` marks an entry that is ADMITTED but currently INVISIBLE to the
# lane — the scenario soft-skips instead of redding, so the defect is real and
# unfixed while the file no longer fails. Without this the ratchet reports it
# STALE and instructs a deletion that would record a live MUST violation as
# closed. Such an entry is still in EXPECTED (so a return to red is admitted, not
# UNLISTED) and is excluded from the STALE check only.
#
# It is NOT a quiet escape hatch: every `~` entry is PRINTED on every run below,
# because invisibility is the exact failure mode being accommodated. Each one
# carries the upstream condition that retires it.
EXPECTED=$(grep -vE '^\s*(#|$)' "$LIST" | sed -E 's/[[:space:]]*#.*$//; s/[[:space:]]+$//; s/^~//' | sort -u)
SOFTSKIP=$(grep -E '^\s*~' "$LIST" | sed -E 's/[[:space:]]*#.*$//; s/[[:space:]]+$//; s/^\s*~//' | sort -u)
EXECUTED=$(( PASS + $(printf '%s\n' "$RED" | grep -c .) ))
echo "  v2 files executed: $EXECUTED (pass $PASS, red $(printf '%s\n' "$RED" | grep -c .)) | known-red list: $(printf '%s\n' "$EXPECTED" | grep -c .)"
fail=0
# THE RUN MUST HAVE FINISHED (2026-09-23, ADR 0743 handover). This script used to
# discard the suite's exit status, and its only liveness check was "zero v2 files
# executed" — so a run the watchdog KILLED after one v2 file (exit 124, 824 log
# lines, MEASURED) printed `✓ … red set == known-red list` and exited 0. A partial
# log is not a lane result: every scenario that never ran is indistinguishable
# from one that passed. Require vitest's closing summary, and refuse a watchdog
# kill outright. (A red run exits non-zero too, which is why the rc alone is not
# the verdict — the red SET is compared below.)
if ! strip | grep -qE '^ +Test Files +[0-9]'; then
  echo "  ✗ the suite never printed its summary — the run did not finish (hung, killed, or crashed); nothing below is a lane result"; fail=1
fi
if [ "$RUN_RC" = "124" ] || strip | grep -q 'WATCHDOG: the suite did not exit'; then
  echo "  ✗ the conformance watchdog killed this run (exit 124) — a partial log is not a lane result"; fail=1
fi
if [ "$EXECUTED" -eq 0 ]; then echo "  ✗ zero v2 scenario files executed — the lane ran nothing (wrong target major, or the log is not a lane log)"; fail=1; fi
UNEXPECTED=$(comm -23 <(printf '%s\n' "$RED" | grep .) <(printf '%s\n' "$EXPECTED" | grep .))
STALE=$(comm -13 <(printf '%s\n' "$RED" | grep .) <(printf '%s\n' "$EXPECTED" | grep .) | comm -23 - <(printf '%s\n' "$SOFTSKIP" | grep .))
if [ -n "$(printf '%s\n' "$SOFTSKIP" | grep .)" ]; then
  echo "  ⚠ ADMITTED BUT INVISIBLE — the scenario soft-skips, so the lane cannot see this defect (NOT fixed):"
  printf '%s\n' "$SOFTSKIP" | grep . | sed 's/^/      /'
fi
if [ -n "$UNEXPECTED" ]; then echo "  ✗ UNLISTED red at major 2 (a new wire gap — fix it or admit it in $LIST with a reason):"; printf '%s\n' "$UNEXPECTED" | sed 's/^/      /'; fail=1; fi
if [ -n "$STALE" ]; then echo "  ✗ STALE known-red entry — the file passes now; delete its line from $LIST:"; printf '%s\n' "$STALE" | sed 's/^/      /'; fail=1; fi
# BLOCKED IS NOT PASS (#5916, the openwop#2093 class). A scenario whose host
# stopped answering soft-skips: vitest prints ✓ for the file, so the red set
# above cannot see it, and the ledger records the row `blocked`. If the lane's
# backend dies mid-run, every later gated file reads as a pass. So read the
# ledger and fail closed on any blocked row not admitted in $BLOCKED_LIST (both
# ways, like the known-red list), and on a ledger that is missing or empty: no
# ledger means no way to tell blocked from passed.
if [ -z "$LEDGER" ] || [ ! -s "$LEDGER" ]; then
  echo "  ✗ no requirement ledger (${LEDGER:-unset}) — cannot tell a blocked scenario from a passing one, so this is not a lane result"; fail=1
else
  COUNTS=$(node -e 'const c={};for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;let d;try{d=JSON.parse(l).disposition}catch{continue}c[d]=(c[d]||0)+1}console.log(Object.entries(c).map(([k,v])=>k+" "+v).join(" · "))' "$LEDGER")
  echo "  dispositions: ${COUNTS:-none}"
  BLOCKED=$(node -e 'const s=new Set();for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;let e;try{e=JSON.parse(l)}catch{continue}if(e.disposition==="blocked")s.add(String(e.requirementId||"(unnamed)"))}console.log([...s].sort().join("\n"))' "$LEDGER" | grep . | sort -u)
  KNOWN_BLOCKED=""
  [ -f "$BLOCKED_LIST" ] && KNOWN_BLOCKED=$(grep -vE '^\s*(#|$)' "$BLOCKED_LIST" | sed -E 's/[[:space:]]*#.*$//; s/[[:space:]]+$//' | sort -u)
  NEW_BLOCKED=$(comm -23 <(printf '%s\n' "$BLOCKED" | grep .) <(printf '%s\n' "$KNOWN_BLOCKED" | grep .))
  STALE_BLOCKED=$(comm -13 <(printf '%s\n' "$BLOCKED" | grep .) <(printf '%s\n' "$KNOWN_BLOCKED" | grep .))
  if [ -n "$NEW_BLOCKED" ]; then echo "  ✗ UNADMITTED blocked requirement(s) — the scenario could not run, and vitest counted it as a pass (admit in $BLOCKED_LIST with a reason, or fix the host):"; printf '%s\n' "$NEW_BLOCKED" | sed 's/^/      /'; fail=1; fi
  if [ -n "$STALE_BLOCKED" ]; then echo "  ✗ STALE known-blocked entry — the requirement is no longer blocked; delete its line from $BLOCKED_LIST:"; printf '%s\n' "$STALE_BLOCKED" | sed 's/^/      /'; fail=1; fi
fi
if [ "$fail" -eq 0 ]; then echo "  ✓ conformance@major2: red set == known-red list ($(printf '%s\n' "$RED" | grep -c .) admitted), blocked set == known-blocked list ($(printf '%s\n' "$BLOCKED" | grep -c .) admitted), $PASS pass"; fi
exit "$fail"
