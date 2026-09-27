#!/usr/bin/env bash
# build-whitelabel-zip — package the white-label demo app as a downloadable
# source zip for the /install/ page on openwop.dev.
#
# This repo (openwop/openwop-app) IS the app, so the zip is `git archive HEAD`
# of the whole repo under a clean `openwop-demo-app/` prefix — tracked files
# only (`node_modules/`, `dist/`, `data/`, key material are untracked /
# gitignored, so they never appear). Output is deterministic per commit (git
# archive stamps the commit time, not the wall clock).
#
# MULTI-HOST: the `deploy/` directory ships every deploy pack (compose, gcp,
# fly, render, aws, azure) plus `deploy/README.md` (the choose-your-host index).
# These are tracked, so git archive includes them automatically; a guard below
# fails the build if any expected pack ever goes missing.
#
# STRIPPED from the distributable:
#   - real `.env*` (but NOT `*.example`) — `frontend/react/.env.production` IS
#     tracked (the steward's own CI/deploy loads it), so `git archive` WOULD
#     ship it, leaking the steward's backend SSE URL + Firebase project into
#     every adopter's bundle (an adopter's `npm run build` auto-loads
#     .env.production → their PRODUCTION app phones home to the steward).
#     gitignore can't help a tracked file, so we strip real env files here.
#     `*.example` files are secret-free and KEPT — they ARE the documented env
#     inventory adopters need (frontend/react/.env.production.example,
#     backend/typescript/.env.example). Adopters copy them to real .env files
#     per WHITE-LABEL.md.
#   - `.claude/`, `.agents/`, `.github/`, `MIGRATION-TODO.md`, `TODO.md` —
#     steward-internal repo meta (agent skills for BOTH harnesses — `.claude/` and
#     the `.agents/` mirror — the steward's CI wired to openwop-dev, migration
#     notes). These were never inside the old `apps/workflow-engine/` subtree, so
#     the pre-split zip never carried them; keep that boundary.
#   - `docs/steward/` — ALL the steward GRADING/TRACKING reports, which now live
#     in one directory instead of scattered across the repo root. These are
#     internal A–F readiness reports the grade-*/polish-screens/manual-tests
#     skills regenerate as features land (they name blockers, F grades, open
#     debt) — never an adopter deliverable. Shipped code only cites them in
#     comments, so dropping them is non-functional.
#
#     They used to sit at the root and be stripped by a hand-kept list of six
#     filenames, which rotted to ~180 unstripped reports before anyone noticed
#     (see the allowlist below). One directory + one glob is the durable shape:
#     a new report is inside the stripped tree by construction, and the root
#     allowlist below is the backstop if one ever lands outside it.
#
# Output (into $OUT_DIR, default ./dist-whitelabel; gitignored):
#   $OUT_DIR/openwop-demo-app.zip
#   $OUT_DIR/openwop-demo-app.zip.sha256
#
# Publishing is a separate step (see the `publish-whitelabel` skill): the zip +
# sidecar are uploaded as assets on a rolling GitHub release on this (public)
# repo, giving a stable download URL:
#   https://github.com/openwop/openwop-app/releases/download/whitelabel/openwop-demo-app.zip
# The /install/ page on openwop.dev links that URL and publishes the sha256 so
# downloaders can verify it.
#
# Usage:
#   bash scripts/build-whitelabel-zip.sh
#
# Idempotent. Safe to re-run.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/dist-whitelabel}"
ZIP="$OUT_DIR/openwop-demo-app.zip"
PREFIX="openwop-demo-app/"

mkdir -p "$OUT_DIR"

# Tracked files only, the whole repo, under a clean top-level dir.
echo "[whitelabel-zip] archiving HEAD @ $(git -C "$ROOT" rev-parse --short HEAD) → $ZIP"
git -C "$ROOT" archive --format=zip --prefix="$PREFIX" -o "$ZIP" HEAD

# Strip the steward's REAL env files but KEEP `*.example`. We can't use a
# broad `zip -d "*/.env.*"` glob — that would also delete the secret-free
# `*.example` inventory adopters need. Instead enumerate members and delete
# every `.env` / `.env.*` EXCEPT the examples (robust to any future tracked
# env file). `/\.env($|\.)` matches a path segment that is exactly `.env` or
# begins `.env.`, so unrelated names like `environment.ts` are never caught.
echo "[whitelabel-zip] stripping real .env* (keeping *.example) + steward meta"
ENV_REAL=()
while IFS= read -r member; do
  [[ -n "$member" ]] && ENV_REAL+=("$member")
done < <(unzip -Z1 "$ZIP" | { grep -E '/\.env($|\.)' || true; } | { grep -vE '\.example$' || true; })
if (( ${#ENV_REAL[@]} > 0 )); then
  zip -q -d "$ZIP" "${ENV_REAL[@]}"
fi

# Steward-internal repo meta. `zip -d` returns 12 ("nothing to do") when no
# entry matches, which is fine; only a real failure should abort. (`*` spans
# `/` in zip's delete globs, so these catch entries at any depth.)
# `backend/typescript/test/steward/` holds the tests that READ the paths stripped
# on the line above (docs/steward, .github). Shipping the tests without their
# artefacts made every adopter's first `npm test` red with ENOENT — MEASURED
# 2026-09-06 on a hosted runner against this bundle. The lane is defined by this
# strip list, so it is stripped here, and `test/steward/steward-lane-ratchet.test.ts`
# refuses any test outside it that names a stripped path.
zip -q -d "$ZIP" \
  "${PREFIX}.claude/*" "${PREFIX}.agents/*" "${PREFIX}.github/*" \
  "${PREFIX}docs/steward/*" "${PREFIX}docs/research/*" \
  "${PREFIX}backend/typescript/test/steward/*" \
  || [[ $? -eq 12 ]]

# Root-level markdown: an ALLOWLIST, enforced by construction. Anything at the
# repo root that is not a named adopter deliverable is deleted.
#
# This replaced a hand-kept denylist of six report filenames, and the swap is the
# whole point. That list was written when six reports existed; by 2026-08 the
# steward's grade-*/upgrade-ux/polish-screens skills had generated ~180 more
# (80 `UX_UPGRADE-*.md` alone, added 2026-07-24..26), and every one of them was
# shipping — against this script's own stated policy that readiness reports
# naming blockers, F grades, and open debt are "never an adopter deliverable".
# Nothing failed, because a denylist cannot know what it has not been told about.
# `publish-install-repo.sh` pushes this same tree to the PUBLIC
# openwop/openwop-app-install repo, so the next release would have published all
# of them. (The last sync predates the flood — 2026-06-30 — so they never went
# out; `AGENTS.md`/`CLAUDE.md` did, and are dropped below.)
#
# Allowlist inverts the failure mode: a new steward report is dropped by default,
# and a genuinely new adopter doc is dropped LOUDLY (printed below, and the
# presence guard further down fails if a listed deliverable goes missing). Adding
# a deliverable is a one-line edit here — which is the point at which someone
# decides whether adopters should receive it.
WHITELABEL_ROOT_MD_KEEP=(
  README.md CHANGELOG.md RELEASES.md ROADMAP.md
  ARCHITECTURE.md DESIGN.md FEATURES.md conformance.md
  DEPLOY.md DEPLOY-SMOKE.md
  OPENWOP-SYNC.md OPENWOP-WHATSAPP.md
)

# Steward report NAMING FAMILIES, for markdown below the root (chiefly `docs/`,
# which holds ~44 per-ADR assessments the root allowlist cannot see).
#
# `docs/adr/` is EXEMPT: ADRs are an adopter deliverable, and three of them have
# slugs that match these families by coincidence — 0301-cdp-f-AUDIT-hash-chain,
# 0337-appbuilder-MYNDHYVE-parity, 0416-trust-center-AUDIT-export. Matching on
# filename shape is a proxy for intent, and this is where the proxy is wrong.
STEWARD_REPORT_RE='(ASSESSMENT|-AUDIT|_AUDIT|UX_UPGRADE|GAP-SWEEP|_SWEEP|SCREEN_POLISH|MANUAL_TESTS|MYNDHYVE)[^/]*\.md$'
STEWARD_EXEMPT_RE="^${PREFIX}docs/adr/"

STEWARD_DROP=()
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  case "$entry" in "$PREFIX"*) : ;; *) continue ;; esac
  base="${entry#"$PREFIX"}"

  # Root-level markdown: allowlist by construction.
  if [[ "$base" != */* && "$base" == *.md ]]; then
    keep=0
    for allowed in "${WHITELABEL_ROOT_MD_KEEP[@]}"; do
      if [ "$base" = "$allowed" ]; then keep=1; break; fi
    done
    [ "$keep" -eq 1 ] || STEWARD_DROP+=("$entry")
    continue
  fi

  # Below the root: drop the steward report families, except under docs/adr/.
  if grep -qE "$STEWARD_EXEMPT_RE" <<<"$entry"; then continue; fi
  if grep -qiE "$STEWARD_REPORT_RE" <<<"$entry"; then STEWARD_DROP+=("$entry"); fi
done < <(unzip -Z1 "$ZIP" | grep -E '\.md$' || true)

if (( ${#STEWARD_DROP[@]} > 0 )); then
  echo "[whitelabel-zip] stripping ${#STEWARD_DROP[@]} steward-internal doc(s) (not adopter deliverables)"
  zip -q -d "$ZIP" "${STEWARD_DROP[@]}" || [[ $? -eq 12 ]]
fi

# Fail loudly if any REAL (non-example) .env file survived — e.g. a future
# tracked env file the enumeration above somehow missed. Examples are allowed.
if unzip -Z1 "$ZIP" | grep -E '/\.env($|\.)' | grep -vqE '\.example$'; then
  echo "[whitelabel-zip] FATAL: a real .env* file remains in the zip after stripping." >&2
  unzip -Z1 "$ZIP" | grep -E '/\.env($|\.)' | grep -vE '\.example$' >&2
  exit 1
fi

# Snapshot the listing once and grep the VAR for every presence/absence guard
# below — `unzip -Z1 | grep -q` lets grep close the pipe early on first match,
# SIGPIPE-killing unzip, which `pipefail` would surface as a false "missing".
ZIP_LISTING="$(unzip -Z1 "$ZIP")"

# Fail loudly if steward agent-skill meta survived the strip — `.claude/` and its
# `.agents/` mirror are steward-internal and must never reach an adopter bundle.
if grep -qE "^${PREFIX}(\.claude|\.agents)/" <<<"$ZIP_LISTING"; then
  echo "[whitelabel-zip] FATAL: steward agent-skill meta (.claude/ or .agents/) remains in the zip." >&2
  grep -E "^${PREFIX}(\.claude|\.agents)/" <<<"$ZIP_LISTING" >&2
  exit 1
fi

# Guard: every allowlisted root deliverable must have SURVIVED. The allowlist
# drops what it does not recognize, so a rename (README.md → readme.md) would
# otherwise silently ship a bundle with no README rather than failing.
for deliverable in "${WHITELABEL_ROOT_MD_KEEP[@]}"; do
  if ! grep -qxF "${PREFIX}${deliverable}" <<<"$ZIP_LISTING"; then
    echo "[whitelabel-zip] FATAL: allowlisted deliverable ${deliverable} is not in the zip." >&2
    echo "  Either it was renamed/removed (update WHITELABEL_ROOT_MD_KEEP) or the strip is over-broad." >&2
    exit 1
  fi
done

# Guard: no steward GRADING/TRACKING report anywhere in the tree, at any depth.
# The root allowlist above cannot see `docs/`, and that is where the per-ADR
# assessments live (`docs/DATA-ASSESSMENT-*.md`, `docs/CODEBASE-ASSESSMENT-*.md`
# — 86 of them). Matching on the naming families the steward skills actually
# emit is a proxy, so keep it broad and case-insensitive; a false positive is a
# one-line allowlist edit, a false negative publishes open-debt reports to a
# public repo.
if grep -iE "$STEWARD_REPORT_RE" <<<"$ZIP_LISTING" | grep -qvE "$STEWARD_EXEMPT_RE"; then
  echo "[whitelabel-zip] FATAL: steward grading/tracking report(s) remain in the zip." >&2
  grep -iE "$STEWARD_REPORT_RE" <<<"$ZIP_LISTING" | grep -vE "$STEWARD_EXEMPT_RE" >&2
  echo "  These name blockers, F grades, and open debt — never an adopter deliverable." >&2
  exit 1
fi

# Guard: the runtime-vendored corpora the backend loads at boot MUST be in the zip.
# `providers.json` (model catalog the AI-chat/model-picker read), `packs/` (node /
# agent / artifact-type / connection packs every feature surface rides on — campaign
# studio, workflow-chain loader, etc.), `schemas/` + `conformance-fixtures/` (wire +
# conformance). These are tracked at the repo root and the Dockerfile COPYs them, so
# git archive includes them — but a stray gitignore/move would silently ship a bundle
# whose backend can't boot, so assert each is present.
echo "[whitelabel-zip] verifying runtime-vendored corpora are present"
for path in 'providers\.json' 'packs/' 'schemas/' 'conformance-fixtures/'; do
  if ! grep -qE "^${PREFIX}${path}" <<<"$ZIP_LISTING"; then
    echo "[whitelabel-zip] FATAL: ${path//\\/} missing from the zip (backend would not boot)." >&2
    exit 1
  fi
done

# Guard: the native shells are part of the white-label deliverable (ADR 0291 —
# adopters rebrand them via clients/desktop/branding.json + clients/ios/project.yml),
# so the zip must carry their sources + white-label seams.
echo "[whitelabel-zip] verifying native shells (clients/) are present"
for path in 'clients/desktop/branding\.json' 'clients/desktop/src/main\.js' \
            'clients/ios/project\.yml' 'clients/ios/Sources/OpenWOP/Branding\.swift'; do
  if ! grep -qE "^${PREFIX}${path}$" <<<"$ZIP_LISTING"; then
    echo "[whitelabel-zip] FATAL: ${path//\\/} missing from the zip (native shells are part of the white-label bundle)." >&2
    exit 1
  fi
done

# Guard: every deploy pack the /install page advertises MUST be in the zip, so a
# stray gitignore / rename can never ship a download missing a host's recipe.
echo "[whitelabel-zip] verifying deploy packs are present"
for pack in README.md compose/docker-compose.yml gcp/up.sh fly/fly.toml \
            render/render.yaml aws/main.tf azure/main.bicep; do
  if ! grep -qxF "${PREFIX}deploy/${pack}" <<<"$ZIP_LISTING"; then
    echo "[whitelabel-zip] FATAL: deploy/${pack} missing from the zip." >&2
    exit 1
  fi
done

# sha256 sidecar — prefer sha256sum (Linux/CI), fall back to shasum (macOS).
echo "[whitelabel-zip] writing sha256 sidecar"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT_DIR" && sha256sum "$(basename "$ZIP")" > "$ZIP.sha256" )
else
  ( cd "$OUT_DIR" && shasum -a 256 "$(basename "$ZIP")" > "$ZIP.sha256" )
fi

SIZE="$(wc -c < "$ZIP" | tr -d ' ')"
echo "[whitelabel-zip] done — $((SIZE / 1024)) KB"
cat "$ZIP.sha256"
