#!/usr/bin/env bash
# Registry ↔ examples parity check (day-1 UX P10 / E4).
#
# The public registry (packs.openwop.dev) and this repo's examples/*-packs
# drift silently: the day-1 UX audit found NetSuite + four ad-platform
# connection packs authored here but never published, while dashboard
# templates named them as if present. This check makes the drift visible.
#
# TWO drift shapes, because NAME parity is not enough (ADR 0583, 2026-08-18):
#
#   1. LOCAL-ONLY — authored here, never published. The original check.
#   2. STALE — published, but at an OLDER version than the repo's copy. This one
#      is worse, and it was invisible: `defaultWorkflowChainPackRoots()`
#      (`host/workflowChainPackLoader.ts`) is FIRST-ROOT-WINS — operator override,
#      then the registry install dir, then `examples/`. So a stale registry copy
#      SHADOWS the fixed in-repo pack for every non-vitest boot (`npm run dev`,
#      `scripts/e2e-routes.sh`, every self-hosted install), and backend vitest
#      cannot see it (per-worker `isolatePackDir` points at an empty temp dir).
#      MEASURED on `core.openwop.workflows.knowledge`: the installed copy was
#      1.0.0 with every delivery edge bare while the repo shipped 1.1.0 — a
#      merged fix that no real boot ran.
#
# Network-dependent by nature, so it lives in the LIVE lane (ci:full /
# on-demand), never the offline `npm run ci` gate. Exit codes:
#   0 = no drift, or registry unreachable (skip, don't fail offline runs)
#   1 = drift found (local-but-unpublished, or published-but-stale)
set -euo pipefail

REGISTRY_URL="${OPENWOP_REGISTRY_URL:-https://packs.openwop.dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# WHICH TREE. The registry is versioned BY TREE, not by header, and
# `.well-known/openwop-registry.json` `endpoints` IS the negotiation — a client
# MUST resolve every path through it rather than constructing one
# (RFC 0177 §A.3 / `spec/v2/core/packs.md` §"The registry tree").
#
# CORRECTED 2026-09-18. This line read `${REGISTRY_URL}/v1/index.json`, which is
# the FROZEN tree — ADR 0663 named it that when it moved the installer off
# constructed `/v1/…` paths for exactly this reason, because "no major-2-
# admissible version is published" there. So this check compared the repo
# against a tree the host never installs from, and confidently reported packs as
# "STALE ON REGISTRY … SHADOWS this repo's fix for every non-vitest boot" when
# the copy the host actually installs was current.
#
# MEASURED on the live registry the day this was fixed: 49 findings against
# `/v1` (31 stale + 18 local-only) versus 35 against `/v2` (17 + 18). **14 of
# the 49 were fiction**, and they were the most alarming-sounding ones. The two
# trees both hold 156 packs and differ only in version, which is why the bug
# survived: nothing about the v1 answer looks degraded.
#
# The host resolves this map at `packs/registryInstaller.ts`; so does this
# check now. One owner for "which tree", not two.
HOST_MAJOR="${OPENWOP_REGISTRY_TREE_MAJOR:-2}"
wellknown="$(curl -fsS --max-time 10 "${REGISTRY_URL}/.well-known/openwop-registry.json" 2>/dev/null)" || {
  echo "check-registry-parity: registry unreachable (${REGISTRY_URL}) — skipping." >&2
  exit 0
}
index_path="$(printf '%s' "$wellknown" | HOST_MAJOR="$HOST_MAJOR" python3 -c '
import json, os, sys
ep = (json.load(sys.stdin).get("endpoints") or {})
tree = ep.get("v%s" % os.environ["HOST_MAJOR"])
# A registry that does not name this tree gets NO fallback to the flat aliases:
# those ARE the v1-era spelling, so falling back would silently restore the bug
# this comment documents. An empty answer must fail, not degrade.
print((tree or {}).get("registryIndex") or "")
')"
if [ -z "$index_path" ]; then
  echo "check-registry-parity: ${REGISTRY_URL}/.well-known/openwop-registry.json names no endpoints.v${HOST_MAJOR}.registryIndex." >&2
  echo "  Refusing to fall back to the flat aliases — those are the v1-era spelling, and comparing" >&2
  echo "  against the frozen tree is the defect this resolution exists to prevent." >&2
  exit 1
fi
index_json="$(curl -fsS --max-time 10 "${REGISTRY_URL}${index_path}" 2>/dev/null)" || {
  echo "check-registry-parity: registry index unreachable (${REGISTRY_URL}${index_path}) — skipping." >&2
  exit 0
}
echo "check-registry-parity: comparing against the v${HOST_MAJOR} tree (${index_path})."

# Registry `name<TAB>version` (all kinds).
#
# The index field is `latestVersion`, NOT `version` — MEASURED against the live
# https://packs.openwop.dev/v1/index.json, whose rows are
# {name, kind, latestVersion, description, tags, typeIds, nodeCount, agentCount,
#  license, deprecated, yanked}. The first cut of this check read `version`,
# got `None` for every pack, and reported a clean bill of health while the
# stalest pack in the corpus sat two minor versions behind. A wrong predicate
# returns nothing, and nothing is what "healthy" looks like — so `version` is
# kept only as a fallback and an UNKNOWN version can never manufacture a
# finding (it is emitted as `-` and skipped, never compared).
registry_rows="$(printf '%s' "$index_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
packs = d.get("packs", d if isinstance(d, list) else [])
for p in packs:
    if not isinstance(p, dict):
        continue
    name = p.get("name")
    if name:
        print("%s\t%s" % (name, p.get("latestVersion") or p.get("version") or "-"))
')"

# Local example `name<TAB>version` (connection + workflow-chain packs).
local_rows="$(
  for f in "$ROOT"/examples/connection-packs/*/pack.json "$ROOT"/examples/workflow-chain-packs/*/pack.json; do
    [ -f "$f" ] || continue
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("%s\t%s" % (d["name"], d.get("version") or "-"))' "$f"
  done
)"

# Numeric-segment SemVer compare: prints `older` / `same` / `newer` for $1 vs $2.
semver_cmp() {
  python3 - "$1" "$2" <<'PY'
import sys
def parts(v):
    core = str(v).split('-')[0]
    out = []
    for seg in core.split('.'):
        try:
            out.append(int(seg))
        except ValueError:
            out.append(0)
    while len(out) < 3:
        out.append(0)
    return out[:3]
a, b = parts(sys.argv[1]), parts(sys.argv[2])
print('same' if a == b else ('newer' if a > b else 'older'))
PY
}

drift=0
behind_count=0
behind_list=""
while IFS=$'\t' read -r name version; do
  [ -n "$name" ] || continue
  reg_version="$(printf '%s\n' "$registry_rows" | awk -F'\t' -v n="$name" '$1 == n { print $2; exit }')"
  if [ -z "$reg_version" ]; then
    echo "LOCAL-ONLY (authored here, not on ${REGISTRY_URL}): $name"
    drift=1
    continue
  fi
  # `-` on either side = version unknown; cannot compare, so do not claim drift.
  if [ "$version" = "-" ] || [ "$reg_version" = "-" ]; then
    continue
  fi
  cmp_result="$(semver_cmp "$reg_version" "$version")"
  if [ "$cmp_result" = "older" ]; then
    echo "STALE ON REGISTRY (the published copy SHADOWS this repo's fix for every non-vitest boot):"
    echo "    $name — registry ${reg_version}, repo ${version}"
    drift=1
  elif [ "$cmp_result" = "newer" ]; then
    # THIRD DRIFT SHAPE, added 2026-09-18. The two shapes above both assume the
    # repo is the one that is ahead. Measured on the live v2 tree the day the
    # tree bug was fixed: 18 local-only, 17 repo-ahead — and **44 REGISTRY-AHEAD**,
    # nearly all by exactly one patch, the signature of a bulk bump made in the
    # registry and never back-ported. The check had no name for the largest
    # category of drift it was looking straight at.
    #
    # Why it matters, and it is not "the newest content wins so it is fine":
    # loading is first-root-wins with the registry install dir BEFORE
    # `examples/`, so the repo's vendored copy is not what runs. An author
    # reading `examples/` sees content that production does not use, and the
    # moment they fix it and bump `1.0.0 → 1.0.1` they MINT A COLLIDING VERSION
    # — same number, different content, one of them already published. A
    # version collision with divergent content is strictly worse than staleness,
    # because nothing downstream can tell which `1.0.1` it holds.
    #
    # Advisory, not drift: publishing is not the remedy here (it would DOWNGRADE
    # a live pack), so this must never make the check exit 1. The fix is to pull
    # the registry copy back into `examples/`.
    behind_count=$((behind_count + 1))
    behind_list="${behind_list}
    $name — registry ${reg_version}, repo ${version}"
  fi
done <<<"$local_rows"

if [ "$behind_count" -gt 0 ]; then
  echo ""
  echo "REGISTRY AHEAD OF REPO — ${behind_count} pack(s). ADVISORY, not drift: do NOT publish these."
  echo "  The registry copy is newer, and loading is first-root-wins with the registry install dir"
  echo "  BEFORE examples/ — so the in-repo copy is not what runs. Editing it and bumping the patch"
  echo "  mints a COLLIDING version: same number, different content, one already published."
  echo "  Remedy: pull the registry copy back into examples/, do not push the repo copy out."
  printf '%s\n' "$behind_list"
  echo ""
fi

if [ "$drift" -eq 0 ]; then
  echo "check-registry-parity: OK — every local example pack is published, at or ahead of the repo version."
else
  echo "check-registry-parity: drift found — publish the packs above (openwop-registry PR), then re-install so ~/.openwop-packs stops shadowing them; or de-reference them." >&2
fi
exit "$drift"
