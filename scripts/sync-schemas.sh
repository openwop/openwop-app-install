#!/usr/bin/env bash
# Sync JSON Schemas from the canonical openwop spec corpus into this repo's
# vendored `schemas/` dir. The backend bundles them into the Docker image
# (Dockerfile COPY) so the deployed Cloud Run revision loads them at boot
# (host/*.ts resolve `schemas/` from /app/lib). Vendoring is required because
# `gcloud run deploy --source .` uploads only this repo; the corpus is elsewhere.
#
# Canonical source (approach A — sibling-clone layout): `../openwop` checked out
# next to this repo. Override with OPENWOP_CORPUS_DIR.
#
# PINNED (2026-09-02, v2 charter Phase 0). The copy is refused without a named
# openwop tag: pass `--tag openwop-conformance/vX.Y.Z` or
# set OPENWOP_CORPUS_TAG. The tag is recorded in `schemas/CORPUS_TAG`, and
# `scripts/check-vendored-schemas.mjs` asserts it matches the installed
# `@openwop/openwop-conformance` version. Why: the corpus is about to grow
# `schemas/v2/`; an unpinned sync from whatever HEAD the sibling clone is on would
# ship v2 schemas into a v1 image (the H34 drift class, one major up).
#
# READ AT THE TAG (2026-09-23). Until today this script did not read the tag — it
# DEMANDED that the sibling clone's HEAD already be at it, and its own error text
# told you to run `git -C ../openwop checkout <tag>`. That checkout is shared with
# every other session and worktree on the machine, so following the instruction
# meant moving someone else's HEAD; the alternative was a throwaway detached
# worktree plus OPENWOP_CORPUS_DIR, which is what adopters actually did. It now
# `git archive`s the tag into a scratch dir and copies from there, leaving the
# clone's HEAD, index and working tree untouched. The HEAD-at-tag and
# clean-`schemas` checks are gone because the tag's bytes are immutable — and the
# dirty check never covered the three `spec/v2/*.json` files copied below anyway.
#
# Usage: bash scripts/sync-schemas.sh --tag openwop-conformance/v1.152.0   (1.x line)
#        bash scripts/sync-schemas.sh --tag v2.0.0-rc.2                    (v2 coordinated release)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="${OPENWOP_CORPUS_DIR:-$REPO_ROOT/../openwop}"
VENDORED="$REPO_ROOT/schemas"

TAG="${OPENWOP_CORPUS_TAG:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --tag=*) TAG="${1#--tag=}"; shift ;;
    *) echo "error: unknown argument $1 (usage: sync-schemas.sh --tag openwop-conformance/vX.Y.Z)" >&2; exit 2 ;;
  esac
done

if ! git -C "$CORPUS" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: canonical corpus checkout not found at $CORPUS (not a git repository)" >&2
  echo "       clone openwop/openwop next to this repo, or set OPENWOP_CORPUS_DIR." >&2
  exit 1
fi

if [ -z "$TAG" ]; then
  echo "error: no corpus tag. Pass --tag openwop-conformance/vX.Y.Z (1.x) or --tag vX.Y.Z[-rc.N] (v2) — or set OPENWOP_CORPUS_TAG." >&2
  echo "       An unpinned sync copies whatever HEAD ../openwop is on; refused since 2026-09-02." >&2
  exit 1
fi

TAG_COMMIT="$(git -C "$CORPUS" rev-parse --verify --quiet "refs/tags/$TAG^{commit}" || true)"
if [ -z "$TAG_COMMIT" ]; then
  echo "error: tag $TAG does not exist in $CORPUS (git -C $CORPUS fetch --tags first)." >&2
  exit 1
fi

# Read the release OUT OF THE TAG into a scratch dir — see the header. The three
# `spec/v2/*.json` authorities copied further down come out of the same archive,
# so they are the tag's bytes too; copying them from the working tree was a hole
# the old clean-`schemas` check did not even cover.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$CORPUS" archive "$TAG" \
  schemas \
  spec/v2/event-codemap.json \
  spec/v2/path-manifest.json \
  spec/v2/declaration.json | tar -x -C "$WORK"
CANONICAL="$WORK/schemas"
if [ ! -d "$CANONICAL" ]; then
  echo "error: $TAG in $CORPUS carries no schemas/ tree." >&2
  exit 1
fi

rm -rf "$VENDORED"; mkdir -p "$VENDORED"
cp -r "$CANONICAL/." "$VENDORED/"
diff -rq "$CANONICAL" "$VENDORED" >/dev/null

# `spec/v2/event-codemap.json` is the ONLY authority for the v1->v2 event-type
# map (spec/v2/core/persistence.md "The codemap is data": "A host MUST NOT carry
# a private mapping"). It lives under the corpus `spec/` tree, not `schemas/`,
# and it is shipped in `@openwop/spec-artifacts` — which this repo carries as a
# devDependency, so it is NOT in the runtime image. The storage-boundary era
# adapter reads it at boot from the vendored `schemas/` dir the Dockerfile
# COPYs, so it is copied here, AFTER the `diff -rq` above (which requires the
# vendored tree to equal the corpus `schemas/` exactly).
cp "$WORK/spec/v2/event-codemap.json" "$VENDORED/v2/event-codemap.json"

# `spec/v2/path-manifest.json` is the ONLY authority for which path keys the v2
# unversioned space contains. Same reasoning as the codemap, and the same
# failure if it is hand-copied: `middleware/protocolVersion.ts` used to carry a
# private allowlist of two prefixes, so this host advertised `["1.1","2.0"]`
# while serving a seventh of major 2's path space — five of five pairable
# surfaces answered 404 under major 2 and 200 under `/v1`. A hand list cannot
# notice the corpus adding an operation; a derived one cannot avoid it.
cp "$WORK/spec/v2/path-manifest.json" "$VENDORED/v2/path-manifest.json"

# `spec/v2/declaration.json` is the ONLY authority for the peer-dependency
# identifier set (spec/v2/core/packs.md "Peer-dependency identifiers": "A
# `peerDependencies` key MUST be a root key of `spec/v2/declaration.json` … A
# host MUST refuse a key the declaration file does not name with
# `pack_peer_dependency_undefined`"). Vendored rather than re-derived: the
# obvious substitute is `schemas/v2/capabilities.schema.json`'s property names,
# and MEASURED they are NOT the same set — 88 properties against 86 families —
# so a host validating against the schema would accept and reject the wrong
# keys while looking principled.
cp "$WORK/spec/v2/declaration.json" "$VENDORED/v2/declaration.json"

printf '%s\n' "$TAG" > "$VENDORED/CORPUS_TAG"
# The SPA ships only the codemap's renamed pairs (bundle budget); regenerate them from the new vendor.
( cd "$REPO_ROOT/frontend/react" && node scripts/gen-event-codemap.mjs )
echo "ok — vendored $(find "$VENDORED" -name '*.json' | wc -l | tr -d ' ') schemas into schemas/ from $CORPUS at $TAG ($TAG_COMMIT); recorded in schemas/CORPUS_TAG"
