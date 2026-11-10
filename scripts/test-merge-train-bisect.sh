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
  cp "$ROOT/scripts/lib/remote-gate-train.sh" scripts/lib/
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
  ci*) mkdir -p node_modules; touch node_modules/.package-lock.json; echo "ci $PWD" >> "$FAKE_DIR/installs" ;;
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

echo "▶ merge-train, root dependencies (missing, unchanged, changed)"
# The root installed only when node_modules was MISSING, so a root devDependency
# (#5586, tracegate-ci) never reached a train worktree that already had one.
setup
( cd "$TMP/repo" && echo '{"v":1}' > package-lock.json && G add package-lock.json && G commit -qm "root lock" && G push -q origin main
  G checkout -q -b pr5 main && echo '{"v":2}' > package-lock.json && G add package-lock.json && G commit -qm pr5 && G push -q origin pr5
  G checkout -q main ) >/dev/null 2>&1
rc=$(run_train 1)
[ "$rc" = 0 ] && grep -q 'repo-train$' "$TMP/fake/installs" && ok "a train with no root node_modules installs the root" || bad "no root install on first train (rc $rc): $(cat "$TMP/fake/installs" 2>/dev/null)"
: > "$TMP/fake/installs"; sleep 1.1
rc=$(run_train 2)
[ "$rc" = 0 ] && ! grep -q 'repo-train$' "$TMP/fake/installs" && ok "  ...a rebuild that rewrites the same root lockfile does not reinstall" || bad "root reinstalled on an unchanged lockfile (rc $rc)"
: > "$TMP/fake/installs"; sleep 1.1
rc=$(run_train 5)
[ "$rc" = 0 ] && grep -q 'repo-train$' "$TMP/fake/installs" && ok "  ...a PR that changes the root lockfile reinstalls the root" || bad "a changed root lockfile was NOT reinstalled (rc $rc): $(cat "$TMP/fake/installs" 2>/dev/null)"

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

echo "▶ merge-train, a car that cannot be merged says WHY (git's own reason)"
# No git identity (a fresh machine, the remote gate VM before 2026-11-02): the
# train's local merge fails, and merge-train used to call that "does not merge
# cleanly ... Rebase it". useConfigOnly makes git refuse a guessed identity on
# every machine, so this case cannot pass on a host whose hostname yields one.
setup
rc=$(env -u EMAIL -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true \
  bash -c "$(declare -f run_train); TMP='$TMP'; run_train --dry-run 1")
[ "$rc" = 1 ] && ok "a train whose merge git refuses exits 1" || bad "no-identity exit $rc (want 1)"
grep -q 'did not merge onto main.*git said:.*\(email\|identity\|who you are\)' "$TMP/out" \
  && ok "...and prints git's own reason (no identity), not a guess" || bad "git's reason missing: $(tail -3 "$TMP/out")"
grep -q 'Rebase it' "$TMP/out" && bad "...but still told the author to rebase a car with no conflict" || ok "...and does not say 'Rebase it' when nothing conflicts"

# A real conflict keeps the rebase advice.
setup
( cd "$TMP/repo" && G checkout -q -b pr5 main && echo conflict > f1.txt && G add -A && G commit -qm pr5 && G push -q origin pr5 && G checkout -q main )
rc=$(run_train --dry-run 1 5)
[ "$rc" = 1 ] && grep -q '#5 did not merge onto main.*CONFLICT' "$TMP/out" && grep -q 'Rebase it' "$TMP/out" \
  && ok "a real conflict names it and keeps 'Rebase it'" || bad "conflict report: rc $rc, $(tail -3 "$TMP/out")"

# ── ADR 0863 D9 P6: remote first ─────────────────────────────────────────────
# A fake PINNED controller (<config>/install/<policy>/remote-gate.mjs) scripts the
# remote outcome; the fake `npm run ci` counts every LOCAL gate.
remote_setup() {
  local conf="$TMP/ociconf"; rm -rf "$conf"; mkdir -p "$conf/install/p0"
  printf '{"policySha256":"p0"}\n' > "$conf/runner.json"
  cat > "$conf/install/p0/remote-gate.mjs" <<'FAKE'
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2); const arg = n => a[a.indexOf(n) + 1];
const repo = arg('--repo'); const mode = process.env.FAKE_REMOTE || 'green';
appendFileSync(process.env.FAKE_DIR + '/remote-calls', mode + '\n');
const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const out = o => { console.log(JSON.stringify(o)); };
if (mode === 'green' || mode === 'tamper') {
  writeFileSync(arg('--accept-out'), JSON.stringify({ requestId: 'r1', commit, tree: mode === 'tamper' ? '0'.repeat(40) : tree }));
  out({ verdict: 'green', id: 'r1', accepted: { requestId: 'r1', commit, tree } }); process.exit(0);
}
if (mode === 'red') { out({ verdict: 'red', id: 'r2', reason: 'remote gate failed', log: '/tmp/fake-remote.log' }); process.exit(1); }
out({ verdict: 'fallback', reason: mode === 'busy' ? 'worker busy' : 'remote gate disabled (fallback-test)' }); process.exit(3);
FAKE
}
remote_train() { OPENWOP_REMOTE_GATE=1 OPENWOP_CI_CONFIG_DIR="$TMP/ociconf" run_train "$@"; }
gates_local() { [ -f "$TMP/fake/gates" ] && wc -l < "$TMP/fake/gates" | tr -d ' ' || echo 0; }

echo "▶ merge-train remote-first: green on the remote gate merges with no local gate"
setup; remote_setup
rc=$(FAKE_REMOTE=green remote_train 1 2 4)
[ "$rc" = 0 ] && ok "a remote-green train exits 0" || bad "remote green exit $rc: $(tail -4 "$TMP/out")"
case "$(landed)" in *f1.txt*f2.txt*f4.txt*) ok "...and its PRs landed";; *) bad "remote green did not land: $(landed)";; esac
[ "$(gates_local)" = 0 ] && ok "...without any local gate" || bad "a local gate ran after a remote green ($(gates_local))"
grep -q 'gate ran on: remote openwop-ci-gate' "$TMP/out" && ok "...and the log says where it ran" || bad "no 'gate ran on: remote' line"
common="$(cd "$TMP/repo" && cd "$(git rev-parse --git-common-dir)" && pwd)"
if find "$TMP/repo-train" -name 'train-*.json' -not -path '*/node_modules/*' | grep -q . ; then bad "an acceptance record sits INSIDE the train worktree"
elif ls "$common"/remote-gate/train-*.json >/dev/null 2>&1; then ok "...and the acceptance record lives in the git common dir, outside the train worktree"
else bad "no acceptance record in $common/remote-gate"; fi

echo "▶ merge-train remote-first: a remote red is final (no local gate, no bisection)"
setup; remote_setup
rc=$(FAKE_REMOTE=red remote_train 1 2 4)
[ "$rc" = 1 ] && ok "a remote-red train exits 1" || bad "remote red exit $rc"
[ "$(gates_local)" = 0 ] && ok "...with no local second chance (no bisection halves)" || bad "a remote red was re-gated locally ($(gates_local) gates)"
case "$(landed)" in *f1.txt*|*f2.txt*|*f4.txt*) bad "something landed after a remote red";; *) ok "...and nothing landed";; esac
grep -q 'RED on the remote gate' "$TMP/out" && ok "...and it says the red was the remote gate's" || bad "remote red not named"

echo "▶ merge-train remote-first: a busy VM falls back to the local gate at once"
setup; remote_setup
rc=$(FAKE_REMOTE=busy remote_train 1 2 4)
[ "$rc" = 0 ] && [ "$(gates_local)" = 1 ] && ok "busy → one local gate decided, and the train landed" || bad "busy fallback: rc $rc, $(gates_local) local gates"
grep -q 'remote fallback: busy (held by' "$TMP/out" && ok "...and the log says busy, naming the holder (or that it is unknown)" || bad "busy fallback not reported: $(grep -i fallback "$TMP/out")"

echo "▶ merge-train remote-first: the disabled flag (the real-fallback drill) gates locally"
setup; remote_setup
rc=$(FAKE_REMOTE=disabled remote_train 1 2 4)
[ "$rc" = 0 ] && [ "$(gates_local)" = 1 ] && grep -q 'remote fallback: remote gate disabled' "$TMP/out" \
  && ok "a disabled VM is a fallback, and the local gate decides" || bad "disabled fallback: rc $rc, $(gates_local) local gates"

echo "▶ merge-train remote-first: an acceptance record that does not match the train refuses the merge"
setup; remote_setup
rc=$(FAKE_REMOTE=tamper remote_train 1 2 4)
[ "$rc" = 1 ] && grep -q 'does not match this train (tree)' "$TMP/out" && ok "a mismatched record refuses the merge" || bad "tampered record: rc $rc, $(tail -3 "$TMP/out")"
case "$(landed)" in *f1.txt*|*f2.txt*|*f4.txt*) bad "a train with a mismatched acceptance record landed";; *) ok "...and nothing landed";; esac

echo "▶ merge-train remote-first: no pinned controller is a fallback; off by default"
setup; remote_setup; rm -rf "$TMP/ociconf/install"
rc=$(FAKE_REMOTE=green remote_train 1 2 4)
[ "$rc" = 0 ] && [ "$(gates_local)" = 1 ] && grep -q 'remote fallback: no pinned controller' "$TMP/out" && ok "no pinned install → local gate" || bad "missing install: rc $rc"
setup; remote_setup
rc=$(FAKE_REMOTE=green OPENWOP_CI_CONFIG_DIR="$TMP/ociconf" run_train 1 2 4)
[ ! -e "$TMP/fake/remote-calls" ] && [ "$(gates_local)" = 1 ] && ok "without OPENWOP_REMOTE_GATE=1 the remote gate is never called" || bad "the remote gate ran while switched off"

echo
echo "== merge-train bisect: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
