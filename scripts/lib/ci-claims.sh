# ci-claims.sh — machine-wide markers for CI work that is not a test suite (sourced).
#
# A merge train spends minutes in `npm ci` (three installs) before its gate
# starts. Nothing a peer looks at saw that phase: `preflight-suite.sh` matches
# running suites by argv, and the daemon's `gate_live` matches the train script
# by name in THIS repo only. A kicktodo gate could start in the middle of an
# openwop-app train's installs, and the reverse (user decision 2026-10-26).
#
# A marker is one file per process under a directory every repo on the machine
# shares ($HOME/.openwop-ci/claims, or OPENWOP_CI_CLAIMS_DIR). kicktodo's
# merge-train vendors this same file, so both projects read and write one set.
#
#   ci_claim_publish <phase> <label>   write or update THIS process's marker
#   ci_claim_clear                     remove it (a dead pid is ignored anyway)
#   ci_claims_live [<exclude-common-dir>]
#       one line per live marker: pid, elapsed, worktree, "phase label". With an
#       argument, markers from that git common dir (this repo) are left out.
#
# A marker counts only while its pid is alive AND that pid's start time is the
# one recorded, so a reused pid cannot keep a dead train's marker alive. Dead
# markers are removed by whoever reads them.

ci_claims_dir() { printf '%s' "${OPENWOP_CI_CLAIMS_DIR:-$HOME/.openwop-ci/claims}"; }
ci_claim_lstart() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }

ci_claim_publish() {
  local dir tmp pid="${CI_CLAIM_PID:-$$}" wt common
  dir="$(ci_claims_dir)"; mkdir -p "$dir" 2>/dev/null || return 0
  wt="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || printf '%s' "$wt")"
  tmp="$dir/.$pid.$RANDOM"
  # One file, renamed in: a reader sees every field or none.
  printf 'pid=%s\nstarted=%s\ncommon=%s\nworktree=%s\nphase=%s\nlabel=%s\nat=%s\n' \
    "$pid" "$(ci_claim_lstart "$pid")" "$common" "$wt" "$1" "${2:-}" "$(date -u +%FT%TZ)" > "$tmp" 2>/dev/null \
    && mv -f "$tmp" "$dir/$pid.claim" 2>/dev/null
  return 0
}

ci_claim_clear() { rm -f "$(ci_claims_dir)/${CI_CLAIM_PID:-$$}.claim" 2>/dev/null; return 0; }

ci_claims_live() {
  local dir f pid started current_start common wt phase label
  dir="$(ci_claims_dir)"; [ -d "$dir" ] || return 0
  for f in "$dir"/*.claim; do
    [ -f "$f" ] || continue
    pid="$(sed -n 's/^pid=//p' "$f")"; started="$(sed -n 's/^started=//p' "$f")"
    common="$(sed -n 's/^common=//p' "$f")"; wt="$(sed -n 's/^worktree=//p' "$f")"
    phase="$(sed -n 's/^phase=//p' "$f")"; label="$(sed -n 's/^label=//p' "$f")"
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f" 2>/dev/null; continue
    fi
    # A failed/empty ps read is not proof of PID reuse. The preflight self-test
    # stubs ps; before its claim-dir isolation, that erased real live markers
    # and let the background daemon resume inside a cross-repo gate (ADR 0974).
    current_start="$(ci_claim_lstart "$pid")"
    if [ -n "$current_start" ] && [ "$current_start" != "$started" ]; then
      rm -f "$f" 2>/dev/null; continue
    fi
    [ -n "${1:-}" ] && [ "$common" = "$1" ] && continue
    printf '%s\t%s\t%s\t%s\n' "$pid" "$(ps -o etime= -p "$pid" | tr -d ' ')" "$wt" "train ${phase}${label:+ $label}"
  done
}
