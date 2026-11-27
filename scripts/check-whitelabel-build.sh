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
# It first checks that the steward-only trees build-whitelabel-zip.sh strips are
# really absent. That needs no npm, so it runs even when the build smoke is skipped.
#
# Usage: check-whitelabel-build.sh [path/to/openwop-demo-app.zip]
# Skip:  OPENWOP_SKIP_WHITELABEL_SMOKE=1 skips the BUILD smoke (e.g. no npm), not the strip check.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
ZIP="${1:-$ROOT/dist-whitelabel/openwop-demo-app.zip}"
SMOKE_URL="https://whitelabel-build-smoke.invalid"   # throwaway, inline only

[ -f "$ZIP" ] || { echo "[whitelabel-smoke] FATAL: zip not found: $ZIP (run build-whitelabel-zip.sh first)"; exit 1; }

# A stripped path that reaches the bundle reaches every adopter: the steward's meta
# leaks, and a path the adopter also writes conflicts on every sync. One entry per
# strip in build-whitelabel-zip.sh; the root-markdown allowlist has its own check.
LEAKED="$(unzip -Z1 "$ZIP" | grep -E '^openwop-demo-app/(\.claude/|\.agents/|\.github/|docs/steward/|docs/research/|backend/typescript/test/steward/|\.hyve/|hyvemind\.json$)' || true)"
if [ -n "$LEAKED" ]; then
  echo "[whitelabel-smoke] ✗ the bundle ships paths build-whitelabel-zip.sh must strip:"
  echo "$LEAKED" | head -20 | sed 's/^/    /'
  exit 1
fi
echo "[whitelabel-smoke] ✓ no steward-only paths in the bundle"

# RFC 0266 — the backend boots from `schemas/v2/` and reads no flat v1 schema. A flat
# `schemas/*.schema.json` (or `schemas/envelopes/`) in the bundle means a sync brought
# the frozen v1 tree back, and an adopter would ship it as if it were current input.
FLAT_V1="$(unzip -Z1 "$ZIP" | grep -E '^openwop-demo-app/schemas/([^/]+\.schema\.json|envelopes/)' || true)"
if [ -n "$FLAT_V1" ]; then
  echo "[whitelabel-smoke] ✗ the bundle ships the frozen flat v1 schema tree (RFC 0266):"
  echo "$FLAT_V1" | head -10 | sed 's/^/    /'
  exit 1
fi
# Not `unzip | grep -q`: grep -q exits on the first match, unzip dies of SIGPIPE (141)
# and `set -o pipefail` turns a present file into a failure.
unzip -Z1 "$ZIP" | grep -x 'openwop-demo-app/schemas/v2/ids.schema.json' >/dev/null \
  || { echo "[whitelabel-smoke] ✗ the bundle has no schemas/v2/ — the backend cannot boot"; exit 1; }
echo "[whitelabel-smoke] ✓ schemas/v2/ only (no flat v1 tree)"

if [ "${OPENWOP_SKIP_WHITELABEL_SMOKE:-0}" = "1" ]; then
  echo "[whitelabel-smoke] build smoke skipped (OPENWOP_SKIP_WHITELABEL_SMOKE=1)"
  exit 0
fi
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
