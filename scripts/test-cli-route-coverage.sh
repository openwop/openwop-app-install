#!/usr/bin/env bash
# Self-test for scripts/cli-route-coverage.mjs (the /update-cli gap measure).
# Runs against THIS repo's real route table and a synthetic CLI tree, so it
# needs no ../openwop-cli checkout. The three properties that matter:
#   1. a CLI that calls nothing reaches (almost) nothing — the check can fail;
#   2. a path the CLI composes from a base constant counts as reached — the
#      under-count the literal grep had (~1,130 "gaps" vs ~90 real) stays fixed;
#   3. a missing --cli checkout is a usage error, not an empty green report.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/cli-route-coverage.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail() { echo "✗ test-cli-route-coverage: $*" >&2; exit 1; }

# 1. Empty CLI → the gap count is large (the measure is not vacuous).
mkdir -p "$TMP/empty/src"; : > "$TMP/empty/src/index.ts"
gaps=$(node "$SCRIPT" --cli "$TMP/empty" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).gaps.length))')
[ "$gaps" -gt 500 ] || fail "an empty CLI should leave >500 routes unreached, got $gaps"

# 2. A path composed from a base constant is reached.
mkdir -p "$TMP/composed/src"
cat > "$TMP/composed/src/relay.ts" <<'TS'
const MESSAGING_BASE = '/v1/host/openwop-app/messaging';
export const enqueue = (id: string) => `${MESSAGING_BASE}/relay/enqueue?id=${id}`;
TS
node "$SCRIPT" --cli "$TMP/composed" --json > "$TMP/composed.json"
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const stillGap = r.gaps.some((g) => g.method === "POST" && g.path === "/v1/host/openwop-app/messaging/relay/enqueue");
  if (stillGap) { console.error("composed path reported as a gap"); process.exit(1); }
' "$TMP/composed.json" || fail "a path composed from a base constant must count as reached"

# 3. No CLI checkout → exit 2.
set +e; node "$SCRIPT" --cli "$TMP/does-not-exist" >/dev/null 2>&1; code=$?; set -e
[ "$code" -eq 2 ] || fail "a missing --cli checkout must exit 2, got $code"

echo "✓ test-cli-route-coverage: vacuity, composed paths, and the missing-checkout refusal hold."
