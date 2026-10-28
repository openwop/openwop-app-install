#!/usr/bin/env bash
# Vendors the brand-film skill from its public repository at a tagged release,
# then applies openwop-app's overlay (its film identity, logos and lexicon).
#
#   scripts/sync-brand-film.sh v1.0.0
#
# The skill is developed at https://github.com/davidscotttufts/brand-film; this
# repository carries a pinned copy so Claude Code and the .agents mirror work
# offline and every agent sees the same version. Do not edit
# .claude/skills/brand-film by hand: change the upstream repository, release,
# and re-run this with the new tag. openwop-specific changes belong in
# scripts/brand-film-overlay/, which is copied over the upstream files.
set -euo pipefail
tag="${1:?usage: sync-brand-film.sh <tag, e.g. v1.0.0>}"
root="$(git rev-parse --show-toplevel)"
dest="$root/.claude/skills/brand-film"
overlay="$root/scripts/brand-film-overlay"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "https://codeload.github.com/davidscotttufts/brand-film/tar.gz/refs/tags/$tag" | tar -xz -C "$tmp"
src="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d)/plugins/brand-film/skills/brand-film"
[ -f "$src/SKILL.md" ] || { echo "sync-brand-film: no skill in the $tag archive" >&2; exit 1; }
sha="$(git ls-remote https://github.com/davidscotttufts/brand-film.git "refs/tags/$tag" | cut -f1)"

rm -rf "$dest"
mkdir -p "$dest"
cp -R "$src/." "$dest/"
cp -R "$overlay/." "$dest/"
cat > "$dest/UPSTREAM.md" <<NOTE
# Vendored from upstream

This skill is a pinned copy of [brand-film](https://github.com/davidscotttufts/brand-film)
**$tag** (\`$sha\`), installed by \`scripts/sync-brand-film.sh $tag\`. Don't edit it here:
change the upstream repository, release it, and re-run the script with the new tag.

openwop-app's overlay (\`scripts/brand-film-overlay/\`) replaces these upstream files:

$(cd "$overlay" && find . -type f | sed 's#^\./#- `#; s#$#`#' | sort)

so a film scaffolded here starts in openwop-app's identity (DESIGN.md §6.1) with
the OpenWOP pronunciations. Films for openwop.dev itself are still rendered in
\`openwop-site/video\`.
NOTE
node "$root/scripts/check-agent-skill-mirror.mjs" --fix
echo "brand-film $tag ($sha) vendored into .claude/skills/brand-film and mirrored."
