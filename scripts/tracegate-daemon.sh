#!/usr/bin/env bash
# tracegate-daemon.sh — ADR 0880 P3/P4: keep the Tracegate ledger warm in the
# background, so gates find verdicts already waiting.
#
#   scripts/tracegate-daemon.sh tick        one unit of work, then exit
#   scripts/tracegate-daemon.sh nightly     the nightly full run, now
#   scripts/tracegate-daemon.sh install     run `tick` every 20 min (LaunchAgent, this user only)
#   scripts/tracegate-daemon.sh uninstall
#   scripts/tracegate-daemon.sh status
#
# ONE UNIT OF WORK per tick, in this order:
#   1. NIGHTLY (01:00–05:59 local, once per 20 h): a FULL shadow run of both
#      lanes on origin/main. It refreshes every footprint, checks every reusable
#      verdict (a failure there is a MISS, exactly as in a gate), and runs the
#      two stale-entry checks that enforce-mode gates hand to it: the frontend
#      live-fetch allowlist and (since 2026-10-14) the backend event-payload
#      ratchet's stale admissions (ADR 0702).
#   2. PRE-GATE one open PR not done yet: merge its head onto the CURRENT
#      origin/main (what a train will build), run only the files that merge can
#      affect, and record their footprints. A merge train holding that PR then
#      reuses them: the train tree differs from that merge only by the OTHER PRs
#      and by how far main has moved (ADR 0880 §Composition).
#      CORRECTED 2026-10-13: the first version ran the PR head AS PUSHED. A head
#      75 commits behind main had a different lockfile, so all 2,540 backend files
#      had to run, for a docs-only PR. It was retried 4 times and a starting gate
#      killed every attempt. Each PR is now tried at most 3 times per head, and a
#      PR that does not merge cleanly is skipped (the train cannot use it either).
#   3. SYNC the ledger with the other machine, if `config.json` names one (P4).
#
# IT YIELDS TO GATES, ALWAYS. It starts nothing while any suite, gate, waiting
# gate or merge train is live (scripts/preflight-suite.sh --check, the gate claim,
# a waiting `--ci-exec`). It polls every 5 s while its own batch runs and kills
# that batch (its own pid tree only) the moment one appears. Its vitest runs at
# utility QoS + nice (see PRIORITY below) with two
# workers, in batches of 60 files, each ingested on its own. A killed batch
# records nothing, because a footprint needs a verdict.
#
# PRIORITY: `taskpolicy -c utility` + `nice`, NOT `taskpolicy -b`. MEASURED
# 2026-10-13 at load ~70: a backend `npm ci` under `-b` (background QoS, which also
# throttles I/O hard) made no progress in 17 minutes; the same install at normal
# priority took 16 s. Background QoS starves work rather than deprioritising it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMON="$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir)"
MAIN_CHECKOUT="$(dirname "$COMMON")"
LEDGER="${OPENWOP_TRACEGATE_LEDGER:-$COMMON/tracegate}"
WORK="${OPENWOP_TRACEGATE_WORK:-$(dirname "$MAIN_CHECKOUT")/$(basename "$MAIN_CHECKOUT")-tracegate-work}"
TOOLS="${OPENWOP_TRACEGATE_TOOLS:-$(dirname "$MAIN_CHECKOUT")/$(basename "$MAIN_CHECKOUT")-tracegate-tools}"
LABEL="dev.openwop.tracegate"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$LEDGER/daemon.log"
DONE="$LEDGER/daemon-done.tsv"
ATTEMPTS="$LEDGER/daemon-attempts.tsv"
NIGHTLY="$LEDGER/nightly.tsv"
BATCH="${OPENWOP_TRACEGATE_BATCH:-60}"
mkdir -p "$LEDGER"

# Under the LaunchAgent, stdout and stderr ARE the log, so a `tee -a "$LOG"` there
# wrote every line twice (the first day's log: 194 lines, half of them copies).
# install_agent sets OPENWOP_TRACEGATE_STDOUT_IS_LOG=1; by hand, tee as before.
logpipe() { if [ "${OPENWOP_TRACEGATE_STDOUT_IS_LOG:-}" = 1 ]; then cat; else tee -a "$LOG"; fi; }
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | logpipe; }

# ── yielding ──────────────────────────────────────────────────────────────────
gate_live() {
  [ -d "$COMMON/preflight-suite.claim" ] && return 0
  pgrep -f 'preflight-suite\.sh --ci-exec' >/dev/null 2>&1 && return 0
  pgrep -f 'scripts/merge-train\.sh' >/dev/null 2>&1 && return 0
  return 1
}
busy() {
  gate_live && return 0
  # Any live suite from another checkout (the detector every gate uses). Our own
  # worktree's processes are excluded by it, so the daemon never blocks itself.
  ( cd "$WORK" 2>/dev/null || cd "$ROOT"; bash "$ROOT/scripts/preflight-suite.sh" --check >/dev/null 2>&1 ) || return 0
  # Load above the core count is someone else's work; come back later.
  local load cores
  load="$(sysctl -n vm.loadavg 2>/dev/null | awk '{print int($2)}')"; cores="$(sysctl -n hw.ncpu 2>/dev/null || echo 8)"
  [ "${load:-0}" -gt "$cores" ] && return 0
  return 1
}
kill_tree() { # kill_tree <pid> — our own process tree only (never pkill by pattern)
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill "$p" 2>/dev/null || true
}

# ── the lock: one daemon at a time ────────────────────────────────────────────
LOCK="$LEDGER/daemon.lock"
take_lock() {
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT; return 0; fi
  local holder; holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then return 1; fi
  rm -rf "$LOCK"; mkdir "$LOCK" && echo $$ > "$LOCK/pid" && trap 'rm -rf "$LOCK"' EXIT
}

# ── the work worktree ─────────────────────────────────────────────────────────
fetch_origin() { # a failed fetch (no credentials under launchd, a network blip) is not fatal
  # GIT_TERMINAL_PROMPT=0: there is no terminal under launchd, so a credential
  # helper that cannot answer (the `gh` token lives in the login keychain, which
  # launchd cannot always read) must fail at once, not try to prompt. The raw
  # `fatal: could not read Username … Device not configured` used to land in the
  # log untimestamped; it is now one dated line that says what the tick does.
  local err
  err=$(GIT_TERMINAL_PROMPT=0 git -C "$MAIN_CHECKOUT" fetch -q origin "$@" 2>&1 >/dev/null) && return 0
  say "git fetch failed (${err%%$'\n'*}) — working from the refs already fetched (origin/main $(git -C "$MAIN_CHECKOUT" rev-parse --short origin/main 2>/dev/null))"
  return 1
}
checkout_work() { # checkout_work <commit>
  fetch_origin || true
  [ -d "$WORK" ] || git -C "$MAIN_CHECKOUT" worktree add -q --detach "$WORK" origin/main
  if [ -n "$(git -C "$WORK" status --porcelain --untracked-files=no)" ]; then
    say "work worktree $WORK is dirty — not touching it"; return 1
  fi
  git -C "$WORK" checkout -q --detach "$1"
  ensure_work_deps
}
ensure_work_deps() {
  local lane dir sha
  for lane in backend/typescript frontend/react; do
    dir="$WORK/$lane"; [ -f "$dir/package-lock.json" ] || continue
    sha="$(shasum -a 256 "$dir/package-lock.json" | cut -d' ' -f1)"
    if [ "$(cat "$dir/node_modules/.tracegate-lock-sha" 2>/dev/null)" != "$sha" ]; then
      say "installing $lane dependencies for $(git -C "$WORK" rev-parse --short HEAD)"
      # npm 10.9.8 for the backend, never the local npm (CLAUDE.md, ADR 0739).
      if [ "$lane" = backend/typescript ]; then ( cd "$dir" && nice -n 10 npx -y npm@10.9.8 ci --no-audit --no-fund >/dev/null 2>&1 ); else ( cd "$dir" && nice -n 10 npm ci --no-audit --no-fund >/dev/null 2>&1 ); fi
      echo "$sha" > "$dir/node_modules/.tracegate-lock-sha"
    fi
  done
}

TG() { OPENWOP_TRACEGATE_ROOT="$WORK" node "$ROOT/scripts/tracegate.mjs" "$@"; }

# recheck_misses <lane> <dir> <run> — the gate's tg_recheck_misses, for the daemon.
# A MISS suspends the lane for 14 days. The gate re-runs each miss ONCE, alone, at
# the same tree, and triages a pass as `flake`; the daemon did not, so a nightly
# miss stayed untriaged and suspended enforcement for everyone (four on
# 2026-10-19). Same rule here: a pass alone is triaged `flake`, a fail stays a
# MISS, and every recheck keeps its log under $LEDGER/daemon-logs so the
# Received diff can be read. Returns 3 if it yielded to a gate.
recheck_misses() {
  local lane="$1" dir="$2" run="$3" f rel h log vp
  [ -s "$run/misses.txt" ] || return 0
  h="$(git -C "$WORK" rev-parse HEAD | cut -c1-12)"
  mkdir -p "$LEDGER/daemon-logs"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rel="${f#"$dir"/}"
    if gate_live; then say "a gate appeared before re-checking $rel — yielding"; return 3; fi
    log="$LEDGER/daemon-logs/$(date -u +%Y%m%dT%H%M%SZ)-recheck-$(basename "$rel").log"
    say "re-running the MISS $rel alone at $h"
    ( cd "$WORK/$dir" && exec taskpolicy -c utility nice -n 15 env OPENWOP_VITEST_NO_WAIT=1 \
        $( [ "$lane" = backend ] && echo OPENWOP_SKIP_TESTCONTAINERS=1 ) node node_modules/vitest/vitest.mjs run --maxWorkers=1 "$rel" ) > "$log" 2>&1 &
    vp=$!
    while kill -0 "$vp" 2>/dev/null; do
      if gate_live; then say "a gate appeared mid-recheck — killing pid $vp and yielding"; kill_tree "$vp"; wait "$vp" 2>/dev/null || true; return 3; fi
      sleep 5
    done
    if wait "$vp"; then
      TG triage --lane "$lane" --file "$f" --head "$h" --verdict flake | logpipe
      say "$rel PASSED alone at $h: triaged flake (log $log)"
    else
      say "$rel FAILS alone at $h too: a real MISS (recorder hole, P0); the lane stays suspended. Log: $log"
    fi
  done < "$run/misses.txt"
  return 0
}

# run_lane <lane> <mode> — select at the work HEAD, run in yielding batches, ingest.
# Returns 3 if it yielded to a gate. Writes the full-run report when mode=shadow.
run_lane() {
  local lane="$1" mode="$2" dir run files n i rc=0
  case "$lane" in backend) dir=backend/typescript ;; frontend) dir=frontend/react ;; esac
  run="$(mktemp -d "${TMPDIR:-/tmp}/owp-tracegate-daemon-$lane.XXXXXX")"
  TG select --lane "$lane" --run "$run" --mode "$mode" --audit 0 | logpipe
  files=(); while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < "$run/selected.txt"
  if [ "$mode" != shadow ]; then
    # Pre-gating runs only what this head can affect: the files select would make
    # a gate run. (`selected.txt` under shadow lists everything; recompute.)
    files=(); while IFS= read -r f; do [ -n "$f" ] && files+=("$WORK/$f"); done < <(node -e '
      const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      for (const [f,d] of Object.entries(p.decisions)) if (d.run) console.log(f)' "$run/predict.json")
  fi
  n=${#files[@]}
  say "$lane at $(git -C "$WORK" rev-parse --short HEAD): $n file(s) to run ($mode)"
  local extra=()
  [ "$lane" = frontend ] && [ "$mode" = shadow ] && { : > "$run/live-fetch.audit"; extra=(OPENWOP_LIVE_FETCH_AUDIT="$run/live-fetch.audit"); }
  [ "$lane" = backend ] && extra=(OPENWOP_SKIP_TESTCONTAINERS=1)
  # ADR 0702 — a full run is the only run that can prove an admission stale, so
  # the nightly records payload samples (one file per process; batches share it).
  [ "$lane" = backend ] && [ "$mode" = shadow ] && { mkdir -p "$run/payload"; extra+=(OPENWOP_PAYLOAD_AUDIT="$run/payload"); }
  for (( i = 0; i < n; i += BATCH )); do
    if gate_live; then say "a gate appeared — yielding"; rm -rf "$run"; return 3; fi
    local b="$run/b$i"; mkdir -p "$b"; cp "$run/predict.json" "$b/predict.json"
    ( cd "$WORK/$dir" && exec taskpolicy -c utility nice -n 15 env OPENWOP_VITEST_NO_WAIT=1 OPENWOP_TRACEGATE_RECORD="$b" ${extra[@]+"${extra[@]}"} \
        node node_modules/vitest/vitest.mjs run --maxWorkers=2 "${files[@]:i:BATCH}" ) >> "$b/vitest.log" 2>&1 &
    local vp=$!
    while kill -0 "$vp" 2>/dev/null; do
      if gate_live; then say "a gate appeared mid-batch — killing our batch (pid $vp) and yielding"; kill_tree "$vp"; wait "$vp" 2>/dev/null || true; rm -rf "$run"; return 3; fi
      sleep 5
    done
    if ! wait "$vp"; then
      rc=1
      # Keep the red batch's output: without it a MISS cannot be read (2026-10-19:
      # four nightly misses went untriaged because the run dir, logs included,
      # was deleted). Under the ledger, beside daemon.log.
      mkdir -p "$LEDGER/daemon-logs"
      cp "$b/vitest.log" "$LEDGER/daemon-logs/$(date -u +%Y%m%dT%H%M%SZ)-$lane-batch$i.log" 2>/dev/null || true
    fi
    TG ingest --lane "$lane" --run "$b" --expect-head "$(git -C "$WORK" rev-parse HEAD)" | logpipe
    # Merge this batch's verdicts into the run's for the report (shadow only).
    [ "$mode" = shadow ] && node -e '
      const fs=require("fs"),[a,b]=process.argv.slice(1);
      let A; try { A=JSON.parse(fs.readFileSync(a,"utf8")); } catch { A={testResults:[]}; }
      let B; try { B=JSON.parse(fs.readFileSync(b,"utf8")); } catch { B={testResults:[]}; }
      A.testResults.push(...(B.testResults||[])); fs.writeFileSync(a, JSON.stringify(A));' "$run/results.json" "$b/results.json"
    rm -rf "$b/raw" "$b/codes"
  done
  if [ "$mode" = shadow ]; then
    TG report --lane "$lane" --run "$run" | logpipe
    recheck_misses "$lane" "$dir" "$run" || { rm -rf "$run"; return 3; }
    if [ "$lane" = frontend ]; then
      local stale=0
      ( cd "$WORK" && node scripts/check-live-fetch-stale.mjs "$run/live-fetch.audit" ) >> "$LOG" 2>&1 || stale=1
      printf '%s\t%s\tlive-fetch-stale\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git -C "$WORK" rev-parse --short=12 HEAD)" "$([ $stale -eq 0 ] && echo pass || echo FAIL)" >> "$NIGHTLY"
    fi
    if [ "$lane" = backend ]; then
      # The full ratchet, stale check included: enforce-mode gates pass --no-stale.
      local pa=0
      ( cd "$WORK" && OPENWOP_PAYLOAD_AUDIT="$run/payload" node scripts/audit-event-payloads.mjs --ratchet ) >> "$LOG" 2>&1 || pa=1
      printf '%s\t%s\tpayload-ratchet\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git -C "$WORK" rev-parse --short=12 HEAD)" "$([ $pa -eq 0 ] && echo pass || echo FAIL)" >> "$NIGHTLY"
    fi
    # A complete, green full run whose stale check passed spares a gate the
    # full lane for 24 h (ADR 0880 D5 correction). Anything less records nothing.
    # NOT for the frontend (ADR 0918): its full-done also licenses gates to run
    # the date-bomb sweep on their selection only, and this run does no sweep.
    # The frontend's backstop is the gate's own FULL lane + whole sweep.
    if [ "$lane" != frontend ] && [ $rc -eq 0 ] && [ "${stale:-0}" -eq 0 ] && [ "${pa:-0}" -eq 0 ]; then TG full-done --lane "$lane" | logpipe; fi
  fi
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git -C "$WORK" rev-parse --short=12 HEAD)" "$lane" "$([ $rc -eq 0 ] && echo green || echo RED)" >> "$NIGHTLY.lanes"
  rm -rf "$run"
  return 0
}

nightly() {
  checkout_work origin/main || return 0
  local lane
  for lane in backend frontend; do run_lane "$lane" shadow || return 0; done
  date +%s > "$LEDGER/nightly.last"
  say "nightly full run complete at $(git -C "$WORK" rev-parse --short HEAD)"
}

pregate_one() {
  command -v gh >/dev/null 2>&1 || return 1
  local list pr oid n main
  list="$(cd "$MAIN_CHECKOUT" && gh pr list --state open --base main --limit 40 --json number,headRefOid,isDraft,updatedAt \
          --jq 'sort_by(.updatedAt) | reverse | .[] | select(.isDraft|not) | "\(.number) \(.headRefOid)"' 2>/dev/null)" || return 1
  while read -r pr oid; do
    [ -n "$oid" ] || continue
    grep -q "	$oid\$" "$DONE" 2>/dev/null && continue
    n="$(grep -c "	$oid\$" "$ATTEMPTS" 2>/dev/null || true)"
    [ "${n:-0}" -ge 3 ] && continue
    git -C "$MAIN_CHECKOUT" fetch -q origin "$oid" 2>/dev/null || git -C "$MAIN_CHECKOUT" fetch -q origin "pull/$pr/head" 2>/dev/null || continue
    checkout_work origin/main || return 1
    main="$(git -C "$WORK" rev-parse --short HEAD)"
    if ! git -C "$WORK" -c user.name=tracegate -c user.email=tracegate@localhost merge -q --no-edit --no-ff "$oid" >/dev/null 2>&1; then
      git -C "$WORK" merge --abort 2>/dev/null || true
      git -C "$WORK" checkout -q --detach origin/main
      say "#$pr does not merge cleanly onto main $main — skipping it (a train could not use it either)"
      printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pr" "$oid" >> "$DONE"
      continue
    fi
    ensure_work_deps
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pr" "$oid" >> "$ATTEMPTS"
    say "pre-gating #$pr (${oid:0:9}) merged onto main $main"
    local lane
    for lane in backend frontend; do run_lane "$lane" enforce || return 0; done
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pr" "$oid" >> "$DONE"
    return 0
  done <<< "$list"
  return 1
}

tick() {
  take_lock || { say "another daemon tick is running — skipping"; return 0; }
  if busy; then say "machine busy (a gate, suite or high load) — skipping this tick"; return 0; fi
  local hour last now
  hour="$(date +%H)"; now="$(date +%s)"; last="$(cat "$LEDGER/nightly.last" 2>/dev/null || echo 0)"
  if [ "$((10#$hour))" -ge 1 ] && [ "$((10#$hour))" -le 5 ] && [ $((now - last)) -ge 72000 ]; then
    nightly
  else
    pregate_one || say "nothing to pre-gate"
  fi
  if [ -f "$LEDGER/config.json" ] && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sync?0:1)' "$LEDGER/config.json" 2>/dev/null; then
    node "$ROOT/scripts/tracegate.mjs" sync >> "$LOG" 2>&1 || say "sync failed"
  fi
}

install_agent() {
  [ "$(uname)" = Darwin ] || { echo "install: macOS LaunchAgents only" >&2; exit 2; }
  fetch_origin || true
  [ -d "$TOOLS" ] || git -C "$MAIN_CHECKOUT" worktree add -q --detach "$TOOLS" origin/main
  mkdir -p "$(dirname "$PLIST")"
  # The tools worktree is fast-forwarded to origin/main BEFORE bash reads the
  # script, so the daemon always runs the merged version of itself.
  # A failed fetch must not skip the tick: it runs the last fetched version.
  local cmd="cd '$TOOLS' && { GIT_TERMINAL_PROMPT=0 git fetch -q origin 2>/dev/null || echo \"\$(date -u +%Y-%m-%dT%H:%M:%SZ) tools fetch failed (credentials unavailable under launchd, or offline) — this tick runs the last fetched version\"; } && git checkout -q --detach origin/main && OPENWOP_TRACEGATE_STDOUT_IS_LOG=1 exec /bin/bash '$TOOLS/scripts/tracegate-daemon.sh' tick"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>$cmd</string></array>
  <key>StartInterval</key><integer>1200</integer>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string><key>HOME</key><string>$HOME</string></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "installed $LABEL: tick every 20 min from $TOOLS; log $LOG"
}
uninstall_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL (worktrees $TOOLS and $WORK are left; remove them with git worktree remove, then npm run packs:prune)"
}
status() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "agent: installed ($PLIST)"; else echo "agent: not installed"; fi
  echo "last nightly: $( [ -f "$LEDGER/nightly.last" ] && date -r "$(cat "$LEDGER/nightly.last")" || echo never)"
  echo "pre-gated heads: $( [ -f "$DONE" ] && wc -l < "$DONE" | tr -d ' ' || echo 0)"
  [ -f "$LOG" ] && { echo "--- last log lines"; tail -8 "$LOG"; }
  node "$ROOT/scripts/tracegate.mjs" status
}

case "${1:-}" in
  tick) tick ;;
  nightly) take_lock || { echo "a daemon tick is running"; exit 1; }; busy && { echo "machine busy — try later"; exit 1; }; nightly ;;
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  status) status ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
