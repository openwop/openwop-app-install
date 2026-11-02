import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { remoteGateControl, runRemoteGate } from './lib/remote-gate-controller.mjs';
import { admitRemoteGateJob, readRemoteGateJob } from './lib/remote-gate-job.mjs';

// The real worker entry, runner, supervisor, canonical gate command and
// controller, end to end on this machine. Only `npm` and `npx` are stubs (the
// stub `npx hyvemind gate` writes evidence and a browser-ledger row the way the
// real gate does), and the SSH hop is a local pipe: transport is qualified
// separately. Synthetic candidate repository; no real gate (ADR 0863 D9 P2).
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const supported = { skip: !['darwin', 'linux'].includes(process.platform) };
const HOST_KEY = 'SHA256:' + 'A'.repeat(43);
const FAST = { sampleMs: 25, quietMs: 60, graceMs: 400 };

function privateDir(parent, name) { const d = join(parent, name); mkdirSync(d, { mode: 0o700 }); return d; }
function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
}

function stubs(dir) {
  const bin = privateDir(dir, 'bin');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$1" = --version ] && { echo 10.9.8; exit 0; }\nexit 0\n');
  // `npx -y hyvemind@0.2.0 gate`: evidence + ledger row inside the gate interval.
  writeFileSync(join(bin, 'npx'), `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (!process.argv.includes('hyvemind@0.2.0')) process.exit(0); // e.g. playwright install
const mode = process.env.STUB_GATE || 'green';
if (mode === 'slow') sleep(60000);
const startedAt = new Date(); const g = a => execFileSync('/usr/bin/git', a, { encoding: 'utf8' }).trim();
const head = g(['rev-parse', 'HEAD']); const tree = g(['rev-parse', 'HEAD^{tree}']);
const rowAt = new Date(Math.ceil((startedAt.getTime() + 1) / 1000) * 1000);
sleep(rowAt - Date.now() + 50);
appendFileSync('.openwop-ci-e2e-ledger', rowAt.toISOString().replace('.000Z', 'Z') + '\\t' + head.slice(0, 9) + '\\tran:pass;serial=pass\\n');
sleep(50); const finishedAt = new Date(); const pass = mode !== 'red';
mkdirSync('.hyve/evidence', { recursive: true });
writeFileSync('.hyve/evidence/gate-' + startedAt.toISOString().replace(/[:.]/g, '-') + '.json', JSON.stringify({
  tool: 'hyvemind', version: '0.2.0', head: mode === 'wrong-head' ? '0'.repeat(40) : head,
  treeBefore: tree, treeAfter: tree, partial: false, verdict: pass ? 'green' : 'red',
  startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
  gates: [{ run: 'npm run ci', exitCode: pass ? 0 : 3, pass, durationMs: finishedAt - startedAt }] }));
process.exit(pass ? 0 : 3);
`);
  chmodSync(join(bin, 'npm'), 0o755); chmodSync(join(bin, 'npx'), 0o755);
  return bin;
}

function fixture(t, { gate = 'green', workerRunner = 'fixture-runner' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-gate-e2e-')); chmodSync(dir, 0o700);
  t.after(() => { if (!process.env.KEEP_E2E) rmSync(dir, { recursive: true, force: true }); else console.error('KEPT ' + dir); });
  const repo = privateDir(dir, 'candidate');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.openwop-ci-e2e-ledger\n.hyve/evidence/\n');
  writeFileSync(join(repo, 'README.md'), 'candidate\n');
  for (const ws of ['backend/typescript', 'frontend/react']) { mkdirSync(join(repo, ws), { recursive: true }); writeFileSync(join(repo, ws, 'package.json'), '{}\n'); }
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
  const main = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'update-ref', 'refs/remotes/origin/main', main);
  writeFileSync(join(repo, 'change.txt'), 'candidate change\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'candidate');
  const commit = git(repo, 'rev-parse', 'HEAD').trim();
  const policySha256 = 'a'.repeat(64);
  const config = {
    root: privateDir(dir, 'jobs'), spoolRoot: privateDir(dir, 'spool'), runnerRoot: privateDir(dir, 'runner'),
    logRoot: privateDir(dir, 'logs'), trust: { runnerId: workerRunner, policySha256 },
    node: process.execPath, installDir: SCRIPTS, launcher: 'detach', timing: FAST,
    env: { PATH: `${stubs(dir)}:/usr/bin:/bin`, STUB_GATE: gate, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  };
  const configPath = join(dir, 'worker.json'); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  // Local stand-in for SSH: the real worker entry on a pipe. The host key is the
  // fixture pin, as the SSH connector would report after strict checking.
  const connect = () => {
    const child = spawn(process.execPath, [join(SCRIPTS, 'remote-gate-worker.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', OPENWOP_CI_WORKER_CONFIG: configPath } });
    let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { stderr += d; });
    const exit = new Promise(resolve => child.once('close', code => resolve(code)));
    return { stdin: child.stdin, stdout: child.stdout, exit, authenticatedHostKey: exit.then(() => HOST_KEY), stderr: () => stderr };
  };
  const trust = { runnerId: 'fixture-runner', policySha256, hostKey: HOST_KEY };
  const local = { repo, home: privateDir(dir, 'home'), commit, main, trust, workRoot: privateDir(dir, 'work'), connect, pollMs: 100 };
  const jobs = () => readdirSync(config.root).filter(n => /^[a-f0-9]{32}$/.test(n)).map(id =>
    readRemoteGateJob({ root: config.root, trust: config.trust, requestBytes: readFileSync(join(config.root, id, 'request.json')) }));
  return { dir, config, local, jobs };
}

test('a green remote gate is fetched and accepted by the local validator', supported, async t => {
  const f = fixture(t);
  const outcome = await runRemoteGate(f.local);
  assert.equal(outcome.verdict, 'green', JSON.stringify(outcome));
  assert.equal(outcome.accepted.commit, f.local.commit);
  assert.equal(outcome.accepted.requiredBrowser, 'pass');
  assert.equal(outcome.accepted.mergeAuthorized, false, 'acceptance never authorizes a merge');
  const [job] = f.jobs();
  assert.equal(job.state, 'completed');
  assert.equal(job.details.exitCode, 0);
  assert.deepEqual(readdirSync(f.config.runnerRoot), [], 'the rebuilt checkout is removed');
  assert(existsSync(join(f.config.logRoot, `${job.id}.log`)), 'the gate log is kept');
});

test('a red remote gate is red, with its exit code, and nothing is fetched', supported, async t => {
  const f = fixture(t, { gate: 'red' });
  const logDir = privateDir(f.dir, 'kept-logs');
  const outcome = await runRemoteGate({ ...f.local, logDir });
  assert.equal(outcome.verdict, 'red');
  assert.match(readFileSync(outcome.log, 'utf8'), /gate exit 3/, 'the red gate log comes home through the log operation');
  assert.deepEqual([outcome.status.state, f.jobs()[0].details.exitCode], ['failed', 3]);
  assert.match(readFileSync(join(f.config.logRoot, `${outcome.id}.log`), 'utf8'), /gate exit 3/);
});

test('evidence for another commit is refused locally: fallback, never green', supported, async t => {
  const f = fixture(t, { gate: 'wrong-head' });
  const outcome = await runRemoteGate(f.local);
  assert.equal(outcome.verdict, 'fallback');
  assert.equal(outcome.reason, 'remote evidence refused');
  assert.match(outcome.detail, /another commit/);
  assert.equal(f.jobs()[0].state, 'completed', 'the worker completed; only the local reader refused it');
});

test('an unfinished job makes the worker busy: fallback, and no second job is admitted', supported, async t => {
  const f = fixture(t);
  const now = Date.now();
  const other = Buffer.from(JSON.stringify({ version: 1, id: '9'.repeat(32), createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(), commit: 'b'.repeat(40), tree: 'c'.repeat(40), main: 'd'.repeat(40),
    refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), ...f.config.trust }));
  admitRemoteGateJob({ root: f.config.root, trust: f.config.trust, requestBytes: other, now });
  const outcome = await runRemoteGate(f.local);
  assert.deepEqual([outcome.verdict, outcome.reason], ['fallback', 'worker busy']);
  assert.equal(f.jobs().length, 1, 'nothing new was admitted');
  assert.deepEqual(readdirSync(f.config.runnerRoot), [], 'no checkout was left behind');
});

test('jobs journaled under an earlier policy never make the worker busy', supported, async t => {
  const f = fixture(t);
  const now = Date.now();
  const old = Buffer.from(JSON.stringify({ version: 1, id: '8'.repeat(32), createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(), commit: 'b'.repeat(40), tree: 'c'.repeat(40), main: 'd'.repeat(40),
    refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), runnerId: f.config.trust.runnerId, policySha256: 'b'.repeat(64) }));
  admitRemoteGateJob({ root: f.config.root, trust: { ...f.config.trust, policySha256: 'b'.repeat(64) }, requestBytes: old, now });
  const outcome = await runRemoteGate(f.local);
  assert.equal(outcome.verdict, 'green', 'an unfinished job from the old policy is retired, not busy');
});

test('a request for another runner is refused before any checkout: fallback', supported, async t => {
  const f = fixture(t, { workerRunner: 'some-other-runner' });
  const outcome = await runRemoteGate(f.local);
  assert.deepEqual([outcome.verdict, outcome.reason], ['fallback', 'worker refused']);
  assert.equal(f.jobs().length, 0);
  assert.deepEqual(readdirSync(f.config.runnerRoot), []);
});

test('a timed-out remote gate is cancelled on the worker with verified cleanup: fallback', supported, async t => {
  const f = fixture(t, { gate: 'slow' });
  const outcome = await runRemoteGate({ ...f.local, maxMs: 1500 });
  assert.deepEqual([outcome.verdict, outcome.reason], ['fallback', 'remote gate timed out']);
  let job;
  for (let i = 0; i < 200; i++) { job = f.jobs()[0]; if (job.state === 'cancelled') break; await delay(50); }
  assert.equal(job.state, 'cancelled');
  assert.equal(job.details.cleanup, 'verified');
  const status = await remoteGateControl({ connect: f.local.connect, operation: 'status', spoolRoot: f.local.workRoot,
    requestBytes: readFileSync(join(f.config.root, job.id, 'request.json')) });
  assert.equal(status.code, 0, 'status still answers after the job ended');
  rmSync(status.frame.work, { recursive: true, force: true });
});
