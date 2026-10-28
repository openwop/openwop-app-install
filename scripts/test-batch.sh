#!/usr/bin/env bash
# ADR 0976 — behaviour test for scripts/batch.sh (and merge-train.sh --gate-ref).
#
# A throwaway origin with five feature PRs. #3 reds the full gate (it adds BREAK);
# #5 reds the quick checks (it adds QUICKBREAK). A fake `gh` keeps PR state in
# files and merges for real into the throwaway origin; a fake `npm` makes
# `npm run ci` red iff BREAK is in the tree and `npm run ci:quick` red iff
# QUICKBREAK is. Expected: #5 is refused at merge; close is red, bisection names
# #3, reverts it on the batch, writes its failure packet, and the second close
# lands #1 #2 #4 on main. #7 changes a lockfile, so it needs --accept-risk.
set -euo pipefail
# ADR 0991 — the scripts under test publish to the real cross-machine release
# bus by default; a test must never write to it.
export OPENWOP_RELEASE_BUS=off
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/batch-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
G() { git -c user.email=t@t -c user.name=t "$@"; }

setup() {
  rm -rf "$TMP/origin.git" "$TMP/repo" "$TMP"/repo-* "$TMP/bin" "$TMP/fake"
  G init -q --bare -b main "$TMP/origin.git"
  G clone -q "$TMP/origin.git" "$TMP/repo" 2>/dev/null
  cd "$TMP/repo"
  mkdir -p scripts/lib backend/typescript frontend/react
  cp "$ROOT/scripts/merge-train.sh" "$ROOT/scripts/batch.sh" scripts/
  cp "$ROOT/scripts/lib/train-lock.sh" scripts/lib/
  printf '#!/usr/bin/env bash\nexit 0\n' > scripts/release-freeze.sh   # no freeze
  echo '{}' > backend/typescript/package-lock.json
  echo '{}' > frontend/react/package-lock.json
  printf '{"version":1,"preset":"openwop"}\n' > hyvemind.json
  printf 'node_modules/\n' > .gitignore
  echo base > base.txt
  G add -A && G commit -qm base && G push -q origin main
  mkdir -p "$TMP/fake"
  for n in 1 2 3 4 5 7; do
    G checkout -q -b "pr$n" main
    echo "$n" > "f$n.txt"
    [ "$n" = 3 ] && echo boom > BREAK
    [ "$n" = 5 ] && echo boom > QUICKBREAK
    [ "$n" = 7 ] && echo '{"v":7}' > backend/typescript/package-lock.json
    G add -A && G commit -qm "pr$n" && G push -q origin "pr$n"
    printf 'pr%s\tmain\tOPEN\n' "$n" > "$TMP/fake/pr-$n"   # head, base, state
  done
  G checkout -q main
  mkdir -p "$TMP/bin"
  cat > "$TMP/bin/gh" <<'FAKE'
#!/usr/bin/env bash
# A fake `gh pr …` over files: $FAKE_DIR/pr-N holds "head<TAB>base<TAB>state".
set -e
[ "$1" = pr ] || exit 1
sub="$2"; shift 2
get() { IFS=$'\t' read -r head base state < "$FAKE_DIR/pr-$1"; }
put() { printf '%s\t%s\t%s\n' "$2" "$3" "$4" > "$FAKE_DIR/pr-$1"; }
opt() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
case "$sub" in
  view)
    n="$1"; get "$n"
    case "$*" in
      *headRefName*) printf '%s\t%s\t%s\t%s\tfalse\n' "$state" "$base" "$head" "$(git -C "$FAKE_ORIGIN" rev-parse "refs/heads/$head")" ;;
      *headRefOid*) printf '%s\t%s\n' "$state" "$(git -C "$FAKE_ORIGIN" rev-parse "refs/heads/$head")" ;;
      *) echo "$state" ;;
    esac ;;
  edit) n="$1"; get "$n"; put "$n" "$head" "$(opt --base "$@")" "$state" ;;
  merge)
    n="$1"; get "$n"
    w="$FAKE_DIR/mergewt"; rm -rf "$w"
    git clone -q "$FAKE_ORIGIN" "$w" 2>/dev/null
    git -C "$w" checkout -q "$base"
    git -C "$w" -c user.email=t@t -c user.name=t merge -q --no-ff --no-edit -m "Merge pull request #$n from t/$head" "origin/$head"
    git -C "$w" push -q origin "$base"
    put "$n" "$head" "$base" MERGED ;;
  list)
    b="$(opt --base "$@")"; h="$(opt --head "$@")"
    for f in "$FAKE_DIR"/pr-*; do
      n="${f##*-}"; get "$n"
      [ "$state" = OPEN ] && [ "$base" = "$b" ] && { [ -z "$h" ] || [ "$head" = "$h" ]; } && echo "$n"
    done | sort -n | { case "$*" in *'.[0]'*) head -1 ;; *) cat ;; esac; } ;;
  create)
    n=100; while [ -f "$FAKE_DIR/pr-$n" ]; do n=$((n + 1)); done
    put "$n" "$(opt --head "$@")" "$(opt --base "$@")" OPEN
    echo "https://github.example/o/r/pull/$n" ;;
  comment) echo "#$1: $(opt --body "$@")" >> "$FAKE_DIR/comments" ;;
esac
FAKE
  cat > "$TMP/bin/npm" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  ci*) mkdir -p node_modules; touch node_modules/.package-lock.json ;;
  "run ci") echo "gate $(git rev-parse --short HEAD)" >> "$FAKE_DIR/gates"; [ ! -f BREAK ] || { echo "FAIL test/break.test.ts > BREAK is present"; exit 1; } ;;
  "run ci:quick") echo "quick $(git rev-parse --short HEAD)" >> "$FAKE_DIR/quick"; [ ! -f QUICKBREAK ] ;;
esac
FAKE
  # Exercise the same CI result through the pinned evidence wrapper. Unknown
  # commands fail closed so a new wrapper cannot silently bypass the red fixture.
  cat > "$TMP/bin/npx" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  "-y hyvemind@0.2.0 gate")
    npm run ci || exit $?
    git rev-parse 'HEAD^{tree}' > "$FAKE_DIR/evidence-tree" ;;
  "-y hyvemind@0.2.0 evidence")
    [ "$(cat "$FAKE_DIR/evidence-tree")" = "$(git rev-parse 'HEAD^{tree}')" ] ;;
  "-y npm@10.9.8 ci") shift 2; exec npm "$@" ;;
  *) echo "unexpected npx invocation: $*" >&2; exit 2 ;;
esac
FAKE
  chmod +x "$TMP/bin/gh" "$TMP/bin/npm" "$TMP/bin/npx"
}

batch() {
  ( cd "$TMP/repo" && PATH="$TMP/bin:$PATH" FAKE_DIR="$TMP/fake" FAKE_ORIGIN="$TMP/origin.git" \
      OPENWOP_TRAIN_DIR="$TMP/repo-train" OPENWOP_BATCH_DIR="$TMP/repo-batch" \
      bash scripts/batch.sh "$@" > "$TMP/out" 2>&1; echo $? )
}
files() { git -C "$TMP/repo" fetch -q --prune origin; git -C "$TMP/repo" ls-tree --name-only "origin/$1" | tr '\n' ' '; }
state() { cut -f3 "$TMP/fake/pr-$1"; }
count() { [ -f "$TMP/fake/$1" ] && wc -l < "$TMP/fake/$1" | tr -d ' ' || echo 0; }

echo "▶ batch: open, merge after quick checks only"
setup
rc=$(batch open feat)
[ "$rc" = 0 ] && git -C "$TMP/repo" ls-remote --exit-code -q origin batch/feat >/dev/null && ok "open creates batch/feat on origin" || bad "open: rc $rc $(tail -3 "$TMP/out")"
[ "$(batch open feat)" = 1 ] && ok "opening it twice is refused" || bad "a second open was accepted"
for n in 1 2 3 4; do
  rc=$(batch merge feat "$n")
  [ "$rc" = 0 ] && [ "$(state "$n")" = MERGED ] || bad "merge #$n: rc $rc state $(state "$n"): $(tail -3 "$TMP/out")"
done
[ "$(state 1)$(state 2)$(state 3)$(state 4)" = MERGEDMERGEDMERGEDMERGED ] && ok "#1–#4 merged into the batch (retargeted from main)" || true
[ "$(cut -f2 "$TMP/fake/pr-1")" = batch/feat ] && ok "a PR against main is retargeted to the batch" || bad "#1 base is $(cut -f2 "$TMP/fake/pr-1")"
grep -q '^next: merge the next feature PR' "$TMP/out" && ok "a merge ends with a next: line" || bad "no next: line after a merge"
[ "$(count gates)" = 0 ] && ok "no full gate ran for any merge" || bad "$(count gates) gates ran during merges"
[ "$(count quick)" = 4 ] && ok "one quick check per merge" || bad "$(count quick) quick checks for 4 merges"
case "$(files main)" in *f1.txt*) bad "a batch merge reached main";; *) ok "main is untouched";; esac
rc=$(batch merge feat 5)
grep -q '^next: fix the failures printed above' "$TMP/out" && ok "a quick-check red says what to do next" || bad "no next: after a quick-check red"
[ "$rc" = 1 ] && [ "$(state 5)" = OPEN ] && [ "$(cut -f2 "$TMP/fake/pr-5")" = main ] && ok "a PR that reds the quick checks is refused and left open, against main" || bad "#5: rc $rc $(cat "$TMP/fake/pr-5")"
case "$(files batch/feat)" in *QUICKBREAK*) bad "#5 reached the batch";; *) ok "#5 did not reach the batch";; esac

echo "▶ batch: the cap"
rc=$(OPENWOP_BATCH_MAX=4 batch merge feat 5)
[ "$rc" = 1 ] && grep -q 'already holds 4' "$TMP/out" && ok "a fifth feature is refused under OPENWOP_BATCH_MAX=4" || bad "cap: rc $rc $(tail -2 "$TMP/out")"

echo "▶ batch: close refuses while a PR still targets the batch"
G -C "$TMP/repo" push -q origin main:pr6 2>/dev/null; printf 'pr6\tbatch/feat\tOPEN\n' > "$TMP/fake/pr-6"
rc=$(batch close feat)
[ "$rc" = 1 ] && grep -q 'PRs still target batch/feat: #6\.' "$TMP/out" && ok "close names the open PR #6 and stops" || bad "close with an open child: rc $rc $(tail -2 "$TMP/out")"
printf 'pr6\tbatch/feat\tCLOSED\n' > "$TMP/fake/pr-6"

echo "▶ batch: main moves, sync brings it in"
( cd "$TMP/repo" && echo later > later.txt && G add later.txt && G commit -qm later && G push -q origin main )
rc=$(batch sync feat)
case "$(files batch/feat)" in *later.txt*) ok "sync merged origin/main into the batch";; *) bad "sync: rc $rc $(tail -3 "$TMP/out")";; esac

echo "▶ batch: a red close bisects, reverts the culprit and lands the rest"
: > "$TMP/fake/gates"
rc=$(batch close feat)
[ "$rc" = 0 ] && ok "close exits 0 once the culprit is reverted" || bad "close: rc $rc: $(tail -8 "$TMP/out")"
m="$(files main)"
for f in f1.txt f2.txt f4.txt later.txt; do case "$m" in *"$f"*) ok "$f is on main";; *) bad "$f is NOT on main — main has: $m";; esac; done
case "$m" in *BREAK*|*f3.txt*) bad "the red feature #3 reached main";; *) ok "#3 did not reach main";; esac
grep -q '^#3: Reverted from `batch/feat`' "$TMP/fake/comments" 2>/dev/null && ok "#3 is told it was reverted, and why" || bad "no revert comment on #3"
pk="$TMP/repo/.git/batch/feat/red-3.md"
[ -f "$pk" ] && grep -q '## Failing lines of the red gate' "$pk" && grep -q '^FAIL test/break.test.ts > BREAK is present' "$pk" && ok "a failure packet for #3 names its change and the red gate's lines" || bad "no usable packet at $pk"
grep -q 'Failure packet' "$TMP/fake/comments" && ok "the packet is posted on #3" || bad "the packet is not on #3"
g=$(count gates)
[ "$g" -le 5 ] && ok "it took $g full gates (close red + ≤ 3 probes + close green)" || bad "it took $g gates"
grep -q 'is NOT the gated tree' "$TMP/out" && bad "main got an ungated tree" || ok "main's tree is the tree the train gated"
git -C "$TMP/repo" ls-remote --exit-code -q origin batch/feat >/dev/null 2>&1 && bad "batch/feat was not deleted" || ok "batch/feat is deleted after it landed"

echo "▶ batch: a risky PR needs an explicit judgment"
setup
batch open b2 >/dev/null; batch merge b2 1 >/dev/null; batch merge b2 2 >/dev/null
rc=$(batch merge b2 7)
[ "$rc" = 1 ] && [ "$(state 7)" = OPEN ] && grep -q 'dependencies: backend/typescript/package-lock.json' "$TMP/out" && ok "a lockfile change is refused, naming the risk" || bad "risk: rc $rc state $(state 7): $(tail -3 "$TMP/out")"
grep -q '^next: .*--accept-risk=' "$TMP/out" && ok "...and next: says how to accept it or gate it alone" || bad "no next: for the risk"
[ "$(count quick)" = 2 ] && ok "...before spending a quick check on it" || bad "$(count quick) quick checks"
rc=$(batch merge b2 7 '--accept-risk=pins one dev dependency; no runtime code reads it')
[ "$rc" = 0 ] && [ "$(state 7)" = MERGED ] && ok "with --accept-risk it merges" || bad "accepted: rc $rc $(tail -3 "$TMP/out")"
grep -q '^#7: Merged into `batch/b2` on quick checks only, with the risk accepted' "$TMP/fake/comments" && grep -q 'pins one dev dependency' "$TMP/fake/comments" && ok "...and the reason is posted on the PR" || bad "no risk comment on #7"

echo "▶ batch: status --json is the machine-readable state"
( cd "$TMP/repo" && PATH="$TMP/bin:$PATH" FAKE_DIR="$TMP/fake" FAKE_ORIGIN="$TMP/origin.git" bash scripts/batch.sh status b2 --json ) > "$TMP/st.json" 2>"$TMP/out" || true
jq -e '.branch=="batch/b2" and .features==3 and .max==10 and ([.commits[].pr|select(.!=null)]==[1,2,7]) and (.commits|length)==3 and .openPRs==[] and (.next|test("close b2"))' "$TMP/st.json" >/dev/null && ok "it lists the features by PR, and next is close" || bad "status --json: $(cat "$TMP/st.json") $(tail -2 "$TMP/out")"

echo "▶ batch: an all-green close is one gate"
: > "$TMP/fake/gates"
rc=$(batch close b2)
[ "$rc" = 0 ] && [ "$(count gates)" = 1 ] && ok "three features, one gate, landed" || bad "rc $rc, $(count gates) gates: $(tail -4 "$TMP/out")"
case "$(files main)" in *f1.txt*f2.txt*f7.txt*) ok "all three features are on main";; *) bad "main has: $(files main)";; esac
grep -q '^next: deploying is a release-queue slot' "$TMP/out" && ok "close ends with the deploy and cleanup steps, and does not deploy" || bad "no next: after close"

echo "▶ merge-train --gate-ref"
setup
( cd "$TMP/repo" && PATH="$TMP/bin:$PATH" FAKE_DIR="$TMP/fake" OPENWOP_TRAIN_DIR="$TMP/repo-train" bash scripts/merge-train.sh "--gate-ref=origin/pr1" > "$TMP/out" 2>&1 ) && grep -q 'probe GREEN' "$TMP/out" && ok "a green probe exits 0" || bad "green probe: $(tail -3 "$TMP/out")"
( cd "$TMP/repo" && PATH="$TMP/bin:$PATH" FAKE_DIR="$TMP/fake" OPENWOP_TRAIN_DIR="$TMP/repo-train" bash scripts/merge-train.sh "--gate-ref=origin/pr3" > "$TMP/out" 2>&1 ) && bad "a red probe exited 0" || { grep -q 'probe RED' "$TMP/out" && ok "a red probe exits 1"; }
[ "$(state 1)$(state 3)" = OPENOPEN ] && case "$(files main)" in *f1.txt*|*f3.txt*) bad "a probe merged something";; *) ok "a probe merges nothing";; esac

echo
echo "== batch: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
