#!/usr/bin/env bash
# ADR 0880 P0 — behaviour test for merge-train.sh's self-bisection.
#
# A throwaway origin with four PRs, one of which (#3) breaks the "gate". A fake
# `gh` merges for real (into the throwaway origin) and a fake `npm run ci` is red
# exactly when the tree contains BREAK. The expected outcome is the one the
# header promises: #1 #2 #4 land, #3 is named and left open, exit 1.
# Then the same trains with --no-bisect: nothing lands.
set -euo pipefail
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
  printf '#!/usr/bin/env bash\nexit 0\n' > scripts/release-freeze.sh   # no freeze
  echo '{}' > backend/typescript/package-lock.json
  echo '{}' > frontend/react/package-lock.json
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
  # fake gh: PR n is branch prN; merging it merges for real into the origin.
  cat > "$TMP/bin/gh" <<'FAKE'
#!/usr/bin/env bash
set -e
n="$3"
case "$1 $2" in
  "pr view")
    if [ -f "$FAKE_DIR/merged-$n" ]; then st=MERGED; else st=OPEN; fi
    case "$*" in
      *headRefOid*) oid=$(git -C "$FAKE_REPO" rev-parse "origin/pr$n"); printf '%s\tmain\tpr%s\t%s\tfalse\n' "$st" "$n" "$oid" ;;
      *) echo "$st" ;;
    esac ;;
  "pr merge")
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
  "run ci") echo "fake gate on $(git rev-parse --short HEAD)" >> "$FAKE_DIR/gates"; [ ! -f BREAK ] ;;
esac
FAKE
  printf '#!/usr/bin/env bash\nshift 2; exec npm "$@"\n' > "$TMP/bin/npx"
  chmod +x "$TMP/bin/gh" "$TMP/bin/npm" "$TMP/bin/npx"
  mkdir -p "$TMP/fake"; rm -f "$TMP/fake"/merged-* "$TMP/fake/gates"
}

run_train() {
  ( cd "$TMP/repo" && PATH="$TMP/bin:$PATH" FAKE_DIR="$TMP/fake" FAKE_REPO="$TMP/repo" FAKE_ORIGIN="$TMP/origin.git" \
      OPENWOP_TRAIN_DIR="$TMP/repo-train" bash scripts/merge-train.sh "$@" > "$TMP/out" 2>&1; echo $? )
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

echo
echo "== merge-train bisect: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
