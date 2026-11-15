#!/usr/bin/env bash
# ADR 1028 P1b — the gate's package step (`tracegate-package.sh shadow-compare`) can never
# fail the gate or hold it past its timeout. Fake package CLIs stand in for the package:
# one that selects, one that exits non-zero, one that hangs (with a child process). The
# last case is a sabotage witness: with the timeout removed, the hang is NOT bounded.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/tracegate-package.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/owp-tg-pkg-test.XXXXXX")"
trap 'pkill -9 -f "$T/hang.cjs" 2>/dev/null; pkill -f "owp-tg-pkg-hang-$$" 2>/dev/null; rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = 0 ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1${3:+ — $3}"; fail=$((fail+1)); fi; }

fork="$T/fork"; mkdir -p "$fork"
printf '%s\n' "$ROOT/a.test.ts" "$ROOT/b.test.ts" "$ROOT/c.test.ts" > "$fork/selected.txt"
# As the package does in shadow: selected.txt is the whole lane; predict.json says what
# it would run (a, b and d; not c).
cat > "$T/good.mjs" <<EOF
const run = process.argv[process.argv.indexOf('--run') + 1];
require('fs').writeFileSync(run + '/selected.txt', ['$ROOT/a.test.ts', '$ROOT/b.test.ts', '$ROOT/c.test.ts', '$ROOT/d.test.ts'].join('\n') + '\n');
require('fs').writeFileSync(run + '/predict.json', JSON.stringify({ decisions: { 'a.test.ts': { run: true }, 'b.test.ts': { run: true }, 'c.test.ts': { run: false }, 'd.test.ts': { run: true } } }));
EOF
mv "$T/good.mjs" "$T/good.cjs"
printf 'process.exit(3);\n' > "$T/bad.cjs"
printf "require('child_process').spawn('sh', ['-c', 'exec -a owp-tg-pkg-hang-%s sleep 600'], { stdio: 'ignore' }); setInterval(() => {}, 1000);\n" "$$" > "$T/hang.cjs"

shadow() { # shadow <fake cli> [timeout] → exit code; the row lands in $T/ledger
  TRACEGATE_PACKAGE_CLI="node $1" TRACEGATE_PACKAGE_LEDGER="$T/ledger" TRACEGATE_PACKAGE_TIMEOUT_S="${2:-30}" \
    bash "$SCRIPT" shadow-compare frontend "$fork" >"$T/out.txt" 2>&1
}
last() { tail -1 "$T/ledger/compare-frontend.tsv" | cut -f"$1"; }

echo "▶ tracegate-package shadow-compare (ADR 1028 P1b)"
# A log from before the `basis` column is set aside, not appended to.
mkdir -p "$T/ledger" && printf 'at\thead\tstatus\tsecs\tfork\tpackage\tonly_fork\tonly_package\tsuperset\nold\n' > "$T/ledger/compare-frontend.tsv"
shadow "$T/good.cjs"; rc=$?
check "a selection is compared and logged: exit 0" "$rc"
[ "$(last 3)" = ok ] && [ "$(last 5)" = 3 ] && [ "$(last 6)" = 3 ] && [ "$(last 7)" = 1 ] && [ "$(last 8)" = 1 ] && [ "$(last 9)" = no ]
check "...with fork 3, package 3, 1 only the fork runs, 1 only the package, not a superset" $? "$(tail -1 "$T/ledger/compare-frontend.tsv")"
[ "$(last 10)" = predict ]
check "...read from predict.json (what it would run), not its whole-lane selected.txt" $? "$(tail -1 "$T/ledger/compare-frontend.tsv")"
ls "$T"/ledger/compare-frontend.before-*.tsv >/dev/null 2>&1 && ! grep -q '^old$' "$T/ledger/compare-frontend.tsv" && head -1 "$T/ledger/compare-frontend.tsv" | grep -q 'basis$'
check "...and an older log (no basis column) is set aside, not mixed in" $?

shadow "$T/bad.cjs"; rc=$?
check "a package that exits non-zero leaves the gate green (exit 0)" "$rc"
[ "$(last 3)" = error-3 ] && grep -q "ignored" "$T/out.txt"
check "...logged as error-3 and printed as ignored" $? "$(cat "$T/out.txt")"

t0=$(date +%s); shadow "$T/hang.cjs" 2; rc=$?; secs=$(( $(date +%s) - t0 ))
check "a package that hangs is killed: exit 0" "$rc"
[ "$secs" -le 10 ] && [ "$(last 3)" = timeout ]
check "...within its timeout (2 s here; took ${secs}s), logged as timeout" $?
sleep 0.5; ! pgrep -f "owp-tg-pkg-hang-$$" >/dev/null
check "...and the process it started is killed with it" $?

TRACEGATE_PACKAGE_LEDGER="$T/ledger" bash "$SCRIPT" shadow-compare frontend "$T/no-such-run" >/dev/null 2>&1
check "no fork selection: skipped, exit 0" $?

# A package that writes REPO-RELATIVE paths is compared on the same footing as the fork's
# absolute ones (both are normalised), so a format difference can't read as 0 overlap.
printf "require('fs').writeFileSync(process.argv[process.argv.indexOf('--run') + 1] + '/selected.txt', 'a.test.ts\\\\nb.test.ts\\\\nc.test.ts\\\\n');\n" > "$T/relative.cjs"
shadow "$T/relative.cjs"; rc=$?
[ "$rc" = 0 ] && [ "$(last 3)" = ok ] && [ "$(last 7)" = 0 ] && [ "$(last 8)" = 0 ] && [ "$(last 9)" = yes ]
check "a relative selection matches the fork's absolute one (0 only-fork, 0 only-package)" $? "$(tail -1 "$T/ledger/compare-frontend.tsv")"

# Not installed: a checkout whose root node_modules predates P1a. The step must not reach
# for npx (a network fetch inside the gate); a fake npx on PATH fails the case if called.
repo="$T/repo"; mkdir -p "$repo/scripts" "$T/bin"
git -C "$repo" init -q && cp "$SCRIPT" "$ROOT/scripts/tracegate-package.config.json" "$repo/scripts/"
printf '#!/bin/sh\ntouch "%s/npx-called"\nexit 0\n' "$T" > "$T/bin/npx"; chmod +x "$T/bin/npx"
( cd "$repo" && PATH="$T/bin:$PATH" TRACEGATE_PACKAGE_LEDGER="$T/ledger3" bash scripts/tracegate-package.sh shadow-compare frontend "$fork" >"$T/out.txt" 2>&1 ); rc=$?
[ "$rc" = 0 ] && [ ! -e "$T/npx-called" ] && [ "$(tail -1 "$T/ledger3/compare-frontend.tsv" | cut -f3)" = not-installed ] && grep -q "not in this checkout's root node_modules" "$T/out.txt"
check "not installed: skipped as not-installed, exit 0, and npx never called" $? "$(cat "$T/out.txt")"

grep -qF '[ -n "$TG_RUN" ] && { bash "$ROOT/scripts/tracegate-package.sh" shadow-compare frontend "$TG_RUN" || true; }' "$ROOT/scripts/ci.sh"
check "the gate calls it guarded by || true, after the fork's frontend selection" $?

# record: under a daemon lease on the fork's broker. A fake broker logs its argv and the
# environment it was started with, then runs the command after `--` (or exits as told).
cat > "$T/broker.cjs" <<'JS'
const fs = require('fs'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2); const i = a.indexOf('--');
fs.writeFileSync(process.env.FAKE_BROKER_LOG, JSON.stringify({ args: a.slice(0, i), config: process.env.TRACEGATE_CONFIG || '', ledger: process.env.TRACEGATE_LEDGER || '' }));
if (process.env.FAKE_BROKER_EXIT) process.exit(Number(process.env.FAKE_BROKER_EXIT));
process.exit(spawnSync(a[i + 1], a.slice(i + 2), { stdio: 'inherit' }).status);
JS
printf "require('fs').writeFileSync(process.env.FAKE_RUN_LOG, JSON.stringify({ args: process.argv.slice(2), config: process.env.TRACEGATE_CONFIG, ledger: process.env.TRACEGATE_LEDGER }));\n" > "$T/run.cjs"
record() { # record [broker exit] → exit code; logs in $T/broker.json and $T/run.json
  rm -f "$T/broker.json" "$T/run.json"
  FAKE_BROKER_LOG="$T/broker.json" FAKE_RUN_LOG="$T/run.json" FAKE_BROKER_EXIT="${1:-}" OPENWOP_TRACEGATE_LEDGER="$T/fork-ledger" \
    TRACEGATE_PACKAGE_CLI="node $T/run.cjs" TRACEGATE_PACKAGE_LEDGER="$T/ledger" TRACEGATE_PACKAGE_BROKER="$T/broker.cjs" \
    bash "$SCRIPT" record frontend >"$T/out.txt" 2>&1
}
record; rc=$?
node -e '
const fs = require("fs"); const b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")), r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const [root, T] = process.argv.slice(3);
process.exit(b.args.join(" ").includes("lease --quiet --class daemon --tokens 2") && b.config === "" && b.ledger === T + "/fork-ledger"
  && r.args.join(" ") === "run --lane frontend --mode shadow" && r.config === root + "/scripts/tracegate-package.config.json" && r.ledger === T + "/ledger" ? 0 : 1);' "$T/broker.json" "$T/run.json" "$ROOT" "$T" 2>/dev/null && [ "$rc" = 0 ]
check "record: a daemon lease on the fork's broker (fork env outside, package config and ledger inside)" $? "$(cat "$T/broker.json" "$T/run.json" "$T/out.txt" 2>/dev/null)"
record 75; rc=$?
[ "$rc" = 75 ] && [ ! -e "$T/run.json" ] && grep -q "asked this recording to yield" "$T/out.txt"
check "record: a lease the broker stops exits 75 and says so" $? "rc=$rc $(cat "$T/out.txt")"
record 2; rc=$?
[ "$rc" = 2 ] && [ ! -e "$T/run.json" ] && grep -q "never runs outside a lease" "$T/out.txt"
check "record: no lease, no recording (exit 2, nothing run)" $? "rc=$rc $(cat "$T/out.txt")"

# Sabotage witness: the same hang with the alarm removed is NOT bounded. The watchdog
# here stops it at 6 s; reaching the watchdog is the expected (red) outcome.
sed 's/alarm \$s; //' "$SCRIPT" > "$T/sabotaged.sh"
grep -q 'alarm \$s' "$T/sabotaged.sh" && check "sabotage applied" 1 "alarm still present"
t0=$(date +%s)
( TRACEGATE_PACKAGE_CLI="node $T/hang.cjs" TRACEGATE_PACKAGE_LEDGER="$T/ledger2" TRACEGATE_PACKAGE_TIMEOUT_S=2 \
    bash "$T/sabotaged.sh" shadow-compare frontend "$fork" >/dev/null 2>&1 ) & sp=$!
( sleep 6; kill -9 "$sp" 2>/dev/null; pkill -9 -f "$T/hang.cjs" 2>/dev/null; pkill -f "owp-tg-pkg-hang-$$" 2>/dev/null ) & wd=$!
wait "$sp" 2>/dev/null; secs=$(( $(date +%s) - t0 )); kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
[ "$secs" -ge 6 ]
check "sabotage witness: without the timeout the hang runs on (stopped by the watchdog at ${secs}s)" $?

if [ "$fail" = 0 ]; then echo "== tracegate package shadow: $pass passed =="; else echo "== tracegate package shadow: $fail FAILED, $pass passed =="; fi
[ "$fail" = 0 ]
