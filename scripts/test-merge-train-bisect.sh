#!/usr/bin/env bash
# ADR 0880 P0 — behaviour test for merge-train.sh's self-bisection.
#
# A throwaway origin with four PRs, one of which (#3) breaks the "gate". A fake
# `gh` merges for real (into the throwaway origin) and a fake `npm run ci` is red
# exactly when the tree contains BREAK. The expected outcome is the one the
# header promises: #1 #2 #4 land, #3 is named and left open, exit 1.
# Then the same trains with --no-bisect: nothing lands.
set -euo pipefail
# ADR 0991 — the scripts under test publish to the real cross-machine release
# bus by default; a test must never write to it.
export OPENWOP_RELEASE_BUS=off
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mt-bisect.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
G() { git -c user.email=t@t -c user.name=t "$@"; }

setup() {
  rm -rf "$TMP/origin.git" "$TMP/repo" "$TMP/repo-train" "$TMP/repo-train.lock" "$TMP/bin"
  G init -q --bare -b main "$TMP/origin.git"
  G clone -q "$TMP/origin.git" "$TMP/repo" 2>/dev/null
  cd "$TMP/repo"
  mkdir -p scripts/lib backend/typescript frontend/react
  cp "$ROOT/scripts/merge-train.sh" scripts/
  cp "$ROOT/scripts/lib/train-lock.sh" scripts/lib/
  if [ "${2:-0}" = 1 ]; then
    cp "$ROOT/scripts/release-freeze.sh" scripts/
  else
    printf '#!/usr/bin/env bash\nexit 0\n' > scripts/release-freeze.sh   # no freeze
  fi
  echo '{}' > backend/typescript/package-lock.json
  echo '{}' > frontend/react/package-lock.json
  [ "${1:-1}" = 0 ] || printf '{"version":1,"preset":"openwop"}\n' > hyvemind.json
  printf 'node_modules/\n' > .gitignore
  echo base > base.txt
  G add -A && G commit -qm base && G push -q origin main
  for n in 1 2 3 4; do
    G checkout -q -b "pr$n" main
    echo "$n" > "f$n.txt"
    [ "$n" = 3 ] && echo boom > BREAK
    G add -A && G commit -qm "pr$n" && G push -q origin "pr$n"
  done
  G checkout -q main
  mkdir -p "$TMP/bin"
  # Simulate a peer pushing after the tested tree was composed. Everything is
  # local: the API double reads this bare origin, not stale tracking refs.
  cat > "$TMP/bin/move-head" <<'FAKE'
#!/usr/bin/env bash
set -e
n="$1"
[ ! -f "$FAKE_DIR/head-moved-$n" ] || exit 0
w="$FAKE_DIR/move-head-worktree"
git clone -q "$FAKE_ORIGIN" "$w" 2>/dev/null
git -C "$w" checkout -q "pr$n"
echo untested > "$w/head-moved-$n.txt"
git -C "$w" add "head-moved-$n.txt"
git -C "$w" -c user.email=t@t -c user.name=t commit -qm 'peer advances PR head'
git -C "$w" push -q origin "pr$n"
touch "$FAKE_DIR/head-moved-$n"
FAKE
  # fake gh: PR n is branch prN; merging it merges for real into the origin.
  cat > "$TMP/bin/gh" <<'FAKE'
#!/usr/bin/env bash
set -e
if [ "$1" = api ]; then
  if [[ "$*" = *enforcement=* ]]; then
    echo "$*" >> "$FAKE_DIR/freeze-updates"
  elif [ "${FAKE_FREEZE:-0}" = 1 ]; then
    printf '%s\n' '[{"id":1,"enforcement":"active","name":"release-freeze | holder=fixture | until=2099-01-01T00:00:00Z | reason=isolated test"}]'
  else
    echo '[]'
  fi
  exit 0
fi
n="$3"
case "$1 $2" in
  "pr view")
    if [ -f "$FAKE_DIR/merged-$n" ]; then st=MERGED; else st=OPEN; fi
    oid=$(git --git-dir="$FAKE_ORIGIN" rev-parse "refs/heads/pr$n")
    case "$*" in
      *headRefName*) printf '%s\tmain\tpr%s\t%s\tfalse\n' "$st" "$n" "$oid" ;;
      *headRefOid*) printf '%s\t%s\n' "$st" "$oid" ;;
      *) echo "$st" ;;
    esac ;;
  "pr merge")
    echo "$n" >> "$FAKE_DIR/merge-requests"
    [ "${FAKE_MOVE_HEAD_AT_MERGE:-0}" != 1 ] || move-head "$n"
    expected=""; shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --match-head-commit) expected="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    actual=$(git --git-dir="$FAKE_ORIGIN" rev-parse "refs/heads/pr$n")
    if [ -n "$expected" ] && [ "$actual" != "$expected" ]; then
      touch "$FAKE_DIR/head-refused-$n"
      echo 'API refused: pull request head changed' >&2
      exit 1
    fi
    w="$FAKE_DIR/mergewt"; rm -rf "$w"
    git clone -q "$FAKE_ORIGIN" "$w" 2>/dev/null
    git -C "$w" -c user.email=t@t -c user.name=t merge -q --no-ff --no-edit -m "Merge pr$n" "origin/pr$n"
    git -C "$w" push -q origin main
    touch "$FAKE_DIR/merged-$n" ;;
esac
FAKE
  # fake npm/npx: installs are a mkdir; `npm run ci` is red iff BREAK is in the tree.
  cat > "$TMP/bin/npm" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  ci*) mkdir -p node_modules; touch node_modules/.package-lock.json ;;
  "run ci")
    echo "fake gate on $(git rev-parse --short HEAD)" >> "$FAKE_DIR/gates"
    [ ! -f BREAK ] || exit 1
    [ "${FAKE_MOVE_HEAD_DURING_GATE:-0}" = 0 ] || move-head "$FAKE_MOVE_HEAD_DURING_GATE" ;;
esac
FAKE
  cat > "$TMP/bin/npx" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  "-y hyvemind@0.2.0 gate")
    echo gate >> "$FAKE_DIR/evidence-calls"
    npm run ci || exit $?
    git rev-parse 'HEAD^{tree}' > "$FAKE_DIR/evidence-tree" ;;
  "-y hyvemind@0.2.0 evidence")
    echo evidence >> "$FAKE_DIR/evidence-calls"
    [ "${FAKE_EVIDENCE_FAIL:-0}" != 1 ] &&
      [ "$(cat "$FAKE_DIR/evidence-tree")" = "$(git rev-parse 'HEAD^{tree}')" ] ;;
  "-y npm@10.9.8 ci") shift 2; exec npm "$@" ;;
  *) echo "unexpected npx invocation: $*" >&2; exit 2 ;;
esac
FAKE
  chmod +x "$TMP/bin/gh" "$TMP/bin/npm" "$TMP/bin/npx" "$TMP/bin/move-head"
  rm -rf "$TMP/fake"; mkdir -p "$TMP/fake"
}

run_train() {
  ( cd "$TMP/repo" && PATH="$TMP/bin:$PATH" FAKE_DIR="$TMP/fake" FAKE_REPO="$TMP/repo" FAKE_ORIGIN="$TMP/origin.git" \
      RELEASE_FREEZE_REPO=fixture/repo OPENWOP_TRAIN_DIR="$TMP/repo-train" bash scripts/merge-train.sh "$@" > "$TMP/out" 2>&1; echo $? )
}
landed() { git -C "$TMP/repo" fetch -q origin; git -C "$TMP/repo" ls-tree --name-only origin/main | tr '\n' ' '; }

echo "▶ merge-train bisection"
setup
rc=$(run_train 1 2 3 4)
[ "$rc" = 1 ] && ok "a train with a red PR exits 1" || bad "exit $rc (want 1): $(tail -5 "$TMP/out")"
files="$(landed)"
for f in f1.txt f2.txt f4.txt; do
  case "$files" in *"$f"*) ok "$f landed (its PR was green)";; *) bad "$f did NOT land — main has: $files";; esac
done
case "$files" in *f3.txt*|*BREAK*) bad "the red PR #3 landed";; *) ok "the red PR #3 did not land";; esac
grep -q 'RED, left open: #3$' "$TMP/out" && ok "it names #3 as the culprit" || bad "culprit not named: $(tail -3 "$TMP/out")"
gates=$(wc -l < "$TMP/fake/gates" | tr -d ' ')
[ "$gates" -le 5 ] && ok "it took $gates gates (≤ 5 for 4 PRs)" || bad "it took $gates gates"
# Every merge kept the invariant: main's tree is the tree that was gated.
grep -q 'is NOT the gated tree' "$TMP/out" && bad "a merge landed an ungated tree" || ok "every merge landed a gated tree"

echo "▶ merge-train --no-bisect"
setup
rc=$(run_train --no-bisect 1 2 3 4)
[ "$rc" = 1 ] && ok "a red train exits 1" || bad "exit $rc"
case "$(landed)" in *f1.txt*|*f2.txt*|*f4.txt*) bad "something landed despite --no-bisect";; *) ok "nothing landed";; esac

echo "▶ merge-train, all green"
setup
rc=$(run_train 1 2 4)
[ "$rc" = 0 ] && ok "a green train exits 0" || bad "exit $rc: $(tail -5 "$TMP/out")"
[ "$(wc -l < "$TMP/fake/gates" | tr -d ' ')" = 1 ] && ok "in exactly one gate" || bad "in $(wc -l < "$TMP/fake/gates") gates"
[ "$(cat "$TMP/fake/evidence-calls" 2>/dev/null)" = $'gate\nevidence' ] && ok "records and checks evidence on the train tree" || bad "the gate bypassed the pinned evidence wrapper"

echo "▶ merge-train, passing CI but rejected evidence"
setup
rc=$(FAKE_EVIDENCE_FAIL=1 run_train --no-bisect 1 2 4)
[ "$rc" = 1 ] && ok "rejected evidence makes the train red" || bad "exit $rc (want 1 for rejected evidence)"
case "$(landed)" in *f1.txt*|*f2.txt*|*f4.txt*) bad "something landed despite rejected evidence";; *) ok "rejected evidence prevents every merge";; esac

echo "▶ merge-train, white-label adopter without Hyvemind configuration"
setup 0
rc=$(run_train 1 2 4)
[ "$rc" = 0 ] && [ "$(wc -l < "$TMP/fake/gates" | tr -d ' ')" = 1 ] && ok "an unconfigured adopter still runs one full CI gate" || bad "adopter gate: rc $rc"
[ ! -e "$TMP/fake/evidence-calls" ] && grep -q 'no Hyvemind record' "$TMP/out" && ok "the adopter result does not claim Hyvemind evidence" || bad "adopter evidence was misreported"

echo "▶ merge-train, a later car advances during the gate"
setup
rc=$(FAKE_MOVE_HEAD_DURING_GATE=2 run_train 1 2)
[ "$rc" = 1 ] && ok "an advanced head stops the train" || bad "advanced-head exit $rc"
[ ! -e "$TMP/fake/merge-requests" ] && ok "all heads are checked before the first merge" || bad "a merge was requested before discovering the later changed head"
case "$(landed)" in *f1.txt*|*f2.txt*|*head-moved*) bad "a changed-head train landed code";; *) ok "main stays unchanged when a later PR head moves";; esac

echo "▶ merge-train, a head races the final check"
setup
rc=$(FAKE_MOVE_HEAD_AT_MERGE=1 run_train 1)
[ "$rc" = 1 ] && [ -f "$TMP/fake/head-refused-1" ] && ok "GitHub's head precondition refuses the race" || bad "head race bypassed API precondition (exit $rc)"
case "$(landed)" in *f1.txt*|*head-moved*) bad "an untested raced head landed";; *) ok "the raced head never reaches main";; esac

echo "▶ merge-train, the legacy helper keeps the same head precondition"
setup 1 1
rc=$(OPENWOP_FREEZE_HOLDER=fixture FAKE_FREEZE=1 FAKE_MOVE_HEAD_AT_MERGE=1 run_train 1)
[ "$rc" = 1 ] && [ -f "$TMP/fake/head-refused-1" ] && ok "the helper forwards the head precondition" || bad "the helper lost the head precondition (exit $rc)"
case "$(landed)" in *f1.txt*|*head-moved*) bad "the helper merged an untested head";; *) ok "the helper also leaves main unchanged";; esac
grep -q 'enforcement=active' "$TMP/fake/freeze-updates" && ok "the isolated helper restores its fixture ruleset after refusal" || bad "the fixture ruleset was not restored"

echo
echo "== merge-train bisect: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
