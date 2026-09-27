#!/usr/bin/env bash
# check-whitelabel-build (ADR 0052) — build-health smoke for the stripped white-label
# bundle. Extracts the published zip and runs the SAME build an adopter runs (the
# frontend canonical gate + the backend bundle), proving the shipped tree compiles
# AFTER the .env/steward strip — catching "the bundle no longer builds" BEFORE it
# reaches the public install repo.
#
# The required VITE_OPENWOP_BASE_URL is supplied INLINE with a throwaway value; it is
# NEVER written into the shipped .env.production, so the adopter's fail-closed config
# guard (vite.config.ts aborts a prod build with no/default backend URL) stays intact.
# A baked-in default would be a footgun (a forgotten value → a silently broken deploy).
#
# Usage: check-whitelabel-build.sh [path/to/openwop-demo-app.zip]
# Skip:  OPENWOP_SKIP_WHITELABEL_SMOKE=1 (e.g. an environment without npm).
set -euo pipefail

if [ "${OPENWOP_SKIP_WHITELABEL_SMOKE:-0}" = "1" ]; then
  echo "[whitelabel-smoke] skipped (OPENWOP_SKIP_WHITELABEL_SMOKE=1)"
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"
ZIP="${1:-$ROOT/dist-whitelabel/openwop-demo-app.zip}"
SMOKE_URL="https://whitelabel-build-smoke.invalid"   # throwaway, inline only

[ -f "$ZIP" ] || { echo "[whitelabel-smoke] FATAL: zip not found: $ZIP (run build-whitelabel-zip.sh first)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "[whitelabel-smoke] FATAL: npm not on PATH"; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
unzip -q "$ZIP" -d "$WORK"
APP="$WORK/openwop-demo-app"
[ -d "$APP" ] || { echo "[whitelabel-smoke] FATAL: unexpected zip layout (no openwop-demo-app/)"; exit 1; }

# Run one project's build, surfacing the tail on failure.
smoke() { # <label> <dir> <build-cmd...>
  local label="$1" dir="$2"; shift 2
  local log="$WORK/$label.log"
  echo "[whitelabel-smoke] $label: npm ci + build …"
  if ( cd "$APP/$dir" && npm ci --no-audit --no-fund && "$@" ) >"$log" 2>&1; then
    echo "[whitelabel-smoke] ✓ $label builds"
  else
    echo "[whitelabel-smoke] ✗ $label build FAILED — the stripped bundle does not build:"
    tail -30 "$log" | grep -vE 'punycode|DeprecationWarning' || true
    exit 1
  fi
}

# Frontend: the canonical gate (tsc + token/CSS checks + vite). The adopter backend
# URL is required by vite.config.ts, so supply it inline for the smoke only.
smoke frontend frontend/react env VITE_OPENWOP_BASE_URL="$SMOKE_URL" npm run build
# Backend: the esbuild bundle.
smoke backend backend/typescript npm run build

echo "[whitelabel-smoke] ✓ the white-label bundle is buildable (frontend + backend)"
