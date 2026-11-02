#!/usr/bin/env bash
#
# Tests for `scripts/preflight-suite.sh --check-gate-age=<sec>` (ADR 0863, loop rule R1:
# "no targeted vitest while a merge-train gate is under 4 minutes old").
#
# R1 was broken twice by agents hand-parsing `ps` (macOS has no `etimes`; a grep
# matched only a literal "[gate]"). This mode is the one detector, so its YOUNG arm
# must be observed firing, not assumed: every exit-1 case below goes red against a
# stub that always exits 0 (run with OPENWOP_PREFLIGHT_TEST_PF=<stub> to see it).
#
#   young    a live foreign claim started just now           -> exit 1, age printed
#   old      the same claim, aged past the threshold         -> exit 0
#   unknown  a start time and an etime that will not parse,
#            or a claim still being written                  -> exit 1 (fail closed)
#   none     no claim and no gate in another worktree        -> exit 0
#   plus     the ps-etime fallback parses [[dd-]hh:]mm:ss, our own claim never
#            counts, and an UNCLAIMED scripts/ci.sh in another worktree is aged
#
set -uo pipefail
# Hermetic, as in test-preflight-suite.sh: scrub the script's knobs and seams.
for v in $(env | grep -oE '^OPENWOP_(CI|PREFLIGHT)_[A-Z0-9_]+' | grep -v '^OPENWOP_PREFLIGHT_TEST_'); do unset "$v"; done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PF="${OPENWOP_PREFLIGHT_TEST_PF:-$ROOT/scripts/preflight-suite.sh}"
TMP="$(mktemp -d)"
OTHER_WT="$TMP/other-worktree"
declare -a PIDS=()
fails=0
# The claim and the machine-wide markers live in scratch dirs: no arm may reach a
# real gate's claim. Scans see only this harness's descendants.
CLAIM="$TMP/claim"
export OPENWOP_PREFLIGHT_CLAIM_DIR="$CLAIM"
export OPENWOP_CI_CLAIMS_DIR="$TMP/ci-claims"
export OPENWOP_PREFLIGHT_TEST_ANCESTOR=$$
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "${p:-}" ] && { pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; }; done
  git -C "$ROOT" worktree remove --force "$OTHER_WT" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
cd "$TMP" || exit 2

ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; fails=$((fails + 1)); }
show() { printf '%s\n' "$1" | sed 's/^/      /'; }

# A `ps` whose process LISTING is empty (no real suite reaches an arm) and whose
# lstart / etime answers are scripted: lstart prints nothing (so a claim whose start
# time cannot be read is KEPT, per GATE-CLAIM-1) and etime prints $STUB_ETIME.
PSSTUB="$TMP/psstub"; mkdir -p "$PSSTUB"
cat > "$PSSTUB/ps" <<'SH'
#!/bin/sh
case " $* " in
  *" -Ao "*) exit 0 ;;
  *lstart=*) [ -n "${STUB_LSTART:-}" ] && printf '%s\n' "$STUB_LSTART"; exit 0 ;;
  *etime=*)  [ -n "${STUB_ETIME:-}" ] && printf '%s\n' "$STUB_ETIME"; exit 0 ;;
esac
exec /bin/ps "$@"
SH
chmod +x "$PSSTUB/ps"
EMPTY_LIST="$TMP/emptylist"; mkdir -p "$EMPTY_LIST"
cat > "$EMPTY_LIST/ps" <<'SH'
#!/bin/sh
case " $* " in *" -Ao "*) exit 0 ;; esac
exec /bin/ps "$@"
SH
chmod +x "$EMPTY_LIST/ps"

write_claim() { rm -rf "$CLAIM"; mkdir -p "$CLAIM"; printf '%s\t%s\t%s\n' "$1" "$2" "$3" > "$CLAIM/info"; }
lstart() { /bin/ps -o lstart= -p "$1" | sed 's/^ *//;s/ *$//'; }
age_of() { sed -n 's/^gate-age: \([0-9][0-9]*\)s .*/\1/p' <<<"$1" | head -1; }

printf '\n\033[1m▶ test-preflight-gate-age\033[0m\n'

sleep 600 & LIVE=$!; PIDS+=("$LIVE")
write_claim "$LIVE" "$(lstart "$LIVE")" /elsewhere/peer-gate

# --- young ----------------------------------------------------------------------
out="$(PATH="$EMPTY_LIST:$PATH" "$PF" --check-gate-age=3600 2>&1)"; rc=$?
a="$(age_of "$out")"
if [ "$rc" -eq 1 ] && [ -n "$a" ] && [ "$a" -lt 60 ] && grep -q "pid $LIVE " <<<"$out" && grep -q '/elsewhere/peer-gate' <<<"$out"; then
  ok "young: a gate claimed ${a}s ago is YOUNG (exit 1), printing age, pid and worktree"
else
  bad "young: expected exit 1 with age/pid/worktree (rc=$rc)"; show "$out"
fi
[ -f "$CLAIM/info" ] && ok "young: checking the age leaves the live claim in place" || bad "the age check deleted a live claim"

# --- old ------------------------------------------------------------------------
sleep 3
out="$(PATH="$EMPTY_LIST:$PATH" "$PF" --check-gate-age=2 2>&1)"; rc=$?
a="$(age_of "$out")"
if [ "$rc" -eq 0 ] && [ -n "$a" ] && [ "$a" -ge 2 ] && grep -q "pid $LIVE " <<<"$out"; then
  ok "old: the same claim at ${a}s against a 2s threshold is old (exit 0), age printed"
else
  bad "old: expected exit 0 with an age >= 2 (rc=$rc)"; show "$out"
fi

# --- DST: a local start time that reads OLDER than the process really is ---------
# `ps -o lstart` has no offset. 01:30 on 2026-11-01 happens twice in New York, and
# `date` resolves it to EDT, an hour early. The claim's start time then says "old"
# while etime says the gate started 30 s ago. The younger reading must win: a young
# gate must never pass as old (the R1 hazard). Red on the lstart-only code, which
# read "gate-age: 3600s … old" for every gate started between 06:00 and 07:00Z.
DST_LSTART="Sun Nov  1 01:30:00 2026"
write_claim "$LIVE" "$DST_LSTART" /elsewhere/peer-gate
out="$(PATH="$PSSTUB:$PATH" TZ=America/New_York STUB_LSTART="$DST_LSTART" STUB_ETIME="00:30" "$PF" --check-gate-age=240 2>&1)"; rc=$?
a="$(age_of "$out")"
if [ "$rc" -eq 1 ] && [ "$a" = 30 ]; then
  ok "dst: an ambiguous local start time cannot make a 30s-old gate read as old (exit 1, age 30)"
else
  bad "dst: a gate 30s old by etime must be YOUNG whatever its local start time says (rc=$rc, age=$a)"; show "$out"
fi
# and the other direction: a start time that reads YOUNGER than etime is kept.
# The stamp is made and read in UTC, which has no DST, so it is never ambiguous
# (the live process's own lstart is not usable here: run inside a fall-back hour,
# it is the very bug above).
UTC_LSTART="$(TZ=UTC LC_ALL=C date '+%a %b %e %T %Y')"
write_claim "$LIVE" "$UTC_LSTART" /elsewhere/peer-gate
out="$(PATH="$PSSTUB:$PATH" TZ=UTC STUB_LSTART="$UTC_LSTART" STUB_ETIME="2-00:00:00" "$PF" --check-gate-age=240 2>&1)"; rc=$?
a="$(age_of "$out")"
if [ "$rc" -eq 1 ] && [ -n "$a" ] && [ "$a" -lt 240 ]; then
  ok "dst: when the start time is the younger reading it wins (age ${a}s, exit 1)"
else
  bad "dst: the younger of start time and etime must win (rc=$rc, age=$a)"; show "$out"
fi

# --- unknown / unparseable -----------------------------------------------------
write_claim "$LIVE" "not a date" /elsewhere/peer-gate
out="$(PATH="$PSSTUB:$PATH" STUB_ETIME="" "$PF" --check-gate-age=240 2>&1)"; rc=$?
if [ "$rc" -eq 1 ] && grep -q "gate-age: unknown pid $LIVE worktree /elsewhere/peer-gate" <<<"$out"; then
  ok "unknown: an unparseable start time and no etime is YOUNG (exit 1), printed as 'unknown'"
else
  bad "unknown: an unreadable age did not fail closed (rc=$rc)"; show "$out"
fi
out="$(PATH="$PSSTUB:$PATH" STUB_ETIME="garbage" "$PF" --check-gate-age=240 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && grep -q 'gate-age: unknown' <<<"$out" && ok "unknown: an unparseable etime is YOUNG (exit 1)" \
  || { bad "unknown: a garbage etime did not fail closed (rc=$rc)"; show "$out"; }
rm -rf "$CLAIM"; mkdir -p "$CLAIM"; : > "$CLAIM/info"
out="$(PATH="$PSSTUB:$PATH" "$PF" --check-gate-age=240 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && grep -q 'gate-age: unknown.*(claim being written)' <<<"$out" \
  && ok "unknown: a claim still being written is YOUNG (exit 1)" \
  || { bad "unknown: a claim mid-write did not fail closed (rc=$rc)"; show "$out"; }

# --- the ps etime fallback, as macOS prints it: [[dd-]hh:]mm:ss ----------------
write_claim "$LIVE" "not a date" /elsewhere/peer-gate
for case_ in "1-02:03:04 93784 0" "02:03:04 7384 0" "05:00 300 0" "03:59 239 1"; do
  set -- $case_
  out="$(PATH="$PSSTUB:$PATH" STUB_ETIME="$1" "$PF" --check-gate-age=240 2>&1)"; rc=$?
  [ "$rc" -eq "$3" ] && [ "$(age_of "$out")" = "$2" ] && ok "fallback: etime $1 reads as ${2}s (exit $3)" \
    || { bad "fallback: etime $1 should read ${2}s and exit $3 (rc=$rc)"; show "$out"; }
done

# --- none -------------------------------------------------------------------------
rm -rf "$CLAIM"
out="$(PATH="$EMPTY_LIST:$PATH" "$PF" --check-gate-age=240 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^gate-age: none' <<<"$out" && ok "none: no claim and no gate exits 0 and says 'none'" \
  || { bad "none: expected exit 0 and 'gate-age: none' (rc=$rc)"; show "$out"; }
write_claim "$LIVE" "$(lstart "$LIVE")" "$(cd "$ROOT" && pwd -P)"
out="$(PATH="$EMPTY_LIST:$PATH" "$PF" --check-gate-age=3600 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^gate-age: none' <<<"$out" && ok "none: a claim from THIS worktree is our own gate and never counts" \
  || { bad "our own claim counted as another worktree's gate (rc=$rc)"; show "$out"; }
rm -rf "$CLAIM"

# --- an UNCLAIMED gate (OPENWOP_CI_NO_WAIT=1 takes no claim) in another worktree --
if git -C "$ROOT" worktree add -q --detach "$OTHER_WT" HEAD 2>/dev/null; then
  mkdir -p "$TMP/fake-gate/scripts"
  printf 'sleep 600 & c=$!; trap '"'"'kill $c 2>/dev/null; exit 0'"'"' TERM INT; wait $c\n' > "$TMP/fake-gate/scripts/ci.sh"
  ( cd "$OTHER_WT" && exec bash "$TMP/fake-gate/scripts/ci.sh" ) & GATE=$!; PIDS+=("$GATE")
  for _ in $(seq 1 40); do ps -o command= -p "$GATE" 2>/dev/null | grep -q 'scripts/ci.sh' && break; sleep 0.25; done
  out="$("$PF" --check-gate-age=3600 2>&1)"; rc=$?
  [ "$rc" -eq 1 ] && grep -q "pid $GATE worktree $(cd "$OTHER_WT" && pwd -P) (unclaimed" <<<"$out" \
    && ok "unclaimed: a scripts/ci.sh in another worktree with no claim is aged from ps etime (exit 1)" \
    || { bad "unclaimed: a running gate with no claim was missed (rc=$rc)"; show "$out"; }
  kill "$GATE" 2>/dev/null; wait "$GATE" 2>/dev/null
else
  bad "could not create the scratch worktree for the unclaimed-gate arm"
fi

"$PF" --check-gate-age=4m >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "a non-numeric threshold is a usage error (exit 2)" || bad "--check-gate-age=4m should exit 2 (got $rc)"

kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null

printf '\n'
if [ "$fails" -eq 0 ]; then printf '\033[32m✓ preflight gate-age: all arms pass\033[0m\n\n'; exit 0; fi
printf '\033[31m✗ preflight gate-age: %d assertion(s) failed\033[0m\n\n' "$fails"
exit 1
