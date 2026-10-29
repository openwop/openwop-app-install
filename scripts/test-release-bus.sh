#!/usr/bin/env bash
# ADR 0991 — behaviour test for the cross-machine release bus.
#
# A fake `gcloud` (objects + generations in a temp dir, offline) proves:
#   - a 412 on queue.json re-reads and retries; a 412 that never ends gives up
#     at the deadline as `unavailable`, exit 0;
#   - events are create-only (`--if-generation-match=0`);
#   - an unavailable bus (auth error, a hung gcloud, no gcloud at all) prints
#     `release-bus: unavailable` and exits 0; OPENWOP_RELEASE_BUS=off calls nothing;
#   - an expired lease reads STALE and is never warned about; a live lease from
#     ANOTHER host is warned about; our own is not;
#   - the shell hook chains onto an existing EXIT trap and never changes the
#     caller's exit status (the deploy.sh / publish-evidence.sh shape);
#   - merge-train.sh's exit status is the same with the bus working, failing,
#     hung or off, green and red, and the train lock is still released.
#
# D9, the per-target deploy queue (user decision 2026-10-27):
#   - deploys to DIFFERENT targets both proceed at once; to the SAME target the
#     second queues and proceeds once the first releases, FIFO;
#   - two simultaneous acquirers on one target: exactly one goes first;
#   - a STALE lease never blocks; the max wait proceeds with a WARN; an
#     unavailable bus proceeds; a 412 storm keeps queueing (busy, not down);
#   - the parent exemption is an exact id; a pre-targets deploy lease counts as
#     the app's own backend; production is per target and keeps the legacy key;
#   - warn-others --targets is a WARN only for a shared target, INFO otherwise.
#
# Red when (each sabotage-witnessed): `notes --for` stops filtering by recipient;
# status prints a note without its text; the secret guard is skipped; updateQueue stops retrying on 412; publish
# drops `--if-generation-match=0`; the mjs throws past main(); isLive ignores
# leaseUntil; release_bus_hold replaces the EXIT trap instead of chaining; the
# hook calls `exit`.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/release-bus.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi; }
# Here-strings, never `printf | grep -q`: under pipefail an early grep exit EPIPEs the printf.
has() { if grep -q -- "$2" <<< "$1"; then ok "$3"; else bad "$3 (no '$2' in: $(head -3 <<< "$1" | tr '\n' ' '))"; fi; }
hasnt() { if grep -q -- "$2" <<< "$1"; then bad "$3 (found '$2')"; else ok "$3"; fi; }

# ── the fake gcloud ──────────────────────────────────────────────────────────
BIN="$TMP/bin"; mkdir -p "$BIN"
cat > "$BIN/gcloud" <<'FAKE'
#!/usr/bin/env node
// Fake `gcloud storage` over a directory: <dir>/<object> holds the body,
// <dir>/<object>.gen the generation. Modes via env (FAKE_GCLOUD_MODE):
//   unauth — every call fails like a missing login;  hang — sleeps 60 s.
// FAKE_GCLOUD_412=N — the first N conditional writes to queue.json fail 412.
const fs = require('fs'); const path = require('path');
const dir = process.env.FAKE_GCS; const log = process.env.FAKE_GCLOUD_LOG;
const argv = process.argv.slice(2);
if (log) fs.appendFileSync(log, argv.join(' ') + '\n');
const mode = process.env.FAKE_GCLOUD_MODE || '';
if (mode === 'hang') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); process.exit(0); }
if (mode === 'unauth') { process.stderr.write('ERROR: (gcloud.storage) You do not currently have an active account selected.\n'); process.exit(1); }
const args = argv.filter((a) => a !== '--quiet');
if (args[0] !== 'storage') { process.stderr.write('fake: only storage\n'); process.exit(2); }
const obj = (url) => { const m = /^gs:\/\/[^/]+\/(.+)$/.exec(url); return m ? m[1] : null; };
const file = (o) => path.join(dir, o.replace(/\//g, '__'));
const gen = (o) => (fs.existsSync(file(o) + '.gen') ? fs.readFileSync(file(o) + '.gen', 'utf8').trim() : null);
const sub = args[1];
if (sub === 'objects' && args[2] === 'describe') {
  const o = obj(args[3]); const g = gen(o);
  if (!g) { process.stderr.write('ERROR: 404 not found\n'); process.exit(1); }
  process.stdout.write(g + '\n'); process.exit(0);
}
if (sub === 'cat') {
  let out = '';
  for (const url of args.slice(2)) {
    const [u, want] = url.split('#'); const o = obj(u); const g = gen(o);
    if (!g || (want && want !== g)) { process.stderr.write(`ERROR: 404 ${url}\n`); process.exit(1); }
    out += fs.readFileSync(file(o), 'utf8');
  }
  process.stdout.write(out); process.exit(0);
}
if (sub === 'ls') {
  const prefix = obj(args[2]).replace(/\*$/, '');
  const names = fs.readdirSync(dir).filter((f) => !f.endsWith('.gen')).map((f) => f.replace(/__/g, '/')).filter((n) => n.startsWith(prefix)).sort();
  process.stdout.write(names.map((n) => `gs://bucket/${n}`).join('\n') + (names.length ? '\n' : '')); process.exit(0);
}
if (sub === 'cp') {
  const src = args[2]; const o = obj(args[3]);
  const m = args.find((a) => a.startsWith('--if-generation-match='));
  const want = m ? m.split('=')[1] : null;
  // A conditional write is atomic in GCS; make it atomic here too, or two
  // concurrent acquirers could both pass the generation check (D9's test).
  const lk = path.join(dir, '.lock');
  if (want !== null) { for (;;) { try { fs.mkdirSync(lk); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } } process.on('exit', () => { try { fs.rmdirSync(lk); } catch {} }); }
  const cur = gen(o);
  if (o === 'queue.json' && want !== null) {
    const n = Number(process.env.FAKE_GCLOUD_412 || 0); const cf = path.join(dir, '.412count');
    const used = fs.existsSync(cf) ? Number(fs.readFileSync(cf, 'utf8')) : 0;
    if (used < n) { fs.writeFileSync(cf, String(used + 1)); process.stderr.write('ERROR: HTTPError 412: At least one of the pre-conditions you specified did not hold.\n'); process.exit(1); }
  }
  if (want !== null && (want === '0' ? cur !== null : cur !== want)) { process.stderr.write('ERROR: HTTPError 412: At least one of the pre-conditions you specified did not hold.\n'); process.exit(1); }
  fs.copyFileSync(src, file(o)); fs.writeFileSync(file(o) + '.gen', String(Date.now() * 1000 + Math.floor(Math.random() * 1000)));
  process.exit(0);
}
process.stderr.write('fake: unhandled ' + args.join(' ') + '\n'); process.exit(2);
FAKE
chmod +x "$BIN/gcloud"

fresh() {
  rm -rf "$TMP/gcs"; mkdir -p "$TMP/gcs"; : > "$TMP/calls"
  local empty='{"version":1,"slots":[],"active":[],"production":{}}'
  printf '%s\n' "${1:-$empty}" > "$TMP/gcs/queue.json"
  echo 1000 > "$TMP/gcs/queue.json.gen"
}
BUS() { PATH="$BIN:$PATH" FAKE_GCS="$TMP/gcs" FAKE_GCLOUD_LOG="$TMP/calls" OPENWOP_RELEASE_BUS=on OPENWOP_RELEASE_BUS_HOST="${HOSTN:-hosta}" \
  node "$ROOT/scripts/lib/release-bus.mjs" "$@" 2>&1; }
Q() { node -e 'const q=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(eval(process.argv[2]))' "$TMP/gcs/queue.json" "$1"; }

echo "▶ release bus"

# ── claim, 412 retry, release, production ───────────────────────────────────
fresh
out="$(FAKE_GCLOUD_412=1 BUS claim --id g1 --kind gate --prs 5,6 --base abc --tree def; echo "rc=$?")"
has "$out" "claimed gate g1 (after 1 retry)" "a 412 on queue.json re-reads and retries"
check "$(Q 'q.active.map(e=>e.id+":"+e.kind+":"+e.prs.join("+")+":"+e.host).join()')" "g1:gate:5+6:hosta" "the claim landed once, with host, kind and PRs"
check "$(Q 'Date.parse(q.active[0].leaseUntil)-Date.parse(q.active[0].startedAt)')" "5400000" "a gate's lease is twice its typical 45 minutes"
out="$(BUS release --id g1)"; check "$(Q 'q.active.length')" "0" "release removes the entry"
BUS set-production --commit 0123456789abcdef --revision rev-9 >/dev/null
check "$(Q 'q.production.commit+" "+q.production.revision')" "0123456789abcdef rev-9" "set-production records commit and revision"
fresh
out="$(FAKE_GCLOUD_412=999 OPENWOP_RELEASE_BUS_TIMEOUT_MS=1500 BUS claim --id g2 --kind gate; echo "rc=$?")"
has "$out" "release-bus: unavailable (" "a 412 that never ends gives up at the deadline"
has "$out" "rc=0" "  ...and still exits 0"
check "$([ "$(grep -c 'queue.json --if-generation-match' "$TMP/calls")" -gt 1 ] && echo retried || echo once)" "retried" "  ...after re-reading and retrying"

# ── events are create-only ───────────────────────────────────────────────────
fresh
out="$(BUS publish '{"kind":"gate","phase":"start","prs":"7"}')"
has "$out" "published gate start" "publish writes an event"
has "$(cat "$TMP/calls")" "events/.*--if-generation-match=0" "  ...create-only (--if-generation-match=0)"
out="$(BUS status --minutes 10)"
has "$out" "hosta gate start #7" "status lists the recent event"

# ── notes (user rule 2026-10-27): any session may post to and read from any other ──
fresh
out="$(NOTE_FROM=d8 BUS note --to openwop-app-b7 --re 5295 'please re-run your train after 109b')"
has "$out" "note sent to openwop-app-b7 \[5295\]" "a note is posted"
NOTE_FROM=14 BUS note --to '*' --re slot-115 'slot 115 starts in 10 min' >/dev/null
NOTE_FROM=14 BUS note --to someone-else --re 1 'not for b7' >/dev/null
out="$(BUS notes --for openwop-app-b7@davids-macbook-air --minutes 10)"
has "$out" "2 note(s)" "notes --for reads notes to that session (with or without @host) and to everyone"
has "$out" "d8@hosta -> openwop-app-b7 \[5295\] please re-run your train after 109b" "  ...with from, to, re and text"
hasnt "$out" "not for b7" "  ...never a note to someone else"
out="$(BUS status --minutes 10)"
has "$out" "note .*14@hosta -> \* \[slot-115\] slot 115 starts in 10 min" "status prints a note's from, to and text"
for secret in 'key sk-abcdefghijklmnopqrstuvwxyz0123' 'dsn postgres://app:hunter2@10.0.0.5:5432/db' '-----BEGIN RSA PRIVATE KEY-----'; do
  n_before=$(ls "$TMP/gcs" | grep -c '^events__.*json$')
  out="$(BUS note --to '*' --re x -- "$secret")"
  n_after=$(ls "$TMP/gcs" | grep -c '^events__.*json$')
  check "$(grep -c 'NOT sent' <<< "$out")/$((n_after - n_before))" "1/0" "a note that looks like a secret is NOT sent (${secret:0:12}…)"
done
out="$(BUS note --to '*' --re x)"
has "$out" "note needs --to" "a note without text is refused, not sent empty"
out="$(FAKE_GCLOUD_MODE=unauth BUS note --to '*' --re x hello; echo "rc=$?")"
has "$out" "unavailable" "an unreachable bus: the note is unavailable"
has "$out" "rc=0" "  ...exit 0"

# ── an unavailable bus never fails its caller ───────────────────────────────
fresh
out="$(FAKE_GCLOUD_MODE=unauth BUS status; echo "rc=$?")"
has "$out" "release-bus: unavailable (ERROR: (gcloud.storage) You do not currently" "no login: unavailable, with the reason"
has "$out" "rc=0" "  ...exit 0"
t0=$(date +%s)
out="$(FAKE_GCLOUD_MODE=hang OPENWOP_RELEASE_BUS_TIMEOUT_MS=1500 BUS claim --id g3 --kind deploy; echo "rc=$?")"
el=$(( $(date +%s) - t0 ))
has "$out" "release-bus: unavailable (timed out)" "a hung gcloud times out"
check "$([ "$el" -le 5 ] && echo bounded || echo "${el}s")" "bounded" "  ...within the deadline, not the hang"
NOG="$TMP/nogcloud"; mkdir -p "$NOG"; ln -sf "$(command -v node)" "$NOG/node"
out="$(PATH="$NOG" OPENWOP_RELEASE_BUS=on node "$ROOT/scripts/lib/release-bus.mjs" status 2>&1; echo "rc=$?")"
has "$out" "release-bus: unavailable (no gcloud)" "no gcloud on PATH: unavailable"
has "$out" "rc=0" "  ...exit 0"
fresh
out="$(PATH="$BIN:$PATH" FAKE_GCS="$TMP/gcs" FAKE_GCLOUD_LOG="$TMP/calls" OPENWOP_RELEASE_BUS=off node "$ROOT/scripts/lib/release-bus.mjs" claim --id g4 --kind gate 2>&1)"
check "$(wc -c < "$TMP/calls" | tr -d ' ')" "0" "OPENWOP_RELEASE_BUS=off calls nothing"

# ── leases: stale vs live, other host vs ours ───────────────────────────────
past="$(node -e 'console.log(new Date(Date.now()-60000).toISOString())')"
future="$(node -e 'console.log(new Date(Date.now()+3600000).toISOString())')"
fresh "{\"version\":1,\"active\":[{\"id\":\"old\",\"host\":\"hostb\",\"kind\":\"gate\",\"prs\":[1],\"startedAt\":\"$past\",\"leaseUntil\":\"$past\"},{\"id\":\"live\",\"host\":\"hostb\",\"kind\":\"deploy\",\"commit\":\"feedfacecafe\",\"startedAt\":\"$past\",\"leaseUntil\":\"$future\"},{\"id\":\"mine\",\"host\":\"hosta\",\"kind\":\"gate\",\"startedAt\":\"$past\",\"leaseUntil\":\"$future\"}]}"
out="$(BUS status)"
has "$out" "STALE gate hostb #1" "an expired lease reads STALE"
has "$out" "LIVE  deploy hostb feedfacec" "a live lease reads LIVE"
out="$(BUS warn-others --kinds gate,deploy)"
has "$out" "WARN release-bus: another machine holds a live lease — LIVE  deploy hostb" "warn-others names another host's live lease"
hasnt "$out" "STALE" "  ...never a stale one"
hasnt "$out" "hosta" "  ...never our own"

# ── D9: per-target deploy queue ─────────────────────────────────────────────
T1=run:p/us-central1/svc-a; T2=run:p/us-central1/svc-b
ACQ() { OPENWOP_DEPLOY_QUEUE_POLL_S=1 BUS acquire "$@"; }
fresh
out="$(HOSTN=hosta ACQ --id d1 --kind deploy --targets "$T1")"
has "$out" "acquired deploy d1 on $T1" "an acquire on a free target goes at once"
t0=$(date +%s)
out="$(HOSTN=hostb ACQ --id d2 --kind deploy --targets "$T2" --max-wait-min 1)"
el=$(( $(date +%s) - t0 ))
has "$out" "acquired deploy d2 on $T2" "a deploy to a DIFFERENT target proceeds while the first holds its own"
check "$([ "$el" -le 5 ] && echo at-once || echo "${el}s")" "at-once" "  ...without waiting"
check "$(Q 'q.active.filter(e=>e.state==="running").map(e=>e.id).sort().join()')" "d1,d2" "  ...both are running"

# same target: the second queues, then proceeds once the first releases
( HOSTN=hostb ACQ --id d3 --kind deploy --targets "$T1" --max-wait-min 1 > "$TMP/d3.out" 2>&1 ) & D3=$!
sleep 3
check "$(Q 'q.active.filter(e=>e.id==="d3").map(e=>e.state).join()')" "waiting" "a deploy to the SAME target queues (waiting entry)"
has "$(cat "$TMP/d3.out")" "queued behind LIVE  deploy hosta \[$T1\]" "  ...and says whom it waits for, on which target"
BUS release --id d1 >/dev/null
wait "$D3"
has "$(cat "$TMP/d3.out")" "acquired deploy d3 on $T1 after" "  ...and proceeds once the first releases"
check "$(Q 'q.active.filter(e=>e.id==="d3").map(e=>e.state).join()')" "running" "  ...as a running lease"

# two simultaneous acquirers: exactly one goes first
fresh
( HOSTN=hosta ACQ --id s1 --kind deploy --targets "$T1" --max-wait-min 1 > "$TMP/s1.out" 2>&1 ) & S1=$!
( HOSTN=hostb ACQ --id s2 --kind deploy --targets "$T1" --max-wait-min 1 > "$TMP/s2.out" 2>&1 ) & S2=$!
sleep 3
check "$(Q 'q.active.filter(e=>e.state==="running").length')/$(Q 'q.active.filter(e=>e.state==="waiting").length')" "1/1" "two simultaneous acquirers on one target: exactly one runs, one waits"
first="$(Q 'q.active.find(e=>e.state==="running").id')"
BUS release --id "$first" >/dev/null
wait "$S1"; wait "$S2"
check "$(grep -l 'acquired deploy' "$TMP/s1.out" "$TMP/s2.out" | wc -l | tr -d ' ')" "2" "  ...and the other goes once the first releases"

# FIFO: a later arrival does not jump an earlier waiter
fresh
HOSTN=hosta ACQ --id f0 --kind deploy --targets "$T1" >/dev/null
( HOSTN=hostb ACQ --id f1 --kind deploy --targets "$T1" --max-wait-min 1 > "$TMP/f1.out" 2>&1 ) & F1=$!
sleep 2
( HOSTN=hostc ACQ --id f2 --kind deploy --targets "$T1" --max-wait-min 1 > "$TMP/f2.out" 2>&1 ) & F2=$!
sleep 2
BUS release --id f0 >/dev/null
sleep 3
check "$(Q 'q.active.filter(e=>e.state==="running").map(e=>e.id).join()')" "f1" "FIFO: the earlier waiter goes first, the later one still waits"
BUS release --id f1 >/dev/null; wait "$F1"; wait "$F2"
has "$(cat "$TMP/f2.out")" "acquired deploy f2" "  ...and the later one goes after it"

# a stale lease never blocks
fresh "{\"version\":1,\"active\":[{\"id\":\"dead\",\"host\":\"hostb\",\"kind\":\"deploy\",\"state\":\"running\",\"targets\":[\"$T1\"],\"startedAt\":\"$past\",\"leaseUntil\":\"$past\"}]}"
t0=$(date +%s); out="$(ACQ --id s3 --kind deploy --targets "$T1" --max-wait-min 1)"; el=$(( $(date +%s) - t0 ))
has "$out" "acquired deploy s3" "a STALE lease on the target never blocks"
check "$([ "$el" -le 5 ] && echo at-once || echo "${el}s")" "at-once" "  ...no wait"

# the max wait proceeds, loudly
fresh "{\"version\":1,\"active\":[{\"id\":\"hog\",\"host\":\"hostb\",\"kind\":\"deploy\",\"state\":\"running\",\"targets\":[\"$T1\"],\"startedAt\":\"$past\",\"leaseUntil\":\"$future\"}]}"
out="$(ACQ --id m1 --kind deploy --targets "$T1" --max-wait-min 0.05; echo "rc=$?")"
has "$out" "WARN release-bus: waited 0 min (max 0.05) for LIVE  deploy hostb" "the max wait PROCEEDS with a WARN naming the holder"
has "$out" "rc=0" "  ...exit 0"
check "$(Q 'q.active.filter(e=>e.id==="m1").map(e=>e.state).join()')" "running" "  ...and the lease it then holds is visible"

# the parent exemption is an exact id (the hog alone on the target each time)
HOG="{\"version\":1,\"active\":[{\"id\":\"hog\",\"host\":\"hostb\",\"kind\":\"deploy\",\"state\":\"running\",\"targets\":[\"$T1\"],\"startedAt\":\"$past\",\"leaseUntil\":\"$future\"}]}"
fresh "$HOG"
out="$(OPENWOP_RELEASE_BUS_PARENT=hog ACQ --id c1 --kind certify --targets "$T1" --max-wait-min 0.05)"
hasnt "$out" "queued behind LIVE  deploy hostb" "a certify run by its parent deploy does not queue behind it"
fresh "$HOG"
out="$(OPENWOP_RELEASE_BUS_PARENT=ho ACQ --id c2 --kind certify --targets "$T1" --max-wait-min 0.03)"
has "$out" "queued behind LIVE  deploy hostb" "  ...the exemption is the exact id, never a prefix"

# OPENWOP_DEPLOY_QUEUE=off skips the wait
out="$(OPENWOP_DEPLOY_QUEUE=off ACQ --id o1 --kind deploy --targets "$T1")"
has "$out" "claimed deploy o1 on $T1" "OPENWOP_DEPLOY_QUEUE=off claims without waiting"

# a pre-targets deploy lease (an older checkout) is the app's own backend
LEG=run:openwop-dev/us-central1/openwop-app-backend
fresh "{\"version\":1,\"active\":[{\"id\":\"old\",\"host\":\"hostb\",\"kind\":\"deploy\",\"startedAt\":\"$past\",\"leaseUntil\":\"$future\"}]}"
out="$(ACQ --id l1 --kind deploy --targets "$LEG" --max-wait-min 0.03)"
has "$out" "queued behind LIVE  deploy hostb since" "an older checkout's deploy lease (no targets) blocks the app's own backend"
out="$(ACQ --id l2 --kind deploy --targets "$T2" --max-wait-min 1)"
hasnt "$out" "queued behind" "  ...and nothing else"

# an unavailable bus proceeds; a 412 storm keeps queueing
out="$(FAKE_GCLOUD_MODE=unauth ACQ --id u1 --kind deploy --targets "$T1"; echo "rc=$?")"
has "$out" "unavailable (ERROR: (gcloud.storage) You do not currently .*proceeding without the queue" "an unavailable bus: acquire proceeds"
has "$out" "rc=0" "  ...exit 0"
fresh
out="$(FAKE_GCLOUD_412=999 OPENWOP_RELEASE_BUS_TIMEOUT_MS=1200 ACQ --id b1 --kind deploy --targets "$T1" --max-wait-min 0.06; echo "rc=$?")"
has "$out" "queue.json is busy (412); still queued" "a 412 storm is busy, not down: it keeps queueing"
has "$out" "rc=0" "  ...and still ends (max wait), exit 0"

# production per target; the legacy key only for the app's own backend
fresh
BUS set-production --commit aaaa111122223333 --revision r-a --target "$T1" >/dev/null
BUS set-production --commit bbbb111122223333 --revision r-b --target "$LEG" >/dev/null
check "$(Q 'q.productions["'"$T1"'"].commit+" "+q.productions["'"$LEG"'"].revision+" "+q.production.commit')" "aaaa111122223333 r-b bbbb111122223333" "production is per target; the legacy key tracks only the app's own backend"
out="$(BUS status)"
has "$out" "target $T1: production aaaa11112 r-a; idle" "status prints each target's production"

# warn-others --targets: WARN only for a shared target
fresh "{\"version\":1,\"active\":[{\"id\":\"x\",\"host\":\"hostb\",\"kind\":\"deploy\",\"state\":\"running\",\"targets\":[\"$T2\"],\"startedAt\":\"$past\",\"leaseUntil\":\"$future\"},{\"id\":\"y\",\"host\":\"hostb\",\"kind\":\"deploy\",\"state\":\"running\",\"targets\":[\"$T1\"],\"startedAt\":\"$past\",\"leaseUntil\":\"$future\"}]}"
out="$(BUS warn-others --kinds deploy --targets "$T1")"
has "$out" "WARN release-bus: another machine holds a live lease — LIVE  deploy hostb \[$T1\]" "warn-others --targets WARNs for a lease on our target"
has "$out" "INFO release-bus: another machine is releasing to a different target — LIVE  deploy hostb \[$T2\]" "  ...and is only INFO for another server"

# targets are derived from deploy.env, never typed
tg="$( . "$ROOT/scripts/lib/release-bus.sh"; OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_REGION=eu OPENWOP_DEPLOY_SERVICE=s OPENWOP_DEPLOY_FIREBASE_PROJECT=fp OPENWOP_DEPLOY_HOSTING_TARGET=app release_bus_targets backend frontend)"
check "$tg" "run:p/eu/s,hosting:fp/app" "release_bus_targets derives run: and hosting: ids from deploy.env"
tg="$( . "$ROOT/scripts/lib/release-bus.sh"; OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_SERVICE=s OPENWOP_DEPLOY_FIREBASE_PROJECT=fp OPENWOP_DEPLOY_HOSTING_TARGET=app release_bus_targets backend)"
check "$tg" "run:p/us-central1/s" "  ...a backend-only deploy claims only run:"

# ── the shell hook: chains the caller's EXIT trap, never changes its status ──
cat > "$TMP/caller.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
trap 'echo previous-trap-ran >> "$TMP/marker"' EXIT
. "$ROOT/scripts/lib/release-bus.sh"
endfn() { printf '{"kind":"deploy","phase":"end","exit":%s}' "\$1"; }
release_bus_hold hook-1 deploy endfn --commit abc
release_bus publish '{"kind":"deploy","phase":"start"}'
exit "\${CALLER_RC:-0}"
EOF
for mode in ok unauth hang off; do
  for want in 0 7; do
    fresh; rm -f "$TMP/marker"
    case "$mode" in off) BUSV=off; FM="";; ok) BUSV=on; FM="";; *) BUSV=on; FM="$mode";; esac
    ( PATH="$BIN:$PATH" FAKE_GCS="$TMP/gcs" FAKE_GCLOUD_MODE="$FM" OPENWOP_RELEASE_BUS="$BUSV" OPENWOP_RELEASE_BUS_TIMEOUT_MS=1500 CALLER_RC="$want" bash "$TMP/caller.sh" >/dev/null 2>&1 ); rc=$?
    check "$rc/$(cat "$TMP/marker" 2>/dev/null)" "$want/previous-trap-ran" "hook, bus $mode, caller exit $want: same exit, previous EXIT trap still runs"
  done
done
fresh
( PATH="$BIN:$PATH" FAKE_GCS="$TMP/gcs" OPENWOP_RELEASE_BUS=on CALLER_RC=3 bash "$TMP/caller.sh" >/dev/null 2>&1 )
check "$(Q 'q.active.length')" "0" "the EXIT hook released the lease"
check "$(ls "$TMP/gcs" | grep '^events__' | grep -vc '\.gen$')" "2" "  ...and published start and end"
check "$(cat "$TMP"/gcs/events__* | grep -c '"phase":"end","exit":3')" "1" "  ...the end event carries the caller's exit status"

# ── merge-train.sh: same exit status whatever the bus does ──────────────────
G() { git -c user.email=t@t -c user.name=t "$@"; }
setup_train() {
  rm -rf "$TMP/origin.git" "$TMP/repo" "$TMP/repo-train" "$TMP/repo-train.lock" "$TMP/tbin" "$TMP/fake"
  G init -q --bare -b main "$TMP/origin.git"
  G clone -q "$TMP/origin.git" "$TMP/repo" 2>/dev/null
  ( cd "$TMP/repo"
    mkdir -p scripts/lib backend/typescript frontend/react
    cp "$ROOT/scripts/merge-train.sh" scripts/
    cp "$ROOT/scripts/lib/train-lock.sh" "$ROOT/scripts/lib/release-bus.sh" "$ROOT/scripts/lib/release-bus.mjs" scripts/lib/
    printf '#!/usr/bin/env bash\nexit 0\n' > scripts/release-freeze.sh
    echo '{}' > backend/typescript/package-lock.json; echo '{}' > frontend/react/package-lock.json
    printf '{"version":1,"preset":"openwop"}\n' > hyvemind.json
    printf 'node_modules/\n' > .gitignore; echo base > base.txt
    G add -A && G commit -qm base && G push -q origin main
    for n in 1 2; do
      G checkout -q -b "pr$n" main; echo "$n" > "f$n.txt"; [ "$n" = 2 ] && echo boom > BREAK
      G add -A && G commit -qm "pr$n" && G push -q origin "pr$n"
    done
    G checkout -q main ) >/dev/null 2>&1
  mkdir -p "$TMP/tbin" "$TMP/fake"
  cat > "$TMP/tbin/gh" <<'FAKE'
#!/usr/bin/env bash
set -e
n="$3"
case "$1 $2" in
  "pr view")
    if [ -f "$FAKE_DIR/merged-$n" ]; then st=MERGED; else st=OPEN; fi
    case "$*" in
      *headRefName*) oid=$(git -C "$FAKE_REPO" rev-parse "origin/pr$n"); printf '%s\tmain\tpr%s\t%s\tfalse\n' "$st" "$n" "$oid" ;;
      *headRefOid*) oid=$(git -C "$FAKE_REPO" rev-parse "origin/pr$n"); printf '%s\t%s\n' "$st" "$oid" ;;
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
  cat > "$TMP/tbin/npm" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  ci*) mkdir -p node_modules; touch node_modules/.package-lock.json ;;
  "run ci")
    if [ -n "${FAKE_TRAIN_SIGNAL:-}" ]; then
      # Signal only this isolated fixture's train, never another process.
      kill -s "$FAKE_TRAIN_SIGNAL" "$FAKE_TRAIN_PID"
      exit 143
    fi
    [ ! -f BREAK ] ;;
esac
FAKE
  # Exercise the same CI result through the pinned evidence wrapper. Unknown
  # commands fail closed so a new wrapper cannot silently bypass the red fixture.
  cat > "$TMP/tbin/npx" <<'FAKE'
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
  chmod +x "$TMP/tbin/gh" "$TMP/tbin/npm" "$TMP/tbin/npx"
}
# The train runs with INT and TERM at their DEFAULT disposition. ci.sh runs this
# file as a background lane, and a background job of a non-interactive shell
# starts with SIGINT ignored; bash cannot un-ignore a signal ignored on entry, so
# the INT case below then got exit 1 every time inside the gate while passing
# alone (2026-10-29, MyndHyve overlay gate, two reds). perl resets both before exec.
DEFAULT_SIGNALS=""
command -v perl >/dev/null 2>&1 && DEFAULT_SIGNALS="perl -e \$SIG{INT}=\$SIG{TERM}='DEFAULT';exec(@ARGV)||die"
run_train() { # <bus mode> <pr>…
  local m="$1"; shift
  local BUSV=on FM=""; case "$m" in off) BUSV=off ;; unauth|hang) FM="$m" ;; esac
  ( cd "$TMP/repo" && PATH="$TMP/tbin:$BIN:$PATH" FAKE_DIR="$TMP/fake" FAKE_REPO="$TMP/repo" FAKE_ORIGIN="$TMP/origin.git" \
      FAKE_GCS="$TMP/gcs" FAKE_GCLOUD_MODE="$FM" OPENWOP_RELEASE_BUS="$BUSV" OPENWOP_RELEASE_BUS_TIMEOUT_MS=1500 OPENWOP_RELEASE_BUS_HOST=hosta \
      OPENWOP_TRAIN_DIR="$TMP/repo-train" $DEFAULT_SIGNALS \
        bash -c 'export FAKE_TRAIN_PID=$$; exec bash scripts/merge-train.sh "$@"' _ "$@" > "$TMP/train.out" 2>&1; echo $? )
}
for m in ok unauth hang off; do
  setup_train; fresh
  check "$(run_train "$m" 1)" "0" "merge-train green with the bus $m: exit 0"
  check "$([ -e "$TMP/repo-train.lock" ] && echo held || echo free)" "free" "  ...the train lock is released"
  if [ "$m" = ok ]; then
    check "$(Q 'q.active.length')" "0" "  ...its active entry is released"
    check "$(cat "$TMP"/gcs/events__* | grep -c '"phase":"result"[^}]*"result":"GREEN"')" "1" "  ...it published a GREEN result"
  fi
  setup_train; fresh
  check "$(run_train "$m" 2)" "1" "merge-train red with the bus $m: exit 1"
  if [ "$m" = ok ]; then
    check "$(cat "$TMP"/gcs/events__* | grep -c '"result":"RED #2"')" "1" "  ...it published RED #2"
  fi
done

# A pending TERM during the gate must not publish GREEN. Without the train's
# explicit signal handler, Bash's EXIT hook can observe zero (incident 2026-10-27).
for signal in TERM INT; do
  case "$signal" in TERM) want=143 ;; INT) want=130 ;; esac
  setup_train; fresh
  check "$(FAKE_TRAIN_SIGNAL="$signal" run_train ok 1)" "$want" "interrupted train $signal exits $want"
  check "$(Q 'q.active.length')" "0" "  ...the interrupted train releases its bus lease"
  check "$([ -e "$TMP/repo-train.lock" ] && echo held || echo free)" "free" "  ...the interrupted train releases its local lock"
  check "$(cat "$TMP"/gcs/events__* | grep -c '"result":"GREEN"')" "0" "  ...the interrupted train never publishes GREEN"
  check "$(cat "$TMP"/gcs/events__* | grep -c "\"result\":\"STOPPED rc=$want\"")" "1" "  ...the bus result preserves the signal exit"
  check "$([ -f "$TMP/fake/merged-1" ] && echo merged || echo open)" "open" "  ...an interrupted gate never merges"
done

echo
echo "release bus: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
