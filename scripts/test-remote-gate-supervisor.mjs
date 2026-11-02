import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { admitRemoteGateJob, readRemoteGateJob, requestRemoteGateCancellation,
  transitionRemoteGateJob } from './lib/remote-gate-job.mjs';
import { compareIdentity, linuxProcessTable, parseLinuxStat, parseMacosPsLine, processTableFor } from './lib/remote-gate-process.mjs';
import { sha256 } from './lib/remote-gate-result.mjs';
import { PUBLICATION_REFUSED_EXIT, recoverRemoteGateJob, runRemoteGateJob,
  superviseRemoteGate } from './lib/remote-gate-supervisor.mjs';

// Real processes, real process tables, real signals — but every signal this suite
// sends itself targets a process it spawned. Synthetic gate commands only: this does
// not qualify SSH, a worker host, or a real gate. Runs on macOS and Linux (ADR 0863
// D9); a few cases pin one platform's semantics and say so.
const darwin = process.platform === 'darwin';
const linux = process.platform === 'linux';
const native = () => processTableFor();
const supported = { skip: !darwin && !linux };
const FAST = { sampleMs: 25, quietMs: 60, graceMs: 400 };

function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  // kill(pid, 0) succeeds on a zombie. When an orphan's new parent never reaps
  // (node as PID 1 in a container), a killed process would read as alive and a
  // "never signalled" assertion would pass vacuously (found by mutant, 2026-10-31).
  if (!linux) return true;
  try { return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-gate-supervisor-'));
  const spawned = [];
  t.after(() => {
    for (const pid of spawned) if (alive(pid)) process.kill(pid, 'SIGKILL'); // only our own processes
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, own: pid => { spawned.push(pid); return pid; } };
}
async function readPid(path) {
  for (let i = 0; i < 200 && !existsSync(path); i++) await delay(10);
  return Number(readFileSync(path, 'utf8').trim());
}
/** A real table that records every pid it is asked to signal. */
function spied(table = native(), overrides = {}) {
  const signalled = [];
  return { table: { ...table, ...overrides, signal: (id, sig) => { signalled.push([id.pid, sig]); return table.signal(id, sig); } }, signalled };
}
async function stranger(s) {
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref(); await new Promise(resolve => child.once('spawn', resolve));
  return s.own(child.pid);
}

test('ps rows parse to full identities; an unparseable row is unknown, never different', () => {
  const row = parseMacosPsLine('  4242     1  4242   501 Wed Oct  8 19:35:24 2026 /bin/sleep');
  assert.deepEqual(row, { pid: 4242, ppid: 1, pgid: 4242, uid: 501, startedAt: 'Wed Oct 8 19:35:24 2026', executable: '/bin/sleep' });
  assert.equal(parseMacosPsLine('79266 1 79266 -2 Sun Oct 25 20:23:25 2026 /usr/libexec/dhcp6d').uid, -2);
  const unreadable = parseMacosPsLine('  4242     1  4242   501 ??? ');
  assert.deepEqual(unreadable, { pid: 4242, unreadable: true });
  assert.equal(compareIdentity(row, unreadable), 'unknown');
  assert.equal(compareIdentity(row, { ...row, startedAt: 'Wed Oct 8 19:35:25 2026' }), 'different');
  assert.equal(compareIdentity(row, undefined), 'gone');
  assert.equal(compareIdentity(row, { ...row }), 'same');
});

test('/proc stat rows parse to full identities; comm may hold spaces and parentheses', () => {
  const boot = '0f2b6c1e-8a4d-4c55-9b0e-3f6d2a1c9e77';
  const stat = '4242 (a) b (c) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10 18446744073709551615';
  assert.deepEqual(parseLinuxStat(stat, boot),
    { pid: 4242, ppid: 1, pgid: 4242, state: 'S', startedAt: `${boot}/987654`, executable: 'a) b (c' });
  assert.equal(parseLinuxStat('4242 (sleep', boot), null);
  assert.equal(parseLinuxStat('4242 (sleep) S 1 4242', boot), null, 'no starttime is no identity');
});

test('linux membership follows descendants of the holder and its group, never strangers', () => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10 }, { pid: 11, ppid: 10, pgid: 10 },
    { pid: 12, ppid: 11, pgid: 12 }, // left the group with setsid: still a descendant
    { pid: 13, ppid: 1, pgid: 10 },  // orphaned after the holder was lost: still the group
    { pid: 14, ppid: 1, pgid: 14 }, { pid: 15, unreadable: true },
  ];
  assert.deepEqual([...linuxProcessTable().members(rows, 10)].sort(), [11, 12, 13]);
});

test('each supported platform has a table; others are refused', () => {
  assert.equal(processTableFor('darwin').platform, 'darwin');
  assert.equal(processTableFor('linux').platform, 'linux');
  assert.throws(() => processTableFor('win32'), /unsupported/);
});

test('a reparented grandchild is found, stopped by pid, and verified', supported, async t => {
  const s = scratch(t); const pidFile = join(s.dir, 'grandchild'); const ppidFile = join(s.dir, 'ppid'); const holderFile = join(s.dir, 'holder');
  const { table, signalled } = spied();
  const result = await superviseRemoteGate({ ...FAST, table, command: '/bin/sh', args: ['-c',
    `echo $PPID > ${holderFile}; sh -c 'sleep 30 & echo $! > ${pidFile}'; sleep 0.3; ps -o ppid= -p "$(cat ${pidFile})" > ${ppidFile}; exit 0`] });
  const grandchild = s.own(Number(readFileSync(pidFile, 'utf8')));
  // macOS reparents an orphan to launchd; on Linux the subreaper holder adopts it.
  assert.equal(Number(readFileSync(ppidFile, 'utf8')), darwin ? 1 : Number(readFileSync(holderFile, 'utf8')),
    'grandchild was reparented away from its parent');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.cleanup, { cleanup: 'verified', owned: result.owned });
  assert.equal(alive(grandchild), false);
  assert(signalled.some(([pid]) => pid === grandchild), 'stopped by its own pid');
  assert(signalled.every(([pid]) => pid > 1), 'never a group or negative pid');
});

test('a TERM-ignoring gate is cancelled with KILL and still verified', supported, async t => {
  scratch(t); const { table, signalled } = spied(); const began = performance.now();
  const result = await superviseRemoteGate({ ...FAST, table, command: '/usr/bin/perl',
    args: ['-e', '$SIG{TERM}="IGNORE"; sleep 30'], shouldCancel: () => performance.now() - began > 300 });
  assert.equal(result.cancelled, true);
  assert.equal(result.exitCode, 137);
  assert.deepEqual(result.cleanup.cleanup, 'verified');
  assert(signalled.some(([, sig]) => sig === 'SIGKILL'), 'escalated to KILL');
});

test('an unrelated peer running the same executable survives cancellation', supported, async t => {
  const s = scratch(t); const peer = await stranger(s); const { table, signalled } = spied(); const began = performance.now();
  const result = await superviseRemoteGate({ ...FAST, table, command: '/bin/sleep', args: ['30'],
    shouldCancel: () => performance.now() - began > 100 });
  assert.equal(result.cleanup.cleanup, 'verified');
  assert.equal(alive(peer), true, 'peer in another group must survive');
  assert(!signalled.some(([pid]) => pid === peer), 'peer was never signalled');
});

test('a reused pid is departed, never signalled', supported, async t => {
  // The stranger's pid is reported as an owned group member with an OLD start time
  // for the first scans (the owned process), then truthfully (a different process).
  const s = scratch(t); const peer = await stranger(s); const real = native();
  let injected = 0; let truthful = 0;
  const { table, signalled } = spied(real, { async list() {
    const rows = await real.list();
    const holder = rows.find(r => !r.unreadable && r.ppid === process.pid && r.pgid === r.pid && r.pid !== peer);
    if (!holder || injected >= 2) { if (injected >= 2) truthful++; return rows; }
    injected++;
    return rows.map(r => r.pid === peer ? { ...r, pgid: holder.pgid, startedAt: 'Thu Jan 1 00:00:00 1970' } : r);
  } });
  const result = await superviseRemoteGate({ ...FAST, table, command: '/bin/sleep', args: ['30'],
    shouldCancel: () => truthful >= 2 });
  assert.equal(injected, 2, 'the owned identity was observed before the pid was reused');
  assert(signalled.length > 0, 'the real gate was still signalled');
  assert.equal(alive(peer), true, 'the process now holding that pid survives');
  assert(!signalled.some(([pid]) => pid === peer), 'a different identity is never signalled');
  assert.equal(result.cleanup.cleanup, 'verified', 'a departed identity is gone, not uncertain');
});

test('macOS: a member that leaves the group after being seen is escaped_group, never verified', { skip: !darwin }, async t => {
  const s = scratch(t); const pidFile = join(s.dir, 'escapee');
  const result = await superviseRemoteGate({ ...FAST, table: native(), command: '/usr/bin/perl', args: ['-e',
    `if (fork) { sleep 1; exit 0 } open my $f, '>', '${pidFile}'; print $f $$; close $f; select undef, undef, undef, 0.4; setpgrp(0, 0); sleep 30`] });
  s.own(await readPid(pidFile));
  assert.equal(result.cleanup.cleanup, 'uncertain');
  assert(result.cleanup.reasons.includes('escaped_group'));
});

test('linux: an escapee that leaves the group before any sample is still found and stopped (R2 closed)', { skip: !linux }, async t => {
  const s = scratch(t); const pidFile = join(s.dir, 'escapee');
  const result = await superviseRemoteGate({ ...FAST, sampleMs: 1000, table: native(), command: '/usr/bin/perl', args: ['-e',
    `if (fork) { exit 0 } setpgrp(0, 0); open my $f, '>', '${pidFile}'; print $f $$; close $f; sleep 30`] });
  const escapee = s.own(await readPid(pidFile));
  assert.equal(alive(escapee), false, 'the subreaper kept it a descendant, so it was stopped');
  assert.equal(result.cleanup.cleanup, 'verified');
});

test('linux: a reused pid is never signalled through the pidfd re-check (R1 closed)', { skip: !linux }, async t => {
  const s = scratch(t); const peer = await stranger(s); const table = native();
  const row = (await table.list()).find(r => r.pid === peer);
  assert.equal(await table.signal({ ...row, startedAt: `${row.startedAt.split('/')[0]}/1` }, 'SIGKILL'), false);
  assert.equal(alive(peer), true, 'a stale identity never reaches the process now holding the pid');
  assert.equal(await table.signal(row, 'SIGKILL'), true);
  for (let i = 0; i < 100 && alive(peer); i++) await delay(10);
  assert.equal(alive(peer), false);
});

test('macOS R2 residual: an escapee never observed in the group is invisible (stated, not claimed)', { skip: !darwin }, async t => {
  const s = scratch(t); const pidFile = join(s.dir, 'hidden'); const real = native(); let hidden;
  const table = { ...real, list: async () => (await real.list()).filter(r => r.pid !== hidden) };
  const run = superviseRemoteGate({ ...FAST, table, command: '/bin/sh', args: ['-c', `sleep 30 & echo $! > ${pidFile}; wait`] });
  hidden = s.own(await readPid(pidFile));
  // The hidden process keeps the gate shell waiting; cancel it ourselves.
  process.kill(hidden, 'SIGKILL');
  const result = await run;
  assert.equal(result.cleanup.cleanup, 'verified', 'R2: sampling cannot see what it never observed');
});

test('a child forked between samples is found before the group counts as empty', supported, async t => {
  const s = scratch(t); const pidFile = join(s.dir, 'late');
  const result = await superviseRemoteGate({ ...FAST, sampleMs: 1000, table: native(),
    command: '/bin/sh', args: ['-c', `sleep 30 & echo $! > ${pidFile}; exit 0`] });
  const late = s.own(Number(readFileSync(pidFile, 'utf8')));
  assert.equal(alive(late), false, 'the late child was discovered and stopped');
  assert.equal(result.cleanup.cleanup, 'verified');
});

test('after the holder is lost, new group members are never adopted: members_remain', supported, async t => {
  const s = scratch(t); const pidFile = join(s.dir, 'after');
  const result = await superviseRemoteGate({ ...FAST, table: native(), command: '/bin/sh', args: ['-c',
    `kill -KILL $PPID; sleep 0.2; sleep 30 & echo $! > ${pidFile}; exit 0`] });
  const after = s.own(await readPid(pidFile));
  assert.equal(alive(after), true, 'an unowned process is not signalled');
  assert.equal(result.cleanup.cleanup, 'uncertain');
  assert(result.cleanup.reasons.includes('holder_lost'));
  assert(result.cleanup.reasons.includes('members_remain'));
});

test('a failed process scan is uncertain, never verified', supported, async t => {
  scratch(t); const real = native(); let scans = 0;
  const table = { ...real, async list() { if (++scans > 2) throw new Error('ps failed'); return real.list(); } };
  const result = await superviseRemoteGate({ ...FAST, table, command: '/bin/sleep', args: ['0.2'] });
  assert.equal(result.cleanup.cleanup, 'uncertain');
  assert(result.cleanup.reasons.includes('scan_failed'));
});

test('an owned identity that becomes unreadable is uncertain, never gone', supported, async t => {
  scratch(t); const real = native(); let gate; let scans = 0;
  const table = { ...real, async list() {
    const rows = await real.list(); scans++;
    gate ??= rows.find(r => r.ppid !== process.pid && /(^|\/)sleep$/.test(r.executable ?? '')
      && rows.find(h => h.pid === r.ppid)?.ppid === process.pid)?.pid;
    return gate !== undefined && scans > 4 ? rows.map(r => r.pid === gate ? { pid: r.pid, unreadable: true } : r) : rows;
  } };
  // Cancel only once the gate has been seen readable AND then unreadable.
  const result = await superviseRemoteGate({ ...FAST, table, command: '/bin/sleep', args: ['30'],
    shouldCancel: () => gate !== undefined && scans > 6 });
  assert.equal(result.cleanup.cleanup, 'uncertain');
  assert(result.cleanup.reasons.includes('identity_unreadable'));
  if (gate && alive(gate)) process.kill(gate, 'SIGKILL'); // our own gate, left uncertain on purpose
});

// --- journal integration --------------------------------------------------
function job(t) {
  const root = mkdtempSync(join(tmpdir(), 'remote-gate-supervisor-job-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trust = { runnerId: 'fixture-mac', policySha256: 'a'.repeat(64) };
  const request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00.000Z',
    expiresAt: '2026-10-28T06:00:00.000Z', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    main: 'd'.repeat(40), refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), ...trust };
  const input = { root, trust, requestBytes: Buffer.from(JSON.stringify(request)), now: Date.parse('2026-10-28T01:00:00.000Z') };
  const { job: admitted } = admitRemoteGateJob(input);
  const artifactsDirectory = join(root, 'output'); mkdirSync(artifactsDirectory, { mode: 0o700 });
  const contents = { 'evidence.json': '{"synthetic":true}\n', 'gate.log': 'synthetic log\n', 'browser.tsv': 'synthetic ledger\n' };
  const result = { version: 1, id: admitted.id, requestSha256: admitted.requestSha256,
    ...Object.fromEntries(['runnerId', 'policySha256', 'commit', 'main', 'refsSha256', 'bundleSha256'].map(k => [k, request[k]])),
    treeBefore: request.tree, treeAfter: request.tree, exitCode: 0,
    artifacts: { evidence: sha256(Buffer.from(contents['evidence.json'])), gateLog: sha256(Buffer.from(contents['gate.log'])),
      browserLedger: sha256(Buffer.from(contents['browser.tsv'])) } };
  contents['result.json'] = JSON.stringify(result);
  for (const [name, text] of Object.entries(contents)) writeFileSync(join(artifactsDirectory, name), text, { mode: 0o600 });
  return { input, artifactsDirectory, run: overrides => runRemoteGateJob({ job: input, table: native(),
    artifactsDirectory, timing: FAST, clock: () => input.now, ...overrides }) };
}

test('a verified, passing gate publishes and completes', supported, async t => {
  const j = job(t);
  const outcome = await j.run({ command: '/bin/sh', args: ['-c', 'exit 0'] });
  assert.equal(outcome.job.state, 'completed');
  assert.equal(readRemoteGateJob(j.input).supervisor.pid, process.pid);
});

test('a failing gate is failed with its exit code; a second runner never relaunches', supported, async t => {
  const j = job(t);
  const outcome = await j.run({ command: '/bin/sh', args: ['-c', 'exit 7'] });
  assert.deepEqual([outcome.job.state, outcome.job.details], ['failed', { exitCode: 7 }]);
  const again = await j.run({ command: '/bin/sh', args: ['-c', 'exit 0'] });
  assert.equal(again.started, false); assert.equal(again.job.state, 'failed');
});

test('uncertain cleanup is interrupted even when the gate exited 0, and never fetchable', supported, async t => {
  const j = job(t); const real = native(); let scans = 0;
  const table = { ...real, async list() { if (++scans > 3) throw new Error('ps failed'); return real.list(); } };
  const outcome = await j.run({ table, command: '/bin/sh', args: ['-c', 'exit 0'] });
  assert.equal(outcome.job.state, 'interrupted');
  assert.equal(outcome.job.details.cleanup, 'uncertain');
  assert.equal(existsSync(join(outcome.job.directory, 'artifacts')), false);
});

test('journal cancellation stops the gate and records verified cleanup', supported, async t => {
  const j = job(t);
  const run = j.run({ command: '/bin/sleep', args: ['30'] });
  for (let i = 0; i < 200 && readRemoteGateJob(j.input).state !== 'running'; i++) await delay(10);
  await delay(100); requestRemoteGateCancellation(j.input);
  const outcome = await run;
  assert.equal(outcome.job.state, 'cancelled');
  assert.equal(outcome.job.details.cleanup, 'verified');
  assert(outcome.job.details.owned >= 1);
});

test('a cancellation recorded after the job started is honoured, not rejected as out of order', supported, async t => {
  // The worker records cancellation at ITS time, later than this job's start. A
  // runner that read the journal with its start time crashed here and left the
  // job stuck in cancelling (D9 P2 end-to-end, 2026-11-01).
  const j = job(t); const t0 = performance.now();
  const clock = () => j.input.now + Math.round(performance.now() - t0);
  const run = j.run({ command: '/bin/sleep', args: ['30'], clock });
  for (let i = 0; i < 200 && readRemoteGateJob({ ...j.input, now: clock() + 1 }).state !== 'running'; i++) await delay(10);
  await delay(100);
  requestRemoteGateCancellation({ ...j.input, now: clock() + 5 });
  const outcome = await run;
  assert.deepEqual([outcome.job.state, outcome.job.details.cleanup], ['cancelled', 'verified']);
});

test('publication refused after a passing gate is failed, never completed', supported, async t => {
  const j = job(t); writeFileSync(join(j.artifactsDirectory, 'gate.log'), 'changed after result was written');
  const outcome = await j.run({ command: '/bin/sh', args: ['-c', 'exit 0'] });
  assert.deepEqual([outcome.job.state, outcome.job.details.exitCode], ['failed', PUBLICATION_REFUSED_EXIT]);
});

test('recovery marks a dead supervisor interrupted, leaves a live one, and never relaunches', supported, async t => {
  const j = job(t); const table = native();
  transitionRemoteGateJob({ ...j.input, expectedSequence: 0, state: 'starting' });
  const self = (await table.list()).find(r => r.pid === process.pid);
  const live = { pid: self.pid, startedAt: self.startedAt, executable: self.executable };
  transitionRemoteGateJob({ ...j.input, expectedSequence: 1, state: 'running', details: { owner: live } });
  assert.equal((await recoverRemoteGateJob({ job: j.input, table })).changed, false, 'a live owner is left alone');
  const j2 = job(t);
  transitionRemoteGateJob({ ...j2.input, expectedSequence: 0, state: 'starting' });
  transitionRemoteGateJob({ ...j2.input, expectedSequence: 1, state: 'running',
    details: { owner: { ...live, startedAt: 'Thu Jan 1 00:00:00 1970' } } });
  const recovered = await recoverRemoteGateJob({ job: j2.input, table });
  assert.deepEqual([recovered.job.state, recovered.job.details.reasons], ['interrupted', ['supervisor_restarted']]);
});

test('recovery leaves a fresh starting job alone and abandons a stale one', supported, async t => {
  const j = job(t); const table = native();
  transitionRemoteGateJob({ ...j.input, expectedSequence: 0, state: 'starting' });
  assert.equal((await recoverRemoteGateJob({ job: j.input, table, now: j.input.now + 1000 })).changed, false);
  assert.equal((await recoverRemoteGateJob({ job: j.input, table, now: j.input.now + 120_000 })).job.state, 'interrupted');
});
