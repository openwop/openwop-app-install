#!/usr/bin/env bash
#
# GATE-6 — does `e2e-routes.sh` actually WIRE its Vite to Playwright?
#
# `test-gate-tooling.sh` proves the MECHANISM (port picking, ownership walking)
# in isolation. `src/__tests__/e2eLaneWiring.test.ts` proves the CONFIG half
# (reuse ⇒ adopt; every port-bearing field agrees). Neither proves the stage
# HANDS Playwright the port it actually booted — and that gap is not theoretical:
# GATE-1 was a correct-in-isolation guard wired to the wrong process tree, and it
# reached main because nothing exercised this stage end to end.
#
# So this boots the REAL stage with a STUB Playwright, and asserts what the stage
# hands over plus how many servers are alive at that moment. It costs a backend
# build + two server boots (~1 min) and no browser, which is why it runs where
# `e2e-routes.sh` runs rather than in the default gate.
#
#   bash scripts/test-e2e-routes-wiring.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/gate-ports.sh
. "$ROOT/scripts/lib/gate-ports.sh"
gate_require_lsof || exit 1

WORK="$(mktemp -d)"
OBS="$WORK/observed.json"
trap 'rm -rf "$WORK"' EXIT

# The stub records what the stage handed it, then exits 0 so the stage completes
# its own teardown exactly as it would after a real run.
cat > "$WORK/stub-playwright.mjs" <<'JS'
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const port = process.env.OPENWOP_E2E_PORT ?? '';
let listeners = [];
try {
  listeners = execSync(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch { /* no listener — recorded as an empty list, which the assertions catch */ }
writeFileSync(process.env.OPENWOP_E2E_WIRING_OBS, JSON.stringify({
  port,
  reuse: process.env.OPENWOP_E2E_REUSE_SERVER ?? '',
  routes: process.env.OPENWOP_E2E_ROUTES ?? '',
  listeners: [...new Set(listeners)],
  argv: process.argv.slice(2),
}));
JS

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✗ $1" >&2; }

# Count backends BEFORE the stage. The stage's own backend must be gone when it
# exits — and this assertion exists because it was NOT: the backend ignores
# SIGTERM (its handler never closes the server or exits), so plain `kill` left it
# serving forever. Eight orphans accumulated in one session before it was noticed,
# each one holding a port the next run then had to skip.
BE_PATTERN="$ROOT/backend/typescript/lib/index.js"
be_count() { pgrep -f "$BE_PATTERN" 2>/dev/null | wc -l | tr -d " "; }
BE_BEFORE="$(be_count)"

echo "== e2e-routes wiring (stub Playwright; no browser) =="
echo "   booting the real stage — backend build + backend + vite…"

# Same shared-namespace guard as `test-shutdown.sh`: this drives the real stage,
# which boots a backend, and a default-gate run must not re-point every
# ~/.openwop-packs symlink out from under a peer's in-flight suite. Playwright is
# stubbed here, so no spec needs a pack.
OPENWOP_MOUNT_LOCAL_PACKS=false \
OPENWOP_E2E_WIRING_OBS="$OBS" \
OPENWOP_E2E_PLAYWRIGHT_BIN="$WORK/stub-playwright.mjs" \
  bash "$ROOT/scripts/e2e-routes.sh" > "$WORK/stage.log" 2>&1
STAGE_EXIT=$?

if [ ! -s "$OBS" ]; then
  bad "the stage never reached the Playwright step (exit $STAGE_EXIT)"
  echo "--- last 25 lines of the stage log ---" >&2
  tail -25 "$WORK/stage.log" >&2
  exit 1
fi
ok "the stage reached the Playwright step"

read -r PORT REUSE ROUTES NLISTEN <<EOF
$(node -e '
const o = require(process.argv[1]);
process.stdout.write([o.port, o.reuse, o.routes, o.listeners.length].join(" "));
' "$OBS")
EOF

# 1. Reuse must be ON, or Playwright starts a SECOND Vite beside the one the
#    stage just booted — the double-server bug GATE-6 exists to pin.
[ "$REUSE" = "1" ] && ok "hands Playwright OPENWOP_E2E_REUSE_SERVER=1 (adopt, don't spawn)" \
                   || bad "reuse flag was '$REUSE' — Playwright would start a second Vite"

# 2. The port handed over must be a port something is actually SERVING, not a
#    number the stage merely chose. A stale or mis-plumbed value is how the
#    suite ends up driving a server nobody configured.
[ -n "$PORT" ] && ok "hands Playwright a port ($PORT)" || bad "no OPENWOP_E2E_PORT handed over"
[ "$NLISTEN" -ge 1 ] 2>/dev/null && ok "something is serving on :$PORT at hand-off" \
                                 || bad "NOTHING was listening on :$PORT when Playwright was invoked"

# 3. Exactly ONE process serves it. Two would mean the stage duplicated its own
#    server; zero is covered above.
[ "$NLISTEN" = "1" ] && ok "exactly ONE server on :$PORT — not two" \
                     || bad "$NLISTEN processes listening on :$PORT (want exactly 1)"

# 4. The route-suite marker rides along; without it the stage runs a different
#    set of specs than its name promises.
[ "$ROUTES" = "1" ] && ok "hands Playwright OPENWOP_E2E_ROUTES=1" \
                    || bad "OPENWOP_E2E_ROUTES was '$ROUTES'"

# 5. The stage must still exit clean — the seam must not change its behaviour.
[ "$STAGE_EXIT" = "0" ] && ok "the stage exits 0 through the seam" \
                        || bad "the stage exited $STAGE_EXIT"

# 6. Nothing may survive teardown. A stage that leaks its servers poisons the
#    NEXT stage's ports, which is exactly the failure that started this work.
sleep 1
if gate_port_in_use "$PORT"; then
  bad "the stage LEAKED its Vite on :$PORT after exiting"
else
  ok "teardown released :$PORT"
fi

BE_AFTER="$(be_count)"
if [ "$BE_AFTER" = "$BE_BEFORE" ]; then
  ok "teardown left no orphaned backend (before=$BE_BEFORE after=$BE_AFTER)"
else
  bad "the stage LEAKED a backend (before=$BE_BEFORE after=$BE_AFTER) — SIGTERM is ignored; escalate to KILL"
fi

echo "== e2e-routes wiring: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
