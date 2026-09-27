#!/usr/bin/env bash
#
# SHUTDOWN-1 — does the backend actually EXIT on SIGTERM?
#
# It did not. The handler stopped the daemons and drained the pool but never
# closed the HTTP server and never exited, so the `app.listen` handle held the
# event loop open: after SIGTERM the process stayed alive, still listening, still
# answering /health 200. Every `e2e-routes.sh` run leaked a backend (eight
# orphans in one session) and any container hung until its supervisor's SIGKILL.
#
# This lives here rather than in vitest because the defect is only observable in
# a REAL process: the handler is registered inside `main()`, and `main()` runs
# only when the module is the entry point, so no test that imports it can ever
# see this. Spawning the built binary is the only honest way to assert it.
#
# Requires `backend/typescript/lib/index.js` (ci.sh runs the backend build first).
#
# §CORRECTION (2026-08-09) — DIAGNOSED. This block previously said the gate was
# "NON-DETERMINISTIC ON macOS DEV MACHINES" and "UNDIAGNOSED", and listed six
# runs with differing results. I wrote that; it was wrong, and it is worth
# leaving the correction here rather than deleting the claim.
#
# THE CAUSE: `index.ts`'s entry-point guard compared `import.meta.url` (which is
# REALPATH-resolved) against a hand-built `file://${process.argv[1]}` (which is
# not). From a worktree under `/tmp` — a symlink to `/private/tmp` on macOS —
# the two never matched, so `main()` never ran and the spawned backend exited
# **0 with an empty log**. It could not bind, so this gate could not pass, ever.
# Fixed in `src/host/entryModule.ts` (+ `test/entry-module.test.ts`).
#
# WHY IT LOOKED LIKE FLAKINESS, WHICH IS THE PART WORTH REMEMBERING:
#   - it is PATH-dependent, not time-dependent: a worktree under `/Users/...`
#     passes and one under `/tmp` cannot, so two people got opposite answers;
#   - the observed "sometimes passes" runs were SPURIOUS. When a stray backend
#     happened to hold the port, `boot()`'s `gate_port_in_use` returned true and
#     the gate proceeded to assert against SOMEBODY ELSE'S process;
#   - I blamed machine load first. It fails 4/4 at an idle load average of 2.5,
#     so load was never it — but load was present when I first looked, which is
#     exactly how a coincidence gets promoted to a cause.
#
# A red here is still worth a second look before blaming your diff — but check
# `wc -c` on the backend log first (its path is printed on any failure). **Zero bytes means the backend
# never ran at all**, which is an environment or entry-point problem, never a
# shutdown defect.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/gate-ports.sh
. "$ROOT/scripts/lib/gate-ports.sh"
gate_require_lsof || exit 1

ENTRY="$ROOT/backend/typescript/lib/index.js"
if [ ! -f "$ENTRY" ]; then
  echo "error: $ENTRY missing — run the backend build first." >&2
  exit 1
fi

PASS=0; FAIL=0
# Per-run scratch, never a shared fixed path. Concurrent gates (two worktrees, a
# peer's `npm run ci`) used to write the SAME /tmp/owp-shutdown-test.log, so one
# run could grep another run's backend output.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/owp-shutdown.XXXXXX")"
LOG="$WORK/backend.log"
HELD="$WORK/held"
ok()  { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✗ $1" >&2; }

PORT="$(gate_pick_free_port 8191)" || { echo "no free port" >&2; exit 1; }
HOLDER=""
BE=""
cleanup() {
  [ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null
  [ -n "$BE" ] && kill -9 "$BE" 2>/dev/null
  if [ "$FAIL" -gt 0 ]; then echo "  (backend log kept: $LOG — $(wc -c <"$LOG" 2>/dev/null || echo 0) bytes)" >&2
  else rm -rf "$WORK"; fi
  return 0
}
trap cleanup EXIT INT TERM

boot() { # graceMs -> sets BE
  # DO NOT re-point the SHARED pack namespace. `ensureLocalPacksMounted`
  # (index.ts:344) rewrites every ~/.openwop-packs symlink to point at THIS
  # worktree on boot, and symlinks resolve on every read — so a peer's suite,
  # running from another checkout, can start reading our pack code MID-RUN and
  # a parity assertion can pass against the wrong repo. That is worse than a red
  # test. GATE-6 moved a backend boot into the DEFAULT gate, so without this the
  # hazard fires on every `npm run ci` rather than only under `ci:full`.
  # Nothing here tests packs; this asserts SIGTERM handling.
  OPENWOP_MOUNT_LOCAL_PACKS=false \
  OPENWOP_SHUTDOWN_GRACE_MS="$1" \
  OPENWOP_STORAGE_DSN=memory:// \
  OPENWOP_SESSION_SECRET=dev-session-secret-at-least-32-characters-long \
  PORT="$PORT" node "$ENTRY" >"$LOG" 2>&1 &
  BE=$!
  for _ in $(seq 1 60); do gate_port_in_use "$PORT" && return 0; sleep 1; done
  return 1
}

# A connection mid-request is NOT idle, so `server.close()` must wait for it.
# (An idle keep-alive connection will NOT do: Node >= 19 closes those on
# `server.close()`, so the force path would never be exercised — measured.)
hold_open() {
  node -e "
    const net = require('net');
    const s = net.connect($PORT, '127.0.0.1', () => {
      s.write('POST /health HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n',
        () => require('fs').writeFileSync('$HELD', 'held'));
    });
    s.on('data', () => {}); s.on('error', () => {});
    setTimeout(() => process.exit(0), 30000);
  " >/dev/null 2>&1 &
  HOLDER=$!
  # WAIT FOR THE HOLD, never a fixed sleep. This was `sleep 2`, and it flaked about
  # 1 run in 6 on main (MEASURED 2026-09-16): under load the holder's own `node`
  # start took longer than 2s, SIGTERM arrived before any request existed, the
  # server drained cleanly, and the force-path assertion below failed. Reproduced
  # deterministically by delaying the holder's connect by 3s. The marker is written
  # once the request headers are flushed to the socket; the lsof check then proves
  # the BACKEND holds an established connection on the port, not merely that the
  # client thinks it wrote.
  local waited=0
  until [ -s "$HELD" ] && lsof -nP -a -p "$BE" -iTCP:"$PORT" -sTCP:ESTABLISHED >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -gt 150 ]; then return 1; fi   # 15s — a hold that never lands is a harness failure
    sleep 0.1
  done
  sleep 0.5   # let the server parse the headers so the request is in flight, not idle
  return 0
}

died_within() { # seconds -> 0 if the backend exited in time
  local n="$1"
  for _ in $(seq 1 "$n"); do kill -0 "$BE" 2>/dev/null || return 0; sleep 1; done
  kill -0 "$BE" 2>/dev/null && return 1 || return 0
}

echo "== shutdown (SHUTDOWN-1) =="

# 1. THE DEFECT ITSELF: a clean SIGTERM must exit, and promptly. Every daemon
#    timer is unref'd, so closing the server is enough — no force needed.
if boot 8000; then
  kill "$BE" 2>/dev/null
  if died_within 10; then ok "exits on SIGTERM (clean drain)"; else bad "STILL RUNNING 10s after SIGTERM — the leak is back"; fi
  grep -q 'shutdown: still alive after grace' "$LOG" \
    && bad "the clean path FORCED — the drain is no longer sufficient on its own" \
    || ok "the clean path drained naturally, without forcing"
else
  bad "backend never came up on :$PORT"
fi
kill -9 "$BE" 2>/dev/null; BE=""

# 2. THE BACKSTOP: when something holds the server open (in production, a live
#    collab WebSocket), it must still exit at the grace rather than hang.
PORT="$(gate_pick_free_port $((PORT + 1)))"
if boot 3000 && hold_open; then
  kill "$BE" 2>/dev/null
  if died_within 12; then ok "exits at the grace even when a connection holds the server open"; else bad "HUNG on a held-open connection — the force path is broken"; fi
  grep -q 'shutdown: still alive after grace' "$LOG" \
    && ok "the force path logged that it forced (an operator can tell the two apart)" \
    || bad "forced without saying so, or never forced"
  kill "$HOLDER" 2>/dev/null; HOLDER=""
else
  bad "backend never came up on :$PORT, or the holding request never reached it"
fi
kill -9 "$BE" 2>/dev/null; BE=""

# NOT TESTED, deliberately: "a second signal exits immediately". I wrote that
# assertion, and the sabotage probe showed it PASSED with the bug restored — with
# `process.once` the handler is removed after the first signal, so a second
# SIGTERM hits Node's default disposition and terminates the process anyway.
# There is no behaviour there to protect, so there is no test here. A green
# assertion that cannot fail is worse than no assertion: it reports coverage it
# does not have.

echo "== shutdown: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
