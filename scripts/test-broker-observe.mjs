// ADR 0974 — broker observe mode: the vendored broker is byte-identical to its
// manifest, and `broker_observe` never blocks, never fails its caller, can be
// switched off, registers a gate inside a train only once, and its observer ends
// with the script it watches. P2: every class but `daemon` registers with
// `--yield`, a daemon lease then stops for it (exit 75), a gate and a train
// register before they wait. The daemon polls mid-run under a lease too, and takes
// no lease from a broker that runs other broker code (2026-10-26 correction).
//   node --test --test-concurrency=1 scripts/test-broker-observe.mjs
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// ADR 0991 — the scripts under test publish to the real cross-machine release bus
// by default; a test must never write to it.
process.env.OPENWOP_RELEASE_BUS = 'off';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'scripts', 'vendor', 'tracegate-ci');
const HELPER = path.join(ROOT, 'scripts', 'lib', 'broker-observe.sh');
const MAIN = path.join(VENDOR, 'src', 'broker', 'main.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owp-observe-test-')));
const env = { ...process.env, TRACEGATE_BROKER_DIR: path.join(tmp, 'broker'), TRACEGATE_BROKER_SOCKET: path.join(tmp, 's.sock'), TRACEGATE_BROKER_ADAPTIVE: 'off', TRACEGATE_BROKER_CAPACITY: '4' };
delete env.OPENWOP_BROKER_OBSERVED; delete env.OPENWOP_BROKER_OBSERVE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = () => { try { return fs.readFileSync(path.join(env.TRACEGATE_BROKER_DIR, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sh = (script, extra = {}, root = ROOT) => spawnSync('/bin/bash', ['-c', `set -u; ROOT=${JSON.stringify(root)}; . ${JSON.stringify(HELPER)}; ${script}`], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 20000 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.after(() => {
  spawnSync(process.execPath, [MAIN, 'stop'], { env, cwd: ROOT, encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the vendored broker is byte-identical to its VENDORED.md manifest', () => {
  const md = fs.readFileSync(path.join(VENDOR, 'VENDORED.md'), 'utf8');
  const rows = [...md.matchAll(/^([0-9a-f]{64})\s+(\S+)$/gm)];
  assert.ok(rows.length >= 9, 'the manifest lists config.mjs and every broker file');
  for (const [, sum, rel] of rows) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR, rel))).digest('hex');
    assert.equal(got, sum, `${rel} differs from the manifest: re-vendor from upstream, do not edit in place`);
  }
  const listed = new Set(rows.map((r) => r[2]));
  for (const f of fs.readdirSync(path.join(VENDOR, 'src', 'broker'))) assert.ok(listed.has(`src/broker/${f}`), `src/broker/${f} is not in the manifest`);
});

test('off: OPENWOP_BROKER_OBSERVE=off registers nothing', async () => {
  const r = sh('broker_observe gate 2 "off test"; echo "rc=$?"', { OPENWOP_BROKER_OBSERVE: 'off' });
  assert.match(r.stdout, /rc=0/);
  await sleep(1500);
  assert.equal(events().filter((e) => e.label === 'off test').length, 0);
});

test('never fails and never blocks: no broker in the tree → returns 0 at once', () => {
  const empty = path.join(tmp, 'no-vendor'); fs.mkdirSync(empty, { recursive: true });
  const t0 = Date.now();
  const r = sh('broker_observe gate gate "no broker"; echo "rc=$?"', {}, empty);
  assert.match(r.stdout, /rc=0/);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test('live: a script\'s work is registered as observed, and the observer ends with the script', async () => {
  const r = sh('broker_observe train 2 "train live-test"; echo "pid=$$"; sleep 3');
  const pid = Number(/pid=(\d+)/.exec(r.stdout)?.[1]);
  assert.ok(pid > 1, r.stdout + r.stderr);
  let g = null;
  for (let i = 0; i < 40 && !g; i++) { await sleep(250); g = events().find((e) => e.type === 'grant' && e.observed && events().some((q) => q.type === 'enqueue' && q.id === e.id && q.label === 'train live-test')); }
  assert.ok(g, `no observed grant: ${JSON.stringify(events().slice(-5))}`);
  assert.equal(events().find((e) => e.type === 'enqueue' && e.id === g.id).class, 'train');
  // The bash script has exited (spawnSync returned); its observer must follow within its 2 s poll.
  assert.equal(alive(pid), false);
  let released = false;
  for (let i = 0; i < 40 && !released; i++) { await sleep(250); released = events().some((e) => e.type === 'release' && e.id === g.id); }
  assert.ok(released, 'the observed lease is released once the watched script exits');
});

test('a gate inside a train is registered once, not twice', async () => {
  const before = events().filter((e) => e.type === 'enqueue').length;
  // ROOT is exported, so the inner script COULD register: only the rule stops it.
  sh('export ROOT; broker_observe train gate "train nested-test"; bash -c \'. "$0"; broker_observe gate gate "gate nested-test"\' ' + JSON.stringify(HELPER) + '; sleep 2');
  await sleep(1500);
  const added = events().filter((e) => e.type === 'enqueue').slice(before).map((e) => e.label);
  assert.deepEqual(added, ['train nested-test'], JSON.stringify(added));
});

test('P2: gate, train, deploy and measure register with yield; the daemon does not; OPENWOP_BROKER_YIELD=off drops it', async () => {
  sh('broker_observe gate 1 "y-gate"; broker_observe daemon 1 "y-daemon"; sleep 2');
  sh('broker_observe deploy 1 "y-off"; sleep 2', { OPENWOP_BROKER_YIELD: 'off' });
  await sleep(1500);
  const enq = (label) => events().find((e) => e.type === 'enqueue' && e.label === label);
  assert.equal(enq('y-gate')?.yieldOthers, true, JSON.stringify(enq('y-gate')));
  assert.equal(enq('y-daemon')?.yieldOthers, undefined, JSON.stringify(enq('y-daemon')));
  assert.equal(enq('y-off')?.yieldOthers, undefined, JSON.stringify(enq('y-off')));
});

test('P2 live: a daemon lease is stopped (exit 75) when a gate registers', async () => {
  const { spawn } = await import('node:child_process');
  const d = spawn(process.execPath, [MAIN, 'lease', '--quiet', '--class', 'daemon', '--tokens', '1', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'], { env, cwd: ROOT, stdio: 'ignore' });
  let granted = false;
  for (let i = 0; i < 40 && !granted; i++) { await sleep(250); granted = events().some((e) => e.type === 'grant' && events().some((q) => q.type === 'enqueue' && q.id === e.id && q.class === 'daemon' && !q.observe)); }
  assert.ok(granted, 'the daemon lease was granted');
  const code = new Promise((r) => d.on('exit', r));
  sh('broker_observe gate gate "gate yield-test"; sleep 4');
  const rc = await Promise.race([code, sleep(10000).then(() => 'still running')]);
  if (rc !== 75) d.kill('SIGKILL');
  assert.equal(rc, 75);
});

test('P2: a gate registers before the preflight wait, and a train before its lock', () => {
  const ci = fs.readFileSync(path.join(ROOT, 'scripts', 'ci.sh'), 'utf8');
  assert.ok(ci.indexOf('broker_observe gate gate') > 0 && ci.indexOf('broker_observe gate gate') < ci.indexOf('exec bash "$ROOT/scripts/preflight-suite.sh" --ci-exec'), 'ci.sh: broker_observe must come before the preflight exec');
  const tr = fs.readFileSync(path.join(ROOT, 'scripts', 'merge-train.sh'), 'utf8');
  assert.ok(tr.indexOf('broker_observe train gate') > 0 && tr.indexOf('broker_observe train gate') < tr.indexOf('claim_train_lock "$TRAIN_LOCK"'), 'merge-train.sh: broker_observe must come before claim_train_lock');
});

test('P2: the daemon runs each tick under a daemon lease, and polls mid-run under it too (backstop)', () => {
  const d = fs.readFileSync(path.join(ROOT, 'scripts', 'tracegate-daemon.sh'), 'utf8');
  assert.match(d, /"\$BROKER_MAIN" lease --quiet --class daemon /);
  // Every mid-run kill goes through yield_mid_run, which polls in EVERY mode: a broker
  // that ignores --yield (2026-10-26: a stale server) must not leave a gate waiting a batch.
  for (const m of d.matchAll(/^.*kill_tree "\$vp".*$/gm)) assert.match(m[0], /if yield_mid_run; then/, m[0]);
  assert.match(d, /^yield_mid_run\(\) \{ gate_live; \}$/m);
  // A stale broker is checked BEFORE a lease is taken, and sends the tick to legacy yielding.
  assert.ok(d.indexOf('broker_stale; then') > 0 && d.indexOf('broker_stale; then') < d.indexOf('"$BROKER_MAIN" lease'), 'broker_stale is checked before the lease');
  assert.match(d, /broker_stale; then\n.*\n\s*DAEMON_YIELD=legacy tick_work; return 0/);
  assert.match(d, /2\) say "no broker lease .*DAEMON_YIELD=legacy tick_work/);
});

// broker_stale, run for real: a fake "server" whose argv names a broker directory.
test('broker_stale: a server running other broker code is stale; ours, or none, is not', () => {
  const d = fs.readFileSync(path.join(ROOT, 'scripts', 'tracegate-daemon.sh'), 'utf8');
  const fn = d.match(/^broker_stale\(\) \{\n[\s\S]*?^\}\n/m)?.[0];
  assert.ok(fn, 'broker_stale is defined');
  const ledger = path.join(tmp, 'stale-ledger');
  const host = 'h1';
  fs.mkdirSync(path.join(ledger, 'broker', host), { recursive: true });
  const mk = (name, bytes) => { const dir = path.join(tmp, name, 'src', 'broker'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'core.mjs'), bytes); fs.writeFileSync(path.join(dir, 'main.mjs'), ''); return path.join(dir, 'main.mjs'); };
  const ours = fs.readFileSync(path.join(VENDOR, 'src', 'broker', 'core.mjs'));
  const run = (mainPath) => {
    let fake = null;
    if (mainPath) {
      fake = spawnSync('/bin/bash', ['-c', `(exec -a "node ${mainPath} serve" sleep 30) >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim();
      fs.writeFileSync(path.join(ledger, 'broker', host, 'broker.pid'), fake);
    } else fs.rmSync(path.join(ledger, 'broker', host, 'broker.pid'), { force: true });
    const r = spawnSync('/bin/bash', ['-c', `set -u; ROOT=${JSON.stringify(ROOT)}; LEDGER=${JSON.stringify(ledger)}; OPENWOP_TRACEGATE_HOST=${host}; BROKER_STALE_WHY=; ${fn}\nif broker_stale; then echo "STALE $BROKER_STALE_WHY"; else echo FRESH; fi`], { encoding: 'utf8', timeout: 10000 });
    if (fake) try { process.kill(Number(fake)); } catch { /* gone */ }
    return r.stdout.trim();
  };
  assert.match(run(mk('old-tree', 'export const OLD = 1;\n')), /^STALE pid \d+ serves .*old-tree.* differs/, 'other core.mjs bytes → stale');
  const same = mk('same-tree', ours);
  // Same bytes, written BEFORE the server starts → fresh.
  fs.utimesSync(path.join(path.dirname(same), 'core.mjs'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(run(same), 'FRESH', 'the same core.mjs → not stale');
  assert.equal(run(null), 'FRESH', 'no server → not stale (the lease starts ours)');
});
