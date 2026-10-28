// ADR 0971 — the adaptive Vitest width: the pure rules, the CLI, and the ci.sh
// wiring that matters most (shadow changes nothing; a broken tool narrows nothing).
//   node --test scripts/test-ci-width.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { learnedWorkerMB, widthFor } from './ci-width.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'ci-width.mjs');
const DEF = Math.max(1, (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) - 1);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owp-ci-width-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const decision = (o = {}) => ({ cpu: 7, memMB: Infinity, pressure: 'normal', why: [], ...o });

test('width: never above the default or the gate\'s own cap', () => {
  assert.equal(widthFor({ def: 7, cap: null, d: decision({ cpu: 9 }), workerMB: 1000, min: 2 }).width, 7);
  assert.equal(widthFor({ def: 7, cap: 4, d: decision(), workerMB: 1000, min: 2 }).width, 4);
});

test('width: busy cores that are not ours narrow it', () => {
  assert.equal(widthFor({ def: 7, cap: null, d: decision({ cpu: 3 }), workerMB: 1000, min: 2 }).width, 3);
});

test('width: memory narrows it, and says so', () => {
  const r = widthFor({ def: 7, cap: null, d: decision({ memMB: 2500 }), workerMB: 800, min: 2 });
  assert.equal(r.width, 3);
  assert.match(r.why.join(), /memory for 3 worker/);
});

test('width: never below the floor, and the floor never above the default', () => {
  assert.equal(widthFor({ def: 7, cap: null, d: decision({ cpu: 1, memMB: 0 }), workerMB: 800, min: 2 }).width, 2);
  assert.equal(widthFor({ def: 1, cap: null, d: decision({ cpu: 1 }), workerMB: 800, min: 2 }).width, 1);
});

test('learned memory per worker: p90 of this host\'s GREEN runs of that lane, from two rows', () => {
  const r = (lane, peakMB, used, rc = 0) => ({ lane, peakMB: String(peakMB), used: String(used), rc: String(rc) });
  assert.equal(learnedWorkerMB([r('backend', 7000, 7)], 'backend'), null);
  assert.equal(learnedWorkerMB([r('backend', 7000, 7), r('backend', 14000, 7), r('frontend', 99999, 1), r('backend', 99999, 1, 1)], 'backend'), 2000);
});

const sampleFile = path.join(tmp, 'sample.json');
const ledger = path.join(tmp, 'ledger');
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', env: { ...process.env, TRACEGATE_BROKER_SAMPLE_FILE: sampleFile, OPENWOP_CI_WIDTH_LEDGER: ledger, OPENWOP_CI_WORKER_MB: '', ...env },
});
const quiet = { cores: DEF + 1, busyCores: 0, load1: 0, totalMB: 65536, availMB: 60000, pressure: 'normal' };
const busy = { ...quiet, busyCores: DEF + 1, load1: DEF + 1 };

test('decide, shadow: suggests, never applies, and reports the width the lane really runs', () => {
  fs.writeFileSync(sampleFile, JSON.stringify(busy));
  const r = run(['decide', '--lane', 'backend'], { OPENWOP_CI_ADAPTIVE: 'shadow' });
  const [sug, apply, runs] = r.stdout.trim().split(' ');
  assert.equal(apply, '-');
  assert.equal(Number(runs), DEF);
  assert.equal(Number(sug), Math.min(2, DEF));
  assert.match(r.stderr, /adaptive width \(backend, shadow\): would run/);
  const capped = run(['decide', '--lane', 'frontend', '--cap', '4'], { OPENWOP_CI_ADAPTIVE: 'shadow' }).stdout.trim().split(' ');
  assert.equal(capped[2], '4', 'shadow reports the gate cap as what runs');
});

test('the default mode is ON (ADR 0971 P2): with no setting, the suggestion is applied', () => {
  fs.writeFileSync(sampleFile, JSON.stringify(busy));
  const [sug, apply] = run(['decide', '--lane', 'backend'], { OPENWOP_CI_ADAPTIVE: '' }).stdout.trim().split(' ');
  assert.equal(apply, sug);
  assert.notEqual(apply, '-');
});

test('decide, on: applies the suggestion; a quiet machine keeps the default', () => {
  fs.writeFileSync(sampleFile, JSON.stringify(busy));
  const [sug, apply] = run(['decide', '--lane', 'backend'], { OPENWOP_CI_ADAPTIVE: 'on' }).stdout.trim().split(' ');
  assert.equal(apply, sug);
  fs.writeFileSync(sampleFile, JSON.stringify(quiet));
  assert.equal(run(['decide', '--lane', 'backend'], { OPENWOP_CI_ADAPTIVE: 'on' }).stdout.trim().split(' ')[1], String(DEF));
});

test('decide, critical memory pressure: the floor', () => {
  fs.writeFileSync(sampleFile, JSON.stringify({ ...quiet, pressure: 'critical' }));
  assert.equal(run(['decide', '--lane', 'backend'], { OPENWOP_CI_ADAPTIVE: 'on' }).stdout.trim().split(' ')[1], String(Math.min(2, DEF)));
});

test('decide, off: nothing', () => {
  assert.equal(run(['decide', '--lane', 'backend'], { OPENWOP_CI_ADAPTIVE: 'off' }).stdout.trim(), '- - - -');
});

test('decide fails soft: an unreadable sample leaves the lane alone and exits 0', () => {
  fs.writeFileSync(sampleFile, '{not json');
  const r = run(['decide', '--lane', 'backend'], { OPENWOP_CI_ADAPTIVE: 'on' });
  assert.equal(r.status, 0);
  // No reading: the cpu and memory budgets stay open, so nothing is narrowed.
  assert.equal(r.stdout.trim().split(' ')[1], String(DEF));
});

test('record + report: one row per lane, and the learned memory reads it back', () => {
  const peak = path.join(tmp, 'peak'); fs.writeFileSync(peak, '7000');
  for (const mb of ['7000', '14000']) { fs.writeFileSync(peak, mb); assert.equal(run(['record', '--lane', 'backend', '--suggested', '3', '--used', '7', '--rc', '0', '--secs', '60', '--peak-file', peak, '--why', 'a\tb']).status, 0); }
  const rows = fs.readdirSync(ledger).filter((f) => f.startsWith('ci-width-'));
  assert.equal(rows.length, 1);
  const text = fs.readFileSync(path.join(ledger, rows[0]), 'utf8').trim().split('\n');
  assert.equal(text.length, 3);
  assert.equal(text[1].split('\t').length, 10, 'a tab inside why must not add a column');
  assert.match(run(['report']).stdout, /backend: 2 run\(s\); suggested narrower than used in 2 \(red 0\).*learned 2000 MB\/worker/);
});

test('watch: the peak RSS of a process tree, and it exits when the process does', async () => {
  const out = path.join(tmp, 'watch-peak');
  const hog = spawn(process.execPath, ['-e', 'const b=Buffer.alloc(150*1024*1024,1); setTimeout(()=>b.length,7000)']);
  const w = spawn(process.execPath, [CLI, 'watch', '--pid', String(hog.pid), '--out', out], { stdio: 'ignore' });
  const exited = new Promise((r) => w.on('exit', r));
  await new Promise((r) => hog.on('exit', r));
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('watcher outlived its process')), 8000))]);
  assert.ok(Number(fs.readFileSync(out, 'utf8')) >= 100, fs.readFileSync(out, 'utf8'));
});

// The ci.sh wiring, extracted and run against a fake `npm` that prints the width
// it was given. This is the property shadow mode stands on.
test('ci.sh: shadow leaves the width alone, on sets it, off skips, a broken tool narrows nothing', () => {
  const ci = fs.readFileSync(path.join(ROOT, 'scripts', 'ci.sh'), 'utf8').split('\n');
  const start = ci.findIndex((l) => l.startsWith('CW_SUG='));
  const tv = ci.findIndex((l) => l.startsWith('tg_vitest() {'));
  const end = ci.findIndex((l, i) => i > tv && l === '}');
  assert.ok(start > 0 && tv > start && end > tv, 'cw_* and tg_vitest must stay one block in ci.sh');
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "WIDTH=${VITEST_MAX_WORKERS-default}"\nexit 3\n', { mode: 0o755 });
  const lane = path.join(tmp, 'lane'); fs.mkdirSync(lane, { recursive: true });
  const harness = path.join(tmp, 'harness.sh');
  fs.writeFileSync(harness, `set -u\nROOT="$1"; shift\nTG_MODE=shadow; TG_ARGS=(); TG_LANE=backend; TG_RUN=""\n${ci.slice(start, end + 1).join('\n')}\nrc=0; tg_vitest lane "$@" || rc=$?\necho "RC=$rc"\n`);
  // broken: the tool throws. silent: it exits 0 and prints nothing (empty fields).
  const fakeRoot = (broken) => {
    const r = path.join(tmp, broken ? `root-${broken}` : 'root'); fs.mkdirSync(path.join(r, 'scripts', 'lib'), { recursive: true });
    fs.symlinkSync(lane, path.join(r, 'lane'), 'dir');
    if (broken) fs.writeFileSync(path.join(r, 'scripts', 'ci-width.mjs'), broken === 'silent' ? '' : 'throw new Error("boom")');
    else {
      fs.mkdirSync(path.join(r, 'scripts', 'vendor', 'tracegate-ci', 'src', 'broker'), { recursive: true });
      for (const f of ['ci-width.mjs', 'vendor/tracegate-ci/src/broker/adapt.mjs', 'vendor/tracegate-ci/src/broker/sampler.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(r, 'scripts', f));
    }
    return r;
  };
  const good = fakeRoot(false); const broken = fakeRoot('broken'); const silent = fakeRoot('silent');
  fs.writeFileSync(sampleFile, JSON.stringify(busy));
  const sh = (root, env, ...args) => spawnSync('/bin/bash', [harness, root, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACEGATE_BROKER_SAMPLE_FILE: sampleFile, OPENWOP_CI_WIDTH_LEDGER: ledger, VITEST_MAX_WORKERS: undefined, ...env } });
  const shadow = sh(good, { OPENWOP_CI_ADAPTIVE: 'shadow' });
  assert.match(shadow.stdout, /WIDTH=default/, shadow.stdout + shadow.stderr);
  assert.match(shadow.stdout, /RC=3/, 'the lane\'s exit code is returned');
  assert.match(shadow.stderr, /would run/);
  assert.match(sh(good, { OPENWOP_CI_ADAPTIVE: 'shadow' }, 'VITEST_MAX_WORKERS=4').stdout, /WIDTH=4/, 'shadow keeps the gate\'s own cap');
  assert.match(sh(good, { OPENWOP_CI_ADAPTIVE: undefined }).stdout, new RegExp(`WIDTH=${Math.min(2, DEF)}`), 'unset = on (P2)');
  assert.match(sh(good, { OPENWOP_CI_ADAPTIVE: 'on' }).stdout, new RegExp(`WIDTH=${Math.min(2, DEF)}`));
  assert.match(sh(good, { OPENWOP_CI_ADAPTIVE: 'on' }, 'VITEST_MAX_WORKERS=4').stdout, new RegExp(`WIDTH=${Math.min(2, DEF)}\\b`), 'on: the adaptive width wins over the cap');
  const off = sh(good, { OPENWOP_CI_ADAPTIVE: 'off' });
  assert.match(off.stdout, /WIDTH=default/); assert.doesNotMatch(off.stderr, /adaptive width/);
  // `default` (unset), never `WIDTH=` (set but empty): an empty width is not "no width".
  const b = sh(broken, { OPENWOP_CI_ADAPTIVE: 'on' });
  assert.match(b.stdout, /WIDTH=default/, b.stdout + b.stderr); assert.match(b.stdout, /RC=3/);
  const q = sh(silent, { OPENWOP_CI_ADAPTIVE: 'on' });
  assert.match(q.stdout, /WIDTH=default/, q.stdout + q.stderr); assert.match(q.stdout, /RC=3/);
});
