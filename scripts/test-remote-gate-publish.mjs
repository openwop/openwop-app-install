import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { admitRemoteGateJob, readRemoteGateJob, requestRemoteGateCancellation,
  transitionRemoteGateJob } from './lib/remote-gate-job.mjs';
import { publishRemoteGateArtifacts } from './lib/remote-gate-publish.mjs';
import { remoteGateJobStatus, remoteGateJobResultFrame } from './lib/remote-gate-status.mjs';
import { receiveRemoteGateFrame, REMOTE_GATE_RESULT_FILES } from './lib/remote-gate-frame.mjs';
import { sha256 } from './lib/remote-gate-result.mjs';

// Actual private files, journal CAS, child processes and result framing; payloads
// describe a synthetic gate and cannot qualify the remote worker or SSH lane.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remote-gate-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trust = { runnerId: 'fixture-mac', policySha256: 'a'.repeat(64) };
  const request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00.000Z',
    expiresAt: '2026-10-28T06:00:00.000Z', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    main: 'd'.repeat(40), refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), ...trust };
  const input = { root, trust, requestBytes: Buffer.from(JSON.stringify(request)),
    now: Date.parse('2026-10-28T01:00:00.000Z') };
  const { job } = admitRemoteGateJob(input);
  transitionRemoteGateJob({ ...input, expectedSequence: 0, state: 'starting' });
  const owner = { pid: 12345, startedAt: 'synthetic-owner', executable: '/usr/local/bin/node' };
  transitionRemoteGateJob({ ...input, expectedSequence: 1, state: 'running', details: { owner } });
  const artifactsDirectory = join(root, 'closed-output'); mkdirSync(artifactsDirectory, { mode: 0o700 });
  const contents = { 'evidence.json': Buffer.from('{"synthetic":true}\n'),
    'gate.log.gz': Buffer.from('synthetic complete log\n'), 'browser.tsv': Buffer.from('synthetic ledger\n') };
  const result = { version: 1, id: job.id, requestSha256: job.requestSha256,
    ...Object.fromEntries(['runnerId', 'policySha256', 'commit', 'main', 'refsSha256', 'bundleSha256']
      .map(key => [key, request[key]])), treeBefore: request.tree, treeAfter: request.tree,
    exitCode: 0, artifacts: { evidence: sha256(contents['evidence.json']),
      gateLog: sha256(contents['gate.log.gz']), browserLedger: sha256(contents['browser.tsv']) } };
  contents['result.json'] = Buffer.from(JSON.stringify(result));
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(join(artifactsDirectory, name), bytes, { mode: 0o600 });
  return { input, job, result, contents, options: { ...input, expectedSequence: 2, owner, exitCode: 0, artifactsDirectory } };
}

test('all published bytes are fetchable only after completion; source changes cannot rewrite them', async t => {
  const f = fixture(t);
  assert.equal(remoteGateJobStatus(f.input).artifactsReady, false);
  const outcome = publishRemoteGateArtifacts(f.options);
  assert.equal(outcome.changed, true);
  assert.equal(outcome.job.state, 'completed');
  assert.equal(outcome.job.details.resultSha256, sha256(f.contents['result.json']));
  writeFileSync(join(f.options.artifactsDirectory, 'gate.log.gz'), 'source changed');
  const result = await receiveRemoteGateFrame(Readable.from(remoteGateJobResultFrame(f.input),
    { objectMode: false }), { kind: 'result', root: f.input.root });
  for (const [name, bytes] of Object.entries(f.contents)) assert.deepEqual(readFileSync(result.paths[name]), bytes);
  assert.equal(remoteGateJobStatus(f.input).gateVerified, false);
});

for (const [label, change, error] of [
  ['different owner', options => { options.owner = { ...options.owner, pid: 12346 }; }, /supervisor/],
  ['stale sequence', options => { options.expectedSequence = 1; }, /job changed/],
  ['failed command', options => { options.exitCode = 1; }, /failed or interrupted/],
]) {
  test(`${label} cannot reserve output or complete the job`, t => {
    const f = fixture(t); change(f.options);
    assert.throws(() => publishRemoteGateArtifacts(f.options), error);
    assert.equal(existsSync(join(f.job.directory, 'artifacts')), false);
    assert.equal(readRemoteGateJob(f.input).state, 'running');
  });
}

for (const [field, replacement] of [['id', '2'.repeat(32)], ['requestSha256', '0'.repeat(64)],
  ['commit', '9'.repeat(40)], ['treeAfter', '9'.repeat(40)], ['exitCode', 137]]) {
  test(`result ${field} mismatch leaves a non-fetchable publication, never completion`, t => {
    const f = fixture(t); f.result[field] = replacement;
    writeFileSync(join(f.options.artifactsDirectory, 'result.json'), JSON.stringify(f.result));
    assert.throws(() => publishRemoteGateArtifacts(f.options), /differs|another job/);
    assert.equal(readRemoteGateJob(f.input).state, 'running');
    assert.throws(() => [...remoteGateJobResultFrame(f.input)], /not ready/);
    assert.throws(() => publishRemoteGateArtifacts(f.options), /EEXIST/);
  });
}

test('changed artifact bytes cannot commit completion even if the source result was valid', t => {
  const f = fixture(t); writeFileSync(join(f.options.artifactsDirectory, 'gate.log.gz'), 'different actual bytes');
  assert.throws(() => publishRemoteGateArtifacts(f.options), /gate\.log\.gz bytes differ/);
  assert.equal(remoteGateJobStatus(f.input).artifactsReady, false);
});

for (const [label, change, error] of [
  ['missing', path => rmSync(path), /ENOENT/],
  ['public', path => chmodSync(path, 0o644), /private artifact/],
  ['empty', path => truncateSync(path, 0), /private artifact/],
  ['oversized', path => truncateSync(path, REMOTE_GATE_RESULT_FILES['gate.log.gz'] + 1), /private artifact/],
]) {
  test(`${label} log leaves partial output unreachable and preserves it on retry`, t => {
    const f = fixture(t); change(join(f.options.artifactsDirectory, 'gate.log.gz'));
    assert.throws(() => publishRemoteGateArtifacts(f.options), error);
    const partial = readdirSync(join(f.job.directory, 'artifacts')).sort();
    assert(partial.includes('result.json'));
    assert.equal(remoteGateJobStatus(f.input).artifactsReady, false);
    assert.throws(() => publishRemoteGateArtifacts(f.options), /EEXIST/);
    assert.deepEqual(readdirSync(join(f.job.directory, 'artifacts')).sort(), partial);
  });
}

test('symlink input cannot read or alter another file', t => {
  const f = fixture(t); const peer = join(f.input.root, 'peer');
  writeFileSync(peer, 'preserve', { mode: 0o600 });
  const path = join(f.options.artifactsDirectory, 'gate.log.gz'); rmSync(path); symlinkSync(peer, path);
  assert.throws(() => publishRemoteGateArtifacts(f.options), /ELOOP/);
  assert.equal(readFileSync(peer, 'utf8'), 'preserve');
  assert.equal(remoteGateJobStatus(f.input).artifactsReady, false);
});

test('a pre-existing publication directory is preserved rather than overwritten', t => {
  const f = fixture(t); const directory = join(f.job.directory, 'artifacts');
  mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, 'sentinel'), 'preserve');
  assert.throws(() => publishRemoteGateArtifacts(f.options), /EEXIST/);
  assert.equal(readFileSync(join(directory, 'sentinel'), 'utf8'), 'preserve');
});

test('cancellation remains terminal and cannot be revived by publication', t => {
  const f = fixture(t);
  transitionRemoteGateJob({ ...f.input, expectedSequence: 2, state: 'cancelled',
    details: { cleanup: 'verified', owned: 0 } });
  assert.throws(() => publishRemoteGateArtifacts(f.options), /only a running job/);
  assert.equal(readRemoteGateJob(f.input).state, 'cancelled');
  assert.equal(existsSync(join(f.job.directory, 'artifacts')), false);
});

test('cancellation during a real publisher process wins completion but does not claim process cleanup', { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const module = new URL('./lib/remote-gate-publish.mjs', import.meta.url).href;
  const resume = join(f.input.root, 'resume-publisher');
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const options=JSON.parse(process.argv[1]);options.requestBytes=Buffer.from(options.requestBytes,'base64');
    const original=fs.fsyncSync;let paused=false;
    fs.fsyncSync=(fd)=>{if(!paused){paused=true;process.stdout.write('ready\\n');
      const deadline=Date.now()+5000;
      while(!fs.existsSync(process.argv[2])){
        if(Date.now()>deadline)throw new Error('publication barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
      }
    }return original(fd);};syncBuiltinESMExports();
    const {publishRemoteGateArtifacts}=await import(${JSON.stringify(module)});
    const result=publishRemoteGateArtifacts(options);
    process.stdout.write(JSON.stringify({changed:result.changed,state:result.job.state}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code,
    JSON.stringify({ ...f.options, requestBytes: f.options.requestBytes.toString('base64') }), resume],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve(code));
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject);
    child.once('close', code => reject(new Error(`publisher exited before barrier: ${code} ${stderr}`)));
  });
  assert.equal(stdout, 'ready\n');
  assert.equal(requestRemoteGateCancellation(f.input).job.state, 'cancelling');
  writeFileSync(resume, 'resume', { mode: 0o600 });
  assert.equal(await ended, 0, stderr);
  assert.deepEqual(JSON.parse(stdout.slice('ready\n'.length)), { changed: false, state: 'cancelling' });
  assert.equal(readRemoteGateJob(f.input).state, 'cancelling');
  assert.equal(remoteGateJobStatus(f.input).artifactsReady, false);
  assert.throws(() => [...remoteGateJobResultFrame(f.input)], /not ready/);
  assert.deepEqual(readFileSync(join(f.job.directory, 'artifacts', 'result.json')), f.contents['result.json']);
});

test('two real publisher processes commit one immutable result, never two completions', { timeout: 10_000 }, async t => {
  const f = fixture(t); const options = { ...f.options, requestBytes: f.options.requestBytes.toString('base64') };
  const module = new URL('./lib/remote-gate-publish.mjs', import.meta.url).href;
  const code = `import { publishRemoteGateArtifacts } from ${JSON.stringify(module)};
    const options = JSON.parse(process.argv[1]); options.requestBytes = Buffer.from(options.requestBytes, 'base64');
    process.stdin.once('data', () => { try { const r=publishRemoteGateArtifacts(options); process.exit(r.changed ? 0 : 2); }
      catch (e) { if (/EEXIST|only a running job|job changed/.test(e.message)) process.exit(2); console.error(e); process.exit(3); } });
    process.stdout.write('ready\\n');`;
  function contender() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.once('data', resolve); child.once('error', reject);
      child.once('close', code => reject(new Error(`publisher exited before ready: ${code} ${stderr}`)));
    });
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stderr })); });
    return { child, ready, ended };
  }
  const a = contender(); const b = contender(); await Promise.all([a.ready, b.ready]);
  a.child.stdin.end('go'); b.child.stdin.end('go');
  const results = await Promise.all([a.ended, b.ended]);
  assert.deepEqual(results.map(value => value.code).sort(), [0, 2], JSON.stringify(results));
  assert.equal(readRemoteGateJob(f.input).sequence, 3);
  assert.equal(readRemoteGateJob(f.input).state, 'completed');
  assert.deepEqual(readFileSync(join(f.job.directory, 'artifacts', 'result.json')), f.contents['result.json']);
});
