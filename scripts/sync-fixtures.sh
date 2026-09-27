#!/usr/bin/env bash
# Sync conformance fixtures from the canonical openwop spec corpus into this
# repo's vendored `conformance-fixtures/` dir. The backend bundles them into the
# Docker image so the deployed Cloud Run revision serves them from
# `capabilities.fixtures` + answers black-box conformance runs. Vendoring as real
# files (vs symlink) is required because Docker COPY can't follow symlinks
# outside the build context.
#
# Canonical source (approach A — sibling-clone layout): `../openwop` checked out
# next to this repo. Override with OPENWOP_CORPUS_DIR.
#
# PINNED (2026-09-23). Like `scripts/sync-schemas.sh`, the copy is REFUSED
# without a named corpus tag: pass `--tag openwop-conformance/vX.Y.Z` or set
# OPENWOP_CORPUS_TAG. The fixtures are read OUT OF THAT TAG (`git archive`),
# never out of the sibling clone's working tree, and the clone's HEAD, index and
# working tree are left untouched — other sessions work in that checkout.
#
# Why: `check-vendored-fixtures.mjs` asserts the vendored tree against the
# INSTALLED `@openwop/openwop-conformance`, while this script used to copy
# whatever the clone happened to be on. When the clone is ahead of the pin
# (measured 2026-09-23 while an adopter vendored: clone at 2.36.1, pin 2.36.0)
# the guard's own remediation line told the reader to run this script, and this
# script then vendored the WRONG release's fixtures — failing the same guard for
# the opposite reason. The workaround was a throwaway detached worktree at the
# tag plus OPENWOP_CORPUS_DIR; naming the tag here removes the need for it.
#
# NOT every file here is canonical. The vendored dir also carries HOST-AUTHORED
# fixtures that exist in no released corpus — RFC 0137's `form-content/` template
# pack (the corpus ships the RFC, the schema and two scenarios but zero fixtures,
# so a host must supply its own) and ADR 0533's `conformance-replay-effect*.json`.
# Until 2026-08-17 this script opened with a blanket `rm -rf "$VENDORED"`, so
# running the refresh documented in DEPLOY.md §"refresh the vendored spec
# artifacts" DELETED all of them, reddening `test/form-content-seam.test.ts` and
# both RFC 0137 instantiation legs. Nothing guarded it. This is the same defect
# `scripts/sync-packs.sh` fixed for `packs/` on 2026-07-22, and the same fix:
# remove only what this script owns.
#
# The preserve-list is NOT restated here. `scripts/check-vendored-fixtures.mjs`
# owns it (`HOST_AUTHORED`) and serves it via `--list-host-authored`, because two
# copies of a list like this is exactly the thing that drifts — and the drift
# would be silent and destructive.
#
# Usage: bash scripts/sync-fixtures.sh --tag openwop-conformance/vX.Y.Z   (suite line)
#        bash scripts/sync-fixtures.sh --tag vX.Y.Z                      (v2 coordinated release)
#
# The tag to pass is the one that matches the INSTALLED suite pin
# (`backend/typescript/package.json` → `@openwop/openwop-conformance`); the run
# warns when it does not, because that is the drift the guard will report.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="${OPENWOP_CORPUS_DIR:-$REPO_ROOT/../openwop}"
VENDORED="$REPO_ROOT/conformance-fixtures"

TAG="${OPENWOP_CORPUS_TAG:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --tag=*) TAG="${1#--tag=}"; shift ;;
    -h|--help) echo "usage: sync-fixtures.sh --tag openwop-conformance/vX.Y.Z"; exit 0 ;;
    *) echo "error: unknown argument $1 (usage: sync-fixtures.sh --tag openwop-conformance/vX.Y.Z)" >&2; exit 2 ;;
  esac
done

if ! git -C "$CORPUS" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: canonical corpus checkout not found at $CORPUS (not a git repository)" >&2
  echo "       clone openwop/openwop next to this repo, or set OPENWOP_CORPUS_DIR." >&2
  exit 1
fi

if [ -z "$TAG" ]; then
  echo "error: no corpus tag. Pass --tag openwop-conformance/vX.Y.Z (suite line) or --tag vX.Y.Z[-rc.N] (v2 coordinated release) — or set OPENWOP_CORPUS_TAG." >&2
  echo "       An unpinned sync copies whatever working tree $CORPUS is on; refused since 2026-09-23." >&2
  exit 1
fi

TAG_COMMIT="$(git -C "$CORPUS" rev-parse --verify --quiet "refs/tags/$TAG^{commit}" || true)"
if [ -z "$TAG_COMMIT" ]; then
  echo "error: tag $TAG does not exist in $CORPUS (git -C $CORPUS fetch --tags first)." >&2
  exit 1
fi

# Read the fixtures OUT OF THE TAG. `git archive` into a scratch dir rather than
# `git -C "$CORPUS" checkout "$TAG"`: that checkout is shared with other sessions
# and with other worktrees, and moving its HEAD (or dirtying its index) to
# perform a copy is a side effect this script has no business having.
# `sync-schemas.sh` demanded exactly that checkout until today; see its header.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$CORPUS" archive "$TAG" conformance/fixtures | tar -x -C "$WORK"
CANONICAL="$WORK/conformance/fixtures"

if [ ! -d "$CANONICAL" ]; then
  echo "error: $TAG in $CORPUS carries no conformance/fixtures tree." >&2
  exit 1
fi

# The guard asserts against the INSTALLED package, so a tag naming a different
# suite version vendors a tree that guard will reject. Warn rather than refuse:
# a deliberate pin bump legitimately syncs the new release before the install
# catches up, and a refusal here would block that.
TAG_SUITE="$(git -C "$CORPUS" show "$TAG:conformance/package.json" 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
INSTALLED_SUITE="$(node -e 'try{process.stdout.write(require(process.argv[1]).version)}catch{}' "$REPO_ROOT/backend/typescript/node_modules/@openwop/openwop-conformance/package.json" 2>/dev/null || true)"
if [ -n "$TAG_SUITE" ] && [ -n "$INSTALLED_SUITE" ] && [ "$TAG_SUITE" != "$INSTALLED_SUITE" ]; then
  echo "sync-fixtures: WARNING — $TAG carries conformance $TAG_SUITE but the installed suite is $INSTALLED_SUITE." >&2
  echo "  check-vendored-fixtures.mjs asserts the vendored tree against the INSTALLED package, so this" >&2
  echo "  copy will fail it unless you are bumping the pin in the same change. To match the pin instead:" >&2
  echo "  bash scripts/sync-fixtures.sh --tag openwop-conformance/v$INSTALLED_SUITE" >&2
  echo >&2
fi

# The one source of truth for what this repo owns under conformance-fixtures/.
# A failure here must ABORT rather than fall through to an empty list — an empty
# list would restore the destructive behaviour this block exists to prevent.
if ! HOST_AUTHORED="$(node "$REPO_ROOT/scripts/check-vendored-fixtures.mjs" --list-host-authored)"; then
  echo "error: could not read the host-authored allowlist from scripts/check-vendored-fixtures.mjs" >&2
  echo "       refusing to sync — a blanket copy would delete repo-owned fixtures." >&2
  exit 1
fi

# Stash the host-authored paths, wipe, copy canonical, restore. Stashing (rather
# than deleting around them) keeps the canonical half a clean mirror: a file the
# corpus DROPPED still disappears from the vendored tree.
STASH="$(mktemp -d)"

# Restore is a FUNCTION, and the EXIT trap calls it, because every statement
# between the wipe and the restore is an abort point under `set -e`. A first cut
# of this script put the restore inline after a `diff` assertion; when that
# assertion failed the shell aborted, the trap deleted the stash, and the
# host-authored paths were gone for good — reintroducing, on the failure path,
# the exact landmine this script exists to remove. MEASURED 2026-08-17 by
# stubbing the assertion to `false`: replay-effect 2 -> 0, form-content gone.
#
# `rm -rf` the destination first: `cp -R src dst` where dst already exists as a
# DIRECTORY copies INTO it (`form-content/form-content`), so without this the
# function would not be safely idempotent — and a trap handler must be.
restore_host_authored() {
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    [ -e "$STASH/${rel%/}" ] || continue
    mkdir -p "$VENDORED/$(dirname "${rel%/}")"
    rm -rf "${VENDORED:?}/${rel%/}"
    cp -R "$STASH/${rel%/}" "$VENDORED/${rel%/}"
  done <<< "$HOST_AUTHORED"
}
trap 'restore_host_authored 2>/dev/null || true; rm -rf "$STASH" "$WORK"' EXIT

preserved=0
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  src="$VENDORED/${rel%/}"
  [ -e "$src" ] || continue
  mkdir -p "$STASH/$(dirname "${rel%/}")"
  cp -R "$src" "$STASH/${rel%/}"
  preserved=$((preserved + 1))
done <<< "$HOST_AUTHORED"

rm -rf "$VENDORED"; mkdir -p "$VENDORED"
cp -r "$CANONICAL/." "$VENDORED/"

# Assert the canonical half mirrors exactly, while the tree still holds ONLY the
# canonical half — once the host-authored paths are back the extras make this
# diff fail by design. Capture the status rather than letting `set -e` abort
# here (see above); the restore runs first, then we report.
mirror_status=0
diff -rq "$CANONICAL" "$VENDORED" >/dev/null || mirror_status=$?

restore_host_authored

if [ "$mirror_status" -ne 0 ]; then
  echo "error: the canonical mirror does not match $CANONICAL after copy." >&2
  echo "       host-authored paths WERE restored; investigate before re-running." >&2
  exit 1
fi

echo "ok — vendored $(ls -1 "$VENDORED"/*.json | wc -l | tr -d ' ') fixtures into conformance-fixtures/ (from $CORPUS at $TAG, $TAG_COMMIT);"
echo "     preserved $preserved host-authored path(s). Verify with: node scripts/check-vendored-fixtures.mjs"
