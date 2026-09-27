#!/usr/bin/env bash
#
# GATE-5: the hand-probes that found GATE-1 and GATE-4, kept as assertions.
#
# Four defects shipped in the merge-gate tooling, every one of them passing
# `bash -n` and review. They surfaced only by RUNNING THE FAILURE CASE — stubbing
# lsof, replicating the npm process tree. Probes run once and discarded protect
# nothing, so they live here and run in the composite gate.
#
# Fast by construction: no build, no browser, no tsc. Seconds, not minutes.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/gate-ports.sh
. "$ROOT/scripts/lib/gate-ports.sh"

# Pick the probe ports DYNAMICALLY. Hardcoding them would put a port collision
# into the merge gate itself — two sessions running `npm run ci` at once would
# fight over the same number and one would go red for no reason. That is the
# exact class of defect these tests exist to pin, so it would be a poor thing to
# introduce while pinning it.
OCC_PORT="$(gate_pick_free_port 45771)" || { echo "no free probe port" >&2; exit 1; }
SRV_PORT="$(gate_pick_free_port $((OCC_PORT + 1)))" || { echo "no free probe port" >&2; exit 1; }
FREE_PORT="$(gate_pick_free_port $((SRV_PORT + 1)))" || { echo "no free probe port" >&2; exit 1; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ✗ $1" >&2; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi; }

echo "== gate tooling tests =="

# ---------------------------------------------------------------- GATE-4
# `lsof` unusable must be REFUSED, never read as "every port is free".
(
  lsof() { return 127; }          # simulate lsof absent / permission-denied
  command() { return 1; }         # ...and absent from PATH
  gate_require_lsof >/dev/null 2>&1
) && bad "gate_require_lsof accepts an unusable lsof" \
   || ok "gate_require_lsof REFUSES an unusable lsof (GATE-4)"

# The defect itself: with lsof broken, does the picker hand back an OCCUPIED port?
python3 -c "
import socket,time,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(1); time.sleep(30)
" "$OCC_PORT" >/dev/null 2>&1 &
OCCUPANT=$!
for _ in $(seq 1 20); do gate_port_in_use "$OCC_PORT" && break; sleep 0.2; done

check "$(gate_port_in_use "$OCC_PORT" && echo busy || echo free)" "busy" \
  "gate_port_in_use SEES a real listener"

# With a working lsof the picker must SKIP the occupied port.
picked="$(gate_pick_free_port "$OCC_PORT")"
if [ "$picked" != "$OCC_PORT" ]; then ok "gate_pick_free_port skips an occupied port (picked $picked)"
else bad "gate_pick_free_port returned the OCCUPIED port $OCC_PORT"; fi

# ---------------------------------------------------------------- GATE-1
# Ancestry must be walked, not peeked one level: the real chain is
# subshell -> npm -> server, so the listener is a GRANDCHILD.
TMPD="$(mktemp -d)"
trap 'kill "$OCCUPANT" 2>/dev/null; rm -rf "$TMPD"' EXIT
cat > "$TMPD/package.json" <<'JSON'
{"name":"gate-shape","private":true,"scripts":{"dev":"node srv.js"}}
JSON
cat > "$TMPD/srv.js" <<'JS'
require('node:http').createServer((_, r) => r.end('ok')).listen(Number(process.env.SRV_PORT));
setTimeout(() => process.exit(0), 30000);
JS
( cd "$TMPD" && SRV_PORT="$SRV_PORT" npm run dev >/dev/null 2>&1 ) &
WEB_PID=$!
for _ in $(seq 1 60); do gate_port_in_use "$SRV_PORT" && break; sleep 0.25; done

if gate_assert_port_owned_by "$SRV_PORT" "$WEB_PID" >/dev/null 2>&1; then
  ok "gate_assert_port_owned_by ACCEPTS our own grandchild server (GATE-1)"
else
  bad "gate_assert_port_owned_by REFUSED our own server — the GATE-1 regression"
fi

# NEGATIVE CONTROL. Without this, "it accepts our server" proves nothing: a
# function that always returns 0 would pass the test above.
if gate_assert_port_owned_by "$OCC_PORT" "$WEB_PID" >/dev/null 2>&1; then
  bad "gate_assert_port_owned_by VOUCHED for a foreign listener"
else
  ok "gate_assert_port_owned_by REFUSES a foreign listener (negative control)"
fi

# Nothing listening at all is a refusal, not a silent pass.
if gate_assert_port_owned_by "$FREE_PORT" "$WEB_PID" >/dev/null 2>&1; then
  bad "gate_assert_port_owned_by passed with NO listener"
else
  ok "gate_assert_port_owned_by refuses when nothing is listening"
fi

pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null
kill "$OCCUPANT" 2>/dev/null

# ── ADR numbering (DEBT-4) ────────────────────────────────────────────────────
# `--next` must return MAX + 1, never the first GAP. The first implementation
# returned 0090 — a hole left by an old renumber — which would attach a brand-new
# decision to a number historical citations may still point at. Fixture repo, so
# this asserts the RULE rather than today's real ADR count.
ADRT="$(mktemp -d)"
mkdir -p "$ADRT/docs/adr" "$ADRT/scripts"
cp "$ROOT/scripts/check-adr-refs.mjs" "$ADRT/scripts/"
# A deliberate GAP at 0002 plus a high number: max+1 must win over the gap.
: > "$ADRT/docs/adr/0001-first.md"
: > "$ADRT/docs/adr/0003-third.md"
: > "$ADRT/docs/adr/0009-ninth.md"
NEXT="$( cd "$ADRT" && node scripts/check-adr-refs.mjs --next 2>/dev/null )"
if [ "$NEXT" = "0010" ]; then
  ok "check-adr-refs --next returns MAX+1 (0010), not the 0002 gap"
else
  bad "check-adr-refs --next returned '$NEXT' — expected 0010 (max+1, gaps stay holes)"
fi

RES="$( cd "$ADRT" && node scripts/check-adr-refs.mjs --reserve my-decision 2>/dev/null )"
if [ -f "$ADRT/docs/adr/0010-my-decision.md" ]; then
  ok "check-adr-refs --reserve creates the placeholder at the reserved number"
else
  bad "check-adr-refs --reserve did not create docs/adr/0010-my-decision.md ($RES)"
fi

NEXT2="$( cd "$ADRT" && node scripts/check-adr-refs.mjs --next 2>/dev/null )"
if [ "$NEXT2" = "0011" ]; then
  ok "a reservation is VISIBLE to the next --next (0011)"
else
  bad "--next returned '$NEXT2' after reserving 0010 — the reservation did not take"
fi

# A malformed slug must be refused, not turned into a junk filename.
if ( cd "$ADRT" && node scripts/check-adr-refs.mjs --reserve "Bad Slug!" >/dev/null 2>&1 ); then
  bad "--reserve accepted a non-kebab slug"
else
  ok "--reserve refuses a non-kebab slug"
fi
rm -rf "$ADRT"

# A RENUMBER MUST BE VISIBLE TO `--next`. The fixture above is not a git repo, so
# it exercises only the directory-listing fallback — which is exactly why the
# rename blindness survived it. This one is a REAL repo with a REAL `git mv` on a
# branch the working tree is not on, i.e. the shape a peer's renumber actually
# has. Against `--diff-filter=A` it returns 0002; the number in use is 0005.
ADRG="$(mktemp -d)"
mkdir -p "$ADRG/docs/adr" "$ADRG/scripts"
cp "$ROOT/scripts/check-adr-refs.mjs" "$ADRG/scripts/"
(
  cd "$ADRG" || exit 1
  git init -q -b main .
  git config user.email t@example.com; git config user.name T
  # Real content: rename detection is a SIMILARITY score, and an empty file gives
  # git nothing to score. A faithful renumber of a real ADR scores ~R098 — the
  # case that was invisible — so the fixture has to look like one.
  printf '# ADR 0001

Status: Proposed

%s
' "$(head -c 400 < /dev/zero | tr '\0' 'x')" > docs/adr/0001-first.md
  git add -A >/dev/null; git commit -qm 'adr 0001'
  git checkout -q -b peer
  git mv docs/adr/0001-first.md docs/adr/0005-first.md
  sed -i.bak 's/ADR 0001/ADR 0005/' docs/adr/0005-first.md && rm -f docs/adr/0005-first.md.bak
  git add -A >/dev/null; git commit -qm 'renumber 0001 -> 0005'
  git checkout -q main        # the working tree now holds 0001 ONLY
) >/dev/null 2>&1
NEXTR="$( cd "$ADRG" && node scripts/check-adr-refs.mjs --next 2>/dev/null )"
if [ "$NEXTR" = "0006" ]; then
  ok "check-adr-refs --next sees a RENUMBER on a peer branch (0006)"
else
  bad "--next returned '$NEXTR' — a git-mv renumber to 0005 is invisible, expected 0006"
fi
# And the old number STAYS USED: holes are holes, so a freed number must not be
# handed out again to a decision old citations may still point at.
HOLE="$( cd "$ADRG" && node scripts/check-adr-refs.mjs --next 2>/dev/null )"
check "$HOLE" "0006" "a renumber's vacated number is NOT recycled"
rm -rf "$ADRG"

# ---------------------------------------------------------------- ENTRY-GUARD
# `isEntryModule` + `check-entry-guard.mjs` (#3070 class).
#
# The cases are run against a REAL symlink and a REAL spaced path, because the
# whole defect was a belief about what Node produces being wrong. A string
# fixture would re-encode that belief.
echo "== entry guards =="

EGT="$(mktemp -d)"
mkdir -p "$EGT/real" "$EGT/a dir"
# Unquoted heredoc so `$ROOT` expands — `import` needs a literal specifier, and
# an unquoted heredoc beats `sed -i`, whose in-place syntax differs between BSD
# and GNU (`sed -i ''` vs `sed -i`) and would make this test macOS-only.
cat > "$EGT/real/probe.mjs" <<PROBE
import { isEntryModule } from '$ROOT/scripts/lib/entry-module.mjs';
console.log(isEntryModule(import.meta.url) ? 'ENTRY' : 'NOT_ENTRY');
PROBE
ln -s "$EGT/real" "$EGT/link"
cp "$EGT/real/probe.mjs" "$EGT/a dir/probe.mjs"

check "$(node "$EGT/real/probe.mjs")"    "ENTRY" "isEntryModule: true via the real path"
check "$(node "$EGT/link/probe.mjs")"    "ENTRY" "isEntryModule: true THROUGH A SYMLINK (the /tmp -> /private/tmp case)"
check "$(node "$EGT/a dir/probe.mjs")"   "ENTRY" "isEntryModule: true on a path containing a SPACE"
# Imported, not launched — the guard must stay closed or every import runs main().
cat > "$EGT/real/importer.mjs" <<'IMP'
await import('./probe.mjs');
IMP
check "$(node "$EGT/real/importer.mjs")" "NOT_ENTRY" "isEntryModule: false when merely IMPORTED"

# The gate must FAIL on a planted violation — a gate that cannot fire is not a
# gate, which is the entire lesson of the bug it guards.
EGV="$EGT/violation.mjs"
printf 'const isMain = fileURLToPath(import.meta.url) === process.argv[1];\n' > "$EGV"
if ( cd "$ROOT" && cp "$EGV" scripts/__eg_violation_probe.mjs \
     && node scripts/check-entry-guard.mjs >/dev/null 2>&1 ); then
  bad "check-entry-guard PASSED with a planted violation"
else
  ok "check-entry-guard FAILS on a planted violation (sabotage-proven)"
fi
rm -f "$ROOT/scripts/__eg_violation_probe.mjs"

# ...and passes on the real tree.
if ( cd "$ROOT" && node scripts/check-entry-guard.mjs >/dev/null 2>&1 ); then
  ok "check-entry-guard passes on the current tree"
else
  bad "check-entry-guard is red on the current tree"
fi

# A SCAN THAT EXAMINED NOTHING MUST NOT REPORT SUCCESS. As first shipped the
# gate collected violations and failed only on `hits.length > 0`, so pointing it
# at a tree with no sources printed the green line and exited 0 — the very
# "passes without checking anything" defect it exists to catch. Copy the gate
# somewhere with no repo around it and require a REFUSAL.
EGE="$EGT/lonely"
mkdir -p "$EGE/scripts/lib"
cp "$ROOT/scripts/check-entry-guard.mjs" "$EGE/scripts/"
cp "$ROOT/scripts/lib/entry-module.mjs" "$EGE/scripts/lib/"
if ( cd "$EGE" && node scripts/check-entry-guard.mjs >/dev/null 2>&1 ); then
  bad "check-entry-guard reported SUCCESS on a scan that reached nothing"
else
  ok "check-entry-guard REFUSES a scan that reached nothing (self-validating)"
fi
rm -rf "$EGT"

# ── H33: the merge-gate e2e backend boots with a DETERMINISTIC pack dir ──────
# `node lib/index.js` is an entry-point boot: without OPENWOP_MOUNT_LOCAL_PACKS=false
# it re-points every ~/.openwop-packs symlink at the checkout, and without an
# OPENWOP_PACK_DIR of its own it READS that shared, mutable directory as the
# chain gallery's first root — which is how the promoted `/builder` visual
# snapshot went red on plain main the same day its baseline was recorded
# (2026-08-16: same tiles, reordered, +438px). These are asserted on the ACTUAL
# env-assignment lines of the boot (a `\` continuation line each), not on the
# comment above them, which also names both variables.
E2E_BOOT="$(awk '/^  step "frontend: e2e \(Playwright/{f=1} f{print} /openwop-ci-e2e-backend\.pid$/ && f{exit}' "$ROOT/scripts/ci.sh")"
check "$(printf '%s\n' "$E2E_BOOT" | grep -cE '^\s+OPENWOP_MOUNT_LOCAL_PACKS=false \\$')" "1" \
  "ci e2e boot passes OPENWOP_MOUNT_LOCAL_PACKS=false (never re-points ~/.openwop-packs)"
check "$(printf '%s\n' "$E2E_BOOT" | grep -cE '^\s+OPENWOP_PACK_DIR="\$E2E_PACK_DIR" \\$')" "1" \
  "ci e2e boot passes its OWN OPENWOP_PACK_DIR (the chain gallery is a function of the commit)"
check "$(printf '%s\n' "$E2E_BOOT" | grep -cE 'for p in "\$ROOT"/packs/\*/; do')" "1" \
  "the e2e pack dir is populated from THIS checkout's vendored packs/"

# ---------------------------------------------------------------- GATE-6
# Every value the certify lane splices into the CONTAINER's must-agree env has
# to reach the DRIVER too.
#
# `release-conformance.sh` computes three values the two sides must agree on
# (ADR 0550 P2): the compat port, the OIDC port, and the harness HOST NAME. It
# passes all three into the container via `-e`, and for a long time exported
# only the two ports. The name was computed, used once, and dropped — so the
# harness advertised its doubles at whatever its own default happened to be, and
# anything in the suite needing the name saw nothing.
#
# That cost two conformance rows: `webhook-signed-delivery` and
# `replay-fanout-suppression` were told to deliver to `127.0.0.1`, which names
# the CONTAINER. MEASURED from inside it: `connect ECONNREFUSED
# 127.0.0.1:55469`. Both recorded a plain `fail` — a false accusation against a
# host that signs webhooks correctly.
#
# A grep for one variable name would be a mirror of the fix. This derives the
# set instead: pull every `$VAR` interpolated into the lane's `-e` lines that
# name a must-agree variable, and require each to be exported. A future
# fourth must-agree value is covered without anyone remembering to add a case.
RC="$ROOT/scripts/release-conformance.sh"
RC_ENV_VARS="$(grep -E '^\s+-e OPENWOP_(TEST_COMPAT_ENDPOINT|OIDC_ISSUER)=' "$RC" \
  | grep -oE '\$\{?[A-Z_]+\}?' | tr -d '${}' | sort -u)"
check "$(printf '%s\n' "$RC_ENV_VARS" | grep -c .)" "3" \
  "certify lane splices 3 must-agree values into the container env"
MISSING=""
for v in $RC_ENV_VARS; do
  # HARNESS_HOST -> OPENWOP_CONFORMANCE_HARNESS_HOST, COMPAT_PORT -> ..._COMPAT_PORT
  grep -qE "^export OPENWOP_CONFORMANCE_${v}=" "$RC" || MISSING="$MISSING $v"
done
check "$MISSING" "" "every must-agree value is ALSO exported to the driver"

# ---------------------------------------------------------------- GATE-7
# The certify lane must DISCLOSE the non-default posture its witness was bought
# with, and the disclosure must be derived rather than hand-listed.
#
# `release-conformance.sh` relaxes real guards so the container can be exercised
# — most consequentially `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true`, without which no
# webhook scenario can reach the harness's receiver. A green line that does not
# name that is claiming more than it measured.
#
# These cases run the lane's own derivation against the lane's own source, with
# no docker: if a future flag is added to the `-e` block it is disclosed for
# free, and if someone replaces the derivation with a hand-list the count stops
# tracking the source.
RCD="$ROOT/scripts/release-conformance.sh"

# Run the LANE's OWN derivation, then compare it to one computed here.
#
# The first draft of this case re-derived the list itself and compared nothing —
# so it measured the script's `-e` block while believing it measured the
# script's instrument. Sabotage caught it: replacing the whole derivation with
# `RELAX_NAMES="OPENWOP_WEBHOOK_ALLOW_PRIVATE"` left every case green. A mirror,
# in a test written to prevent a mirror.
#
# Extracting and evaluating the real assignment (with $0 bound to the lane, as
# it is at runtime) makes a hand-list diverge from the derived list, which is
# the property the comment in the lane claims.
RELAX_STMT="$(awk '/^RELAX_NAMES=/{f=1} f{print} f&&!/\\$/{exit}' "$RCD")"
# ROOT is exported, not just $0 bound: the lane resolves its own path through
# $ROOT because it cd's into backend/typescript before this block runs, and a
# relative $0 does not survive that (it did not — caught live).
LANE_RELAX="$(ROOT="$ROOT" bash -c "$RELAX_STMT"'; printf "%s\n" "$RELAX_NAMES"' "$RCD" 2>/dev/null)"
HERE_RELAX="$(grep -oE '^\s+-e (OPENWOP_[A-Z0-9_]*(ALLOW|ENABLE|DISABLE|SKIP)[A-Z0-9_]*)=' "$RCD" \
  | grep -oE 'OPENWOP_[A-Z0-9_]+' | sort -u)"

check "$(printf '%s\n' "$LANE_RELAX" | grep -c 'OPENWOP_WEBHOOK_ALLOW_PRIVATE')" "1" \
  "the LANE's derivation finds the webhook egress waiver by name"
[ "$(printf '%s\n' "$LANE_RELAX" | grep -c .)" -ge 2 ] \
  && ok "the LANE's derivation finds >=2 relaxations (not a one-off grep)" \
  || bad "the LANE's derivation found fewer than 2 names — it is measuring nothing"
check "$(printf '%s\n' "$LANE_RELAX")" "$(printf '%s\n' "$HERE_RELAX")" \
  "the lane DERIVES the list from its own -e block (a hand-list diverges here)"
# An empty derivation must REFUSE, never print "no relaxations". This lane
# demonstrably relaxes at least one guard, so empty means the instrument broke,
# and an undisclosed waiver is exactly what the block exists to prevent.
check "$(awk '/could not enumerate the lane.s posture flags/{print "1"}' "$RCD" | head -1)" "1" \
  "an empty posture list is a REFUSAL, not a silent pass"

# ---------------------------------------------------------------- PACKS-1
# `sync-packs.sh` must REFUSE a run that destroys vendored content canon cannot
# restore.
#
# THE DEFECT. The sweep removes every `core.openwop.*` / `vendor.*` family; the
# copy loop only restores families that EXIST IN CANON. So a family this repo
# owns and the registry has never seen is deleted outright and never comes back.
# MEASURED on a clean worktree at 108f166fe: a plain run deleted 17 files across
# six families and modified 449 more. The script's own comment claimed it touched
# "only the families this script owns" — true of the GLOB, false of the OUTCOME.
#
# Hermetic fixture: a fake repo root (so $0/.. resolves there) plus a fake canon
# via OPENWOP_REGISTRY_DIR. No network, no real packs, no registry clone.
echo "== sync-packs guard =="

SPT="$(mktemp -d)"
sp_reset() {
  rm -rf "$SPT/repo" "$SPT/canon"
  mkdir -p "$SPT/repo/scripts" "$SPT/repo/packs" "$SPT/canon/packs"
  cp "$ROOT/scripts/sync-packs.sh" "$SPT/repo/scripts/"
  # Two canon-backed families and one repo-owned family the sweep's glob catches.
  for n in core.openwop.alpha vendor.beta; do
    mkdir -p "$SPT/repo/packs/$n" "$SPT/canon/packs/$n"
    printf '{"name":"%s","version":"1.0.0"}\n' "$n" > "$SPT/repo/packs/$n/pack.json"
    printf '{"name":"%s","version":"1.0.0"}\n' "$n" > "$SPT/canon/packs/$n/pack.json"
    printf 'shared\n' > "$SPT/repo/packs/$n/README.md"
    printf 'shared\n' > "$SPT/canon/packs/$n/README.md"
  done
}
sp_check() { ( cd "$SPT/repo" && OPENWOP_REGISTRY_DIR="$SPT/canon" bash scripts/sync-packs.sh --check >/dev/null 2>&1 ); }

# NEGATIVE CONTROL FIRST. Without this, every "it refuses" case below is also
# satisfied by a guard that refuses unconditionally — which would be useless and
# would simply be --force'd forever.
sp_reset
if sp_check; then ok "sync-packs --check PASSES when canon can restore everything (negative control)"
else bad "sync-packs --check refused a clean tree — the guard cannot pass"; fi

# ARM 1 — a whole family canon has never seen.
sp_reset
mkdir -p "$SPT/repo/packs/vendor.orphan"
printf '{"name":"vendor.orphan","version":"1.0.0"}\n' > "$SPT/repo/packs/vendor.orphan/pack.json"
if sp_check; then bad "sync-packs did not refuse a family ABSENT from canon (deleted, never restored)"
else ok "sync-packs REFUSES a family absent from canon (arm 1)"; fi

# ARM 2 — a file canon lacks inside a family canon HAS. The family survives the
# sweep; this file does not, which is why a family-level check is insufficient.
sp_reset
printf 'repo-only\n' > "$SPT/repo/packs/core.openwop.alpha/EXTRA.md"
if sp_check; then bad "sync-packs did not refuse a repo-only FILE inside a surviving family"
else ok "sync-packs REFUSES a repo-only file inside a surviving family (arm 2)"; fi

# ARM 3 — vendored ahead of canon: rm -rf + copy-older silently reverts real work.
sp_reset
printf '{"name":"core.openwop.alpha","version":"2.0.0"}\n' > "$SPT/repo/packs/core.openwop.alpha/pack.json"
if sp_check; then bad "sync-packs did not refuse a family vendored AHEAD of canon"
else ok "sync-packs REFUSES a family vendored ahead of canon (arm 3)"; fi

# THE PROPERTY THAT ACTUALLY MATTERS: a refusal must change NOTHING. A guard that
# reports the loss after taking it is not a guard.
sp_reset
mkdir -p "$SPT/repo/packs/vendor.orphan"
printf 'precious\n' > "$SPT/repo/packs/vendor.orphan/keep.txt"
BEFORE="$(find "$SPT/repo/packs" -type f | sort | md5 2>/dev/null || find "$SPT/repo/packs" -type f | sort | md5sum)"
( cd "$SPT/repo" && OPENWOP_REGISTRY_DIR="$SPT/canon" bash scripts/sync-packs.sh >/dev/null 2>&1 )
AFTER="$(find "$SPT/repo/packs" -type f | sort | md5 2>/dev/null || find "$SPT/repo/packs" -type f | sort | md5sum)"
check "$AFTER" "$BEFORE" "a REFUSED sync leaves packs/ byte-for-byte untouched"
[ -f "$SPT/repo/packs/vendor.orphan/keep.txt" ] \
  && ok "the repo-only file survives a refused sync" \
  || bad "the repo-only file was DELETED by a sync that refused"

# --force must still permit the destructive path (a deliberate override, not a
# wall). Without this the guard would be unbypassable and someone would delete it.
if ( cd "$SPT/repo" && OPENWOP_REGISTRY_DIR="$SPT/canon" bash scripts/sync-packs.sh --force >/dev/null 2>&1 ) \
   && [ ! -f "$SPT/repo/packs/vendor.orphan/keep.txt" ]; then
  ok "--force overrides the guard and performs the destructive sync"
else
  bad "--force did not perform the sync it is supposed to authorise"
fi

# A guard whose ADVICE is wrong is a guard people route around: the stale-pack
# warning must NOT tell the reader to run a bare sync (it did, and that advice is
# how a per-pack staleness report licenses a repo-wide destructive sweep).
if grep -q 'Run scripts/sync-packs\.sh' "$ROOT/scripts/check-pack-pin-drift.mjs"; then
  bad "check-pack-pin-drift still recommends a BARE sync-packs.sh run"
else
  ok "check-pack-pin-drift no longer recommends a bare destructive sync"
fi
rm -rf "$SPT"

# ── check-vendored-fixtures: the WHICH-SIDE-IS-STALE diagnosis ────────────────
# Added 2026-09-16 (ADR 0705) because the classifier shipped a wrong answer and
# nothing here could see it: every `vendored != corpus` returned "it was
# hand-edited", and on the 2.1.5 -> 2.2.0 pin bump that fired for NINE fixtures,
# all nine byte-identical to the corpus at the PREVIOUS tag. Nothing had been
# edited. A gate whose ADVICE is wrong is the failure mode the sync-packs block
# above already records; this is the same shape in a different file.
#
# Hermetic: a fake repo root (so `$0/..` resolves there) carrying its own
# node_modules copy of the pin, plus a fake corpus via OPENWOP_CORPUS_DIR. The
# three inputs — vendored, pin, corpus — are then set independently, which is
# the only way to exercise arms that are defined by how they DISAGREE.
CVF="$(mktemp -d)"
mkdir -p "$CVF/repo/scripts" "$CVF/repo/conformance-fixtures" "$CVF/repo/backend/typescript" \
         "$CVF/repo/node_modules/@openwop/openwop-conformance/fixtures" \
         "$CVF/corpus/conformance/fixtures"
cp "$ROOT/scripts/check-vendored-fixtures.mjs" "$CVF/repo/scripts/"
echo '{"name":"@openwop/app-server"}'                               > "$CVF/repo/backend/typescript/package.json"
echo '{"name":"@openwop/openwop-conformance","version":"9.9.9"}'    > "$CVF/repo/node_modules/@openwop/openwop-conformance/package.json"
echo '{"name":"openwop-corpus","version":"9.9.9"}'                  > "$CVF/corpus/conformance/package.json"
# The script carries a hard-coded HOST_AUTHORED allowlist, and an entry naming no
# vendored file is itself reported (correctly — a rotted allowlist is a real
# defect). In a fake root none of them exist, so without this the guard can never
# report OK and the negative control below could not pass. Read the list from the
# script itself rather than hard-coding it here: a copy would rot the moment the
# real allowlist changed, which is the exact failure the entries guard against.
while IFS= read -r a; do
  case "$a" in
    */) mkdir -p "$CVF/repo/conformance-fixtures/$a" && printf '{}' > "$CVF/repo/conformance-fixtures/${a}placeholder.json" ;;
    ?*) printf '{}' > "$CVF/repo/conformance-fixtures/$a" ;;
  esac
done < <( cd "$ROOT" && node scripts/check-vendored-fixtures.mjs --list-host-authored 2>/dev/null )
cvf() { ( cd "$CVF/repo" && OPENWOP_CORPUS_DIR="$CVF/corpus" node scripts/check-vendored-fixtures.mjs 2>&1 ); }
plant() { printf '%s' "$2" > "$CVF/repo/conformance-fixtures/$1"; }
pin()   { printf '%s' "$2" > "$CVF/repo/node_modules/@openwop/openwop-conformance/fixtures/$1"; }
canon() { printf '%s' "$2" > "$CVF/corpus/conformance/fixtures/$1"; }

# NEGATIVE CONTROL first: all three agree, so nothing may be reported. Without
# this, every assertion below could be passing on an unconditional failure.
plant f.json '{"a":1}'; pin f.json '{"a":1}'; canon f.json '{"a":1}'
if cvf | grep -q '^check-vendored-fixtures: ok'; then
  ok "check-vendored-fixtures: three agreeing copies report OK (negative control)"
else
  bad "check-vendored-fixtures: agreeing copies did NOT report OK — every case below is suspect"
fi

# THE CASE THAT WAS MISDIAGNOSED: corpus and pin moved together, vendored is
# behind. This is what a pin bump looks like, and it must NOT allege an edit.
plant f.json '{"a":1}'; pin f.json '{"a":2}'; canon f.json '{"a":2}'
OUT="$(cvf)"
# Matched without the corpus LABEL, which now names its source ("the corpus at
# <tag>" when the clone carries the pin's tag, "the corpus working tree" when it
# falls back) — the diagnosis is the assertion, not which of the two it read.
if grep -q 'and the pin AGREE; the vendored copy is BEHIND' <<<"$OUT"; then
  ok "check-vendored-fixtures: pin-moved-under-vendored is diagnosed as BEHIND, not as an edit"
else
  bad "check-vendored-fixtures: a moved pin is not diagnosed as BEHIND (got: $(grep -m1 '→' <<<"$OUT" || echo none))"
fi
if grep -q 'hand-edited' <<<"$OUT"; then
  bad "check-vendored-fixtures: still alleges a hand-edit when corpus and pin simply agree"
else
  ok "check-vendored-fixtures: no hand-edit allegation when corpus and pin agree"
fi

# The arm that IS a local edit: three mutually different values. It must stay
# reachable, and must warn that a re-vendor would DISCARD the edit — otherwise
# the fix for the common case has quietly deleted the rare one.
plant f.json '{"a":3}'; pin f.json '{"a":2}'; canon f.json '{"a":1}'
OUT="$(cvf)"
if grep -q 'three DIFFERENT values' <<<"$OUT"; then
  ok "check-vendored-fixtures: three divergent copies are still called out as a likely local edit"
else
  bad "check-vendored-fixtures: the local-edit arm is unreachable — the new arm swallowed it"
fi
if grep -q 'would discard it' <<<"$OUT"; then
  ok "check-vendored-fixtures: the local-edit advice warns that sync-fixtures discards the edit"
else
  bad "check-vendored-fixtures: the local-edit advice does not warn about discarding the edit"
fi

# The OPPOSITE remedy must survive: vendored matches the corpus and the PIN is
# the stale side. Re-vendoring here would be wrong, and this arm predates the
# change — it is asserted so the new branch cannot have shadowed it.
plant f.json '{"a":1}'; pin f.json '{"a":2}'; canon f.json '{"a":1}'
# NOTE the `OUT="$(cvf)"` form, used in every case here. This script runs under
# `set -o pipefail`, so the obvious `cvf | grep -q …` returns the GATE's exit
# code (1, correctly, because it is reporting drift) rather than grep's — the
# assertion then fails no matter what the message says. Cost me one confused
# debugging pass; capture first, match second.
OUT="$(cvf)"
if grep -q 'the PIN is the stale side' <<<"$OUT"; then
  ok "check-vendored-fixtures: a stale PIN still gets the opposite remedy (do not re-sync)"
else
  bad "check-vendored-fixtures: the stale-PIN arm was shadowed by the new branch"
fi
rm -rf "$CVF"

# ── preflight-suite: the SWAP-HEADROOM advisory (ADR 0705) ───────────────────
# Two memory kills in one evening, both starting from a preflight that had just
# called the machine quiet. (A third dead run the same hour was a peer's
# `pkill -f vitest` on a shared box, not memory — see the note in
# preflight-suite.sh; the count here was corrected down from four.) The arm is driven through
# OPENWOP_PREFLIGHT_SWAPFREE_MB on the SAME narrow terms as the existing
# OPENWOP_PREFLIGHT_LOAD1 seam: advisory wording only, never competitor
# detection, so it cannot be used to hide a contending worktree.
PF_LOW="$(OPENWOP_PREFLIGHT_SWAPFREE_MB=500 bash "$ROOT/scripts/preflight-suite.sh" --check 2>&1 || true)"
PF_OK="$(OPENWOP_PREFLIGHT_SWAPFREE_MB=8000 bash "$ROOT/scripts/preflight-suite.sh" --check 2>&1 || true)"

if grep -q 'swap headroom is 500 MB' <<<"$PF_LOW"; then
  ok "preflight: low swap headroom is reported"
else
  bad "preflight: low swap headroom produced no warning"
fi
# NEGATIVE CONTROL — the arm must be conditional, not unconditional. Without
# this the assertion above passes on a check that always warns, which would
# train every reader to ignore it.
if grep -q 'swap headroom' <<<"$PF_OK"; then
  bad "preflight: the swap warning fired at 8000 MB free — it is unconditional, not an advisory"
else
  ok "preflight: ample swap headroom produces NO warning (negative control)"
fi
# The wording is the point: a kill is not a red, and a reader who reads it as one
# blames their diff. Assert the distinction survives, not merely that text exists.
if grep -q 'suspect memory before your diff' <<<"$PF_LOW"; then
  ok "preflight: the warning distinguishes a KILL from a failure"
else
  bad "preflight: the warning does not say a kill is not a verdict"
fi
# The arm must NOT claim to predict. FOUR samples now: 598 MB passed, 805 MB
# killed, 934 MB passed, 1588 MB killed — the threshold fires on neither kill and
# on both passes. A check that forecasts from a number its own evidence
# ANTI-correlates with is the failure this file exists to catch, one level up.
if grep -q 'NOT A PREDICTION' <<<"$PF_LOW"; then
  ok "preflight: the warning states it is a tripwire, not a forecast"
else
  bad "preflight: the warning reads as a prediction its evidence does not support"
fi
if grep -q 'NO exit line' <<<"$PF_LOW"; then
  ok "preflight: the warning names the kill's signature (no exit line, no summaries, zero reds)"
else
  bad "preflight: the warning does not name what a kill looks like"
fi
# It must REPORT, never REFUSE — refusing above a threshold was weighed and
# rejected, and a guard that blocks acquires a bypass flag that goes default-on.
if grep -qE '^ +(machine|competing) ' <<<"$PF_LOW"; then
  ok "preflight: low swap still REPORTS and proceeds — advisory, not a refusal"
else
  bad "preflight: low swap suppressed the normal report — it is behaving as a refusal"
fi
echo "== steward lane detection =="
# ci.sh skips two steward-lane gates in an adopter bundle. The detector must TAKE
# the lane on the full repo, SKIP it on a bundle, and REFUSE when its markers
# disagree — the third case is the one a single-marker detector cannot express,
# and it is what stops a docs/steward/ rename from silently disabling both gates.
# shellcheck source=lib/steward-lane.sh
. "$ROOT/scripts/lib/steward-lane.sh"
SLT="$(mktemp -d)"
ST="backend/typescript/test/steward"
mkdir -p "$SLT/full/docs/steward" "$SLT/full/$ST" "$SLT/bundle" "$SLT/moved/$ST" "$SLT/half/docs/steward"
# An adopter's main re-adds its own .github/ .agents/ .claude/ (kicktodo does);
# those must NOT make a bundle look like the full repo.
mkdir -p "$SLT/adopter/.github" "$SLT/adopter/.agents" "$SLT/adopter/.claude"
check "$(steward_lane "$SLT/full")" take "full repo (docs/steward + test/steward) TAKES the steward lane"
check "$(steward_lane "$SLT/bundle")" skip "adopter bundle (both stripped) SKIPS the steward lane"
check "$(steward_lane "$SLT/adopter")" skip "adopter main with its own .github/.agents/.claude still SKIPS"
steward_lane "$SLT/moved" >/dev/null 2>&1; check "$?" 2 "docs/steward moved but test/steward present REFUSES (never a silent skip)"
steward_lane "$SLT/half" >/dev/null 2>&1; check "$?" 2 "docs/steward present but test/steward absent REFUSES"
# ci.sh must actually consult the helper and abort on a refusal — a helper nothing
# calls pins nothing.
if grep -q 'steward_lane "\$ROOT"' "$ROOT/scripts/ci.sh" && grep -q 'steward-lane detection refused' "$ROOT/scripts/ci.sh"; then
  ok "ci.sh consults steward_lane and exits on a refusal"
else
  bad "ci.sh does not consult steward_lane (or does not exit when it refuses)"
fi
rm -rf "$SLT"

# GATE-EPIPE — piping a shell variable into a SHORT-CIRCUITING grep is a
# false-negative generator under `set -o pipefail`, which every gate script sets.
# `grep -q` exits the instant it matches, closing the pipe; the writer is still
# writing, takes EPIPE, and exits non-zero; with pipefail the PIPELINE is then
# non-zero — so a condition that is TRUE reads as FALSE. It only misfires when the
# pattern DOES match, and only once the payload is large enough that the writer has
# not finished, which is why it presented as a flake: it burned two CI runs claiming
# "deploy.sh no longer runs scripts/check-conformance-major2.sh" against a deploy.sh
# that plainly does. Deterministic demo, with `set -uo pipefail`:
#     big=$(seq 1 200000)
#     writer "$big" | grep -q '^1$'   -> FALSE      grep -q '^1$' <<<"$big" -> TRUE
# A herestring has no writer process to kill. This ratchet keeps the class at zero.
# NOTE: comment lines are stripped before counting — an earlier draft of this very
# block scored 4 against ITSELF (its own prose and message text), which is the
# "ratchets count comments" trap.
EPIPE_RE="printf [^|]*\| *grep -[A-Za-z]*"'(q|m1)'
epipe_hits=$(grep -rhE "$EPIPE_RE" "$ROOT"/scripts/*.sh | grep -vE '^[[:space:]]*#' | grep -c . || true)
check "$epipe_hits" "0" "no printf-piped-into-a-short-circuiting-grep survives (pipefail + EPIPE reads a TRUE condition as FALSE)"
# The same race on the INNER grep of a two-stage pipe whose tail short-circuits.
EPIPE_CHAIN_RE="printf [^|]*\| *grep -[AB][0-9]+ [^|]*\| *grep -[A-Za-z]*q"
epipe_chain=$(grep -rhE "$EPIPE_CHAIN_RE" "$ROOT"/scripts/*.sh | grep -vE '^[[:space:]]*#' | grep -c . || true)
check "$epipe_chain" "0" "no two-stage variant survives (the MIDDLE grep takes the EPIPE)"
# Positive control: the detector must fire on a planted instance, or a zero above is
# indistinguishable from a search that matched nothing because it was malformed.
EPIPE_T=$(mktemp -d)
echo 'x=$(true); printf "%s" "$x" | GREPQ foo' | sed 's/GREPQ/grep -q/' > "$EPIPE_T/planted.sh"
planted=$(grep -rhE "$EPIPE_RE" "$EPIPE_T"/*.sh | grep -vE '^[[:space:]]*#' | grep -c . || true)
check "$planted" "1" "  ...and the detector FIRES on a planted instance (so the zero above is a measurement)"
rm -rf "$EPIPE_T"

# ── check-conformance-major2.sh refuses a run that did not FINISH (ADR 0743) ──
# MEASURED 2026-09-23: the watchdog killed a lane after ONE v2 file and the ratchet
# printed `✓ red set == known-red list` and exited 0 — it discarded the suite's exit
# status and read the partial log as a result. Three synthetic logs: the killed one
# must FAIL, and the two complete ones must keep their normal verdicts, so this pins
# the new refusal without breaking the ratchet it sits in front of.
M2T=$(mktemp -d)
cat > "$M2T/killed.log" <<'LOG'
 ✓ src/scenarios/v2-alpha.test.ts (2 tests) 10ms
[conformance] WATCHDOG: the suite did not exit within 2700000 ms (OPENWOP_CONFORMANCE_MAX_MS) — killing it.
LOG
cat > "$M2T/green.log" <<'LOG'
 ✓ src/scenarios/v2-alpha.test.ts (2 tests) 10ms
 Test Files  1 passed (1)
LOG
cat > "$M2T/red.log" <<'LOG'
 ❯ src/scenarios/v2-alpha.test.ts (2 tests | 1 failed) 10ms
 Test Files  1 failed (1)
LOG
# An EMPTY known-red list, not the live one: the "green" leg used to read the
# repo's list, so it passed only while that list happened to be empty — the first
# admitted entry (ADR 0749) turned it red as a STALE entry absent from the log.
: > "$M2T/known-red.txt"
m2() { OPENWOP_M2_KNOWN_RED="$M2T/known-red.txt" OPENWOP_M2_LOG="$M2T/$1" bash "$ROOT/scripts/check-conformance-major2.sh" >/dev/null 2>&1; echo $?; }
check "$(m2 killed.log)" "1" "major-2 ratchet FAILS a watchdog-killed partial run (it used to print ✓ and exit 0)"
check "$(m2 green.log)" "0" "  ...and still PASSES a complete green run (the refusal is not a blanket fail)"
check "$(m2 red.log)" "1" "  ...and still FAILS a complete run with an unlisted red"
rm -rf "$M2T"

echo "== gate tooling: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
