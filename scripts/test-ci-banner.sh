#!/usr/bin/env bash
# Execute the real CI banner with a recording npm stub: double-quoted backticks
# used to run both installs while printing the step, even on a docs-only gate.
# No dependencies, network, real npm calls, or release-bus writes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$ROOT/scripts/ci.sh}"
PROBE="$(mktemp -d)"
trap 'rm -rf "$PROBE"' EXIT

sed -n '/^step .*build configs:/p' "$SOURCE" > "$PROBE/banner.txt"
[ "$(wc -l < "$PROBE/banner.txt" | tr -d ' ')" = 1 ] || {
  echo 'CI banner probe: expected exactly one build-config banner' >&2; exit 1;
}
cat > "$PROBE/run.sh" <<'SH'
set -euo pipefail
step() { printf '%s\n' "$*"; }
npm() { printf '%s\n' "$*" >> "$BANNER_NPM_CALLS"; }
SH
cat "$PROBE/banner.txt" >> "$PROBE/run.sh"
BANNER_NPM_CALLS="$PROBE/npm-calls" bash "$PROBE/run.sh" > "$PROBE/output"
if [ -e "$PROBE/npm-calls" ]; then
  echo 'CI banner probe: printing the banner executed npm:' >&2
  cat "$PROBE/npm-calls" >&2
  exit 1
fi
printf '%s\n' 'build configs: `npm ci`, never `npm install` (zero gate)' > "$PROBE/expected"
cmp "$PROBE/expected" "$PROBE/output"
echo 'CI banner probe: literal banner, no package-manager calls'
