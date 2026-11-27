#!/usr/bin/env bash
# test-tracegate-daemon-portability.sh — tracegate-daemon.sh runs on Linux as well as macOS
# (DeckTalk's Cloud Build gate tooling, 2026-11-26). Two macOS-only calls broke it there:
#  - BSD `date -r <epoch>`, which GNU reads as a reference FILE ("date: <N>: No such file or
#    directory"). `epoch_date` now tries GNU `-d @N` first, then BSD;
#  - `exec taskpolicy -c utility nice …`, which fails 127 where there is no taskpolicy.
#    `PRIO` is that prefix where taskpolicy exists, and empty elsewhere.
#
# Each case runs the helper with a FAKE `date` first on PATH: one behaves like GNU
# (`-d @N`; `-r` takes a file), one like BSD (`-r N`; no `-d`). Both fakes convert epochs
# through the machine's real `date`, whichever flavour it is, so this runs on macOS and
# Linux alike.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/owp-epoch-date-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = 0 ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1${3:+ — $3}"; fail=$((fail+1)); fi; }

REAL_DATE="$(command -v date)"
# How the real date formats an epoch: GNU `-d @N`, else BSD `-r N`.
if "$REAL_DATE" -u -d @0 +%Y >/dev/null 2>&1; then REAL_EPOCH='-d @'; else REAL_EPOCH='-r '; fi

mkdir -p "$T/gnu" "$T/bsd"
# GNU-like: `-d @N` formats N; `-r X` is a reference FILE and fails when X is not one.
cat > "$T/gnu/date" <<EOF
#!/usr/bin/env bash
args=(); epoch=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -d) epoch="\${2#@}"; shift 2 ;;
    -r) [ -e "\$2" ] || { echo "date: \$2: No such file or directory" >&2; exit 1; }; args+=("\$1" "\$2"); shift 2 ;;
    *) args+=("\$1"); shift ;;
  esac
done
if [ -n "\$epoch" ]; then exec "$REAL_DATE" ${REAL_EPOCH}"\$epoch" "\${args[@]}"; fi
exec "$REAL_DATE" "\${args[@]}"
EOF
# BSD-like: no `-d` at all; `-r N` formats N.
cat > "$T/bsd/date" <<EOF
#!/usr/bin/env bash
args=(); epoch=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -d) echo "date: illegal option -- d" >&2; exit 1 ;;
    -r) epoch="\$2"; shift 2 ;;
    *) args+=("\$1"); shift ;;
  esac
done
if [ -n "\$epoch" ]; then exec "$REAL_DATE" ${REAL_EPOCH}"\$epoch" "\${args[@]}"; fi
exec "$REAL_DATE" "\${args[@]}"
EOF
chmod +x "$T/gnu/date" "$T/bsd/date"

# The helper exactly as the daemon defines it (one line), so this tests the shipped code.
helper="$(grep -E '^epoch_date\(\) \{' "$ROOT/scripts/tracegate-daemon.sh")"
[ -n "$helper" ]; check "the daemon defines epoch_date on one line" $?
eval "$helper"

for flavour in gnu bsd; do
  out="$(PATH="$T/$flavour:$PATH" epoch_date 86400 -u +%Y-%m-%dT%H:%M:%SZ 2>&1)"
  [ "$out" = "1970-01-02T00:00:00Z" ]
  check "$flavour date: epoch_date formats an epoch in UTC (the 20 h window's since)" $? "$out"
  out="$(PATH="$T/$flavour:$PATH" epoch_date 0 -u 2>&1)"
  [ -n "$out" ] && ! grep -q 'No such file\|illegal option' <<<"$out"
  check "$flavour date: epoch_date with no format (the status line) prints a date" $? "$out"
done

# Witness: the old BSD-only call fails under GNU, so the fake reproduces the Linux bug.
out="$(PATH="$T/gnu:$PATH" date -u -r 1795633052 +%Y 2>&1)"; rc=$?
[ "$rc" != 0 ] && grep -q 'No such file or directory' <<<"$out"
check "witness: the old \`date -r <epoch>\` fails on GNU date exactly as reported" $? "rc=$rc $out"

# No other BSD-only epoch call is left in the daemon.
! grep -nE '\bdate\b[^#]*[[:space:]]-r[[:space:]]+["$]' "$ROOT/scripts/tracegate-daemon.sh" | grep -v '^[0-9]*:epoch_date()'
check "tracegate-daemon.sh has no other \`date -r <epoch>\`" $?

# ── taskpolicy ──
# A Linux-like PATH: the GNU-style date first, and no /usr/sbin or /sbin, which on macOS
# hides exactly taskpolicy and sysctl.
LINUX_PATH="$T/gnu:$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxE '/usr/sbin|/sbin' | paste -sd: -)"
prio_of() { # prio_of <PATH> → the daemon's PRIO, as the sourced daemon sets it
  ( PATH="$1"; export OPENWOP_DAEMON_SOURCE_ONLY=1 OPENWOP_TRACEGATE_LEDGER="$T/dledger" OPENWOP_TRACEGATE_WORK="$T/work" OPENWOP_TRACEGATE_STDOUT_IS_LOG=1
    . "$ROOT/scripts/tracegate-daemon.sh" >/dev/null 2>&1; printf '%s' "${PRIO[*]:-}" )
}
PATH="$LINUX_PATH" command -v taskpolicy >/dev/null 2>&1
[ $? != 0 ]; check "precondition: the Linux-like PATH has no taskpolicy" $?
out="$(prio_of "$LINUX_PATH")"
[ -z "$out" ]; check "no taskpolicy: PRIO is empty" $? "PRIO='$out'"
( PATH="$LINUX_PATH"; PRIO=(); exec ${PRIO[@]+"${PRIO[@]}"} nice -n 15 true ); rc=$?
[ "$rc" = 0 ]; check "no taskpolicy: the daemon's exec shape runs under nice (set -u safe)" $? "rc=$rc"
( set -u; PATH="$LINUX_PATH"; PRIO=(); exec ${PRIO[@]+"${PRIO[@]}"} nice -n 15 true ); rc=$?
[ "$rc" = 0 ]; check "no taskpolicy: the same under set -u" $? "rc=$rc"
( PATH="$LINUX_PATH"; exec taskpolicy -c utility nice -n 15 true ) 2>/dev/null; rc=$?
[ "$rc" = 127 ]; check "witness: the old \`exec taskpolicy …\` fails 127 there" $? "rc=$rc"
if command -v taskpolicy >/dev/null 2>&1; then
  out="$(prio_of "$PATH")"
  [ "$out" = "taskpolicy -c utility" ]; check "macOS: PRIO is taskpolicy -c utility" $? "PRIO='$out'"
fi
! grep -nE 'exec taskpolicy' "$ROOT/scripts/tracegate-daemon.sh" | grep -vE '^[0-9]+:[[:space:]]*#'
check "tracegate-daemon.sh has no unguarded \`exec taskpolicy\`" $?

echo "tracegate-daemon portability: $pass passed, $fail failed"
[ "$fail" = 0 ]
