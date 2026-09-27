#!/usr/bin/env bash
#
# Merge a PR and delete its remote branch — in that order, with the delete gated
# on a VERIFIED merged state.
#
# WHY THIS EXISTS. The obvious one-liner is wrong in two independent ways, and
# both have cost this repo real work:
#
#   gh pr merge N --squash ; git push origin --delete my-branch
#
#   1. `;` is not `&&`. MEASURED 2026-09-19 on PR #4001: the merge failed on
#      conflicts, the delete ran anyway, and GitHub AUTO-CLOSED the PR because
#      its head ref had vanished — then refused to reopen it. Restoring the
#      branch does not bring the PR back; the review thread, its comments and
#      its CI history are gone. #4001 had to be re-opened as #4002.
#   2. `&&` is ALSO wrong here, because a successful merge can still exit
#      non-zero. Per CLAUDE.md, `gh pr merge` run from a worktree merges fine
#      and THEN fails trying to check out `main`, which the shared checkout
#      already holds (`fatal: 'main' is already used by worktree at …`). So an
#      `&&` chain skips the cleanup after a merge that actually landed.
#
# The exit code of `gh pr merge` is therefore evidence of nothing in either
# direction. The only trustworthy signal is the PR's STATE, read back from the
# API afterwards. That is what this script does, and it is the whole point.
#
# It also refuses to delete a branch that another OPEN PR is based on — the
# stacked-PR hazard CLAUDE.md records as costing #1348 and #3496.
#
#   scripts/pr-merge-cleanup.sh 1234                 # squash (default)
#   scripts/pr-merge-cleanup.sh 1234 --merge         # or --rebase
#   scripts/pr-merge-cleanup.sh 1234 --dry-run       # print the plan, change nothing
#
set -uo pipefail

PR=""; METHOD=--squash; DRY=0
for arg in "$@"; do
  case "$arg" in
    --squash|--merge|--rebase) METHOD="$arg" ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    ''|*[!0-9]*) echo "pr-merge-cleanup: unknown argument '$arg'" >&2; exit 2 ;;
    *) PR="$arg" ;;
  esac
done
[ -n "$PR" ] || { echo "usage: scripts/pr-merge-cleanup.sh <pr-number> [--squash|--merge|--rebase] [--dry-run]" >&2; exit 2; }

say() { printf '  %s\n' "$*"; }
printf '\n\033[1m▶ pr-merge-cleanup #%s\033[0m\n' "$PR"

state=$(gh pr view "$PR" --json state -q .state 2>/dev/null) || { say "cannot read PR #$PR (wrong repo, or no such PR)"; exit 1; }
head=$(gh pr view "$PR" --json headRefName -q .headRefName)
say "state   : $state"
say "head    : $head"

if [ "$state" = MERGED ]; then
  say "already merged — skipping the merge, proceeding to cleanup"
elif [ "$state" != OPEN ]; then
  say "PR is $state, not OPEN. Refusing to act."; exit 1
fi

# The stacked-PR guard. Deleting a branch that another OPEN PR targets as its
# BASE makes GitHub auto-close that PR and then refuse to reopen it.
# FAIL CLOSED. The first version swallowed the query's exit code, so a FAILED
# `gh pr list` — network blip, auth expiry, rate limit — produced empty output and
# read exactly like "no dependents", and the script deleted the branch. That is the
# unrecoverable case this guard exists to prevent, reached BY the guard. Not
# hypothetical: `gh` returned "Post https://api.github.com/graphql: unexpected EOF"
# during this program's own session.
if ! dependents=$(gh pr list --state open --base "$head" --json number -q '.[].number' 2>&1); then
  say "REFUSING: cannot determine dependents — 'gh pr list' failed:"
  while IFS= read -r l; do say "  $l"; done <<< "$dependents"
  say "An unanswerable query is NOT an answer of 'none'. Nothing deleted."
  exit 1
fi
dependents=$(printf '%s' "$dependents" | tr '\n' ' ')
if [ -n "${dependents// /}" ]; then
  say "REFUSING: open PR(s) [ ${dependents}] are based on '$head'."
  say "Retarget them first:  gh pr edit <n> --base main"
  exit 1
fi
say "stacked : none — no open PR uses '$head' as its base (query answered)"

if [ "$DRY" = 1 ]; then
  say "dry-run : would run 'gh pr merge $PR $METHOD', re-read the state, and delete '$head' ONLY if it reads MERGED"
  printf '\n'; exit 0
fi

if [ "$state" = OPEN ]; then
  say "merging : gh pr merge $PR $METHOD"
  # Deliberately NOT `&&`, NOT `;`-chained to the delete, and NOT --delete-branch.
  # The exit code is captured for the log and then IGNORED for the decision.
  gh pr merge "$PR" "$METHOD" 2>&1 | sed 's/^/          /'
  say "merge exit: ${PIPESTATUS[0]} (not load-bearing — the state read below is)"
fi

# THE GATE. Nothing above this line may delete anything.
final=$(gh pr view "$PR" --json state -q .state 2>/dev/null)
if [ "$final" != MERGED ]; then
  say "VERIFY FAILED: state is '$final', not MERGED. Branch '$head' left intact."
  printf '\n'; exit 1
fi
say "verified: state is MERGED"
# Read git's OWN status, not the pipeline's. `git … | sed` reports sed's exit, so
# the previous form printed "deleted" after a REJECTED delete and exited 0.
del_out=$(git push origin --delete "$head" 2>&1); del_rc=$?
while IFS= read -r l; do say "$l"; done <<< "$del_out"
if [ "$del_rc" -eq 0 ]; then
  say "deleted : $head"
elif case "$del_out" in *"remote ref does not exist"*|*"unable to delete"*) true;; *) false;; esac; then
  say "note    : remote branch was already gone (merge stands)"
else
  say "WARNING : delete FAILED (exit $del_rc). The merge stands; '$head' still exists."
  printf '\n'; exit 1
fi
printf '\n'
