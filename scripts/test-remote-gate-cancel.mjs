import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { admitRemoteGateJob, readRemoteGateJob, requestRemoteGateCancellation,
  transitionRemoteGateJob } from './lib/remote-gate-job.mjs';
import { remoteGateJobStatus, remoteGateJobResultFrame } from './lib/remote-gate-status.mjs';

// These are real immutable-journal races, not worker/process-cleanup tests.
// No gate, SSH connection, production API or process signal is used.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remote-gate-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trust = { runnerId: 'fixture-mac', policySha256: 'a'.repeat(64) };
  const request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00.000Z',
    expiresAt: '2026-10-28T06:00:00.000Z', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    main: 'd'.repeat(40), refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), ...trust };
  return { root, trust, request, requestBytes: Buffer.from(JSON.stringify(request)),
    now: Date.parse('2026-10-28T01:00:00.000Z') };
}
const owner = { pid: 12345, startedAt: 'synthetic-owner', executable: '/usr/local/bin/node' };
function transition(f, state, details = {}) {
  const job = readRemoteGateJob(f);
  return transitionRemoteGateJob({ ...f, expectedSequence: job.sequence, state, details });
}

test('unknown cancellation never admits a job', t => {
  const f = fixture(t);
  assert.throws(() => requestRemoteGateCancellation(f), /ENOENT/);
  assert.equal(existsSync(join(f.root, f.request.id)), false);
});

test('cancelling accepted work wins the same start CAS and does not create an owner', t => {
  const f = fixture(t); admitRemoteGateJob(f);
  const cancelled = requestRemoteGateCancellation(f);
  assert.equal(cancelled.changed, true);
  assert.equal(cancelled.job.state, 'cancelled');
  assert.equal(cancelled.job.supervisor, null);
  assert.equal(transitionRemoteGateJob({ ...f, expectedSequence: 0, state: 'starting' }).changed, false);
  assert.throws(() => transition(f, 'starting'), /transition refused/);
  assert.equal(admitRemoteGateJob(f).created, false);
});

for (const initial of ['starting', 'running']) {
  test(`cancelling ${initial} retains pending cleanup and never returns artifacts`, t => {
    const f = fixture(t); admitRemoteGateJob(f); transition(f, 'starting');
    if (initial === 'running') transition(f, 'running', { owner });
    const result = requestRemoteGateCancellation(f);
    assert.equal(result.changed, true);
    assert.equal(result.job.state, 'cancelling');
    assert.deepEqual(result.job.supervisor, initial === 'running' ? owner : null);
    const status = remoteGateJobStatus(f);
    assert.equal(status.cancellationRequested, true);
    assert.equal(status.artifactsReady, false);
    assert.equal(status.gateVerified, false);
    assert.equal(status.supervisor, undefined);
    assert.throws(() => [...remoteGateJobResultFrame(f)], /not ready/);
    for (const [state, details] of [['starting', {}], ['running', { owner }],
      ['completed', { exitCode: 0, resultSha256: '9'.repeat(64) }]]) {
      assert.throws(() => transition(f, state, details), /transition refused/);
    }
  });
}

test('repeated and expired cancellation keep the original journal bytes', t => {
  const f = fixture(t); admitRemoteGateJob(f); transition(f, 'starting');
  const { job } = requestRemoteGateCancellation(f);
  const snapshot = () => readdirSync(job.directory).sort().map(name => [name,
    readFileSync(join(job.directory, name)).toString('base64')]);
  const before = snapshot();
  const retry = requestRemoteGateCancellation({ ...f, now: Date.parse(f.request.expiresAt) + 1000 });
  assert.equal(retry.changed, false);
  assert.equal(retry.job.state, 'cancelling');
  assert.deepEqual(snapshot(), before);
});

test('caller cannot cancel another request by reusing its ID', t => {
  const f = fixture(t); admitRemoteGateJob(f);
  assert.throws(() => requestRemoteGateCancellation({ ...f,
    requestBytes: Buffer.from(JSON.stringify({ ...f.request, commit: '9'.repeat(40) })) }), /other bytes/);
  assert.equal(readRemoteGateJob(f).state, 'accepted');
});

test('interrupted cleanup retains cancellation intent without claiming stopped processes', t => {
  const f = fixture(t); admitRemoteGateJob(f); transition(f, 'starting');
  transition(f, 'running', { owner }); requestRemoteGateCancellation(f);
  transition(f, 'interrupted', { cleanup: 'uncertain', reasons: ['supervisor_restarted'] });
  const status = remoteGateJobStatus(f);
  assert.equal(status.state, 'interrupted');
  assert.equal(status.cancellationRequested, true);
  assert.equal(status.artifactsReady, false);
  assert.equal(requestRemoteGateCancellation(f).changed, false);
});

for (const state of ['completed', 'failed', 'interrupted']) {
  test(`terminal ${state} wins a later cancellation`, t => {
    const f = fixture(t); admitRemoteGateJob(f); transition(f, 'starting');
    transition(f, 'running', { owner });
    transition(f, state, state === 'completed' ? { exitCode: 0, resultSha256: '9'.repeat(64) }
      : state === 'failed' ? { exitCode: 1 } : { cleanup: 'uncertain', reasons: ['members_remain'] });
    const before = readRemoteGateJob(f);
    const result = requestRemoteGateCancellation(f);
    assert.equal(result.changed, false);
    assert.deepEqual(result.job, before);
    assert.equal(remoteGateJobStatus(f).cancellationRequested, false);
  });
}

for (const competingAction of ['start', 'cancel']) {
  test(`two actual processes racing cancel versus ${competingAction} preserve one journal`, async t => {
    const f = fixture(t); admitRemoteGateJob(f);
    const module = new URL('./lib/remote-gate-job.mjs', import.meta.url).href;
    const code = `import fs from 'node:fs'; import {join} from 'node:path';
      import {syncBuiltinESMExports} from 'node:module';
      const f=JSON.parse(process.argv[1]); f.requestBytes=Buffer.from(f.requestBytes,'base64');
      const original=fs.fsyncSync; let ready=false;
      fs.fsyncSync=(fd)=>{ if(!ready){ ready=true;
        fs.writeFileSync(join(f.root,'ready-'+process.pid),'ready');
        const deadline=Date.now()+5000;
        while(fs.readdirSync(f.root).filter(n=>n.startsWith('ready-')).length<2){
          if(Date.now()>deadline)throw new Error('cancel race barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
        }
      } return original(fd); }; syncBuiltinESMExports();
      const m=await import(${JSON.stringify(module)});
      const r=process.argv[2]==='start'
        ? m.transitionRemoteGateJob({...f,expectedSequence:0,state:'starting'})
        : m.requestRemoteGateCancellation(f);
      process.stdout.write(JSON.stringify({changed:r.changed,state:r.job.state}));`;
    const input = JSON.stringify({ ...f, requestBytes: f.requestBytes.toString('base64') });
    const output = await Promise.all(['cancel', competingAction].map(action =>
      promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, input, action], { timeout: 10000 })));
    const results = output.map(value => JSON.parse(value.stdout));
    const job = readRemoteGateJob(f);
    if (competingAction === 'cancel') {
      assert.equal(results.filter(value => value.changed).length, 1);
      assert.equal(job.state, 'cancelled');
      assert.equal(job.sequence, 1);
    } else {
      assert.equal(results[0].changed, true);
      assert.equal(job.state, results[1].changed ? 'cancelling' : 'cancelled');
      assert.equal(job.sequence, results[1].changed ? 2 : 1);
    }
    assert.equal(job.supervisor, null);
    assert.equal(admitRemoteGateJob(f).created, false);
  });
}

test('cancelled after launch requires verified cleanup; interrupted requires closed uncertain reasons', t => {
  const f = fixture(t); admitRemoteGateJob(f); transition(f, 'starting');
  transition(f, 'running', { owner }); requestRemoteGateCancellation(f);
  for (const [state, details] of [['cancelled', {}], ['cancelled', { cleanup: 'uncertain', owned: 1 }],
    ['interrupted', {}], ['interrupted', { cleanup: 'verified', reasons: ['members_remain'] }],
    ['interrupted', { cleanup: 'uncertain', reasons: [] }],
    ['interrupted', { cleanup: 'uncertain', reasons: ['processes_stopped'] }],
    ['interrupted', { cleanup: 'uncertain', reasons: ['scan_failed', 'scan_failed'] }]]) {
    assert.throws(() => transition(f, state, details), /detail fields|cleanup|owned/);
  }
  assert.equal(readRemoteGateJob(f).state, 'cancelling');
  assert.equal(transition(f, 'cancelled', { cleanup: 'verified', owned: 3 }).changed, true);
});
