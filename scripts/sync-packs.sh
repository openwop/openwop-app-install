#!/usr/bin/env bash
# Sync core + vendor packs from the canonical pack ecosystem into this repo's
# vendored `packs/` dir. The backend auto-mounts them at boot (bootstrap/*.ts) so
# the deployed Cloud Run revision shows every core.openwop.* / vendor.* pack in
# /v1/agents + the node palette. Vendoring is required because
# `gcloud run deploy --source .` uploads only this repo.
#
# Canonical source (approach A — sibling-clone layout): `../openwop-registry`
# (its `packs/`) checked out next to this repo. Override with OPENWOP_REGISTRY_DIR.
# Scope: core.openwop.* + vendor.* real directories (skips symlinks +
# .registry-<version> shadow dirs). Future hardening: MIGRATION-TODO.md item 3.
#
# Usage: bash scripts/sync-packs.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${OPENWOP_REGISTRY_DIR:-$REPO_ROOT/../openwop-registry}"
CANONICAL="$REGISTRY/packs"
VENDORED="$REPO_ROOT/packs"

if [ ! -d "$CANONICAL" ]; then
  echo "error: canonical packs dir not found at $CANONICAL" >&2
  echo "       clone openwop/openwop-registry next to this repo, or set OPENWOP_REGISTRY_DIR." >&2
  exit 1
fi

rm -rf "$VENDORED"; mkdir -p "$VENDORED"

copied=0
for entry in "$CANONICAL"/*; do
  [ -d "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in core.openwop.*|vendor.*) ;; *) continue ;; esac
  case "$name" in *.registry-*) continue ;; esac
  if [ -L "$entry" ]; then
    target="$(readlink "$entry")"; [ -d "$target" ] || continue
    cp -RL "$entry" "$VENDORED/$name"
  else
    cp -R "$entry" "$VENDORED/$name"
  fi
  copied=$((copied + 1))
done

echo "ok — vendored $copied packs into packs/ (from $CANONICAL)"
