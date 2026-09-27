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
# .registry-<version> shadow dirs). The sweep below removes ONLY those vendored
# families — the repo-owned feature.* / community.* packs are never touched
# (the old `rm -rf packs/` wiped them; 2026-07-22 cleanup hardening).
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

# ---------------------------------------------------------------------------
# GUARD — refuse to destroy vendored work that canon does not have.
#
# MEASURED 2026-09-15 on a clean worktree at 108f166fe: a plain run of this
# script DELETED 17 files across SIX families and modified 449 more. The sweep
# below removes every `core.openwop.*` / `vendor.*` family, but the copy loop
# only restores families that EXIST IN CANON — so a family this repo owns and
# the registry has never seen is deleted outright and never comes back:
#
#   core.openwop.agents.lead-concierge        2 files
#   core.openwop.forms.starters               1     <- see the note below
#   vendor.myndhyve.market-intel-shift-detect 5
#   vendor.openwop.app-builder.kits           1
#   vendor.openwop.trusted-demo               6
#   core.openwop.artifact-types               2   (partial — family exists in
#                                                  canon, these files do not)
#
# CORRECTION, same day: the first draft of this note called all five families
# "ones the registry has never seen". FOUR are. `core.openwop.forms.starters` IS
# published — registry commit `85355a0`, sitting in the 31 commits the local
# clone had not pulled. It is deleted by a sync only because the clone is stale,
# and it would come back on a pull. That is the staleness warning below,
# demonstrated on the very measurement used to justify writing it: the guard's
# output is a statement about YOUR clone, never about the registry.
#
# The comment above says the sweep touches "only the families this script owns".
# That is true of the GLOB and false of the OUTCOME: ownership was assumed from
# the name prefix, and a `core.openwop.*` name does not mean the registry has a
# copy to restore.
#
# Second failure mode, same sweep: families vendored at a HIGHER version than
# canon get reverted to the older copy. These carry real unpublished content —
# `vendor.myndhyve.chat` alone adds the WF-EM-5 `actions` verb allowlist and the
# gate `artifact` output. `rm -rf` + copy-older silently discards all of it.
#
# HOW MANY depends on WHICH canon, and that distinction cost a measurement:
# against the registry's `origin/main` it is FIVE families (core.openwop.http,
# .ai, .integration, .web-search, vendor.myndhyve.chat); against a local clone
# 31 commits behind it is TWENTY-TWO. The guard deliberately judges the LOCAL
# clone, because that is what the copy loop below actually reads — a guard that
# consulted `origin/main` would bless a copy from a tree it never inspected.
# The staleness warning below exists so the difference is never silent again.
#
# NOTE for anyone reading `check-pack-pin-drift.mjs`: its header says a pack where
# production is ahead "means the repo is stale and a `sync-packs.sh` run would fix
# it — annoying, not undelivered work." That is safe ONLY per-pack and ONLY when
# this guard passes; the script is family-granular and destroys the rest. The
# stale-repo case and the destroys-work case are the same command.
# ---------------------------------------------------------------------------
CHECK_ONLY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) echo "usage: sync-packs.sh [--check] [--force]"; exit 0 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Semver compare: prints VENDORED-AHEAD / CANON-AHEAD / EQ. Non-numeric or
# absent versions print UNKNOWN rather than guessing — an unparseable version is
# not evidence that the copy is safe to delete.
pack_version() {
  [ -f "$1/pack.json" ] || { printf '%s' ''; return; }
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/pack.json" | head -1
}
semver_cmp() {
  a="$1"; b="$2"
  case "$a$b" in *[!0-9.]*|'') echo UNKNOWN; return ;; esac
  [ -n "$a" ] && [ -n "$b" ] || { echo UNKNOWN; return; }
  i=1
  while [ "$i" -le 3 ]; do
    x="$(printf '%s' "$a" | cut -d. -f"$i")"; y="$(printf '%s' "$b" | cut -d. -f"$i")"
    x="${x:-0}"; y="${y:-0}"
    [ "$x" -gt "$y" ] 2>/dev/null && { echo VENDORED-AHEAD; return; }
    [ "$x" -lt "$y" ] 2>/dev/null && { echo CANON-AHEAD; return; }
    i=$((i + 1))
  done
  echo EQ
}

if [ -d "$REGISTRY/.git" ]; then
  behind="$(git -C "$REGISTRY" rev-list --count HEAD..@{upstream} 2>/dev/null || echo 0)"
  if [ "${behind:-0}" -gt 0 ] 2>/dev/null; then
    echo "sync-packs: WARNING — the registry clone at $REGISTRY is $behind commits behind" >&2
    echo "  its upstream. Everything below is measured against THAT tree, so a family may" >&2
    echo "  look newer here purely because canon has not been pulled. Run" >&2
    echo "  \`git -C $REGISTRY pull --ff-only\` before trusting a divergence count." >&2
    echo >&2
  fi
fi

orphans=''
ahead=''
orphan_files=0
for existing in "$VENDORED"/core.openwop.* "$VENDORED"/vendor.*; do
  [ -d "$existing" ] || continue
  name="$(basename "$existing")"
  case "$name" in *.registry-*) continue ;; esac
  if [ ! -d "$CANONICAL/$name" ]; then
    n="$(find "$existing" -type f | wc -l | tr -d ' ')"
    orphans="$orphans  $name ($n file$([ "$n" = 1 ] || echo s))
"
    orphan_files=$((orphan_files + n))
    continue
  fi
  cmp="$(semver_cmp "$(pack_version "$existing")" "$(pack_version "$CANONICAL/$name")")"
  if [ "$cmp" = "VENDORED-AHEAD" ]; then
    ahead="$ahead  $name (vendored $(pack_version "$existing") > canon $(pack_version "$CANONICAL/$name"))
"
  fi
done

# Files inside a family that EXISTS in canon but that canon does not carry. The
# family survives the sweep; these individual files do not.
stranded=''
stranded_files=0
for existing in "$VENDORED"/core.openwop.* "$VENDORED"/vendor.*; do
  [ -d "$existing" ] || continue
  name="$(basename "$existing")"
  case "$name" in *.registry-*) continue ;; esac
  [ -d "$CANONICAL/$name" ] || continue
  n=0
  while IFS= read -r f; do
    rel="${f#$existing/}"
    [ -e "$CANONICAL/$name/$rel" ] || n=$((n + 1))
  done <<EOF
$(find "$existing" -type f)
EOF
  if [ "$n" -gt 0 ]; then
    stranded="$stranded  $name ($n file$([ "$n" = 1 ] || echo s))
"
    stranded_files=$((stranded_files + n))
  fi
done

if [ -n "$orphans$ahead$stranded" ]; then
  echo "sync-packs: this run would DESTROY vendored content canon cannot restore." >&2
  [ -n "$orphans" ] && { echo >&2; echo "  families absent from canon — deleted and NOT re-copied ($orphan_files file$([ "$orphan_files" = 1 ] || echo s)):" >&2; printf '%s' "$orphans" >&2; }
  [ -n "$stranded" ] && { echo >&2; echo "  files absent from canon inside surviving families ($stranded_files file$([ "$stranded_files" = 1 ] || echo s)):" >&2; printf '%s' "$stranded" >&2; }
  [ -n "$ahead" ] && { echo >&2; echo "  families vendored NEWER than canon — would be reverted:" >&2; printf '%s' "$ahead" >&2; }
  echo >&2
  echo "  Publish the newer copies to the registry FIRST, then re-run. A family the" >&2
  echo "  registry has never seen must be published or deliberately retired — this" >&2
  echo "  script cannot tell those apart, so it refuses rather than guessing." >&2
  echo "  Override with --force ONLY when you have confirmed the loss is intended." >&2
  [ "$FORCE" = "1" ] || exit 1
  echo "sync-packs: --force given — proceeding despite the losses above." >&2
fi

if [ "$CHECK_ONLY" = "1" ]; then
  [ -n "$orphans$ahead$stranded" ] || echo "ok — no vendored content would be lost by a sync."
  exit 0
fi

# Remove only the families this script owns (re-copied below). A blanket
# `rm -rf packs/` would also delete the repo-owned feature.* / community.*
# packs, which live ONLY in this repo.
mkdir -p "$VENDORED"
for stale in "$VENDORED"/core.openwop.* "$VENDORED"/vendor.*; do
  [ -e "$stale" ] || continue
  rm -rf "$stale"
done

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
