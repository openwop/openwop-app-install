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
