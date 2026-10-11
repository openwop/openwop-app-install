/** ADR 0863: real process trees and the actual deploy wrapper; providers are stubs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supervisor = path.join(root, 'scripts/lib/owned-process.mjs');
const checked = (exe, args, opts) => {
  const p = spawnSync(exe, args, { encoding: 'utf8', ...opts });
  assert.equal(p.status, 0, p.stderr); return p.stdout.trim();
};
function launch(exe, args, opts = {}) {
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, output })); });
  return { child, done };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('process did not exit within 10 seconds')), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await delay(25); }
  throw new Error('fixture did not become ready');
}
function signal(pid, sig = 'SIGKILL') { try { process.kill(pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
function fixture() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-deploy-test-')));
  const beat = path.join(temp, 'beat'), pidfile = path.join(temp, 'grandchild.pid');
  const grandchild = path.join(temp, 'grandchild.mjs'), leader = path.join(temp, 'leader.mjs');
  fs.writeFileSync(grandchild, `import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),25);`);
  fs.writeFileSync(leader, `import{spawn}from'node:child_process';spawn('/bin/sh',['-c',JSON.stringify(process.execPath)+' '+JSON.stringify(${JSON.stringify(grandchild)})],{stdio:'inherit'});setInterval(()=>{},1000);`);
  return { temp, beat, pidfile, leader, cleanup() { if (fs.existsSync(pidfile)) signal(Number(fs.readFileSync(pidfile))); fs.rmSync(temp, { recursive: true, force: true }); } };
}
async function stopped(f) {
  const before = fs.readFileSync(f.beat).length; await delay(200);
  assert.equal(fs.readFileSync(f.beat).length, before, 'TERM-resistant descendant survived cancellation');
  const pid = Number(fs.readFileSync(f.pidfile));
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  assert(!state.stdout.trim() || state.stdout.trim().startsWith('Z'), `descendant ${pid} still running: ${state.stdout}`);
}
for (const code of [0, 7]) test(`owned supervisor preserves child exit ${code}`, async () => {
  const p = launch(process.execPath, [supervisor, root, process.execPath, '-e', `process.exit(${code})`]);
  assert.equal((await bounded(p.done)).code, code);
});
test('owned supervisor refuses a missing executable', async () => {
  const p = launch(process.execPath, [supervisor, root, '/does-not-exist-owned-deploy-test']);
  const result = await bounded(p.done); assert.equal(result.code, 1); assert.match(result.output, /ENOENT/);
});
for (const sig of ['SIGTERM', 'SIGINT']) test(`owned supervisor cancels resistant descendants on ${sig}, preserving a foreign process`, async () => {
  const f = fixture(); const foreign = launch(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const p = launch(process.execPath, [supervisor, f.temp, process.execPath, f.leader]);
  try {
    await until(() => fs.existsSync(f.beat)); p.child.kill(sig);
    assert.equal((await bounded(p.done)).code, sig === 'SIGTERM' ? 143 : 130);
    await stopped(f); assert.equal(foreign.child.exitCode, null); process.kill(foreign.child.pid, 0);
  } finally { p.child.kill('SIGTERM'); signal(foreign.child.pid); await bounded(foreign.done); f.cleanup(); }
});

function deployFixture(mode) {
  const f = fixture(); const repo = path.join(f.temp, 'repo'), bin = path.join(f.temp, 'bin');
  fs.mkdirSync(path.join(repo, 'scripts/lib'), { recursive: true }); fs.mkdirSync(bin);
  for (const name of ['scripts/deploy.sh', 'scripts/lib/owned-process.mjs']) fs.copyFileSync(path.join(root, name), path.join(repo, name));
  for (const name of ['write-build-commit.mjs', 'check-deploy-conformance-install.mjs']) fs.writeFileSync(path.join(repo, 'scripts', name), 'process.exit(0);');
  fs.writeFileSync(path.join(repo, 'scripts/preflight-deploy.sh'), '#!/bin/bash\n[ "$TEST_MODE" != preflight-fail ]\n');
  fs.writeFileSync(path.join(repo, 'scripts/check-conformance-major2.sh'), '#!/bin/bash\nexec npm run fixture-major2\n');
  fs.mkdirSync(path.join(repo, 'frontend/react/node_modules'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'backend/typescript/node_modules/@openwop/openwop-conformance'), { recursive: true });
  checked('git', ['init', '-q', repo]); checked('git', ['-C', repo, 'config', 'user.name', 'test']); checked('git', ['-C', repo, 'config', 'user.email', 'test@invalid']);
  checked('git', ['-C', repo, 'add', 'scripts']); checked('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  fs.writeFileSync(path.join(repo, 'scripts/deploy.env'), ['OPENWOP_DEPLOY_SERVICE=fixture','OPENWOP_DEPLOY_PROJECT=fixture','OPENWOP_DEPLOY_REGION=fixture','OPENWOP_DEPLOY_ACCOUNT=fixture','OPENWOP_DEPLOY_HOSTING_TARGET=fixture','OPENWOP_DEPLOY_FIREBASE_PROJECT=fixture','OPENWOP_DISTRIBUTION=openwop-app','BASE=http://invalid'].join('\n'));
  const calls = path.join(f.temp, 'provider.calls'), completed = path.join(f.temp, 'frontend.done'), certPid = path.join(f.temp, 'cert-child.pid');
  const scripts = {
    npm: `#!/bin/bash\nif [ "$PWD" = "$TEST_REPO/frontend/react" ]; then\n [ "$OPENWOP_BUILD_COMMIT" = "$TEST_SHA" ] && [ "$OPENWOP_DISTRIBUTION" = openwop-app ] || exit 84\n case "$TEST_MODE" in frontend-fail|frontend-serial-fail) exit 7;; success) touch "$TEST_COMPLETED";exit 0;; *) exec "$TEST_NODE" "$TEST_LEADER";; esac\nelse\n case "$TEST_MODE" in image-*) [ -z "$OPENWOP_CERT_BUNDLE_ORIGIN" ] || exit 85;; major2-*) [ "$OPENWOP_CERT_BUNDLE_ORIGIN" = fixture-origin ] || exit 86;; esac\n while [ ! -f "$TEST_BEAT" ]; do sleep 0.02; done\n case "$TEST_MODE" in image-cancel|major2-cancel) sleep 2 & echo "$!" > "$TEST_CERT_PID";wait;; esac\n exit 9\nfi\n`,
    gcloud: '#!/bin/bash\necho "gcloud $*" >> "$TEST_CALLS"\n[ -f "$TEST_COMPLETED" ] || { echo frontend-not-done >&2; exit 98; }\nexit 97\n',
    firebase: '#!/bin/bash\necho "firebase $*" >> "$TEST_CALLS"\nexit 96\n',
  };
  for (const [name, bytes] of Object.entries(scripts)) { fs.writeFileSync(path.join(bin, name), bytes); fs.chmodSync(path.join(bin, name), 0o755); }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_REPO: repo, TEST_MODE: mode, TEST_COMPLETED: completed, TEST_CALLS: calls, TEST_NODE: process.execPath, TEST_LEADER: f.leader, TEST_BEAT: f.beat, TEST_CERT_PID: certPid, TEST_SHA: checked('git', ['-C', repo, 'rev-parse', 'HEAD']), TMPDIR: f.temp };
  delete env.OPENWOP_CERT_BUNDLE_ORIGIN; delete env.OPENWOP_DEPLOY_FRONTEND_PARALLEL;
  if (mode === 'frontend-serial-fail') env.OPENWOP_DEPLOY_FRONTEND_PARALLEL = '0';
  // ADR 0869 — image mode (origin empty) builds no image bundle and still runs the major-2 ratchet.
  if (mode.startsWith('image-')) env.OPENWOP_CERT_BUNDLE_ORIGIN = '';
  if (mode.startsWith('major2-')) env.OPENWOP_CERT_BUNDLE_ORIGIN = 'fixture-origin';
  return { ...f, repo, env, calls, completed, certPid };
}
for (const mode of ['frontend-fail', 'frontend-serial-fail', 'image-fail', 'image-cancel', 'major2-fail', 'major2-cancel', 'cancel', 'success', 'preflight', 'preflight-fail']) test(`actual deploy wrapper ${mode} honors build/write/cancellation boundary`, async () => {
  const f = deployFixture(mode);
  const args = ['scripts/deploy.sh', '--ignore-hour-window'];
  if (!mode.startsWith('image-') && !mode.startsWith('major2-')) args.push('--skip-certify');
  if (mode === 'preflight') args.push('--preflight-only');
  const p = launch('bash', args, { cwd: f.repo, env: f.env, detached: true });
  try {
    let cancelledAt;
    if (mode.endsWith('cancel')) { await until(() => fs.existsSync(f.beat) && (mode === 'cancel' || fs.existsSync(f.certPid))); cancelledAt = Date.now(); p.child.kill('SIGTERM'); }
    const result = await bounded(p.done);
    if (mode === 'preflight') { assert.equal(result.code, 0, result.output); assert(!fs.existsSync(f.beat)); }
    else assert.equal(result.code, cancelledAt ? 143 : 1, result.output);
    if (mode === 'success') {
      assert(fs.existsSync(f.completed)); assert.match(fs.readFileSync(f.calls, 'utf8'), /gcloud run deploy/);
      assert.match(result.output, /backend FAILED/); // Stub refuses first provider write; nothing external happens.
    } else assert(!fs.existsSync(f.calls), result.output);
    if (mode === 'image-fail') { assert.match(result.output, /image mode serves no major-2 evidence/); assert.doesNotMatch(result.output, /certify lane FAILED/); assert.match(result.output, /major-2 lane regressed/); await stopped(f); }
    if (mode === 'major2-fail') { assert.match(result.output, /major-2 lane regressed/); await stopped(f); }
    if (cancelledAt) { assert(Date.now() - cancelledAt < 1500, 'TERM was deferred until the foreground certification finished'); await stopped(f); }
    if (fs.existsSync(f.certPid)) {
      const state = spawnSync('ps', ['-o', 'stat=', '-p', fs.readFileSync(f.certPid, 'utf8').trim()], { encoding: 'utf8' });
      assert(!state.stdout.trim() || state.stdout.trim().startsWith('Z'), 'owned certification child survived cancellation');
    }
    if (mode.startsWith('frontend-')) assert.match(result.output, /frontend build FAILED/);
    if (mode === 'preflight-fail') { assert.match(result.output, /aborted by preflight/); assert(!fs.existsSync(f.beat)); }
  } finally {
    p.child.kill('SIGTERM');
    if (p.child.exitCode === null) { await delay(750); signal(-p.child.pid); }
    f.cleanup();
  }
});
