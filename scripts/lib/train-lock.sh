# train-lock.sh — the merge-train worktree lock (sourced; defines one function).
#
# `merge-train.sh` builds every train in ONE worktree per clone
# (`<checkout>-train`), shared by every session on the machine. Nothing used to
# stop a second train from checking out over a running one, and when that
# happened the first gate tested the second train's tree, so its verdict meant
# nothing. MEASURED twice on 2026-10-05: the first voided a gate that had been
# fully green after 2.5 h, and the second happened hours after a memory note
# said "check for a peer train first". A note did not stop it. This does.
#
#   claim_train_lock <lock-dir> <description>
#
# `mkdir` is atomic, so exactly one claimant wins. The winner writes its PID,
# the description (the PRs) and a UTC timestamp to `<lock-dir>/owner`, and
# removes the lock on EXIT. A loser reads the owner:
#   - a LIVE pid → prints who holds it and returns 1 (refuse, never wait);
#   - a DEAD pid or an unreadable owner → the lock is stale (a killed train),
#     so it is reclaimed once and the claim retried.
claim_train_lock() {
  local lock="$1" desc="$2" pid="" prs="" since=""
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n%s\n%s\n' "$$" "$desc" "$(date -u +%FT%TZ)" > "$lock/owner"
    # shellcheck disable=SC2064 # expand $lock now: the trap must remove THIS lock
    trap "rm -rf '$lock'" EXIT
    return 0
  fi
  { read -r pid; read -r prs; read -r since; } < "$lock/owner" 2>/dev/null || true
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "merge-train: another train holds ${lock%.lock} — pid $pid, PRs ${prs:-?}, since ${since:-?}." >&2
    echo "             Its gate is running in that worktree; starting here would void it." >&2
    echo "             Wait for it, or add your PRs to the next train." >&2
    return 1
  fi
  echo "merge-train: reclaiming a stale lock (pid ${pid:-?} is not running)" >&2
  rm -rf "$lock"
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n%s\n%s\n' "$$" "$desc" "$(date -u +%FT%TZ)" > "$lock/owner"
    # shellcheck disable=SC2064
    trap "rm -rf '$lock'" EXIT
    return 0
  fi
  echo "merge-train: lost the race for ${lock} to another train — run again after it." >&2
  return 1
}
