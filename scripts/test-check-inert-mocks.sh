#!/bin/bash
# test-check-inert-mocks.sh — frontend/react/scripts/check-inert-mocks.mjs reads the keys a vi.mock
# factory RETURNS, in both factory shapes, and never a local's type annotation (main f3bb33c4a5, 2026-11-27).
#
# The bug this pins: the check took the first `{` after the specifier as the override object. For a
# BLOCK-bodied factory (`async (orig) => { const x: T = …; return { … }; }`) that brace is the function
# body, so `x: T` read as a key the module "does not export" (two false reds on main f3bb33c4a5), and the
# real keys inside `return { … }` were never checked at all.
#
# Each case builds a throwaway tree with NO .git, so the check walks src/ (its adopter-bundle path).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/frontend/react/scripts/check-inert-mocks.mjs"
pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1"; [ -n "${2:-}" ] && echo "    $2"; fail=$((fail + 1)); }

# run_case <name> <want-exit> <want-text|''> <test-body>
run_case() {
  local name="$1" want="$2" text="$3" body="$4" T out rc
  T="$(mktemp -d "${TMPDIR:-/tmp}/inert-mocks.XXXXXX")"
  mkdir -p "$T/scripts" "$T/src/__tests__"
  cp "$CHECK" "$T/scripts/"
  cat > "$T/src/client.ts" <<'TS'
export function realRead(): number { return 1; }
export const realConst = 2;
export interface Thing { id: string }
TS
  printf '%s\n' "$body" > "$T/src/__tests__/x.test.ts"
  out="$(cd "$T" && node scripts/check-inert-mocks.mjs 2>&1)"; rc=$?
  rm -rf "$T"
  if [ "$rc" != "$want" ]; then bad "$name" "exit $rc, want $want: $out"; return; fi
  if [ -n "$text" ] && ! grep -qF -- "$text" <<<"$out"; then bad "$name" "missing '$text' in: $out"; return; fi
  ok "$name"
}

echo "▶ check-inert-mocks: reads the RETURNED keys of a vi.mock factory, in both shapes"

run_case "block body: an annotated local is not a key (the two false reds on main)" 0 "" \
"vi.mock('../client.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  const thing: Thing = { id: 'a' };
  return { ...actual, realRead: () => thing.id.length };
});"

run_case "block body: an inert key inside return { … } is caught (it was never read)" 1 "overrides 'notExported'" \
"vi.mock('../client.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, notExported: 1, realRead: () => 3 };
});"

run_case "block body: an inert key in a second return is caught" 1 "overrides 'alsoMissing'" \
"vi.mock('../client.js', async (orig) => {
  if (Math.random() > 2) { return { realRead: () => 1 }; }
  return { alsoMissing: 1 };
});"

run_case "expression body: an inert key is caught" 1 "overrides 'gone'" \
"vi.mock('../client.js', () => ({ gone: 1, realConst: 3 }));"

run_case "expression body: real exports pass" 0 "" \
"vi.mock('../client.js', () => ({ realRead: () => 2, realConst: 3 }));"

echo "check-inert-mocks: $pass passed, $fail failed"
[ "$fail" = 0 ]
