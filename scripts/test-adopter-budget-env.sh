#!/usr/bin/env bash
#
# Issue #5006 (ADR 0874 D4, amended 2026-10-22) — the REAL-BUILD witness that an
# adopter's brand strings cannot move the entry size check-bundle-budget judges.
#
# Four production `vite build`s of THIS frontend (minutes, so not in the default
# gate; `scripts/test-gate-tooling.sh` pins the decision and the ci.sh wiring in
# seconds). Run it when vite.config.ts's env handling or budget_env_dir changes.
#
#   R  the full repo, no override          → reads frontend/react/.env.production
#   A  adopter tree, brand-heavy .env.production, via budget_env_dir
#   B  adopter tree, NO .env.production,         via budget_env_dir
#   X  the brand-heavy file loaded directly (what ci.sh did before #5006)
#
# Asserts: A == B (the same entry bytes, the claim); X > A (the brand strings DO
# reach the entry when loaded, so A == B is a measurement, not an inert
# override); budget_env_dir gives the full repo no override, and R carries a
# value only this repo's .env.production holds (it still reads its own file).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FE="$ROOT/frontend/react"
# shellcheck source=lib/steward-lane.sh
. "$ROOT/scripts/lib/steward-lane.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ✗ $1" >&2; }

[ -x "$FE/node_modules/.bin/vite" ] || { echo "frontend/react has no node_modules (npm ci there first)" >&2; exit 2; }
T="$(mktemp -d "${TMPDIR:-/tmp}/owp-budget-env-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT

# Adopter-shaped trees: no docs/steward/ and no backend/typescript/test/steward/,
# so steward_lane says `skip`, which is what ci.sh passes to budget_env_dir.
for t in heavy bare; do
  mkdir -p "$T/$t/frontend/react"
  cp "$FE/.env.production.example" "$T/$t/frontend/react/.env.production.example"
done
brand() { printf 'ZZ-%s-' "$1"; for _ in 1 2 3 4 5 6 7 8; do printf '%s' "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"; done; }
{
  echo "VITE_OPENWOP_BASE_URL=/api"
  echo "VITE_OPENWOP_AUTH_MODE=cookie"
  for k in PRODUCT_NAME MARK_PRE MARK_EMPHASIS MARK_SUB TAGLINE ASSISTANT_NAME DOCUMENT_TITLE DESCRIPTION PRIMARY_DOMAIN INSTANCE_NAME FOOTER_TEXT; do
    echo "VITE_BRAND_$k=$(brand "$k")"
  done
} > "$T/heavy/frontend/react/.env.production"

lane_heavy="$(steward_lane "$T/heavy")"; lane_repo="$(steward_lane "$ROOT")"
[ "$lane_heavy" = skip ] && ok "the adopter-shaped tree is detected as a bundle" || bad "adopter tree detected as '$lane_heavy'"
[ "$lane_repo" = take ] || { echo "this checkout is not the full repo (steward lane '$lane_repo')" >&2; exit 2; }
DA="$(budget_env_dir "$T/heavy" skip)" || { bad "budget_env_dir refused the heavy tree"; exit 1; }
DB="$(budget_env_dir "$T/bare" skip)"  || { bad "budget_env_dir refused the bare tree"; exit 1; }
DR="$(budget_env_dir "$ROOT" "$lane_repo")"
[ -z "$DR" ] && ok "the full repo gets no override" || bad "the full repo got an override: $DR"

# build <name> [envdir] → prints the entry chunk's gzip bytes (the budget's measure).
build() {
  local name="$1" envd="${2:-}" out="$T/out-$1" log="$T/build-$1.log"
  if [ -n "$envd" ]; then
    ( cd "$FE" && OPENWOP_VITE_ENV_DIR="$envd" node node_modules/vite/bin/vite.js build --outDir "$out" --emptyOutDir ) > "$log" 2>&1
  else
    ( cd "$FE" && node node_modules/vite/bin/vite.js build --outDir "$out" --emptyOutDir ) > "$log" 2>&1
  fi || { echo "build $name FAILED (tail of $log):" >&2; tail -20 "$log" >&2; return 1; }
  node -e '
    const fs = require("fs"), z = require("zlib"), d = process.argv[1] + "/assets";
    const e = fs.readdirSync(d).find((f) => f.startsWith("index-") && f.endsWith(".js"));
    process.stdout.write(String(z.gzipSync(fs.readFileSync(d + "/" + e)).length));
  ' "$out"
}

echo "== 4 production builds (minutes) =="
R="$(build repo)"           || exit 1; echo "  R repo, own .env.production      : $R B"
A="$(build heavy "$DA")"    || exit 1; echo "  A adopter, brand-heavy, #5006    : $A B"
B="$(build bare "$DB")"     || exit 1; echo "  B adopter, no .env.production    : $B B"
X="$(build loaded "$T/heavy/frontend/react")" || exit 1; echo "  X brand-heavy loaded (pre-#5006) : $X B"

[ "$A" = "$B" ] && ok "adopter entry with brand strings == without ($A B): brand bytes cannot move the budget" \
  || bad "adopter entry moved with its .env.production: $A vs $B B"
[ "$X" -gt "$A" ] && ok "loaded directly, the brand strings add $((X - A)) B to the entry (so A == B is a measurement)" \
  || bad "brand-heavy env did not grow the entry ($X vs $A B): the witness is vacuous"
if grep -rqF "openwop-dev" "$T/out-repo/assets"; then
  ok "the full repo's build still inlines its own .env.production (VITE_FIREBASE_PROJECT_ID=openwop-dev)"
else
  bad "the full repo's build no longer carries its own .env.production values"
fi
if grep -rqF "openwop-dev" "$T/out-heavy/assets"; then
  bad "the adopter build carries this repo's .env.production values"
else
  ok "the adopter build carries none of this repo's .env.production values"
fi
rm -rf "$DA" "$DB"

echo "== adopter budget env: $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
