/** ADR 0863 D9: validate evidence from an authenticated, explicitly trusted runner.
 * This is an evidence reader, not SSH authentication or a malicious-worker sandbox.
 * Keep it on the submitting host; never execute a verifier downloaded from a worker.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = (value, name, length = 64) => assert.match(value, new RegExp(`^[a-f0-9]{${length}}$`), name);
function object(value, name) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), name);
}
function instant(value, name) {
  assert.equal(typeof value, 'string', name);
  assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/, name);
  const n = Date.parse(value);
  assert(Number.isFinite(n), name);
  assert.equal(new Date(n).toISOString(), value.includes('.') ? value : value.replace('Z', '.000Z'), name);
  return n;
}
function json(bytes, name) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024, name);
  const value = JSON.parse(bytes.toString('utf8'));
  object(value, name);
  return value;
}

/** Shared pre-execution contract. The trust object is local runner policy, not
 * data submitted by the candidate. No field can select a command or directory.
 */
export function parseRemoteGateRequest(requestBytes, trust, now = Date.now()) {
  object(trust, 'local runner trust is required');
  assert.match(trust.runnerId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'runner identity');
  sha(trust.policySha256, 'locally approved runner policy');
  const request = json(requestBytes, 'request');
  assert.deepEqual(Object.keys(request).sort(), ['version', 'id', 'createdAt', 'expiresAt',
    'commit', 'tree', 'main', 'refsSha256', 'bundleSha256', 'runnerId', 'policySha256'].sort(), 'request fields');
  assert.equal(request.version, 1, 'request version');
  sha(request.id, 'fresh request ID', 32);
  for (const key of ['commit', 'tree', 'main']) sha(request[key], key, 40);
  for (const key of ['refsSha256', 'bundleSha256']) sha(request[key], key);
  assert.equal(request.runnerId, trust.runnerId, 'request runner differs from local trust');
  assert.equal(request.policySha256, trust.policySha256, 'request policy differs from local trust');
  const issued = instant(request.createdAt, 'request creation time');
  const expires = instant(request.expiresAt, 'request expiry');
  assert(Number.isFinite(now) && issued <= now && now <= expires, 'request is not currently valid');
  assert(expires > issued && expires - issued <= 6 * 60 * 60 * 1000, 'request lifetime exceeds six hours');
  return request;
}

/**
 * `trust` and `authenticatedHostKey` come from local operator configuration and
 * the SSH controller, not fields read from resultBytes. Hashes bind exact bytes.
 * A returned object reports required vs advisory browser status separately.
 */
export function validateRemoteGateResult({ requestBytes, resultBytes, gateLog,
  evidenceBytes, browserLedger, trust, authenticatedHostKey, now = Date.now() }) {
  object(trust, 'local runner trust is required');
  assert.match(trust.hostKey, /^SHA256:[A-Za-z0-9+/]{43}$/, 'pinned SSH host key');
  assert.equal(authenticatedHostKey, trust.hostKey, 'SSH host identity differs');
  assert.match(trust.runnerId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'runner identity');
  sha(trust.policySha256, 'locally approved runner policy');
  const request = parseRemoteGateRequest(requestBytes, trust, now);
  const result = json(resultBytes, 'result');
  assert.equal(result.version, 1, 'result version');
  const issued = instant(request.createdAt, 'request creation time');
  assert.equal(result.id, request.id, 'result belongs to another request');
  assert.equal(result.requestSha256, sha256(requestBytes), 'request bytes changed');
  for (const key of ['runnerId', 'policySha256', 'commit', 'main', 'refsSha256', 'bundleSha256']) {
    assert.equal(result[key], request[key], `result ${key} differs`);
  }
  assert.equal(result.treeBefore, request.tree, 'worker started with another tree');
  assert.equal(result.treeAfter, request.tree, 'worker tree changed');
  assert.equal(result.dirtyBefore, false, 'worker started dirty');
  assert.equal(result.dirtyAfter, false, 'worker finished dirty');
  assert.equal(result.exitCode, 0, 'remote gate failed or was interrupted');
  assert.match(result.nodeVersion, /^22\.\d+\.\d+$/, 'Node 22 required');
  assert.equal(result.npmVersion, '10.9.8', 'npm version');
  assert.deepEqual(result.disabledLanes, [], 'remote gate disabled a required lane');
  const started = instant(result.startedAt, 'worker start');
  const finished = instant(result.finishedAt, 'worker finish');
  assert(issued <= started && started < finished && finished <= now, 'worker times do not belong to this request');
  object(result.artifacts, 'artifact digests missing');
  for (const [name, bytes] of Object.entries({ gateLog, evidence: evidenceBytes, browserLedger })) {
    assert(Buffer.isBuffer(bytes) && bytes.length > 0, `${name} missing or empty`);
    sha(result.artifacts[name], `${name} digest`);
    assert.equal(sha256(bytes), result.artifacts[name], `${name} bytes differ`);
  }
  const evidence = json(evidenceBytes, 'Hyvemind evidence');
  assert.equal(evidence.tool, 'hyvemind', 'evidence tool');
  assert.equal(evidence.version, '0.2.0', 'evidence version');
  assert.equal(evidence.head, request.commit, 'evidence is for another commit');
  assert.equal(evidence.treeBefore, request.tree, 'evidence initial tree');
  assert.equal(evidence.treeAfter, request.tree, 'evidence final tree');
  assert.equal(evidence.partial, false, 'partial evidence is not a gate');
  assert.equal(evidence.verdict, 'green', 'full green evidence is missing');
  assert(Array.isArray(evidence.gates) && evidence.gates.length === 1, 'canonical gate record missing');
  const gate = evidence.gates[0];
  assert.equal(gate.run, 'npm run ci', 'wrong gate command');
  assert.equal(gate.exitCode, 0, 'canonical gate exit');
  assert.equal(gate.pass, true, 'canonical gate did not pass');
  assert(Number.isFinite(gate.durationMs) && gate.durationMs > 0, 'gate duration missing');
  const gateStart = instant(evidence.startedAt, 'gate start');
  const gateEnd = instant(evidence.finishedAt, 'gate finish');
  assert(started <= gateStart && gateStart < gateEnd && gateEnd <= finished, 'stale evidence times');
  assert(gate.durationMs <= gateEnd - gateStart, 'gate duration exceeds recorded interval');
  // The normal ledger uses short commit IDs. An exact prefix plus the full-head
  // Hyvemind record binds it without inventing a different browser reporting lane.
  const last = browserLedger.toString('utf8').trim().split('\n').at(-1).split('\t');
  assert.equal(last.length, 3, 'browser ledger shape');
  assert.match(last[1], /^[a-f0-9]{9,40}$/, 'browser ledger commit');
  assert(request.commit.startsWith(last[1]), 'browser ledger is for another commit');
  const browserAt = instant(last[0], 'browser ledger time');
  assert(gateStart <= browserAt && browserAt <= gateEnd, 'browser ledger is stale');
  const browser = /^ran:pass;serial=(pass|FAIL|skip)$/.exec(last[2]);
  assert(browser, 'required browser lane did not run and pass');
  return { commit: request.commit, tree: request.tree, requestId: request.id,
    runnerId: trust.runnerId, gateDurationMs: gate.durationMs,
    requiredBrowser: 'pass', advisoryBrowser: browser[1],
    provenance: 'trusted SSH runner; not a signature against a compromised worker' };
}
