#!/usr/bin/env bash
# git-sync — fetch and fast-forward, safely, in a repo that several Claude Code
# sessions and worktrees share.
#
#   npm run sync
#
# What it does, and why each part earns its place:
#
#   1. `git fetch --prune`, RETRIED. Concurrent sessions fetch at the same time
#      and lose the ref-update race:
#        error: fetching ref refs/remotes/origin/main failed: incorrect old value provided
#      That is harmless — the fetch simply did not apply — but a one-shot fetch
#      leaves you reasoning about a stale `origin/main` and a bogus "[behind N]".
#      `--prune` also drops tracking refs for branches a peer already deleted.
#
#   2. Fast-forward ONLY, and only when that is the right move:
#        - on `main`  -> `git merge --ff-only origin/main`
#        - elsewhere  -> report the gap; never merge into someone's feature branch
#      `--ff-only` refuses to invent a merge commit, so it fails loudly instead of
#      quietly entangling a tree that has local commits.
#
#   3. Refuses to touch a dirty tree. In a shared checkout the uncommitted work
#      may be another session's, and CLAUDE.md's first rule about this repo is
#      that you do not destroy it.
#
# NOTE the deliberate absence of `git pull --ff-only origin main`. That merges
# from FETCH_HEAD and does NOT reliably advance the `origin/main` tracking ref, so
# `git status -sb` keeps reporting "[behind N]" after you have already
# fast-forwarded — which is exactly the confusion this script exists to end.
set -euo pipefail

REMOTE="${1:-origin}"
BASE="${2:-main}"

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

cd "$(git rev-parse --show-toplevel)"

say "fetching $REMOTE (pruning deleted branches)"
fetched=0
for attempt in 1 2 3; do
  if git fetch --prune "$REMOTE" 2>/tmp/git-sync-fetch.err; then
    fetched=1
    break
  fi
  if grep -q 'incorrect old value provided' /tmp/git-sync-fetch.err; then
    note "ref race with a concurrent fetch (attempt $attempt/3) — retrying"
    sleep 2
    continue
  fi
  cat /tmp/git-sync-fetch.err >&2
  exit 1
done
if [ "$fetched" -ne 1 ]; then
  note "fetch kept losing the ref race — another session may be fetching in a loop"
  cat /tmp/git-sync-fetch.err >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "HEAD" ]; then
  say "detached HEAD — fetched only, nothing to fast-forward"
  exit 0
fi

behind="$(git rev-list --count "HEAD..$REMOTE/$BASE" 2>/dev/null || echo 0)"
ahead="$(git rev-list --count "$REMOTE/$BASE..HEAD" 2>/dev/null || echo 0)"

if [ "$BRANCH" != "$BASE" ]; then
  say "on '$BRANCH' — not fast-forwarding a non-$BASE branch"
  note "$ahead commit(s) ahead of $REMOTE/$BASE, $behind behind"
  [ "$behind" -gt 0 ] && note "to integrate: git rebase $REMOTE/$BASE   (or merge, if the branch is shared)"
  exit 0
fi

if [ "$behind" -eq 0 ]; then
  say "already up to date with $REMOTE/$BASE"
  [ "$ahead" -gt 0 ] && note "$ahead local commit(s) not yet pushed"
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  say "$behind commit(s) behind $REMOTE/$BASE — but the tree is dirty, so NOT fast-forwarding"
  note "in a shared checkout these changes may belong to another session; commit them to a branch first"
  git status --short | sed 's/^/    /'
  exit 1
fi

say "fast-forwarding $BASE by $behind commit(s)"
git merge --ff-only "$REMOTE/$BASE"
note "now at $(git rev-parse --short HEAD)"
