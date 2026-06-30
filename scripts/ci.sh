#!/usr/bin/env bash
#
# Local CI gate — a trustworthy pre-merge signal that mirrors
# `.github/workflows/ci.yml`. Use it while GitHub Actions is unavailable (the
# hosted jobs currently fail at startup — an account/billing or org Actions-policy
# matter, not a code defect; see the CI note in CLAUDE.md).
#
# Runs the non-Docker, non-browser jobs (the ones that give the real signal):
#   - backend:  build (esbuild) + vitest        (testcontainers skipped, as in CI)
#   - frontend: lint (0 warnings) + build (tsc + token/CSS + vite + budgets) + vitest
#
# Opt-in heavier jobs (need extra runtime, off by default):
#   OPENWOP_CI_E2E=1   frontend Playwright e2e (needs Chromium)
#   OPENWOP_CI_LIVE=1  backend live adapters via testcontainers (needs Docker)
#
# Usage:  npm run ci         (or: bash scripts/ci.sh)
#         npm run ci:full    (e2e + live adapters too)
# Bypass on push: git push --no-verify
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
skip() { printf '\n\033[2m↷ skipped %s\033[0m\n' "$*"; }

# Fail early with a clear message if deps aren't installed (CI runs `npm ci`; locally
# you install once). We don't auto-install — that's the dev's choice.
for d in backend/typescript frontend/react; do
  if [ ! -d "$ROOT/$d/node_modules" ]; then
    echo "error: $d/node_modules missing — run 'npm install' there first." >&2
    exit 1
  fi
done

step "vendored schemas: load-bearing drift guard"
node "$ROOT/scripts/check-vendored-schemas.mjs"

step "backend: build (esbuild bundle)"
( cd "$ROOT/backend/typescript" && npm run build )

step "backend: vitest (OPENWOP_SKIP_TESTCONTAINERS=1, as in CI)"
( cd "$ROOT/backend/typescript" && OPENWOP_SKIP_TESTCONTAINERS=1 npm run test )

step "frontend: lint (eslint, zero warnings)"
( cd "$ROOT/frontend/react" && npm run lint -- --max-warnings=0 )

step "frontend: build (tsc + token/CSS checks + vite + bundle budget)"
( cd "$ROOT/frontend/react" && npm run build )

step "frontend: vitest"
( cd "$ROOT/frontend/react" && npm run test )

if [ "${OPENWOP_CI_E2E:-0}" = "1" ]; then
  step "frontend: e2e (Playwright — a11y/focus/smoke)"
  ( cd "$ROOT/frontend/react" && npm run test:e2e )
else
  skip "frontend e2e (set OPENWOP_CI_E2E=1; needs Chromium)"
fi

# CSP runtime gate (CC-4): the hosted ci.yml runs check:csp-runtime, but this
# local mirror previously omitted it, so the enforcing-CSP check ran NOWHERE
# while hosted Actions is down. It needs a browser — so rather than hiding it
# behind an opt-in flag, AUTO-DETECT Chromium and run it whenever a browser is
# available (still forceable via OPENWOP_CI_E2E=1; only skipped when no browser).
chromium_available() {
  command -v google-chrome >/dev/null 2>&1 && return 0
  command -v chromium >/dev/null 2>&1 && return 0
  command -v chromium-browser >/dev/null 2>&1 && return 0
  # Playwright-managed Chromium (linux + mac cache locations).
  ls -d "$HOME/.cache/ms-playwright/chromium-"* >/dev/null 2>&1 && return 0
  ls -d "$HOME/Library/Caches/ms-playwright/chromium-"* >/dev/null 2>&1 && return 0
  return 1
}
if [ "${OPENWOP_CI_E2E:-0}" = "1" ] || chromium_available; then
  step "frontend: CSP runtime (enforcing-CSP, all routes — Chromium detected)"
  ( cd "$ROOT/frontend/react" && npm run check:csp-runtime )
else
  skip "frontend CSP runtime (no Chromium found; install Playwright Chromium or set OPENWOP_CI_E2E=1)"
fi

# Dependency advisory gate (CC-3): surface known CVEs in the production
# dependency trees. Two tiers:
#   - HIGH/CRITICAL → ALWAYS BLOCKING. A high+ CVE in a prod dep is a real
#     deploy risk; it must not ship green. (This is the genuine CVE gate that
#     was previously missing.)
#   - MODERATE → advisory by default (|| true) so a newly-filed moderate
#     advisory — e.g. the observability-only @opentelemetry chain — doesn't
#     block a release out of nowhere. Set OPENWOP_CI_AUDIT_STRICT=1 to make the
#     moderate tier blocking too.
audit_strict="${OPENWOP_CI_AUDIT_STRICT:-0}"
step "deps: npm audit (production) — high/critical blocking"
for d in backend/typescript frontend/react; do
  ( cd "$ROOT/$d" && npm audit --omit=dev --audit-level=high )
done
step "deps: npm audit (production) — moderate (advisory unless OPENWOP_CI_AUDIT_STRICT=1)"
for d in backend/typescript frontend/react; do
  if [ "$audit_strict" = "1" ]; then
    ( cd "$ROOT/$d" && npm audit --omit=dev --audit-level=moderate )
  else
    ( cd "$ROOT/$d" && npm audit --omit=dev --audit-level=moderate || true )
  fi
done

if [ "${OPENWOP_CI_LIVE:-0}" = "1" ]; then
  step "backend: live pgvector / pg-sql / opensearch (testcontainers)"
  ( cd "$ROOT/backend/typescript" && OPENWOP_PGVECTOR_LIVE=1 npm run test -- test/pgvector-live.test.ts )
  ( cd "$ROOT/backend/typescript" && OPENWOP_PG_SQL_LIVE=1 npm run test -- test/pg-sql-live.test.ts )
  ( cd "$ROOT/backend/typescript" && OPENWOP_OPENSEARCH_LIVE=1 npm run test -- test/opensearch-live.test.ts )
else
  skip "backend live adapters (set OPENWOP_CI_LIVE=1; needs Docker)"
fi

printf '\n\033[1;32m✅ local CI gate passed\033[0m\n'
