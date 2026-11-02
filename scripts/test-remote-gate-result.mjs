import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256, validateRemoteGateResult } from './lib/remote-gate-result.mjs';

const bytes = (v) => Buffer.from(JSON.stringify(v));
function fixture() {
  const trust = { hostKey: `SHA256:${'A'.repeat(43)}`, runnerId: 'test-mac', policySha256: 'a'.repeat(64) };
  const request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00Z',
    expiresAt: '2026-10-28T06:00:00Z', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    main: 'd'.repeat(40), refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64),
    runnerId: trust.runnerId, policySha256: trust.policySha256 };
  const evidence = { tool: 'hyvemind', version: '0.2.0', head: request.commit,
    treeBefore: request.tree, treeAfter: request.tree, partial: false, verdict: 'green',
    startedAt: '2026-10-28T00:05:00Z', finishedAt: '2026-10-28T00:35:00Z',
    gates: [{ name: 'ci', run: 'npm run ci', exitCode: 0, pass: true, durationMs: 1800000 }] };
  const result = { ...request, requestSha256: sha256(bytes(request)), treeBefore: request.tree,
    treeAfter: request.tree, dirtyBefore: false, dirtyAfter: false, exitCode: 0,
    startedAt: '2026-10-28T00:01:00Z', finishedAt: '2026-10-28T00:36:00Z',
    nodeVersion: '22.23.4', npmVersion: '10.9.8', disabledLanes: [] };
  return { trust, request, evidence, result,
    browserLedger: Buffer.from(`2026-10-28T00:34:00Z\t${request.commit.slice(0,9)}\tran:pass;serial=FAIL\n`),
    gateLog: Buffer.from('fixture canonical full gate output\n') };
}
function input(f) {
  const evidenceBytes = bytes(f.evidence);
  const artifacts = { gateLog: sha256(f.gateLog), evidence: sha256(evidenceBytes), browserLedger: sha256(f.browserLedger) };
  return { requestBytes: bytes(f.request), resultBytes: bytes({ ...f.result, artifacts }),
    evidenceBytes, gateLog: f.gateLog, browserLedger: f.browserLedger, trust: f.trust,
    authenticatedHostKey: f.trust.hostKey, now: Date.parse('2026-10-28T00:40:00Z') };
}

test('accepts a bound full gate and preserves an advisory browser failure', () => {
  const verdict = validateRemoteGateResult(input(fixture()));
  assert.equal(verdict.requiredBrowser, 'pass');
  assert.equal(verdict.advisoryBrowser, 'FAIL');
});
for (const [name, mutate, pattern] of [
  ['another request', f => { f.result.id = '2'.repeat(32); }, /another request/],
  ['another runner', f => { f.result.runnerId = 'other-mac'; }, /runnerId differs/],
  ['unapproved policy', f => { f.result.policySha256 = '0'.repeat(64); }, /policySha256 differs/],
  ['another main', f => { f.result.main = '0'.repeat(40); }, /main differs/],
  ['another ref snapshot', f => { f.result.refsSha256 = '0'.repeat(64); }, /refsSha256 differs/],
  ['another bundle', f => { f.result.bundleSha256 = '0'.repeat(64); }, /bundleSha256 differs/],
  ['tree changed', f => { f.result.treeAfter = '0'.repeat(40); }, /tree changed/],
  ['dirty worker', f => { f.result.dirtyAfter = true; }, /finished dirty/],
  ['interrupted gate', f => { f.result.exitCode = 143; }, /failed or was interrupted/],
  ['wrong npm', f => { f.result.npmVersion = '11.5.0'; }, /npm version/],
  ['required lane disabled', f => { f.result.disabledLanes = ['browser']; }, /disabled a required lane/],
  ['partial evidence', f => { f.evidence.partial = true; }, /partial evidence/],
  ['reused earlier evidence', f => { f.evidence.startedAt = '2026-10-27T00:05:00Z'; }, /stale evidence/],
  ['evidence for another head', f => { f.evidence.head = '0'.repeat(40); }, /another commit/],
  ['empty gate list', f => { f.evidence.gates = []; }, /canonical gate record/],
  ['quick gate', f => { f.evidence.gates[0].run = 'npm run ci:quick'; }, /wrong gate command/],
  ['red gate', f => { f.evidence.gates[0].pass = false; }, /did not pass/],
  ['missing log', f => { f.gateLog = Buffer.alloc(0); }, /missing or empty/],
  ['browser opt-out', f => { f.browserLedger = Buffer.from(`2026-10-28T00:34:00Z\t${f.request.commit.slice(0,9)}\tskipped\n`); }, /did not run/],
  ['stale browser ledger', f => { f.browserLedger = Buffer.from(`2026-10-27T00:34:00Z\t${f.request.commit.slice(0,9)}\tran:pass;serial=pass\n`); }, /ledger is stale/],
]) test(`rejects ${name}`, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => validateRemoteGateResult(input(f)), pattern);
});
for (const [name, mutate, pattern] of [
  ['wrong authenticated SSH key', i => { i.authenticatedHostKey = `SHA256:${'B'.repeat(43)}`; }, /SSH host identity differs/],
  ['expired request', i => { i.now = Date.parse('2026-10-28T06:00:01Z'); }, /not currently valid/],
  ['missing log bytes', i => { i.gateLog = undefined; }, /missing or empty/],
  ['changed log bytes', i => { i.gateLog = Buffer.from('truncated'); }, /gateLog bytes differ/],
  ['changed evidence bytes', i => { i.evidenceBytes = Buffer.from('{}'); }, /evidence bytes differ/],
  ['changed ledger bytes', i => { i.browserLedger = Buffer.from('forged'); }, /browserLedger bytes differ/],
  ['changed request bytes', i => { i.requestBytes = Buffer.concat([i.requestBytes, Buffer.from(' ')]); }, /request bytes changed/],
]) test(`rejects ${name}`, () => {
  const i = input(fixture()); mutate(i);
  assert.throws(() => validateRemoteGateResult(i), pattern);
});
