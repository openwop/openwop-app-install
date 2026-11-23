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
#       selections is appended to compare-<lane>.tsv there. In shadow the package's
#       selected.txt is the WHOLE lane (shadow runs everything), so what it would run is
#       read from its predict.json: the files decided `run`. The fork's side is read the
#       same way (its must-run files, never its audit draw), and the files that differ
#       are kept in compare-<lane>-diff/<at>-<head>.json. It can never fail the gate:
#       it always exits 0, and is killed after TRACEGATE_PACKAGE_TIMEOUT_S (default 60).
#       It uses only the INSTALLED package (never npx): not installed, it logs and skips.
#   scripts/tracegate-package.sh record <lane>
#       P1b, on demand and never in the gate: a whole shadow run of the lane, recorded by
#       the package into its own ledger. This is a full suite; ask for a window first.
#       It runs under a preemptible `daemon` lease on the FORK's broker, the one gates,
#       trains and deploys register with, so any of them stops it at once (exit 75).
#       No lease (no broker, exit 2), no recording; TRACEGATE_PACKAGE_NO_LEASE=1 skips
#       the lease (tests). The broker sees the fork's environment; only the run inside
#       the lease gets the package's config and ledger.
#
# The package is the root devDependency (P1a). TRACEGATE_PACKAGE_CLI,
# TRACEGATE_PACKAGE_LEDGER and TRACEGATE_PACKAGE_BROKER override it, its ledger and the
# fork's broker entry point (tests).
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
export TRACEGATE_CONFIG="$ROOT/scripts/tracegate-package.config.json"
PKG_LEDGER="${TRACEGATE_PACKAGE_LEDGER:-$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir)/tracegate-package}"
CLI="${TRACEGATE_PACKAGE_CLI:-}"
if [ -z "$CLI" ]; then
  if [ -f "$ROOT/node_modules/tracegate-ci/src/cli.mjs" ]; then CLI="node $ROOT/node_modules/tracegate-ci/src/cli.mjs"
  else CLI="npx -y tracegate-ci@0.10.4"; fi
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
// What the package WOULD run: in shadow its selected.txt lists every file, so the
// decisions in predict.json are the selection. selected.txt only when there are none.
const wouldRun = () => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(path.dirname(pkgSel), 'predict.json'), 'utf8')).decisions;
    if (d && typeof d === 'object') return { set: new Set(Object.keys(d).filter((f) => d[f]?.run).map((f) => path.resolve(root, f))), basis: 'predict' };
  } catch { /* none: fall back */ }
  const set = read(pkgSel); return set ? { set, basis: 'selected' } : null;
};
// What the fork MUST run, likewise from its predict.json: its selected.txt also holds the
// random audit in enforce (and the whole lane in shadow), which says nothing about
// prediction. A superset test against an audit draw is noise (2026-11-23: fork 85 = 13 must
// run + 72 audited). selected.txt only when the fork wrote no decisions.
const forkMust = () => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(path.dirname(forkSel), 'predict.json'), 'utf8')).decisions;
    if (d && typeof d === 'object') return { set: new Set(Object.keys(d).filter((f) => d[f]?.run).map((f) => path.resolve(root, f))), basis: 'predict' };
  } catch { /* none: fall back */ }
  const set = read(forkSel); return set ? { set, basis: 'selected' } : null;
};
const fm = forkMust(), fork = fm ? fm.set : new Set(), w = rc === '0' ? wouldRun() : null, pkg = w ? w.set : null;
const status = rc === 'not-installed' ? 'not-installed' : rc === '124' ? 'timeout' : rc !== '0' ? `error-${rc}` : pkg ? 'ok' : 'no-selection';
const onlyFork = pkg ? [...fork].filter((f) => !pkg.has(f)).length : '';
const onlyPkg = pkg ? [...pkg].filter((f) => !fork.has(f)).length : '';
const header = 'at\thead\tstatus\tsecs\tfork\tpackage\tonly_fork\tonly_package\tsuperset\tbasis\tfork_basis\n';
const at = new Date().toISOString();
const row = [at, head, status, secs, fork.size, pkg ? pkg.size : '', onlyFork, onlyPkg, pkg ? (onlyFork === 0 ? 'yes' : 'no') : '', w ? w.basis : '', fm ? fm.basis : ''].join('\t') + '\n';
// Which files differ, so a row that is not a superset can be explained file by file
// (the P1 exit allows "or the differences are explained"). Repo-relative, at most 500 each.
if (pkg && (onlyFork || onlyPkg)) {
  const rel = (xs) => xs.map((f) => path.relative(root, f)).sort().slice(0, 500);
  const dir = out.replace(/\.tsv$/, '-diff');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${at.replace(/[:.]/g, '')}-${head}.json`), JSON.stringify({ at, head, onlyFork: rel([...fork].filter((f) => !pkg.has(f))), onlyPackage: rel([...pkg].filter((f) => !fork.has(f))) }, null, 1)); } catch { /* the row stands */ }
}
// A log with another header is set aside, never mixed in: those rows don't count toward
// the P1 exit. The rows before `basis` compared the package's whole lane; the rows before
// `fork_basis` compared against the fork's selected.txt, audit draw included.
if (fs.existsSync(out) && fs.readFileSync(out, 'utf8').split('\n')[0] + '\n' !== header) fs.renameSync(out, out.replace(/\.tsv$/, `.before-${new Date().toISOString().slice(0, 10)}.tsv`));
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
    if [ "${TRACEGATE_PACKAGE_NO_LEASE:-0}" = 1 ]; then TRACEGATE_LEDGER="$PKG_LEDGER" exec $CLI run --lane "$lane" --mode shadow; fi
    broker="${TRACEGATE_PACKAGE_BROKER:-$ROOT/scripts/vendor/tracegate-ci/src/broker/main.mjs}"
    fork_ledger="${OPENWOP_TRACEGATE_LEDGER:-$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir)/tracegate}"
    # As scripts/tracegate-daemon.sh takes its tick's lease: same broker, same class.
    ( cd "$ROOT" && env -u TRACEGATE_CONFIG TRACEGATE_LEDGER="$fork_ledger" TRACEGATE_HOST="${OPENWOP_TRACEGATE_HOST:-}" \
        node "$broker" lease --quiet --class daemon --tokens 2 --deadline-min 2 --label "package record $lane" \
        -- env TRACEGATE_CONFIG="$TRACEGATE_CONFIG" TRACEGATE_LEDGER="$PKG_LEDGER" $CLI run --lane "$lane" --mode shadow ); rc=$?
    case "$rc" in
      0) ;;
      75) echo "tracegate-package: the broker asked this recording to yield (a gate, train, deploy or measurement); nothing is kept from a stopped run. Record again in the next window." >&2 ;;
      2) echo "tracegate-package: no broker lease (unreachable or refused), so nothing was recorded. A recording never runs outside a lease." >&2 ;;
    esac
    exit "$rc" ;;

  *)
    echo "tracegate-package: report-card | status | savings | shadow-compare <lane> <run> | record <lane>" >&2; exit 2 ;;
esac
