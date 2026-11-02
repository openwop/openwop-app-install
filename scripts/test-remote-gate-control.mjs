import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { remoteGateControlResponse } from './lib/remote-gate-control.mjs';
import { remoteGateFrame, receiveRemoteGateFrame } from './lib/remote-gate-frame.mjs';
import { admitRemoteGateJob, readRemoteGateJob, transitionRemoteGateJob } from './lib/remote-gate-job.mjs';
import { sha256 } from './lib/remote-gate-result.mjs';

// Real framing, immutable journals and private files. The completed artifacts
// are synthetic: this suite cannot qualify SSH authentication or a remote gate.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remote-gate-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const jobs = join(root, 'jobs'); const spool = join(root, 'spool'); const receive = join(root, 'receive');
  for (const path of [jobs, spool, receive]) mkdirSync(path, { mode: 0o700 });
  const peer = join(spool, 'peer'); writeFileSync(peer, 'preserve peer file');
  const trust = { runnerId: 'fixture-mac', policySha256: 'a'.repeat(64) };
  const request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00.000Z',
    expiresAt: '2026-10-28T06:00:00.000Z', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    main: 'd'.repeat(40), refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), ...trust };
  const requestBytes = Buffer.from(JSON.stringify(request));
  const input = { root: jobs, trust, requestBytes, now: Date.parse('2026-10-28T01:00:00.000Z') };
  const options = { root: jobs, spoolRoot: spool, trust, now: input.now };
  function framed(value, rawRequest = requestBytes) {
    const paths = { 'request.json': join(root, 'request.json'), 'operation.json': join(root, 'operation.json') };
    writeFileSync(paths['request.json'], rawRequest, { mode: 0o600 });
    writeFileSync(paths['operation.json'], Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
    return Buffer.concat([...remoteGateFrame('control', paths)]);
  }
  async function response(bytes, kind = 'status', overrides = {}) {
    return receiveRemoteGateFrame(Readable.from(remoteGateControlResponse(
      Readable.from([bytes], { objectMode: false }), { ...options, ...overrides }), { objectMode: false }),
    { kind, root: receive });
  }
  async function status(action = 'status', overrides = {}) {
    const r = await response(framed({ version: 1, operation: action }), 'status', overrides);
    return JSON.parse(readFileSync(r.paths['status.json']));
  }
  function untouchedSpool() {
    assert.deepEqual(readdirSync(spool), ['peer']);
    assert.equal(readFileSync(peer, 'utf8'), 'preserve peer file');
  }
  return { ...input, input, options, root, jobs, spool, receive, request, framed, response, status, untouchedSpool };
}
function transition(f, state, details = {}) {
  const job = readRemoteGateJob(f.input);
  return transitionRemoteGateJob({ ...f.input, expectedSequence: job.sequence, state, details });
}

test('unknown status cannot admit, start or create a job', async t => {
  const f = fixture(t);
  await assert.rejects(f.status(), /ENOENT/);
  assert.equal(existsSync(join(f.jobs, f.request.id)), false);
  assert.deepEqual(readdirSync(f.jobs), []); f.untouchedSpool();
});

test('expired status reconnect preserves the actual unresolved journal', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input); transition(f, 'starting');
  const before = readRemoteGateJob(f.input);
  const status = await f.status('status', { now: Date.parse(f.request.expiresAt) + 1000 });
  assert.equal(status.state, 'starting'); assert.equal(status.sequence, 1);
  assert.equal(status.requestSha256, sha256(f.requestBytes));
  assert.equal(status.artifactsReady, false); assert.equal(status.gateVerified, false);
  assert.equal(status.directory, undefined); assert.equal(status.supervisor, undefined);
  assert.deepEqual(readRemoteGateJob(f.input), before); f.untouchedSpool();
});

test('accepted cancellation is idempotent and does not authorize execution', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input);
  const first = await f.status('cancel'); const again = await f.status('cancel');
  assert.equal(first.state, 'cancelled'); assert.equal(first.cancellationRequested, true);
  assert.equal(first.gateVerified, false); assert.deepEqual(again, first);
  assert.equal(readRemoteGateJob(f.input).supervisor, null); f.untouchedSpool();
});

test('running cancellation reports pending cleanup, never stopped or GREEN', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input); transition(f, 'starting');
  const owner = { pid: 12345, startedAt: 'synthetic owner identity', executable: '/usr/local/bin/node' };
  transition(f, 'running', { owner });
  const status = await f.status('cancel');
  assert.equal(status.state, 'cancelling'); assert.equal(status.cancellationRequested, true);
  assert.equal(status.artifactsReady, false); assert.equal(status.gateVerified, false);
  assert.deepEqual(readRemoteGateJob(f.input).supervisor, owner); f.untouchedSpool();
});

for (const value of [
  { version: 1, operation: 'start' },
  { version: 1, operation: 'cancel', command: 'touch forbidden' },
  { version: 1, operation: 'cancel', root: '/tmp/peer' },
  { version: 2, operation: 'cancel' },
  { version: 1, operation: '$(touch forbidden)' },
  [], null, Buffer.from([0xff]),
]) test(`refuses unapproved control data ${JSON.stringify(value)}`, async t => {
  const f = fixture(t); admitRemoteGateJob(f.input); const before = readRemoteGateJob(f.input);
  await assert.rejects(f.response(f.framed(value)), /control (?:fields|version|operation|object|encoding)/);
  assert.deepEqual(readRemoteGateJob(f.input), before); f.untouchedSpool();
  assert.equal(existsSync(join(f.root, 'forbidden')), false);
});

test('different original request bytes cannot inspect or cancel the job', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input);
  const bytes = Buffer.from(JSON.stringify({ ...f.request, commit: '9'.repeat(40) }));
  await assert.rejects(f.response(f.framed({ version: 1, operation: 'cancel' }, bytes)), /other bytes/);
  assert.equal(readRemoteGateJob(f.input).state, 'accepted'); f.untouchedSpool();
});

test('trailing control bytes cannot mutate the journal before EOF validation', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input);
  const bytes = Buffer.concat([f.framed({ version: 1, operation: 'cancel' }), Buffer.from('extra')]);
  await assert.rejects(f.response(bytes), /trailing frame bytes/);
  assert.equal(readRemoteGateJob(f.input).state, 'accepted'); f.untouchedSpool();
});

test('interruption at EOF cannot commit a cancellation', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input);
  const bytes = f.framed({ version: 1, operation: 'cancel' });
  async function* interrupted() { yield bytes; throw new Error('transport interrupted before EOF'); }
  const response = remoteGateControlResponse(Readable.from(interrupted(), { objectMode: false }), f.options);
  await assert.rejects(async () => { for await (const _ of response) { /* consume */ } }, /transport interrupted before EOF/);
  assert.equal(readRemoteGateJob(f.input).state, 'accepted'); f.untouchedSpool();
});

test('abort before dispatch leaves the journal unchanged', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input);
  const controller = new AbortController(); controller.abort(new Error('caller aborted'));
  await assert.rejects(f.status('cancel', { signal: controller.signal }), /caller aborted/);
  assert.equal(readRemoteGateJob(f.input).state, 'accepted'); f.untouchedSpool();
});

test('disconnect after cancellation records intent but cleans only its response spool', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input);
  const response = remoteGateControlResponse(Readable.from([f.framed({ version: 1, operation: 'cancel' })], { objectMode: false }), f.options);
  assert.equal((await response.next()).done, false);
  await response.return();
  assert.equal(readRemoteGateJob(f.input).state, 'cancelled');
  assert.equal((await f.status()).state, 'cancelled'); f.untouchedSpool();
});

test('fetch refuses unfinished jobs without changing their state', async t => {
  const f = fixture(t); admitRemoteGateJob(f.input);
  await assert.rejects(f.response(f.framed({ version: 1, operation: 'fetch' }), 'result'), /not ready/);
  assert.equal(readRemoteGateJob(f.input).state, 'accepted'); f.untouchedSpool();
});

test('fetch returns the journal-bound bytes through the existing result receiver', async t => {
  const f = fixture(t); const { job } = admitRemoteGateJob(f.input); transition(f, 'starting');
  const directory = join(job.directory, 'artifacts'); mkdirSync(directory, { mode: 0o700 });
  const contents = { 'result.json': JSON.stringify({ id: job.id, requestSha256: job.requestSha256 }),
    'evidence.json': '{}', 'gate.log': 'synthetic gate\n', 'browser.tsv': 'synthetic browser ledger\n' };
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(join(directory, name), bytes, { mode: 0o600 });
  transition(f, 'running', { owner: { pid: 12345, startedAt: 'synthetic identity', executable: '/usr/local/bin/node' } });
  transition(f, 'completed', { exitCode: 0, resultSha256: sha256(Buffer.from(contents['result.json'])) });
  const result = await f.response(f.framed({ version: 1, operation: 'fetch' }), 'result');
  for (const [name, bytes] of Object.entries(contents)) assert.equal(readFileSync(result.paths[name], 'utf8'), bytes);
  assert.equal(readRemoteGateJob(f.input).state, 'completed'); f.untouchedSpool();
});

test('log returns a finished job\'s kept log, refuses an unfinished one and other request bytes', async t => {
  const f = fixture(t); const logs = join(f.root, 'logs'); mkdirSync(logs, { mode: 0o700 });
  const { job } = admitRemoteGateJob(f.input);
  writeFileSync(join(logs, `${job.id}.log`), 'red gate log\n', { mode: 0o600 });
  const log = (raw) => f.response(f.framed({ version: 1, operation: 'log' }, raw), 'log', { logRoot: logs });
  await assert.rejects(log(), /not finished/, 'an unfinished job\'s log is not served');
  transition(f, 'starting'); transition(f, 'failed', { exitCode: 3 });
  const got = await log();
  assert.equal(readFileSync(got.paths['gate.log'], 'utf8'), 'red gate log\n');
  const other = Buffer.from(JSON.stringify({ ...f.request, commit: 'a'.repeat(40) }));
  await assert.rejects(log(other), /other bytes/, 'possession of THIS request\'s bytes is the right to read');
  assert.equal(readRemoteGateJob(f.input).state, 'failed'); f.untouchedSpool();
});
