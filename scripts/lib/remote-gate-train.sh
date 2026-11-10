# shellcheck shell=bash
# ADR 0863 D9 P6 — merge-train's remote-first attempt for the FULL train gate.
#
# remote_gate_train: gate the train commit ($TRAIN at $BASE_OID) on the remote gate
# VM through this Mac's PINNED controller (<config>/install/<policy-sha>/, see
# scripts/remote-gate-install-controller.sh), never from the train's candidate tree.
# Returns 0 green, 1 red, 3 fallback (the caller then gates locally, as before).
# Sets GATE_WHERE, REMOTE_REQUEST_ID and REMOTE_ACCEPT_FILE (the acceptance record,
# kept in the git common dir, OUTSIDE the train worktree: the candidate cannot
# pre-place or alter what lets it merge). Needs ROOT, TRAIN, BASE_OID, PRS and the
# release_bus function. Off unless OPENWOP_REMOTE_GATE=1 (the caller checks).
#
# Rules agreed with the release manager (2026-11-02):
#  - a red is final for the train (no local second chance); the closed set of
#    worker faults is already a fallback inside the controller;
#  - a busy VM means an immediate fallback, never a queue;
#  - the remote attempt is bounded by OPENWOP_REMOTE_GATE_TRAIN_MAX_MIN (default 75),
#    after which the controller cancels it and the outcome is a fallback.

REMOTE_GATE_RUNNER_LABEL="openwop-ci-gate"

remote_gate_json() { # remote_gate_json <json> <field>
  node -e 'try { const o = JSON.parse(process.argv[1]); const v = o[process.argv[2]]; process.stdout.write(v == null ? "" : String(v)); } catch { }' "$1" "$2"
}

# Who holds the VM: the newest remote-start on the bus from ANOTHER host with no
# later remote-end from that host. The worker cannot say (requests carry no host).
remote_gate_busy_holder() {
  local me; me="$(hostname -s 2>/dev/null || hostname)"
  node "$ROOT/scripts/lib/release-bus.mjs" status --minutes 240 2>/dev/null \
    | awk -v me="$me" '$3 == "gate" && ($4 == "remote-start" || $4 == "remote-end") && $2 != me { state[$2] = $4 }
        END { for (h in state) if (state[h] == "remote-start") { print h; exit } }'
}

remote_gate_train() {
  local conf="${OPENWOP_CI_CONFIG_DIR:-$HOME/.config/openwop-ci}" pin install common out rc t0 verdict reason holder log
  local host; host="$(hostname -s 2>/dev/null || hostname)"
  GATE_WHERE=""; REMOTE_REQUEST_ID=""; REMOTE_ACCEPT_FILE=""
  pin="$(node -e 'process.stdout.write(require(process.argv[1]).policySha256)' "$conf/runner.json" 2>/dev/null)" || pin=""
  if [ -z "$pin" ]; then echo "  remote fallback: no runner config at $conf"; return 3; fi
  install="$conf/install/$pin"
  if [ ! -f "$install/remote-gate.mjs" ]; then
    echo "  remote fallback: no pinned controller for policy ${pin:0:12} (scripts/remote-gate-install-controller.sh <commit>)"
    return 3
  fi
  common="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)"
  mkdir -p "$common/remote-gate" && chmod 700 "$common/remote-gate"
  REMOTE_ACCEPT_FILE="$common/remote-gate/train-$$-$(date +%s).json"
  rm -f "$REMOTE_ACCEPT_FILE"
  say "gating the train on the REMOTE gate VM first (ADR 0863 D9; policy ${pin:0:12}; bound ${OPENWOP_REMOTE_GATE_TRAIN_MAX_MIN:-75} min)"
  release_bus publish "{\"kind\":\"gate\",\"phase\":\"remote-start\",\"prs\":\"$(IFS=,; echo "${PRS[*]}")\",\"tree\":\"${TRAIN_TREE:-}\"}"
  t0=$(date +%s); rc=0
  out="$(node "$install/remote-gate.mjs" run --repo "$TRAIN" --base "$BASE_OID" --accept-out "$REMOTE_ACCEPT_FILE" \
    --max-min "${OPENWOP_REMOTE_GATE_TRAIN_MAX_MIN:-75}")" || rc=$?
  verdict="$(remote_gate_json "$out" verdict)"; reason="$(remote_gate_json "$out" reason)"
  REMOTE_REQUEST_ID="$(remote_gate_json "$out" id)"; log="$(remote_gate_json "$out" log)"
  local wall=$(( ($(date +%s) - t0) / 60 ))
  case "$rc:$verdict" in
    0:green)
      GATE_WHERE="remote:$REMOTE_GATE_RUNNER_LABEL"
      echo "  gate ran on: remote $REMOTE_GATE_RUNNER_LABEL (request ${REMOTE_REQUEST_ID:0:12}, policy ${pin:0:12}, ${wall} min) — GREEN"
      release_bus publish "{\"kind\":\"gate\",\"phase\":\"remote-end\",\"result\":\"green\",\"request\":\"$REMOTE_REQUEST_ID\"}"
      return 0 ;;
    1:red)
      GATE_WHERE="remote:$REMOTE_GATE_RUNNER_LABEL"
      echo "  gate ran on: remote $REMOTE_GATE_RUNNER_LABEL (request ${REMOTE_REQUEST_ID:0:12}, policy ${pin:0:12}, ${wall} min) — RED${log:+ (log: $log)}"
      release_bus publish "{\"kind\":\"gate\",\"phase\":\"remote-end\",\"result\":\"red\",\"request\":\"$REMOTE_REQUEST_ID\"}"
      rm -f "$REMOTE_ACCEPT_FILE"
      return 1 ;;
  esac
  [ -n "$reason" ] || reason="controller exit $rc"
  if [ "$reason" = "worker busy" ]; then
    holder="$(remote_gate_busy_holder)"
    reason="busy (held by ${holder:-holder unknown})"
  fi
  echo "  remote fallback: $reason — gating locally"
  release_bus publish "{\"kind\":\"gate\",\"phase\":\"remote-end\",\"result\":\"fallback\",\"reason\":\"$(printf '%s' "$reason" | tr -d '"\\' | cut -c1-120)\"}"
  rm -f "$REMOTE_ACCEPT_FILE"; REMOTE_ACCEPT_FILE=""
  return 3
}

# remote_gate_check_accept: before merging a remote-green train, the acceptance
# record must name THIS request, the train's commit and its tree.
remote_gate_check_accept() {
  local commit; commit="$(git -C "$TRAIN" rev-parse HEAD)"
  [ -n "$REMOTE_ACCEPT_FILE" ] && [ -f "$REMOTE_ACCEPT_FILE" ] || { echo "merge-train: the remote acceptance record is missing" >&2; return 1; }
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const [id, commit, tree] = process.argv.slice(2);
    const bad = [r.requestId !== id && "request", r.commit !== commit && "commit", r.tree !== tree && "tree"].filter(Boolean);
    if (bad.length) { console.error("merge-train: the remote acceptance record does not match this train (" + bad.join(", ") + ")"); process.exit(1); }
  ' "$REMOTE_ACCEPT_FILE" "$REMOTE_REQUEST_ID" "$commit" "$TRAIN_TREE"
}
