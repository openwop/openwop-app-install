#!/usr/bin/env bash
# Sync conformance fixtures from the canonical openwop spec corpus into this
# repo's vendored `conformance-fixtures/` dir. The backend bundles them into the
# Docker image so the deployed Cloud Run revision serves them from
# `capabilities.fixtures` + answers black-box conformance runs. Vendoring as real
# files (vs symlink) is required because Docker COPY can't follow symlinks
# outside the build context.
#
# Canonical source (approach A — sibling-clone layout): `../openwop` checked out
# next to this repo. Override with OPENWOP_CORPUS_DIR. Future hardening:
# MIGRATION-TODO.md item 3 (version-pinned sparse-clone + coherence gate).
#
# Usage: bash scripts/sync-fixtures.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="${OPENWOP_CORPUS_DIR:-$REPO_ROOT/../openwop}"
CANONICAL="$CORPUS/conformance/fixtures"
VENDORED="$REPO_ROOT/conformance-fixtures"

if [ ! -d "$CANONICAL" ]; then
  echo "error: canonical fixtures dir not found at $CANONICAL" >&2
  echo "       clone openwop/openwop next to this repo, or set OPENWOP_CORPUS_DIR." >&2
  exit 1
fi

rm -rf "$VENDORED"; mkdir -p "$VENDORED"
cp -r "$CANONICAL/." "$VENDORED/"
diff -rq "$CANONICAL" "$VENDORED" >/dev/null
echo "ok — vendored $(ls -1 "$VENDORED"/*.json | wc -l | tr -d ' ') fixtures into conformance-fixtures/ (from $CANONICAL)"
