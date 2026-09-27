#!/usr/bin/env bash
# check-branding — white-label guardrail. Greps a BUILT app bundle for OpenWOP
# brand defaults that a fork forgot to override (favicon, title, product name,
# the steward's domain). Exits non-zero if any leak.
#
# This is a FORK tool, not part of the upstream openwop-app build/CI: upstream
# IS OpenWOP, so its own build legitimately carries these strings and this script
# is EXPECTED to "fail" there. Run it against YOUR fork's build:
#
#   ( cd frontend/react && npm run build )
#   bash scripts/check-branding.sh frontend/react/dist
#
# The instance-name check (§5) reads `dist/brand-info.json`, which the build
# emits from the resolved brand — see the note at §5 for why a bundle grep
# cannot do that job.
#
# It ALSO scans the native shells' white-label configs (ADR 0291:
# clients/desktop/branding.json + package.json builder identity,
# clients/ios/project.yml) — source-level, no shell build needed — so a fork
# that rebrands the web app can't silently ship desktop/iOS artifacts under
# the OpenWOP identity. A fork that does not ship the shells can skip that
# half with OPENWOP_SKIP_SHELL_BRANDING=1.
#
# See frontend/react/WHITE-LABEL.md for the full surface list + the
# `.env.production.example` template.

set -euo pipefail

DIST="${1:-frontend/react/dist}"
INDEX="$DIST/index.html"

if [[ ! -f "$INDEX" ]]; then
  echo "[check-branding] FATAL: $INDEX not found — build the frontend first." >&2
  exit 2
fi

leaks=0
flag() { echo "  ✗ LEAK: $1"; leaks=$((leaks + 1)); }

echo "[check-branding] scanning $DIST for un-overridden OpenWOP defaults…"

# 1) Document title (Vite plugin stamps it from VITE_BRAND_DOCUMENT_TITLE).
grep -qiE '<title>[^<]*OpenWOP' "$INDEX" && flag "<title> still names OpenWOP (set VITE_BRAND_DOCUMENT_TITLE)"

# 2) Favicon — only the OpenWOP defaults: the /OpenWOP.svg asset or the stock
#    data-URI (clay rect fill %23a35a30). A custom inline-SVG favicon must NOT
#    false-positive here.
grep -qiE 'rel="icon".*(OpenWOP\.svg|a35a30)' "$INDEX" \
  && flag "favicon is the OpenWOP default (set VITE_BRAND_FAVICON_SRC + drop your icon in public/)"

# 3) The steward's domain baked into the bundle.
if grep -rqiE 'app\.openwop\.dev|//openwop\.dev' "$DIST"/assets/*.js 2>/dev/null; then
  flag "the bundle references the steward domain openwop.dev (set VITE_BRAND_PRIMARY_DOMAIN / VITE_BRAND_HOME_URL; scrub .env.production)"
fi

# 4) PWA manifest — stamped from VITE_BRAND_PRODUCT_NAME.
MANIFEST="$DIST/manifest.webmanifest"
if [[ -f "$MANIFEST" ]] && grep -qiE '"(name|short_name)"[[:space:]]*:[[:space:]]*"[^"]*OpenWOP' "$MANIFEST"; then
  flag "PWA manifest still names OpenWOP (set VITE_BRAND_PRODUCT_NAME)"
fi

# 5) Instance/workspace name left at the stock default — read from the RESOLVED
#    identity the build emits (`brand-info.json`, written by the brand plugin in
#    vite.config.ts from the same resolver that renders the sidebar), never from
#    a grep over the bundle. Two reasons, both measured (#3627 instance 3):
#    the stock default compiles into every bundle whether or not an override is
#    set, so a grep for it cannot distinguish "set" from "unset"; and the phrase
#    this used to grep for (`Demo host`) was retired in #260, so for months the
#    only thing it could match was prose ("the demo host defaults it ON") — a
#    false positive on a correctly branded build, and NO positive on a wrong one.
#    A missing brand-info.json is a hard error, not a skip: it means the dist was
#    not produced by the current build, and a check that silently passes on the
#    wrong artifact is the failure mode this script exists to prevent.
BRAND_INFO="$DIST/brand-info.json"
if [[ ! -f "$BRAND_INFO" ]]; then
  echo "[check-branding] FATAL: $BRAND_INFO not found — the frontend build emits it (vite.config.ts brand plugin); rebuild with a current tree." >&2
  exit 2
fi
if node -e 'const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(b.isDefault && b.isDefault.instanceName === true ? 1 : 0)' "$BRAND_INFO"; then
  :
else
  flag "sidebar instance name is still the stock default (set VITE_BRAND_INSTANCE_NAME)"
fi

# --- Native shells (ADR 0291) --------------------------------------------
# Source-level scan of the shells' white-label configs — a fork that rebrands
# the web app must not ship desktop/iOS artifacts under the OpenWOP identity.
# Skippable for forks that do not ship the shells.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${OPENWOP_SKIP_SHELL_BRANDING:-0}" = "1" ]]; then
  echo "[check-branding] shell configs: skipped (OPENWOP_SKIP_SHELL_BRANDING=1)"
else
  DESKTOP_BRANDING="$ROOT/clients/desktop/branding.json"
  DESKTOP_PKG="$ROOT/clients/desktop/package.json"
  IOS_PROJECT="$ROOT/clients/ios/project.yml"

  if [[ -f "$DESKTOP_BRANDING" ]]; then
    grep -qE '"productName"[[:space:]]*:[[:space:]]*"OpenWOP"' "$DESKTOP_BRANDING" \
      && flag "desktop shell productName is still OpenWOP (edit clients/desktop/branding.json)"
    grep -qE '"appId"[[:space:]]*:[[:space:]]*"dev\.openwop\.' "$DESKTOP_BRANDING" \
      && flag "desktop shell appId is still dev.openwop.* (edit clients/desktop/branding.json)"
    grep -qE '"(demoHost|helpUrl)"[[:space:]]*:[[:space:]]*"[^"]*app\.openwop\.dev' "$DESKTOP_BRANDING" \
      && flag "desktop shell demoHost/helpUrl points at the steward demo app.openwop.dev (edit clients/desktop/branding.json — enterprise forks usually want mode: enterprise + lockedHost)"
  fi
  if [[ -f "$DESKTOP_PKG" ]]; then
    # package.json is what electron-builder actually reads — catch a fork that
    # edited branding.json but forgot `npm run apply-branding`.
    grep -qE '"(appId|productName)"[[:space:]]*:[[:space:]]*"(dev\.openwop\.[^"]*|OpenWOP)"' "$DESKTOP_PKG" \
      && flag "desktop package.json builder identity is still OpenWOP — run ( cd clients/desktop && npm run apply-branding )"
  fi
  if [[ -f "$IOS_PROJECT" ]]; then
    grep -qE '^\s*(OWPProductName|CFBundleDisplayName):\s*OpenWOP\s*$' "$IOS_PROJECT" \
      && flag "iOS shell display/product name is still OpenWOP (edit clients/ios/project.yml)"
    grep -qE '^\s*(PRODUCT_BUNDLE_IDENTIFIER|bundleIdPrefix):\s*dev\.openwop' "$IOS_PROJECT" \
      && flag "iOS bundle identifier is still dev.openwop.* (edit clients/ios/project.yml)"
    grep -qE '^\s*OWPDemoHost:\s*\S*app\.openwop\.dev' "$IOS_PROJECT" \
      && flag "iOS OWPDemoHost points at the steward demo app.openwop.dev (edit clients/ios/project.yml)"
  fi
fi

if [[ "$leaks" -gt 0 ]]; then
  echo "[check-branding] FAIL — $leaks OpenWOP default(s) leaked into the build." >&2
  echo "[check-branding] Set the matching VITE_BRAND_* vars (WHITE-LABEL.md) and rebuild." >&2
  exit 1
fi

echo "[check-branding] OK — no OpenWOP brand defaults found in the build."
