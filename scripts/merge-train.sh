#!/usr/bin/env bash
# merge-train.sh — gate SEVERAL pull requests in ONE `npm run ci`, then merge them.
#
#   scripts/merge-train.sh 4316 4319            # gate both together, merge on green
#   scripts/merge-train.sh --dry-run 4316 4319  # build the train and report; no gate
#   scripts/merge-train.sh --no-merge 4316      # gate the train; leave merging to you
#   scripts/merge-train.sh --no-bisect 4316 4319  # a red train stops instead of bisecting
#
# WHY. The gate is ~45 minutes and one runs at a time on a machine, so N pull
# requests gated one by one cost N gates PLUS the queue between them — measured
# 2026-10-01: gates that take 45 minutes spent one to two hours each waiting for
# the previous one. Twice that day two PRs were gated as one by hand and each
# time it saved a full cycle. This makes that the default shape.
#
# WHAT IS TESTED IS WHAT LANDS. The train is `origin/main` plus each PR head
# merged in the order given. If `origin/main` has not moved by the time the gate
# is green, merging the same heads in the same order produces the SAME TREE, and
# this script checks that it did (tree hash of the new main == tree hash that was
# gated). If main moved underneath, it REFUSES to merge and says so: the tested
# tree is no longer the tree that would land.
#
# A RED TRAIN BISECTS ITSELF (ADR 0880 P0). With more than one PR, the train is
# split in half and the first half re-gated on `origin/main`. A green half
# merges (with the same tree check as a whole train), the other half is re-gated
# on the new main; a red half splits again, down to the single PR that reds it.
# The culprit is named and left open; everything else lands. Each sub-gate is a
# full gate, so this costs about log2(N) extra gates — far less than the human
# loop it replaces, and much less once Tracegate enforcement selects tests.
# `--no-bisect` restores the old stop-on-red behaviour.
#
# MAIN MOVED DURING THE GATE: the train is rebuilt on the new main and re-gated
# once (OPENWOP_TRAIN_RETRIES, default 1) instead of being abandoned. Under
# Tracegate the re-gate only runs what the new commits can affect.
#
# It never passes `--delete-branch` (CLAUDE.md: deleting a base branch closes the
# PRs stacked on it), and it verifies every merge with `gh pr view` instead of
# trusting `gh pr merge`'s exit code, which is non-zero from a worktree even when
# the merge landed.
set -euo pipefail

DRY_RUN=0
DO_MERGE=1
BISECT=1
RETRIES="${OPENWOP_TRAIN_RETRIES:-1}"
PRS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-merge) DO_MERGE=0 ;;
    --no-bisect) BISECT=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    ''|*[!0-9]*) echo "merge-train: not a PR number: $arg" >&2; exit 2 ;;
    *) PRS+=("$arg") ;;
  esac
done
if [ "${#PRS[@]}" -eq 0 ]; then
  echo "usage: scripts/merge-train.sh [--dry-run|--no-merge|--no-bisect] <pr> [<pr>…]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMON="$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir)"
MAIN_CHECKOUT="$(dirname "$COMMON")"
# One persistent train worktree per clone, beside the main checkout, so its
# node_modules survive between trains (a fresh install is minutes of the saving).
TRAIN="${OPENWOP_TRAIN_DIR:-$(dirname "$MAIN_CHECKOUT")/$(basename "$MAIN_CHECKOUT")-train}"
# The lock is per CLONE, never per train dir. It used to be "${TRAIN}.lock", so
# OPENWOP_TRAIN_DIR silently minted a SEPARATE lock and two trains ran at once,
# neither seeing the other (MEASURED 2026-10-14: slot 74 held
# ../openwop-app-train74.lock while ../openwop-app-train.lock was absent).
# A custom train dir still serialises against every other train on this clone.
# OPENWOP_TRAIN_LOCK exists for self-tests that run this script against the real
# clone from inside a live train's gate; never set it to run a second train.
TRAIN_LOCK="${OPENWOP_TRAIN_LOCK:-${MAIN_CHECKOUT}-train.lock}"

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

say "merge train: ${PRS[*]}"
# One train at a time: the train worktree is SHARED by every session on this clone
# (scripts/lib/train-lock.sh says why). Claimed BEFORE any fetch or checkout.
# shellcheck source=lib/train-lock.sh
. "$ROOT/scripts/lib/train-lock.sh"
claim_train_lock "$TRAIN_LOCK" "${PRS[*]}${OPENWOP_TRAIN_DIR:+ (train dir $TRAIN)}" || exit 3
git -C "$ROOT" fetch -q origin

# ── CE-17: a release freeze refuses the train BEFORE a 45-minute gate ────────
# `release-freeze.sh status` exits 3 while main is frozen. Someone else's freeze
# means this train cannot land until they thaw, so say so now; the holder's OWN
# train (OPENWOP_FREEZE_HOLDER) merges through the freeze further down.
freeze_holder() { bash "$ROOT/scripts/release-freeze.sh" status 2>/dev/null | sed -n 's/^FROZEN by \([^ ]*\).*/\1/p'; }
frc=0; FREEZE="$(bash "$ROOT/scripts/release-freeze.sh" status 2>&1)" || frc=$?   # 3 = frozen; `set -e` must not take it as a failure
if [ "$frc" -eq 3 ] && [ "$(freeze_holder)" != "${OPENWOP_FREEZE_HOLDER:-}" ]; then
  echo "merge-train: main is $FREEZE" >&2
  echo "             Not gating a train that cannot merge. Wait for the holder to thaw it." >&2
  exit 1
elif [ "$frc" -ne 0 ] && [ "$frc" -ne 3 ]; then
  echo "merge-train: could not read the release-freeze state ($FREEZE) — continuing; the merge step re-checks." >&2
fi

# ── every car must be an open PR against main ────────────────────────────────
HEADS=()
for pr in "${PRS[@]}"; do
  info="$(gh pr view "$pr" --json state,baseRefName,headRefName,headRefOid,isDraft --jq '[.state,.baseRefName,.headRefName,.headRefOid,(.isDraft|tostring)]|@tsv')"
  IFS=$'\t' read -r state base head oid draft <<< "$info"
  if [ "$state" != "OPEN" ]; then echo "merge-train: #$pr is $state, not OPEN" >&2; exit 1; fi
  if [ "$base" != "main" ]; then echo "merge-train: #$pr targets '$base', not main — retarget it first (do not stack)" >&2; exit 1; fi
  if [ "$draft" = "true" ]; then echo "merge-train: #$pr is a draft" >&2; exit 1; fi
  git -C "$ROOT" fetch -q origin "$head"
  if [ "$(git -C "$ROOT" rev-parse "origin/$head")" != "$oid" ]; then
    echo "merge-train: #$pr head moved while fetching ($head) — run again" >&2; exit 1
  fi
  HEADS+=("$pr:$head:$oid")
  echo "  #$pr  $head  ${oid:0:9}"
done


# ── build the train ──────────────────────────────────────────────────────────
# build_train <pr>… — origin/main plus each listed PR head, merged in order.
# Sets BASE_OID and TRAIN_TREE. Returns 1 (after explaining) if a PR does not merge.
head_of() { local want="$1" e; for e in "${HEADS[@]}"; do [ "${e%%:*}" = "$want" ] && { echo "$e"; return 0; }; done; return 1; }
build_train() {
  git -C "$ROOT" fetch -q origin
  BASE_OID="$(git -C "$ROOT" rev-parse origin/main)"
  if [ ! -d "$TRAIN" ]; then
    say "creating the train worktree at $TRAIN"
    git -C "$ROOT" worktree add -q --detach "$TRAIN" origin/main
  fi
  if [ -n "$(git -C "$TRAIN" status --porcelain)" ]; then
    echo "merge-train: $TRAIN has uncommitted changes — not touching it" >&2; exit 1
  fi
  git -C "$TRAIN" checkout -q --detach "$BASE_OID"
  local pr entry head oid
  for pr in "$@"; do
    entry="$(head_of "$pr")"
    IFS=: read -r pr head oid <<< "$entry"
    if ! git -C "$TRAIN" merge -q --no-ff --no-edit -m "train: #$pr ($head)" "$oid"; then
      git -C "$TRAIN" merge --abort || true
      echo "merge-train: #$pr does not merge cleanly onto main plus the PRs before it." >&2
      echo "             Rebase it, or put it in a different train." >&2
      return 1
    fi
  done
  TRAIN_TREE="$(git -C "$TRAIN" rev-parse 'HEAD^{tree}')"
  say "train built on ${BASE_OID:0:9} — tree ${TRAIN_TREE:0:12} (#$*)"
  git -C "$TRAIN" --no-pager diff --stat "$BASE_OID" HEAD | tail -1
}
build_train "${PRS[@]}" || exit 1

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "dry run: the train merges cleanly. Nothing was gated or merged."
  exit 0
fi

# ── dependencies: install what is missing OR stale ───────────────────────────
# `node_modules` survives between trains, but building a train rewrites every
# lockfile it touches: the worktree is reset to main, then each PR is merged
# in. So a train that changes a lockfile leaves it NEWER than the install even
# when the install already matches it, and ci.sh's stale guard reds the whole
# gate before a single test runs. MEASURED 2026-10-03: the #4346 train (a suite
# pin bump) went red exactly so on a relaunch, after the first launch had
# installed for the same lockfile. So apply ci.sh's own rule here, and install
# when it would fail: lockfile newer than npm's install marker AND its content
# not the one ci.sh last stamped. A byte-identical rewrite still skips.
needs_install() {
  local d="$TRAIN/$1"
  [ -d "$d/node_modules" ] || return 0
  [ "$d/package-lock.json" -nt "$d/node_modules/.package-lock.json" ] || return 1
  [ "$(cat "$d/node_modules/.openwop-ci-lock-sha" 2>/dev/null)" != "$(shasum -a 256 "$d/package-lock.json" | cut -d' ' -f1)" ]
}
ensure_deps() {
  if needs_install backend/typescript; then
    say "installing backend dependencies in the train"
    # npm 10.9.8, never the local npm: npm >= 11.5 drops @azure/core-rest-pipeline
    # at install time (CLAUDE.md, ADR 0739).
    ( cd "$TRAIN/backend/typescript" && npx -y npm@10.9.8 ci )
  fi
  if needs_install frontend/react; then
    say "installing frontend dependencies in the train"
    ( cd "$TRAIN/frontend/react" && npm ci )
  fi
  if [ ! -d "$TRAIN/node_modules" ] && [ -f "$TRAIN/package-lock.json" ]; then
    ( cd "$TRAIN" && npm ci )
  fi
}

# ── gate + merge ─────────────────────────────────────────────────────────────
# gate_train — ONE `npm run ci` on the current train tree.
gate_train() {
  ensure_deps
  say "gating the train (one npm run ci for $# PR(s): #$*)"
  ( cd "$TRAIN" && npm run ci )
}

# merge_train <pr>… — merge in order, ONLY if main is still what the train was
# built on, then check main's tree IS the gated tree. Returns 2 if main moved
# (the caller may rebuild and re-gate); exits on anything else that is wrong.
merge_train() {
  git -C "$ROOT" fetch -q origin
  NOW_OID="$(git -C "$ROOT" rev-parse origin/main)"
  if [ "$NOW_OID" != "$BASE_OID" ]; then
    echo "merge-train: origin/main moved during the gate (${BASE_OID:0:9} → ${NOW_OID:0:9})." >&2
    echo "             The tested tree is not the tree that would land. Nothing was merged." >&2
    return 2
  fi
  # A freeze may have been taken DURING the gate. Someone else's refuses; our own
  # is merged through (release-freeze.sh disables it for each merge and re-enables
  # it on any exit).
  frc=0; FREEZE="$(bash "$ROOT/scripts/release-freeze.sh" status 2>&1)" || frc=$?   # 3 = frozen; `set -e` must not take it as a failure
  OWN_FREEZE=0
  if [ "$frc" -eq 3 ]; then
    if [ "$(freeze_holder)" = "${OPENWOP_FREEZE_HOLDER:-}" ] && [ -n "${OPENWOP_FREEZE_HOLDER:-}" ]; then
      OWN_FREEZE=1
    else
      echo "merge-train: main was frozen during the gate — $FREEZE" >&2
      echo "             The train is green but NOT merged. Merge it after the thaw (the tree may need re-gating)." >&2
      exit 1
    fi
  fi
  local pr state
  for pr in "$@"; do
    say "merging #$pr"
    if [ "$OWN_FREEZE" -eq 1 ]; then
      bash "$ROOT/scripts/release-freeze.sh" merge "$pr" --holder "$OPENWOP_FREEZE_HOLDER" >/dev/null 2>&1 || true
    else
      gh pr merge "$pr" --merge >/dev/null 2>&1 || true   # exit code is not the result — see header
    fi
    state="$(gh pr view "$pr" --json state --jq .state)"
    if [ "$state" != "MERGED" ]; then
      echo "merge-train: #$pr is $state after merge — stopping. Earlier PRs in this train ARE merged." >&2
      exit 1
    fi
  done
  git -C "$ROOT" fetch -q origin
  LANDED_TREE="$(git -C "$ROOT" rev-parse 'origin/main^{tree}')"
  if [ "$LANDED_TREE" = "$TRAIN_TREE" ]; then
    say "merged $# PR(s); main is $(git -C "$ROOT" rev-parse --short origin/main) and its tree is the tree that was gated"
  else
    echo "merge-train: merged, but main's tree (${LANDED_TREE:0:12}) is NOT the gated tree (${TRAIN_TREE:0:12})." >&2
    echo "             Something else landed between the check and the merges. Treat main as ungated." >&2
    exit 1
  fi
}

# ride <pr>… — build, gate and merge one train; on red, bisect; on a moved main,
# rebuild and re-gate up to $RETRIES times. Appends red PRs to CULPRITS.
CULPRITS=()
MERGED=()
ride() {
  local tries=0 rc
  while :; do
    if ! gate_train "$@"; then
      if [ "$BISECT" -eq 1 ] && [ "$#" -gt 1 ]; then
        local all=("$@") half=$(( $# / 2 ))
        local left=("${all[@]:0:half}") right=("${all[@]:half}")
        say "train RED — bisecting: #${left[*]} | #${right[*]}"
        build_train "${left[@]}" && ride "${left[@]}"
        build_train "${right[@]}" && ride "${right[@]}"
        return 0
      fi
      CULPRITS+=("$@")
      echo "merge-train: the train is RED for #$*. Nothing of it was merged." >&2
      return 0
    fi
    if [ "$DO_MERGE" -eq 0 ]; then
      echo
      echo "train green (tree ${TRAIN_TREE:0:12}). --no-merge: merge #$* in this order while main is still ${BASE_OID:0:9}."
      MERGED+=("$@")
      return 0
    fi
    rc=0; merge_train "$@" || rc=$?
    if [ "$rc" -eq 0 ]; then MERGED+=("$@"); return 0; fi
    if [ "$rc" -eq 2 ] && [ "$tries" -lt "$RETRIES" ]; then
      tries=$((tries + 1))
      say "main moved — rebuilding the train on the new main and re-gating (retry $tries of $RETRIES)"
      build_train "$@" || { CULPRITS+=("$@"); return 0; }
      continue
    fi
    echo "             Re-run the train; if the new commits share no files with it, that is your call to make by hand." >&2
    exit 1
  done
}

ride "${PRS[@]}"
if [ "${#CULPRITS[@]}" -gt 0 ]; then
  echo >&2
  [ "${#MERGED[@]}" -gt 0 ] && echo "merge-train: green and handled: #${MERGED[*]}" >&2
  echo "merge-train: RED, left open: #${CULPRITS[*]}" >&2
  exit 1
fi
