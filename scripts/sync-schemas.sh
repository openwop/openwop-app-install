#!/usr/bin/env bash
# Sync JSON Schemas from the canonical openwop spec corpus into this repo's
# vendored `schemas/` dir. The backend bundles them into the Docker image
# (Dockerfile COPY) so the deployed Cloud Run revision loads them at boot
# (host/*.ts resolve `schemas/` from /app/lib). Vendoring is required because
# `gcloud run deploy --source .` uploads only this repo; the corpus is elsewhere.
#
# Canonical source (approach A — sibling-clone layout): `../openwop` checked out
# next to this repo. Override with OPENWOP_CORPUS_DIR. Future hardening
# (MIGRATION-TODO.md item 3): a version-pinned sparse-clone of openwop@<tag> +
# a coherence gate asserting the vendored tag == the SDK's stamped CORPUS_VERSION.
#
# Usage: bash scripts/sync-schemas.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="${OPENWOP_CORPUS_DIR:-$REPO_ROOT/../openwop}"
CANONICAL="$CORPUS/schemas"
VENDORED="$REPO_ROOT/schemas"

if [ ! -d "$CANONICAL" ]; then
  echo "error: canonical schemas dir not found at $CANONICAL" >&2
  echo "       clone openwop/openwop next to this repo, or set OPENWOP_CORPUS_DIR." >&2
  exit 1
fi

rm -rf "$VENDORED"; mkdir -p "$VENDORED"
cp -r "$CANONICAL/." "$VENDORED/"
diff -rq "$CANONICAL" "$VENDORED" >/dev/null
echo "ok — vendored $(find "$VENDORED" -name '*.json' | wc -l | tr -d ' ') schemas into schemas/ (from $CANONICAL)"
