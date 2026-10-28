#!/usr/bin/env bash
# batch.sh — build several features on a BATCH BRANCH, then gate, merge and ship
# them together (ADR 0976).
#
#   scripts/batch.sh open   <name>                    # batch/<name> from origin/main
#   scripts/batch.sh merge  <name> <pr> [--accept-risk="<why>"]   # quick checks, then merge
#   scripts/batch.sh sync   <name>                    # merge origin/main into the batch
#   scripts/batch.sh status <name> [--json]           # what is in it, and what to do next
#   scripts/batch.sh close  <name>                    # ONE full gate; green → main; red → bisect
#   scripts/batch.sh bisect <name>                    # find (and revert) the merge that reds it
#
# WHY. A full gate is 15–45 minutes and one runs at a time, so features that
# build on each other wait on one gate each, in a queue. On a batch branch they
# merge into each other after QUICK checks only (`npm run ci:quick`: the static
# checks, typechecks, lint and builds, no test suite), and the whole batch is
# gated ONCE, at close. This is the integration-branch model (Linux's merge
# window, git-flow's develop, Perl's smoke-me branches); see ADR 0976.
#
# BUILT TO BE DRIVEN BY AN AGENT (Claude Code, Codex, Cursor …). The procedure
# is the `batch` skill (.claude/skills/batch/SKILL.md, mirrored to
# .agents/skills/). Every stop prints a `next:` line saying what to do;
# `status --json` is the machine-readable state, with its own `next`. Where a
# call needs JUDGMENT, the script asks for it explicitly instead of guessing: a
# PR that touches what quick checks cannot vouch for (lockfiles, the gate's own
# scripts, migrations, vendored schemas, very wide diffs) is refused until the
# agent re-runs with --accept-risk="<reason>", and that reason is posted on the
# PR. A red close leaves a FAILURE PACKET (culprit, diff, the red gate's failing
# lines) under <git-common-dir>/batch/<name>/, also posted on the PR, so the
# agent that fixes it starts from the evidence.
#
# WHAT IT NEVER DOES.
#   - It never touches main except through merge-train.sh, so main stays gated:
#     the batch lands as one PR, with the train's own tree check.
#   - It never deploys. A deploy is a release-queue slot; close prints the step.
#   - It never deletes a branch another open PR is based on (CLAUDE.md).
#
# A RED CLOSE BISECTS. The batch's first-parent commits are probed one gate at a
# time (merge-train.sh --gate-ref: origin/main plus that commit), about log2(N)
# gates. A feature merge found to red it is REVERTED on the batch (Firefox's
# backout rule: revert, don't fix forward), its PR is told why, and close runs
# again, up to OPENWOP_BATCH_CLOSE_ROUNDS (default 2) times.
#
# OPENWOP_BATCH_MAX (default 10) caps the features in one batch: if each PR has a
# 10% chance of being red, a batch of 10 is red about 65% of the time.
set -euo pipefail

usage() { sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
CMD="${1:-}"; NAME="${2:-}"
[ -n "$CMD" ] && [ -n "$NAME" ] || usage
case "$NAME" in *[!a-z0-9-]*|-*) echo "batch: name must be lowercase letters, digits and dashes: $NAME" >&2; exit 2 ;; esac
PR=""; JSON=0; ACCEPT=""
for a in "${@:3}"; do
  case "$a" in
    --json) JSON=1 ;;
    --accept-risk=*) ACCEPT="${a#--accept-risk=}" ;;
    ''|*[!0-9]*) echo "batch: unexpected argument: $a" >&2; usage ;;
    *) PR="$a" ;;
  esac
done
BRANCH="batch/$NAME"
MAX="${OPENWOP_BATCH_MAX:-10}"
ROUNDS="${OPENWOP_BATCH_CLOSE_ROUNDS:-2}"
WIDE="${OPENWOP_BATCH_WIDE_FILES:-60}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMON="$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir)"
MAIN_CHECKOUT="$(dirname "$COMMON")"
# One persistent worktree per batch, beside the main checkout, so its
# node_modules survive between merges (an install is minutes).
BWT="${OPENWOP_BATCH_DIR:-$(dirname "$MAIN_CHECKOUT")/$(basename "$MAIN_CHECKOUT")-batch-$NAME}"
LOCK="${MAIN_CHECKOUT}-batch-$NAME.lock"
# Logs and failure packets: in the git common dir, shared by every worktree, never committed.
PKT="$COMMON/batch/$NAME"

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
# die <what happened> [<what to do next>] — the second line is for the agent driving this.
die() { echo "batch: $1" >&2; [ -z "${2:-}" ] || echo "next: $2" >&2; exit 1; }
G() { git -C "$ROOT" "$@"; }
W() { git -C "$BWT" "$@"; }

# ── one command per batch at a time: they share the batch worktree ───────────
claim() {
  local pid=""
  if ! mkdir "$LOCK" 2>/dev/null; then
    read -r pid < "$LOCK/owner" 2>/dev/null || true
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      die "another batch command holds $BRANCH (pid $pid: $(sed -n 2p "$LOCK/owner" 2>/dev/null))." "wait for it to finish, then run this again"
    fi
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || die "lost the race for $LOCK" "run this again"
  fi
  printf '%s\n%s\n' "$$" "$CMD $NAME${PR:+ $PR}" > "$LOCK/owner"
  trap 'rm -rf "$LOCK"' EXIT
}

remote_tip() { G fetch -q origin; G rev-parse --verify -q "origin/$BRANCH" || die "no branch $BRANCH on origin" "scripts/batch.sh open $NAME"; }

# The batch worktree, detached at the batch's tip, clean.
checkout_tip() {
  local tip; tip="$(remote_tip)"
  if [ ! -d "$BWT" ]; then
    say "creating the batch worktree at $BWT"
    G worktree add -q --detach "$BWT" "$tip"
  fi
  [ -z "$(W status --porcelain)" ] || die "$BWT has uncommitted changes — not touching it" "commit or move those changes; this worktree belongs to batch.sh"
  W fetch -q origin
  W checkout -q --detach "$tip"
}

needs_install() {
  local d="$BWT/$1"
  [ -d "$d/node_modules" ] || return 0
  [ "$d/package-lock.json" -nt "$d/node_modules/.package-lock.json" ] || return 1
  [ "$(cat "$d/node_modules/.openwop-ci-lock-sha" 2>/dev/null)" != "$(shasum -a 256 "$d/package-lock.json" | cut -d' ' -f1)" ]
}
quick_check() {
  # npm 10.9.8 for the backend, never the local npm (CLAUDE.md, ADR 0739).
  if needs_install backend/typescript; then ( cd "$BWT/backend/typescript" && npx -y npm@10.9.8 ci ); fi
  if needs_install frontend/react; then ( cd "$BWT/frontend/react" && npm ci ); fi
  if [ ! -d "$BWT/node_modules" ] && [ -f "$BWT/package-lock.json" ]; then ( cd "$BWT" && npm ci ); fi
  say "quick checks on $(W rev-parse --short HEAD) (statics, typechecks, lint, builds; no suite)"
  ( cd "$BWT" && npm run ci:quick )
}

# What quick checks cannot vouch for. Prints one reason per line; empty = low risk.
# The agent decides what to do with a non-empty answer (the skill's rubric).
risk_reasons() { # risk_reasons <base> <head>
  local files n
  files="$(W diff --name-only "$1" "$2")"
  n="$(printf '%s\n' "$files" | grep -c . || true)"
  printf '%s\n' "$files" | grep -E '(^|/)package(-lock)?\.json$' | sed 's/^/dependencies: /' || true
  printf '%s\n' "$files" | grep -E '^(scripts/(ci|merge-train|batch|preflight-[a-z-]+|deploy[a-z-]*|tracegate[a-z-]*)\.(sh|mjs)|scripts/lib/|scripts/vendor/|Dockerfile|\.github/)' | sed 's/^/the gate or deploy itself: /' || true
  printf '%s\n' "$files" | grep -E '/migrations?/' | sed 's/^/a migration: /' || true
  printf '%s\n' "$files" | grep -E '^(schemas|conformance-fixtures)/' | head -3 | sed 's/^/vendored wire schemas: /' || true
  [ "$n" -le "$WIDE" ] || echo "a wide change: $n files (> $WIDE)"
}

# First-parent commits of the batch, oldest first: "<sha> <subject>".
commits() { local tip; tip="$(remote_tip)"; G log --first-parent --reverse --format='%H %s' "$(G merge-base origin/main "$tip")..$tip"; }
# Net features: feature merges minus their reverts.
feature_count() {
  local m r
  m="$(commits | grep -c ' Merge pull request #' || true)"
  r="$(commits | grep -c ' Revert "Merge pull request #' || true)"
  echo $(( m - r ))
}
# Open PRs based on the batch, as "#5 #6" (empty when none).
open_children() { gh pr list --base "$BRANCH" --state open --json number --jq '.[].number' | sed 's/^/#/' | paste -sd' ' -; }
batch_pr() { gh pr list --head "$BRANCH" --base main --state open --json number --jq '.[0].number // empty'; }

cmd_open() {
  G fetch -q origin
  G rev-parse --verify -q "origin/$BRANCH" >/dev/null && die "$BRANCH already exists on origin" "scripts/batch.sh status $NAME"
  G push -q origin "origin/main:refs/heads/$BRANCH"
  say "opened $BRANCH at $(G rev-parse --short origin/main)"
  echo "next: open feature PRs with 'gh pr create --base $BRANCH', then 'scripts/batch.sh merge $NAME <pr>' for each"
}

cmd_merge() {
  local info state base head oid draft tested landed risk
  [ -n "$PR" ] || die "usage: scripts/batch.sh merge $NAME <pr>" "name the PR to merge"
  claim
  [ "$(feature_count)" -lt "$MAX" ] || die "$BRANCH already holds $MAX features (OPENWOP_BATCH_MAX)." "close this batch (ask the release manager for a slot), or open another batch for #$PR"
  info="$(gh pr view "$PR" --json state,baseRefName,headRefName,headRefOid,isDraft --jq '[.state,.baseRefName,.headRefName,.headRefOid,(.isDraft|tostring)]|@tsv')"
  IFS=$'\t' read -r state base head oid draft <<< "$info"
  [ "$state" = OPEN ] || die "#$PR is $state, not OPEN" "scripts/batch.sh status $NAME"
  [ "$draft" != true ] || die "#$PR is a draft" "mark it ready (gh pr ready $PR) when it is, then merge again"
  [ "$base" = main ] || [ "$base" = "$BRANCH" ] || die "#$PR targets '$base', not $BRANCH or main" "gh pr edit $PR --base $BRANCH (do not stack PRs on each other)"
  checkout_tip
  W fetch -q origin "$head"
  [ "$(W rev-parse "origin/$head")" = "$oid" ] || die "#$PR head moved while fetching" "run this again"
  risk="$(risk_reasons "$(W merge-base HEAD "$oid")" "$oid")"
  if [ -n "$risk" ]; then
    say "risk: quick checks cannot vouch for #$PR"
    printf '%s\n' "$risk" | sed 's/^/  - /'
    [ -n "$ACCEPT" ] || die "#$PR needs a judgment before it merges on quick checks only." \
      "read the diff against the batch skill's rubric. If it is safe here, re-run with --accept-risk=\"<one-line reason>\"; if not, gate it on its own: scripts/merge-train.sh $PR"
  fi
  W merge -q --no-ff --no-edit -m "batch($NAME): check #$PR" "$oid" || { W merge --abort || true; die "#$PR does not merge cleanly into $BRANCH" "rebase #$PR onto origin/$BRANCH, push, and merge again"; }
  tested="$(W rev-parse 'HEAD^{tree}')"
  quick_check || die "quick checks RED for #$PR on $BRANCH — nothing merged, #$PR left as it was" "fix the failures printed above on #$PR's branch (they are lint, type or build errors, not tests), push, and merge again"
  # Retargeted only now, so a PR the quick checks refuse is left where it was.
  if [ "$base" = main ]; then
    say "retargeting #$PR from main to $BRANCH"
    gh pr edit "$PR" --base "$BRANCH" >/dev/null
  fi
  say "merging #$PR into $BRANCH"
  gh pr merge "$PR" --merge >/dev/null 2>&1 || true   # its exit code is not the result (CLAUDE.md)
  [ "$(gh pr view "$PR" --json state --jq .state)" = MERGED ] || die "#$PR is not MERGED after the merge" "gh pr view $PR, and merge it by hand only if it is green on quick checks"
  if [ -n "$risk" ]; then
    gh pr comment "$PR" --body "$(printf 'Merged into `%s` on quick checks only, with the risk accepted (ADR 0976):\n\n> %s\n\nFlagged:\n%s\n' "$BRANCH" "$ACCEPT" "$(printf '%s\n' "$risk" | sed 's/^/- /')")" >/dev/null 2>&1 || true
  fi
  landed="$(G rev-parse "$(remote_tip)^{tree}")"
  if [ "$landed" = "$tested" ]; then
    echo "merged #$PR; $BRANCH's tree is the tree the quick checks passed"
  else
    echo "batch: merged #$PR, but $BRANCH moved meanwhile, so its tree is not the one checked. The close gate checks it." >&2
  fi
  echo "$BRANCH: $(feature_count)/$MAX features"
  echo "next: merge the next feature PR, or ask the release manager for a slot and run scripts/batch.sh close $NAME"
}

# Merge origin/main into the batch (quick checks, then push). No-op when current.
do_sync() {
  checkout_tip
  local main; main="$(G rev-parse origin/main)"
  if W merge-base --is-ancestor "$main" HEAD; then echo "$BRANCH already contains origin/main ${main:0:9}"; return 0; fi
  W merge -q --no-ff --no-edit -m "batch($NAME): sync origin/main ${main:0:9}" "$main" || { W merge --abort || true; die "origin/main does not merge cleanly into $BRANCH" "open a PR against $BRANCH that merges origin/main and resolves the conflicts, merge it with scripts/batch.sh merge, then sync again"; }
  quick_check || die "quick checks RED after syncing origin/main into $BRANCH — nothing pushed" "the batch and main disagree; fix it in a PR against $BRANCH (the errors are above)"
  W push -q origin "HEAD:refs/heads/$BRANCH" || die "push to $BRANCH refused (it moved?)" "run sync again"
  say "synced: $BRANCH now contains origin/main ${main:0:9}"
}
cmd_sync() { claim; do_sync; }

# The next step, as one line, from the batch's state.
next_step() { # next_step <features> <behind> <open> <batch pr>
  if [ -n "$3" ]; then echo "merge or retarget the open PRs against $BRANCH ($3): scripts/batch.sh merge $NAME <pr>"
  elif [ "$1" -eq 0 ]; then echo "open feature PRs with 'gh pr create --base $BRANCH' and merge them with scripts/batch.sh merge $NAME <pr>"
  elif [ "$2" -gt 0 ]; then echo "scripts/batch.sh sync $NAME (it is $2 commit(s) behind main)"
  else echo "when the batch is complete, ask the release manager for a slot, then scripts/batch.sh close $NAME"; fi
}

cmd_status() {
  local tip n behind open bpr next
  tip="$(remote_tip)"; n="$(feature_count)"; behind="$(G rev-list --count "$tip..origin/main")"
  open="$(open_children)"; bpr="$(batch_pr)"
  next="$(next_step "$n" "$behind" "$open" "$bpr")"
  if [ "$JSON" -eq 1 ]; then
    commits | jq -R -s --arg branch "$BRANCH" --arg tip "$tip" --argjson n "$n" --argjson max "$MAX" \
      --argjson behind "$behind" --arg open "$open" --arg bpr "$bpr" --arg next "$next" --arg packets "$PKT" '
      {branch:$branch, tip:$tip, features:$n, max:$max, behindMain:$behind,
       commits:[split("\n")[]|select(length>0)|{sha:.[0:40], subject:.[41:],
                pr:([.[41:]|capture("^Merge pull request #(?<n>[0-9]+)").n|tonumber]|first)}],
       openPRs:[$open|scan("[0-9]+")|tonumber], batchPR:(try ($bpr|tonumber) catch null),
       packets:$packets, next:$next}'
    return 0
  fi
  echo "$BRANCH at ${tip:0:9}: $n/$MAX features, $behind commit(s) behind origin/main"
  commits | sed 's/^\([0-9a-f]\{9\}\)[0-9a-f]* /  \1 /'
  [ -z "$open" ] || echo "open PRs against it: $open"
  [ -z "$bpr" ] || echo "batch PR: #$bpr"
  echo "next: $next"
}

# Probe each first-parent commit with one gate; find the first red one. Each
# probe's log is kept as $PKT/probe-<sha>.log for the failure packet.
# Prints "<sha> <subject>" of the culprit, or nothing (exit 1) when none is red.
find_culprit() {
  local list=() line lo=0 hi mid sha
  while IFS= read -r line; do list+=("$line"); done < <(commits)
  hi=${#list[@]}   # list[hi-1] is the tip, which the close gate saw red
  [ "$hi" -gt 0 ] || return 1
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(( (lo + hi) / 2 ))
    sha="${list[mid-1]%% *}"
    say "bisect: probing ${sha:0:9} (${mid} of ${#list[@]}) — one full gate" >&2
    if bash "$ROOT/scripts/merge-train.sh" "--gate-ref=$sha" 2>&1 | tee "$PKT/probe-$sha.log" >&2; then lo=$mid; else hi=$mid; fi
  done
  echo "${list[hi-1]}"
}

# The lines of a gate log an agent needs first: failures, then the end.
failure_lines() { # failure_lines <log>
  { grep -E '(FAIL|✗|×|AssertionError|Error:|error TS[0-9]+|RED|MISS)' "$1" | head -60; echo '…'; tail -25 "$1"; } 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'
}

# Write the failure packet for a culprit: what an agent needs to fix it.
write_packet() { # write_packet <sha> <pr> <subject> → path
  local sha="$1" pr="$2" log="$PKT/probe-$1.log" p="$PKT/red-${2:-${1:0:9}}.md"
  [ -f "$log" ] || log="$PKT/close.log"   # the tip itself: the close gate saw it red
  {
    echo "# Red in batch \`$BRANCH\`: ${pr:+#$pr }(${sha:0:9})"
    echo
    echo "Bisection found the first red commit on the batch: \`$3\`."
    echo "Gated as origin/main plus that commit (ADR 0976). Full log: \`$log\`."
    echo
    echo "## What it changed"
    echo '```'
    G diff --stat "$sha^1" "$sha" | tail -40
    echo '```'
    echo
    echo "## Failing lines of the red gate"
    echo '```'
    failure_lines "$log"
    echo '```'
    echo
    echo "## To fix"
    echo "1. Read the failures above, then the full log. A Tracegate MISS is a recorder bug, not this PR's (CLAUDE.md)."
    echo "2. Reproduce one failing test alone on a branch from origin/$BRANCH (the change is reverted there)."
    echo "3. Fix it, open a new PR against \`$BRANCH\`, and merge it with \`scripts/batch.sh merge $NAME <pr>\`."
  } > "$p"
  echo "$p"
}

# Revert the culprit on the batch and tell its PR. Returns 1 if it is not a feature merge.
revert_culprit() {
  local sha="${1%% *}" subj="${1#* }" pr packet
  pr="$(sed -n 's/^Merge pull request #\([0-9]*\) .*/\1/p' <<< "$subj")"
  packet="$(write_packet "$sha" "$pr" "$subj")"
  echo "failure packet: $packet"
  if [ -z "$pr" ]; then
    echo "batch: the first red commit is not a feature merge: ${sha:0:9} $subj" >&2
    echo "next: it is a sync with main or a direct commit, so two changes disagree. Read $packet, fix it in a PR against $BRANCH, merge that, then close again." >&2
    return 1
  fi
  checkout_tip
  W revert --no-edit -m 1 "$sha" >/dev/null || { W revert --abort || true; echo "batch: #$pr does not revert cleanly — later features build on it." >&2; echo "next: fix forward: read $packet, fix it in a PR against $BRANCH, merge that, then close again." >&2; return 1; }
  quick_check || { echo "batch: quick checks RED after reverting #$pr — not pushed" >&2; echo "next: later features depend on #$pr; fix forward from $packet in a PR against $BRANCH." >&2; return 1; }
  W push -q origin "HEAD:refs/heads/$BRANCH" || { echo "batch: push to $BRANCH refused" >&2; echo "next: scripts/batch.sh bisect $NAME" >&2; return 1; }
  gh pr comment "$pr" --body "$(printf 'Reverted from `%s` (ADR 0976): the batch'"'"'s close gate was red, and bisection found the first red commit to be this PR'"'"'s merge (%s). Fix it and open a new PR against `%s` (or `main`).\n\n<details><summary>Failure packet</summary>\n\n%s\n\n</details>\n' "$BRANCH" "${sha:0:9}" "$BRANCH" "$(cat "$packet")")" >/dev/null 2>&1 || true
  say "reverted #$pr from $BRANCH"
}

cmd_bisect() {
  claim
  mkdir -p "$PKT"
  local c; c="$(find_culprit)" || die "no commit on $BRANCH is red on its own — the red was not reproducible (a flake?)." "read the red gate's log; if it is a known flake, close again to re-gate"
  revert_culprit "$c" || exit 1
}

cmd_close() {
  claim
  mkdir -p "$PKT"
  local open bpr rc round=0 c
  open="$(open_children)"
  [ -z "$open" ] || die "PRs still target $BRANCH: $open." "merge them (scripts/batch.sh merge $NAME <pr>) or retarget them to main (gh pr edit <pr> --base main), then close again"
  [ "$(feature_count)" -gt 0 ] || die "$BRANCH has no features to land" "merge feature PRs into it first, or delete the branch if it is abandoned"
  do_sync
  while :; do
    bpr="$(batch_pr)"
    if [ -z "$bpr" ]; then
      bpr="$(gh pr create --base main --head "$BRANCH" --title "batch: $NAME" \
        --body "$(printf 'Batch branch `%s` (ADR 0976): feature PRs merged after quick checks only, gated here once.\n\n%s\n' "$BRANCH" "$(commits | sed 's/^[0-9a-f]* /- /')")" | sed -n 's|.*/pull/\([0-9]*\).*|\1|p')"
      [ -n "$bpr" ] || die "could not open the batch PR" "gh pr create --base main --head $BRANCH, then close again"
    fi
    say "closing $BRANCH through the merge train as #$bpr"
    rc=0; bash "$ROOT/scripts/merge-train.sh" "$bpr" 2>&1 | tee "$PKT/close.log" || rc=${PIPESTATUS[0]}
    if [ "$rc" -eq 0 ]; then
      [ "$(gh pr view "$bpr" --json state --jq .state)" = MERGED ] || die "the train was green but #$bpr is not MERGED" "gh pr view $bpr; do not merge by hand unless main is still the tree the train gated"
      G push -q origin --delete "$BRANCH" 2>/dev/null || echo "batch: could not delete $BRANCH on origin — delete it by hand" >&2
      say "batch $NAME landed on main as #$bpr ($(G rev-parse --short origin/main))"
      echo "next: deploying is a release-queue slot (scripts/deploy.sh from a clean origin/main worktree, DEPLOY.md); then remove $BWT and run npm run packs:prune"
      return 0
    fi
    grep -q 'RED, left open:' "$PKT/close.log" || die "the train failed for another reason (above) — nothing was bisected" "read $PKT/close.log; if main moved or a lock was held, close again"
    round=$((round + 1))
    [ "$round" -le "$ROUNDS" ] || die "still red after $ROUNDS bisect round(s) — stopping (OPENWOP_BATCH_CLOSE_ROUNDS)" "read the packets in $PKT and $PKT/close.log; fix in PRs against $BRANCH, then close again"
    say "close gate RED — bisecting $BRANCH (round $round of $ROUNDS)"
    c="$(find_culprit)" || die "no commit on $BRANCH is red on its own — the red was not reproducible (a flake?)." "read $PKT/close.log; if it is a known flake, close again to re-gate"
    revert_culprit "$c" || exit 1
    [ "$(feature_count)" -gt 0 ] || die "every feature on $BRANCH has been reverted — nothing to land" "read the packets in $PKT"
  done
}

case "$CMD" in
  open) cmd_open ;;
  merge) cmd_merge ;;
  sync) cmd_sync ;;
  status) cmd_status ;;
  close) cmd_close ;;
  bisect) cmd_bisect ;;
  *) usage ;;
esac
