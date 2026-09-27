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
# Which branch of $REPO the mirror lands on. Defaults to `main` — the public
# install repo IS the mirror, so its main is the right target there.
#
# A DOWNSTREAM distribution is the case this exists for: it keeps the pristine
# mirror on its own branch and merges forward into a `main` that carries the
# adopter's overlay (brand assets, deploy config). The sync below is a TRUE
# MIRROR — `git rm -rq -- .` then lay down the fresh tree — so pointing it at a
# branch that holds an overlay DELETES that overlay. Set this to the pristine
# branch and merge forward:
#
#   OPENWOP_INSTALL_REPO=acme/acme-app OPENWOP_INSTALL_BRANCH=upstream \
#     bash scripts/publish-install-repo.sh
#   ( cd ~/dev/acme-app && git fetch origin && git merge origin/upstream )
BRANCH="${OPENWOP_INSTALL_BRANCH:-main}"
ROOT="$(git rev-parse --show-toplevel)"

# STALE-HEAD GUARD. The bundle is `git archive HEAD`, so a checkout that is
# behind its own origin mirrors OLD code — and the failure is silent: the sync
# below compares trees, finds nothing changed since the last mirror, prints
# "tree unchanged" and exits 0. A green run that mirrored nothing is
# indistinguishable from a green run that had nothing to mirror. That happened
# (2026-09-09, a KickTodo sync from a HEAD 16 commits behind), and it cost a
# round trip to notice.
#
# The exit code was never the bug. `tree unchanged -> exit 0` is the CORRECT
# answer after a genuine fresh pull that changed nothing the bundle can see.
# The bug is that the same exit code was reachable from a second state —
# "you forgot to pull" — that needed a different response. This guard splits
# them, and leaves the legitimate one alone.
#
# The fetch is not optional. `origin/main` is a LOCAL ref: comparing against a
# stale one passes vacuously and reports green having validated nothing, which
# is this same defect one layer down — a guard satisfiable by not knowing.
# Skip only with an explicit OPENWOP_SKIP_FRESHNESS_CHECK=1 (offline mirrors).
if [ "${OPENWOP_SKIP_FRESHNESS_CHECK:-0}" != "1" ]; then
  UPSTREAM_REF="${OPENWOP_SOURCE_REF:-origin/main}"
  UPSTREAM_REMOTE="${UPSTREAM_REF%%/*}"
  echo "[publish-install] freshness — fetching $UPSTREAM_REMOTE to compare HEAD against $UPSTREAM_REF"
  git -C "$ROOT" fetch --quiet "$UPSTREAM_REMOTE" || {
    echo "[publish-install] ABORT: could not fetch '$UPSTREAM_REMOTE'. The freshness check cannot" >&2
    echo "  run against a ref it did not just update, and passing it on a stale ref would" >&2
    echo "  validate nothing. Fix connectivity, or set OPENWOP_SKIP_FRESHNESS_CHECK=1 to" >&2
    echo "  publish deliberately without it." >&2
    exit 1
  }
  git -C "$ROOT" rev-parse --verify --quiet "$UPSTREAM_REF" >/dev/null || {
    echo "[publish-install] ABORT: '$UPSTREAM_REF' does not resolve after fetch." >&2
    exit 1
  }
  # HEAD must CONTAIN the upstream tip. Ahead is fine (a local commit being
  # published deliberately); behind is not. Asserted in this direction rather
  # than as equality so a legitimately-ahead HEAD is not refused.
  if ! git -C "$ROOT" merge-base --is-ancestor "$UPSTREAM_REF" HEAD; then
    BEHIND="$(git -C "$ROOT" rev-list --count "HEAD..$UPSTREAM_REF")"
    echo "[publish-install] ABORT: HEAD is $BEHIND commit(s) behind $UPSTREAM_REF." >&2
    echo "  $(git -C "$ROOT" rev-parse --short HEAD) (HEAD)  vs  $(git -C "$ROOT" rev-parse --short "$UPSTREAM_REF") ($UPSTREAM_REF)" >&2
    echo "  The bundle is 'git archive HEAD', so this would mirror code that old — and if" >&2
    echo "  the tree happens to match the last sync, it would do it while exiting 0." >&2
    echo "  Pull first:  git -C '$ROOT' merge --ff-only $UPSTREAM_REF" >&2
    exit 1
  fi
  echo "[publish-install] freshness — HEAD contains $UPSTREAM_REF"
fi

SRC_SHA="$(git -C "$ROOT" rev-parse --short HEAD)"

echo "[publish-install] building stripped bundle @ $SRC_SHA"
bash "$ROOT/scripts/build-whitelabel-zip.sh"
ZIP="$ROOT/dist-whitelabel/openwop-demo-app.zip"

# Build-health smoke: the stripped bundle must compile (the adopter's build path)
# BEFORE it reaches the public repo. Aborts the publish on failure (set -e). Skip
# with OPENWOP_SKIP_WHITELABEL_SMOKE=1 where npm is unavailable.
echo "[publish-install] build-smoke — verifying the stripped bundle compiles"
bash "$ROOT/scripts/check-whitelabel-build.sh" "$ZIP"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
unzip -q "$ZIP" -d "$WORK"                       # -> $WORK/openwop-demo-app/
git clone --quiet "https://github.com/$REPO.git" "$WORK/repo"
cd "$WORK/repo"
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH"

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
git push -q origin "$BRANCH"
echo "[publish-install] synced tree -> $REPO@$BRANCH"

# The push to `main` triggers the install repo's own .github/workflows/
# publish-release.yml, which rebuilds the zip from the synced tree and publishes
# the rolling `whitelabel` release WITH a sigstore build-provenance attestation
# (possible because that repo is public). We intentionally do NOT cut the release
# here — keeping a single release authority avoids a non-attested race.
echo "[publish-install] release+attestation will be produced by $REPO's publish-release workflow"
echo "[publish-install] watch: gh run watch --repo $REPO \$(gh run list --repo $REPO --workflow publish-release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
echo "[publish-install] download: https://github.com/$REPO/releases/download/whitelabel/openwop-demo-app.zip (source $SRC_SHA)"
