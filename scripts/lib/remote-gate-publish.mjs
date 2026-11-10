/** ADR 0863 D9: publish the installed supervisor's closed artifact files, then
 * CAS the existing job to completed. The journal is the visibility boundary:
 * status/fetch never exposes partial publication. This does not start a job,
 * observe process exit, authenticate SSH, or accept a gate on the submitter.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { REMOTE_GATE_RESULT_FILES } from './remote-gate-frame.mjs';
import { readRemoteGateJob, transitionRemoteGateJob } from './remote-gate-job.mjs';
import { privateRoot } from './remote-gate-source.mjs';

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Keep one source descriptor throughout the bounded copy. Hash the bytes actually
// written, refuse growth/truncation, and fsync each private exclusive destination.
function copyArtifact(source, destination, max) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const stat = fstatSync(input);
    assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0
      && stat.size > 0 && stat.size <= max, 'bounded private artifact required');
    output = openSync(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const n = readSync(input, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      assert(n > 0, 'artifact truncated during publication');
      let written = 0;
      while (written < n) {
        const count = writeSync(output, buffer, written, n - written);
        assert(count > 0, 'artifact copy stopped');
        written += count;
      }
      hash.update(buffer.subarray(0, n));
      offset += n;
    }
    assert.equal(readSync(input, buffer, 0, 1, offset), 0, 'artifact grew during publication');
    fsyncSync(output);
    return hash.digest('hex');
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

/** Only the installed supervisor calls this after observing its owned command
 * exit. owner/exitCode and artifactsDirectory are local observations/config, not
 * submission fields. A repeated, interrupted or racing publication cannot
 * overwrite artifacts. Existing incomplete output is retained for diagnosis.
 * The submitting host still validates full Hyvemind/browser/tree/SSH evidence.
 */
export function publishRemoteGateArtifacts({ root, requestBytes, trust,
  expectedSequence, owner, exitCode, artifactsDirectory, now = Date.now() }) {
  const input = { root, requestBytes, trust, now };
  const job = readRemoteGateJob(input);
  assert.equal(job.state, 'running', 'only a running job can publish artifacts');
  assert.equal(job.sequence, expectedSequence, 'job changed before publication');
  assert.deepEqual(owner, job.supervisor, 'publisher differs from recorded supervisor');
  assert.equal(exitCode, 0, 'failed or interrupted command cannot complete');
  const source = privateRoot(artifactsDirectory);
  const destination = join(job.directory, 'artifacts');
  assert.notEqual(source, destination, 'source must be separate from publication');
  // Exclusive reservation: no rename-over-existing-directory behavior. Keep this
  // directory on ALL subsequent errors, including a concurrent cancellation.
  mkdirSync(destination, { mode: 0o700 });
  syncDirectory(job.directory);
  const digests = {};
  for (const [name, limit] of Object.entries(REMOTE_GATE_RESULT_FILES)) {
    digests[name] = copyArtifact(join(source, name), join(destination, name), limit);
  }
  const result = JSON.parse(readFileSync(join(destination, 'result.json'), 'utf8'));
  assert.equal(result?.version, 1, 'result version');
  assert.equal(result?.id, job.id, 'result belongs to another job');
  assert.equal(result?.requestSha256, job.requestSha256, 'result request differs');
  for (const field of ['runnerId', 'policySha256', 'commit', 'main', 'refsSha256', 'bundleSha256']) {
    assert.equal(result[field], job.request[field], `result ${field} differs`);
  }
  assert.equal(result.treeBefore, job.request.tree, 'result initial tree differs');
  assert.equal(result.treeAfter, job.request.tree, 'result final tree differs');
  assert.equal(result.exitCode, exitCode, 'result exit differs from observed command');
  for (const [field, name] of Object.entries({ gateLog: 'gate.log.gz', evidence: 'evidence.json', browserLedger: 'browser.tsv' })) {
    assert.equal(result.artifacts?.[field], digests[name], `${name} bytes differ`);
  }
  syncDirectory(destination);
  // If cancellation won the sequence, changed=false preserves its verdict and
  // leaves the fully copied artifacts unavailable through status/fetch.
  return transitionRemoteGateJob({ ...input, expectedSequence, state: 'completed',
    details: { exitCode: 0, resultSha256: digests['result.json'] } });
}
