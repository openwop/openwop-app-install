import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { admitRemoteGateJob, readRemoteGateJob, transitionRemoteGateJob } from './lib/remote-gate-job.mjs';
import { remoteGateJobStatus, remoteGateJobResultFrame } from './lib/remote-gate-status.mjs';
import { remoteGateFrame, receiveRemoteGateFrame } from './lib/remote-gate-frame.mjs';
import { sha256 } from './lib/remote-gate-result.mjs';

// Real private filesystem/journal/framing, synthetic gate payloads: these tests
// qualify status/fetch behavior, not a real worker, SSH connection or GREEN gate.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remote-gate-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trust = { runnerId: 'fixture-mac', policySha256: 'a'.repeat(64) };
  const request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00.000Z',
    expiresAt: '2026-10-28T06:00:00.000Z', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    main: 'd'.repeat(40), refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), ...trust };
  return { root, trust, request, requestBytes: Buffer.from(JSON.stringify(request)),
    now: Date.parse('2026-10-28T01:00:00.000Z') };
}
function transition(f, state, details = {}) {
  const job = readRemoteGateJob(f);
  return transitionRemoteGateJob({ ...f, expectedSequence: job.sequence, state, details });
}
function ready(f, resultExtra = {}) {
  const { job } = admitRemoteGateJob(f);
  transition(f, 'starting');
  transition(f, 'running', { owner: { pid: 12345, startedAt: 'synthetic-owner', executable: '/usr/local/bin/node' } });
  const directory = join(job.directory, 'artifacts'); mkdirSync(directory, { mode: 0o700 });
  const contents = { 'result.json': JSON.stringify({ id: job.id, requestSha256: job.requestSha256, ...resultExtra }),
    'evidence.json': '{}', 'gate.log': 'synthetic gate log\n', 'browser.tsv': 'synthetic browser ledger\n' };
  const paths = {};
  for (const [name, text] of Object.entries(contents)) {
    paths[name] = join(directory, name); writeFileSync(paths[name], text, { mode: 0o600 });
  }
  transition(f, 'completed', { exitCode: 0, resultSha256: sha256(Buffer.from(contents['result.json'])) });
  return { directory, contents, paths };
}

test('status never admits an unknown request or creates its directory', t => {
  const f = fixture(t);
  assert.throws(() => remoteGateJobStatus(f), /ENOENT/);
  assert.equal(existsSync(join(f.root, f.request.id)), false);
});

test('expired unresolved start remains readable and unchanged on reconnect', t => {
  const f = fixture(t); const { job } = admitRemoteGateJob(f); transition(f, 'starting');
  const before = readdirSync(job.directory).sort();
  const status = remoteGateJobStatus({ ...f, now: Date.parse(f.request.expiresAt) + 1000 });
  assert.equal(status.state, 'starting'); assert.equal(status.sequence, 1);
  assert.equal(status.artifactsReady, false); assert.equal(status.gateVerified, false);
  assert.equal(status.resultSha256, null);
  assert.deepEqual(readdirSync(job.directory).sort(), before);
  assert.equal(status.directory, undefined); assert.equal(status.supervisor, undefined);
});

test('same ID cannot inspect different request bytes', t => {
  const f = fixture(t); admitRemoteGateJob(f);
  assert.throws(() => remoteGateJobStatus({ ...f,
    requestBytes: Buffer.from(JSON.stringify({ ...f.request, commit: '9'.repeat(40) })) }), /other bytes/);
});

for (const state of ['accepted', 'starting', 'failed', 'cancelled']) {
  test(`${state} never returns result artifacts`, t => {
    const f = fixture(t); admitRemoteGateJob(f);
    if (state !== 'accepted') transition(f, 'starting');
    if (state === 'failed') transition(f, 'failed', { exitCode: 1 });
    if (state === 'cancelled') transition(f, 'cancelled', { cleanup: 'verified', owned: 0 });
    assert.throws(() => [...remoteGateJobResultFrame(f)], /not ready/);
    assert.equal(remoteGateJobStatus(f).artifactsReady, false);
  });
}

test('completed bytes survive the real frame receiver, without a GREEN claim', async t => {
  const f = fixture(t); const { contents } = ready(f);
  const status = remoteGateJobStatus(f);
  assert.equal(status.artifactsReady, true); assert.equal(status.gateVerified, false);
  const input = Readable.from(remoteGateJobResultFrame(f), { objectMode: false });
  const result = await receiveRemoteGateFrame(input, { kind: 'result', root: f.root });
  for (const [name, value] of Object.entries(contents)) assert.equal(readFileSync(result.paths[name], 'utf8'), value);
  assert.equal(readRemoteGateJob(f).sequence, 3);
});

test('a replaced result fails its durable digest before emitting any frame bytes', t => {
  const f = fixture(t); const { paths } = ready(f);
  writeFileSync(paths['result.json'], '{}');
  assert.throws(() => remoteGateJobResultFrame(f).next(), /differs from durable job/);
});

test('a completed record cannot bind artifacts from another request', t => {
  const f = fixture(t); ready(f, { requestSha256: '0'.repeat(64) });
  assert.throws(() => remoteGateJobResultFrame(f).next(), /request differs/);
});

test('symlink artifact reads are refused and the peer target is untouched', t => {
  const f = fixture(t); const { paths } = ready(f);
  const peer = join(f.root, 'peer'); writeFileSync(peer, 'preserve', { mode: 0o600 });
  rmSync(paths['gate.log']); symlinkSync(peer, paths['gate.log']);
  assert.throws(() => remoteGateJobResultFrame(f).next(), /private regular/);
  assert.equal(readFileSync(peer, 'utf8'), 'preserve');
});

test('a public artifact is not exposed through fetch', t => {
  const f = fixture(t); const { paths } = ready(f); chmodSync(paths['gate.log'], 0o644);
  assert.throws(() => remoteGateJobResultFrame(f).next(), /private regular/);
});

test('encoder pins the digest on its own descriptor, closing the earlier-read gap', t => {
  const f = fixture(t); const { paths } = ready(f);
  const expected = sha256(readFileSync(paths['result.json']));
  writeFileSync(paths['result.json'], '{}');
  assert.throws(() => remoteGateFrame('result', paths,
    { expectedSha256: { 'result.json': expected } }).next(), /artifact differs from durable job/);
});
