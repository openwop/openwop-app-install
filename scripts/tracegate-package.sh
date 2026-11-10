#!/usr/bin/env bash
# ADR 1028: the tracegate-ci PACKAGE, beside the fork, with its own lane config
# (scripts/tracegate-package.config.json, reached only through TRACEGATE_CONFIG).
#
#   scripts/tracegate-package.sh report-card [--json] [--redact] [--out file]
#   scripts/tracegate-package.sh status | savings
#       P0, read-only, against the FORK's live ledger.
#   scripts/tracegate-package.sh shadow-compare <lane> <fork run dir>
#       P1b, called by the gate after the fork's selection. The package selects into its
#       OWN ledger (<git common dir>/tracegate-package/) and one row comparing the two
#       selections is appended to compare-<lane>.tsv there. It can never fail the gate:
#       it always exits 0, and is killed after TRACEGATE_PACKAGE_TIMEOUT_S (default 60).
#       It uses only the INSTALLED package (never npx): not installed, it logs and skips.
#   scripts/tracegate-package.sh record <lane>
#       P1b, on demand and never in the gate: a whole shadow run of the lane, recorded by
#       the package into its own ledger. This is a full suite; ask for a window first.
#
# The package is the root devDependency (P1a). TRACEGATE_PACKAGE_CLI and
# TRACEGATE_PACKAGE_LEDGER override it and its ledger (tests).
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
export TRACEGATE_CONFIG="$ROOT/scripts/tracegate-package.config.json"
PKG_LEDGER="${TRACEGATE_PACKAGE_LEDGER:-$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir)/tracegate-package}"
CLI="${TRACEGATE_PACKAGE_CLI:-}"
if [ -z "$CLI" ]; then
  if [ -f "$ROOT/node_modules/tracegate-ci/src/cli.mjs" ]; then CLI="node $ROOT/node_modules/tracegate-ci/src/cli.mjs"
  else CLI="npx -y tracegate-ci@0.10.1"; fi
fi

case "${1:-}" in
  report-card|status|savings)
    exec $CLI "$@" ;;

  shadow-compare)
    lane="${2:-}"; fork_run="${3:-}"
    [ -n "$lane" ] && [ -f "$fork_run/selected.txt" ] || { echo "tracegate-package: shadow-compare needs <lane> and a fork run dir with selected.txt (skipped)"; exit 0; }
    mkdir -p "$PKG_LEDGER" 2>/dev/null || exit 0
    run="$(mktemp -d "${TMPDIR:-/tmp}/owp-tracegate-pkg-$lane.XXXXXX")" || exit 0
    t0=$(date +%s)
    # Only the INSTALLED package, never npx: a checkout whose root node_modules predates
    # P1a would otherwise fetch over the network inside the gate (d8's review of #5691).
    if [ -z "${TRACEGATE_PACKAGE_CLI:-}" ] && [ ! -f "$ROOT/node_modules/tracegate-ci/src/cli.mjs" ]; then
      rc=not-installed
    else
      # perl's alarm is the portable timeout (macOS has no GNU timeout). The select runs in
      # its own process group, so a hang is killed with everything it started.
      TRACEGATE_LEDGER="$PKG_LEDGER" perl -e 'my $s = shift; my $pid = fork; if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
        local $SIG{ALRM} = sub { kill "KILL", -$pid; exit 124 }; alarm $s; waitpid $pid, 0; exit($? >> 8)' \
        "${TRACEGATE_PACKAGE_TIMEOUT_S:-60}" $CLI select --lane "$lane" --run "$run" --mode shadow >"$run/select.log" 2>&1
      rc=$?
    fi
    secs=$(( $(date +%s) - t0 ))
    node - "$PKG_LEDGER/compare-$lane.tsv" "$fork_run/selected.txt" "$run/selected.txt" "$rc" "$secs" "$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo none)" "$ROOT" <<'EOF' || true
const fs = require('fs');
const path = require('path');
const [out, forkSel, pkgSel, rc, secs, head, root] = process.argv.slice(2);
// Both write absolute paths today; normalise anyway, so a relative list can't read as 0 overlap.
const read = (f) => { try { return new Set(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((p) => path.resolve(root, p))); } catch { return null; } };
const fork = read(forkSel), pkg = rc === '0' ? read(pkgSel) : null;
const status = rc === 'not-installed' ? 'not-installed' : rc === '124' ? 'timeout' : rc !== '0' ? `error-${rc}` : pkg ? 'ok' : 'no-selection';
const onlyFork = pkg ? [...fork].filter((f) => !pkg.has(f)).length : '';
const onlyPkg = pkg ? [...pkg].filter((f) => !fork.has(f)).length : '';
const header = 'at\thead\tstatus\tsecs\tfork\tpackage\tonly_fork\tonly_package\tsuperset\n';
const row = [new Date().toISOString(), head, status, secs, fork.size, pkg ? pkg.size : '', onlyFork, onlyPkg, pkg ? (onlyFork === 0 ? 'yes' : 'no') : ''].join('\t') + '\n';
if (!fs.existsSync(out)) fs.writeFileSync(out, header);
fs.appendFileSync(out, row);
console.log(status === 'ok'
  ? `tracegate-package (shadow): the package would run ${pkg.size} files, the fork ${fork.size}; ${onlyFork} only the fork runs, ${onlyPkg} only the package (${secs}s)`
  : status === 'not-installed'
    ? 'tracegate-package (shadow): tracegate-ci is not in this checkout\'s root node_modules (npm ci at the root); skipped, the gate is unaffected'
    : `tracegate-package (shadow): ${status} after ${secs}s, ignored (the gate is unaffected)`);
EOF
    rm -rf "$run"
    exit 0 ;;

  record)
    lane="${2:-}"; [ -n "$lane" ] || { echo "usage: tracegate-package.sh record <lane>" >&2; exit 2; }
    TRACEGATE_LEDGER="$PKG_LEDGER" exec $CLI run --lane "$lane" --mode shadow ;;

  *)
    echo "tracegate-package: report-card | status | savings | shadow-compare <lane> <run> | record <lane>" >&2; exit 2 ;;
esac
