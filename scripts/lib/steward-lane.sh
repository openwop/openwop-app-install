# shellcheck shell=bash
#
# Is this checkout the full repo (steward lane present) or a white-label adopter
# bundle (steward lane stripped)? Shared by `ci.sh`; tested in
# `scripts/test-gate-tooling.sh` § steward lane.
#
# `build-whitelabel-zip.sh` strips a SET of paths in one `zip -d`:
#   .claude/ .agents/ .github/ docs/steward/ docs/research/ backend/typescript/test/steward/
# so in a real bundle they are absent TOGETHER and in the full repo present
# together. The primary marker is `docs/steward/` (what the two guarded gates
# read). The CO-MARKER is `backend/typescript/test/steward/`: stripped by the same
# line, and the one member of the set an adopter never re-adds.
#
# NOT `.github/`, `.agents/` or `.claude/`: an adopter restores its OWN copies of
# those on its main branch (measured on kicktodo 2026-09-16: all three tracked,
# while docs/steward/ and test/steward/ are absent). A `.github/` co-marker made
# kicktodo's ci.sh refuse outright — caught before push by running the detector
# on a clean kicktodo tree. `docs/research/` is out for the same reason: an
# adopter can create its own. A co-marker must be steward-owned by construction.
#
# Why a co-marker at all (steward review of #3888): with one marker, renaming or
# moving `docs/steward/` in the FULL repo would make both gates skip, print
# "adopter bundle", and stay structurally green forever — a gate that cannot
# fail, announcing itself as healthy. Disagreeing markers are not a bundle; they
# are a detector that is wrong, and the run must FAIL rather than skip.
#
# steward_lane <root>  → prints `take` or `skip`; returns 2 (and prints why on
#                        stderr) when the markers disagree.
steward_lane() {
  local root="$1" steward=0 tests=0
  [ -d "$root/docs/steward" ] && steward=1
  [ -d "$root/backend/typescript/test/steward" ] && tests=1
  if [ "$steward" = 1 ] && [ "$tests" = 1 ]; then echo take; return 0; fi
  if [ "$steward" = 0 ] && [ "$tests" = 0 ]; then echo skip; return 0; fi
  echo "error: steward-lane markers disagree (docs/steward/ present=$steward, backend/typescript/test/steward/ present=$tests)." >&2
  echo "  An adopter bundle strips BOTH (build-whitelabel-zip.sh). One without the other means a" >&2
  echo "  marker moved, and skipping the steward gates now would disable them silently. Fix the" >&2
  echo "  detector in scripts/lib/steward-lane.sh rather than letting the gates skip." >&2
  return 2
}

# Issue #5006 (ADR 0874 D4, amended 2026-10-22) — which env files the BUDGETED
# frontend build reads.
#
# `check-bundle-budget` judges the default build against the HOST's entry
# ceiling. In an adopter bundle, Vite would also load the adopter's own
# `frontend/react/.env.production`, compile its VITE_BRAND_* strings into the
# entry, and red the gate on a build the adopter never ships (KickTodo: 175 B
# over, 2026-10-19). So in a bundle the budgeted build reads a temp dir holding
# only a copy of `.env.production.example`: host code only. The full repo keeps
# its own `.env.production`, exactly as before.
#
# budget_env_dir <root> <take|skip> → prints nothing for `take` (build as today);
#   for `skip` makes a temp dir, copies the example in as `.env.production`, and
#   prints the dir (the caller exports it as OPENWOP_VITE_ENV_DIR and removes it).
#   Returns 1 when a bundle has no example: refusing beats measuring brand bytes.
budget_env_dir() {
  local root="$1" mode="$2" ex d
  [ "$mode" = skip ] || return 0
  ex="$root/frontend/react/.env.production.example"
  [ -f "$ex" ] || { echo "error: adopter bundle without $ex; the budgeted build has no host-only env to read." >&2; return 1; }
  d="$(mktemp -d "${TMPDIR:-/tmp}/owp-budget-env.XXXXXX")" || return 1
  cp "$ex" "$d/.env.production" || { rm -rf "$d"; return 1; }
  echo "$d"
}

# skill_mirror_lane <root> <steward-lane-mode>  → prints `take` or `skip`.
#
# The agent-skill mirror gate (`check-agent-skill-mirror.mjs`) compares
# `.agents/skills/` to `.claude/skills/`, both stripped by the same `zip -d` as
# the steward lane, so in a bundle it exits 1 on ".claude/skills is missing"
# (MEASURED: MyndHyve's v0.6.0 overlay gate, 2026-10-20). It SKIPS only when the
# steward lane is skipped AND both skill dirs are absent. In the full repo it
# always runs, so deleting both dirs there still fails instead of skipping. An
# adopter that re-adds either dir (kicktodo tracks both) gets the check, so
# `.claude/skills` without an in-sync `.agents/skills` still fails.
skill_mirror_lane() {
  local root="$1" mode="$2"
  if [ "$mode" = skip ] && [ ! -e "$root/.claude/skills" ] && [ ! -e "$root/.agents/skills" ]; then
    echo skip
  else
    echo take
  fi
}
