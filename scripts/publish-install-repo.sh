#!/usr/bin/env bash
#
# Publish the white-label bundle to the PUBLIC install repo
# (openwop/openwop-app-install) — the adopter-facing distribution mirror of this
# private repo. Builds the stripped tree (build-whitelabel-zip.sh: no .env
# secrets, no steward meta), syncs it as the public repo's `main` (so the install
# FILES are version-controlled + browsable), and (re)publishes the rolling
# `whitelabel` release zip + sha256 sidecar at a stable URL.
#
#   /install/ download:
#   https://github.com/openwop/openwop-app-install/releases/download/whitelabel/openwop-demo-app.zip
#
# Prereqs: gh authed with write to the install repo; zip/unzip on PATH; run from a
# clean HEAD (the bundle is `git archive HEAD`, so uncommitted changes don't ship).
set -euo pipefail

REPO="${OPENWOP_INSTALL_REPO:-openwop/openwop-app-install}"
ROOT="$(git rev-parse --show-toplevel)"
SRC_SHA="$(git -C "$ROOT" rev-parse --short HEAD)"

echo "[publish-install] building stripped bundle @ $SRC_SHA"
bash "$ROOT/scripts/build-whitelabel-zip.sh"
ZIP="$ROOT/dist-whitelabel/openwop-demo-app.zip"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
unzip -q "$ZIP" -d "$WORK"                       # -> $WORK/openwop-demo-app/
git clone --quiet "https://github.com/$REPO.git" "$WORK/repo"
cd "$WORK/repo"
git checkout -q main 2>/dev/null || git checkout -q -b main

# True mirror: drop tracked files, lay down the fresh tree (dotfile-safe via tar),
# so deletions upstream propagate too. PRESERVE the install repo's own `.github/`
# (its release workflow) — the bundle strips `.github/`, so without the exclude
# the sync would delete the public repo's CI. `.git` is untouched by `git rm`.
git rm -rq -- . ':(exclude).github' >/dev/null 2>&1 || true
( cd "$WORK/openwop-demo-app" && tar cf - . ) | tar xf -

# Distribution banner so visitors know this is the generated mirror.
{ printf '> **Published white-label install bundle.** Auto-synced from `openwop/openwop-app` (source `%s`). Clone or download the release zip, then follow **[WHITE-LABEL.md](./frontend/react/WHITE-LABEL.md)** to deploy your own. Generated — PRs here are not merged; development happens upstream.\n\n' "$SRC_SHA"; cat README.md 2>/dev/null || true; } > README.tmp && mv README.tmp README.md

git add -A
if git diff --cached --quiet; then
  echo "[publish-install] tree unchanged since last sync — nothing to publish"
  exit 0
fi
git commit -qs -m "sync: white-label bundle from openwop-app @ $SRC_SHA"
git push -q origin main
echo "[publish-install] synced tree -> $REPO@main"

# The push to `main` triggers the install repo's own .github/workflows/
# publish-release.yml, which rebuilds the zip from the synced tree and publishes
# the rolling `whitelabel` release WITH a sigstore build-provenance attestation
# (possible because that repo is public). We intentionally do NOT cut the release
# here — keeping a single release authority avoids a non-attested race.
echo "[publish-install] release+attestation will be produced by $REPO's publish-release workflow"
echo "[publish-install] watch: gh run watch --repo $REPO \$(gh run list --repo $REPO --workflow publish-release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
echo "[publish-install] download: https://github.com/$REPO/releases/download/whitelabel/openwop-demo-app.zip (source $SRC_SHA)"
