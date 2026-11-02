import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { admitRemoteGateJob, readRemoteGateJob, transitionRemoteGateJob } from './lib/remote-gate-job.mjs';

const now = Date.parse('2026-10-28T01:00:00Z');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remote-gate-job-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trust = { runnerId: 'fixture-mac', policySha256: 'a'.repeat(64) };
  const request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00Z',
    expiresAt: '2026-10-28T06:00:00Z', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    main: 'd'.repeat(40), refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), ...trust };
  const requestBytes = Buffer.from(JSON.stringify(request));
  return { root, request, trust, requestBytes, now };
}
const change = (f, expectedSequence, state, details = {}, at = now + 1) =>
  transitionRemoteGateJob({ ...f, expectedSequence, state, details, now: at });
const supervisor = { pid: 12345, startedAt: 'observed-start-identity', executable: '/usr/local/bin/node' };

test('reconnect and a new module instance retain one admitted job', async t => {
  const f = fixture(t);
  assert.equal(admitRemoteGateJob(f).created, true);
  assert.equal(admitRemoteGateJob(f).created, false);
  assert.equal(change(f, 0, 'starting').changed, true);
  const reopened = await import(`./lib/remote-gate-job.mjs?restart=${Date.now()}`);
  const replay = reopened.admitRemoteGateJob({ ...f, now: now + 2 });
  assert.equal(replay.created, false);
  assert.equal(replay.job.state, 'starting');
  assert.equal(change(f, 0, 'starting').changed, false);
  assert.throws(() => change(f, 1, 'starting'), /transition refused/);
});

test('completed artifact status preserves the supervisor and cannot restart', t => {
  const f = fixture(t); admitRemoteGateJob(f);
  change(f, 0, 'starting');
  change(f, 1, 'running', { owner: supervisor }, now + 2);
  const done = change(f, 2, 'completed', { exitCode: 0, resultSha256: '9'.repeat(64) }, now + 3);
  assert.equal(done.changed, true);
  assert.deepEqual(done.job.supervisor, supervisor);
  assert.equal(done.job.state, 'completed');
  assert.equal(done.job.verdict, undefined, 'job completion does not claim gate evidence');
  assert.throws(() => change(f, 3, 'starting', {}, now + 4), /transition refused/);
});

test('expired reconnect is readable but an expired job cannot start', t => {
  const f = fixture(t); admitRemoteGateJob(f);
  const expired = Date.parse(f.request.expiresAt) + 1;
  assert.equal(admitRemoteGateJob({ ...f, now: expired }).created, false);
  assert.equal(readRemoteGateJob({ ...f, now: expired }).state, 'accepted');
  assert.throws(() => change(f, 0, 'starting', {}, expired), /not currently valid/);
});

test('an expired new request is refused before creating any job', t => {
  const f = fixture(t);
  assert.throws(() => admitRemoteGateJob({ ...f, now: Date.parse(f.request.expiresAt) + 1 }), /not currently valid/);
  // The same ID may be admitted normally later in this simulated earlier clock.
  assert.equal(admitRemoteGateJob(f).created, true);
});

test('same request ID with different bytes is refused', t => {
  const f = fixture(t); admitRemoteGateJob(f);
  const changed = { ...f, requestBytes: Buffer.from(JSON.stringify({ ...f.request, commit: '9'.repeat(40) })) };
  assert.throws(() => admitRemoteGateJob(changed), /other bytes/);
});

test('partial admission is preserved and never repaired into another start', t => {
  const f = fixture(t);
  const job = join(f.root, f.request.id); mkdirSync(job, { mode: 0o700 });
  writeFileSync(join(job, 'request.json'), f.requestBytes, { mode: 0o600 });
  assert.throws(() => admitRemoteGateJob(f), /incomplete/);
  assert.deepEqual(readFileSync(join(job, 'request.json')), f.requestBytes);
});

test('symlinked job cannot read or write a peer directory', t => {
  const f = fixture(t);
  const peer = join(f.root, 'peer'); mkdirSync(peer, { mode: 0o700 });
  writeFileSync(join(peer, 'sentinel'), 'preserve');
  symlinkSync(peer, join(f.root, f.request.id));
  assert.throws(() => admitRemoteGateJob(f), /private owned directory/);
  assert.equal(readFileSync(join(peer, 'sentinel'), 'utf8'), 'preserve');
});

test('symlinked record is refused and its target is preserved', t => {
  const f = fixture(t); const { job } = admitRemoteGateJob(f);
  const original = join(job.directory, '0000.json');
  const target = join(f.root, 'target'); writeFileSync(target, readFileSync(original), { mode: 0o600 });
  rmSync(original); symlinkSync(target, original);
  const before = readFileSync(target);
  assert.throws(() => readRemoteGateJob(f));
  assert.deepEqual(readFileSync(target), before);
});

for (const [name, mutate, pattern] of [
  ['history digest', value => { value.previousSha256 = '0'.repeat(64); }, /history differs/],
  ['request binding', value => { value.requestSha256 = '0'.repeat(64); }, /request differs/],
  ['extra command field', value => { value.command = 'touch forbidden'; }, /record fields/],
  ['future timestamp', value => { value.at = '2026-10-28T05:00:00.000Z'; }, /timestamp order/],
]) test(`changed ${name} refuses recovery`, t => {
  const f = fixture(t); admitRemoteGateJob(f); const { job } = change(f, 0, 'starting');
  const path = join(job.directory, '0001.json');
  const record = JSON.parse(readFileSync(path)); mutate(record); writeFileSync(path, JSON.stringify(record));
  assert.throws(() => readRemoteGateJob({ ...f, now: now + 2 }), pattern);
});

test('missing sequence does not hide a later running job', t => {
  const f = fixture(t); admitRemoteGateJob(f); change(f, 0, 'starting');
  const { job } = change(f, 1, 'running', { owner: supervisor }, now + 2);
  rmSync(join(job.directory, '0001.json'));
  assert.throws(() => readRemoteGateJob({ ...f, now: now + 3 }), /sequence gap/);
});

test('public job record permissions refuse recovery', t => {
  const f = fixture(t); const { job } = admitRemoteGateJob(f);
  chmodSync(join(job.directory, '0000.json'), 0o644);
  assert.throws(() => readRemoteGateJob(f), /private job record/);
});

for (const state of ['cancelled', 'interrupted', 'failed']) test(`${state} is terminal and cannot acquire another start`, t => {
  const f = fixture(t); admitRemoteGateJob(f); change(f, 0, 'starting');
  change(f, 1, state, { failed: { exitCode: 143 }, cancelled: { cleanup: 'verified', owned: 0 },
    interrupted: { cleanup: 'uncertain', reasons: ['supervisor_restarted'] } }[state], now + 2);
  assert.throws(() => change(f, 2, 'starting', {}, now + 3), /transition refused/);
});

test('two real processes racing the same accepted job grant starting once', async t => {
  const f = fixture(t); admitRemoteGateJob(f);
  const module = new URL('./lib/remote-gate-job.mjs', import.meta.url).href;
  const code = `import fs from 'node:fs';import {join} from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const f=JSON.parse(process.argv[1]);f.requestBytes=Buffer.from(f.requestBytes,'base64');
    const sync=fs.fsyncSync;let arrived=false;
    fs.fsyncSync=(fd)=>{
      if(!arrived){
        arrived=true;
        fs.writeFileSync(join(f.root,'ready-'+process.pid),'ready');
        const deadline=Date.now()+5000;
        while(fs.readdirSync(f.root).filter(n=>n.startsWith('ready-')).length<2){
          if(Date.now()>deadline)throw new Error('start race barrier timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
        }
      }
      return sync(fd);
    };
    syncBuiltinESMExports();
    const {transitionRemoteGateJob}=await import(${JSON.stringify(module)});
    const r=transitionRemoteGateJob({...f,expectedSequence:0,state:'starting'});
    process.stdout.write(JSON.stringify({changed:r.changed,state:r.job.state}));`;
  const args = ['--input-type=module', '-e', code, JSON.stringify({ ...f,
    requestBytes: f.requestBytes.toString('base64'), now: now + 1 })];
  const results = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, args, { timeout: 10000 })));
  const outcomes = results.map(result => JSON.parse(result.stdout));
  assert.equal(outcomes.filter(result => result.changed).length, 1);
  assert(outcomes.every(result => result.state === 'starting'));
  assert.equal(readRemoteGateJob({ ...f, now: now + 2 }).sequence, 1);
});
