#!/usr/bin/env bash
#
# Live feature-route Playwright run (ADR 0183). Boots a local backend on :8080 with the
# test seams, a cookie-mode Vite dev server proxying /api → :8080, then runs the
# render-smoke (e2e/feature-routes.spec.ts) + step-driven (e2e/feature-gated.spec.ts).
# This makes the "56 passed live" result reproducible instead of a one-off manual run.
#
# Gated (needs Chromium + a free :8080/:5173). Run directly, or via `npm run ci:full`
# (which sets OPENWOP_CI_E2E_ROUTES=1) / `npm run test:e2e:full`.
#
# Env knobs: OPENWOP_E2E_BACKEND_PORT / OPENWOP_E2E_WEB_PORT — both AUTO-SELECT a
# free port when unset; a PINNED port that is busy is an error, never relocated.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# PICK FREE PORTS, and REFUSE an occupied one rather than adopting it.
#
# These used to default hard to 8080/5173. `ci.sh` learned to auto-select (ADR
# 0509 Phase 4a) but this script reads DIFFERENT variable names, so the fix never
# reached it — same assumption, different port. It then collided with a dev server,
# or with the previous stage's server that had not finished releasing.
#
# Refusing beats adopting: `wait_for` below cannot tell OUR server from an
# occupant, so adopting one would run the suite against a different build and
# report it green — the defect `playwright.config.ts` keeps `reuseExistingServer`
# off for.
#
# Shared with `ci.sh` and tested by `scripts/test-gate-tooling.sh` — see that file
# for why these helpers are not inlined here any more.
# shellcheck source=lib/gate-ports.sh
. "$ROOT/scripts/lib/gate-ports.sh"
gate_require_lsof || exit 1
pick_free_port() { gate_pick_free_port "$@"; }
if [ -n "${OPENWOP_E2E_BACKEND_PORT:-}" ]; then
  BE_PORT="$OPENWOP_E2E_BACKEND_PORT"
  gate_port_in_use "$BE_PORT" && {
    echo "error: pinned backend port :$BE_PORT is in use — free it, or unset OPENWOP_E2E_BACKEND_PORT to auto-select." >&2; exit 1; }
else
  BE_PORT="$(pick_free_port 8080)" || { echo "error: no free backend port in 8080-8120." >&2; exit 1; }
fi
if [ -n "${OPENWOP_E2E_WEB_PORT:-}" ]; then
  WEB_PORT="$OPENWOP_E2E_WEB_PORT"
  gate_port_in_use "$WEB_PORT" && {
    echo "error: pinned web port :$WEB_PORT is in use — free it, or unset OPENWOP_E2E_WEB_PORT to auto-select." >&2; exit 1; }
else
  WEB_PORT="$(pick_free_port 5173)" || { echo "error: no free web port in 5173-5213." >&2; exit 1; }
fi
BE_PID=""; WEB_PID=""

cleanup() {
  # `npm run dev` spawns Vite as a CHILD, so kill the wrapper's children first, then it.
  [ -n "$WEB_PID" ] && pkill -P "$WEB_PID" 2>/dev/null || true
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  #
  # THE BACKEND IGNORES SIGTERM, so `kill` alone LEAKS IT. Its handler stops the
  # daemons and drains the storage pool but never closes the HTTP server and
  # never exits, so the listener holds the event loop open and the process keeps
  # serving forever. MEASURED: eight orphaned backends accumulated in one
  # session, each still answering /health.
  #
  # This stage now runs in the DEFAULT gate, so a leak per run is a leak per
  # `npm run ci`. Escalate: TERM, give it a moment, then KILL.
  #
  # There used to be a `pkill -f "backend/typescript/lib/index.js"` here, labelled
  # "best-effort: reap any strays we spawned". It is gone because a
  # pattern-matched kill cannot tell your process from someone else's — but note
  # it never worked as cleanup either, since it also sent SIGTERM.
  if [ -n "$BE_PID" ]; then
    kill "$BE_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$BE_PID" 2>/dev/null || break; sleep 1; done
    kill -9 "$BE_PID" 2>/dev/null || true
  fi
  return 0
}
trap cleanup EXIT INT TERM

wait_for() { # url, name, tries
  local url="$1" name="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then echo "  ✓ $name up"; return 0; fi
    sleep 1
  done
  echo "  ✗ $name did not come up at $url" >&2; return 1
}

echo "== e2e-routes: build backend =="
( cd "$ROOT/backend/typescript" && npm run build >/dev/null )

echo "== e2e-routes: boot backend on :$BE_PORT (test seams + DEV_OPEN, memory DSN) =="
OPENWOP_TEST_AUTH_ENABLED=true \
OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true \
OPENWOP_STORAGE_DSN=memory:// \
OPENWOP_SESSION_SECRET=dev-session-secret-at-least-32-characters-long \
PORT="$BE_PORT" \
  node "$ROOT/backend/typescript/lib/index.js" >/tmp/owp-e2e-backend.log 2>&1 &
BE_PID=$!
# /health is up even while /readiness reports degraded (managed provider unconfigured).
wait_for "http://localhost:$BE_PORT/health" "backend" 60

# BOOT VITE, AND RECOVER FROM A LOST PORT RACE RATHER THAN DYING ON IT.
#
# `gate_pick_free_port` proves a port free, but binding happens seconds later, so
# two gates starting at once can pick the SAME free port — and only one wins. The
# ownership guard below correctly refuses to adopt the winner's server (that is
# the whole point of it), but "correctly refusing" is still a red gate for work
# that was never broken. Since this stage now runs in the DEFAULT gate, where
# peers run concurrently, a lost race has to be recovered, not reported.
#
# MEASURED: two stages started together, one won the port and the other failed
# with "our server never bound". With this loop, the loser simply takes the next
# free port. Bounded at 3 so a genuinely un-bootable Vite still fails loudly
# instead of spinning.
web_attempt=0
while :; do
  web_attempt=$((web_attempt + 1))
  # `--port … --strictPort` is NOT decoration. This stage used to run a bare
  # `npm run dev` and then WAIT on the port it had picked itself — two independent
  # choices that agreed only because Vite auto-increments from 5173 and the ports
  # below happened to be occupied in exactly the right pattern. It worked by
  # coincidence, the same shape as the #2784 split-backend bug, and the coincidence
  # broke the moment a retry asked for a port Vite would not have chosen.
  # `--strictPort` also makes a lost race FAIL rather than silently hop to another
  # port, which is what lets the retry below own the recovery.
  echo "== e2e-routes: boot cookie-mode Vite dev server on :$WEB_PORT (proxy /api → :$BE_PORT) =="
  ( cd "$ROOT/frontend/react" && \
    VITE_OPENWOP_AUTH_MODE=cookie \
    VITE_OPENWOP_BASE_URL=/api \
    OPENWOP_DEV_PROXY_TARGET="http://localhost:$BE_PORT" \
      npm run dev -- --port "$WEB_PORT" --strictPort >/tmp/owp-e2e-vite.log 2>&1 ) &
  WEB_PID=$!
  if wait_for "http://localhost:$WEB_PORT/" "vite" 60 \
     && gate_assert_port_owned_by "$WEB_PORT" "$WEB_PID" >/dev/null 2>&1; then
    break
  fi
  # Ours did not bind, or someone else holds the port. Either way this attempt is
  # dead: tear down only what THIS attempt started, then try a different port.
  pkill -P "$WEB_PID" 2>/dev/null || true
  kill "$WEB_PID" 2>/dev/null || true
  WEB_PID=""
  if [ "$web_attempt" -ge 3 ] || [ -n "${OPENWOP_E2E_WEB_PORT:-}" ]; then
    # A PINNED port is never relocated — if you named it, you meant it.
    echo "error: Vite did not come up on :$WEB_PORT after $web_attempt attempt(s)." >&2
    tail -20 /tmp/owp-e2e-vite.log >&2
    exit 1
  fi
  WEB_PORT="$(gate_pick_free_port $((WEB_PORT + 1)))" || { echo "error: no free web port." >&2; exit 1; }
  echo "  ↻ port contended — retrying on :$WEB_PORT"
done
wait_for "http://localhost:$WEB_PORT/api/health" "proxy → backend" 30

echo "== e2e-routes: run render-smoke + step-driven =="
( cd "$ROOT/frontend/react" && \
  # TOCTOU GUARD. `pick_free_port` proved the port free, but another process could
  # have taken it between that check and our `npm run dev` binding — and `wait_for`
  # cannot tell OUR server from an occupant. Adopting one would run the suite
  # against a different build and report it green, which is the defect
  # `reuseExistingServer:false` exists to prevent. So before enabling reuse, prove
  # the listener is a descendant of the wrapper we started.
  #
  # The first cut of this guard was WRONG and would have failed every legitimate
  # run. It compared the listener against `pgrep -P "$WEB_PID"`, which lists only
  # DIRECT children — but the real chain is three deep: this script backgrounds a
  # SUBSHELL, the subshell runs `npm`, and npm spawns the vite that actually binds.
  # The listener is a GRANDCHILD, so the check never matched and the stage would
  # have refused its own server. It survived review because this stage runs only
  # under `ci:full`, and I verified the change with `bash -n` — which proves
  # syntax, not behaviour. The corrected walk now lives in the shared lib, where
  # `scripts/test-gate-tooling.sh` pins BOTH directions: it accepts our own
  # grandchild AND refuses a foreign listener. Without that negative control,
  # "it accepts our server" would also be satisfied by a function that always
  # returns 0 — which is exactly the kind of vacuous check that let this ship.
  gate_assert_port_owned_by "$WEB_PORT" "$WEB_PID" || exit 1

  # ONE Vite, not two. Playwright reads OPENWOP_E2E_PORT and, with reuse off,
  # would start its OWN server — ignoring the one this script booted seconds ago
  # and duplicating it on whatever port it inherited. Point it at ours and allow
  # reuse. That flag is normally off because a suite must never bind a server it
  # did not start; here the check above PROVED every listener on this port
  # descends from the server this script launched, which is the case the flag's
  # warning carves out for. Proven, not argued from timing.
  # TEST SEAM (GATE-6). `scripts/test-e2e-routes-wiring.sh` substitutes a stub
  # here to observe what this stage HANDS Playwright — the port and the reuse
  # flag — without paying for the real suite. Unset everywhere else, so the
  # default path is byte-identical to what it was before the seam existed.
  OPENWOP_E2E_PORT="$WEB_PORT" \
  OPENWOP_E2E_REUSE_SERVER=1 \
  OPENWOP_E2E_ROUTES=1 node "${OPENWOP_E2E_PLAYWRIGHT_BIN:-node_modules/@playwright/test/cli.js}" test feature-routes feature-gated announcement-delivery --reporter=line )
echo "== e2e-routes: PASS =="
