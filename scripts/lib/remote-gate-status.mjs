/** ADR 0863 D9: read-only worker status and result fetch. The installed SSH
 * dispatcher supplies its own root/trust, plus the original bounded request.
 * This module never admits, starts, signals, repairs or removes a job. A ready
 * artifact is not an accepted gate; the submitting host validates it separately.
 */
import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { readRemoteGateJob } from './remote-gate-job.mjs';
import { privateRoot } from './remote-gate-source.mjs';
import { remoteGateFrame } from './remote-gate-frame.mjs';
import { sha256 } from './remote-gate-result.mjs';

/** Existing jobs remain inspectable after request expiry; unknown IDs are not
 * admitted as a side effect of status. No local paths or process identities are
 * included in the response, and an unresolved start remains unresolved.
 */
export function remoteGateJobStatus(input) {
  const job = readRemoteGateJob(input);
  return {
    version: 1, id: job.id, requestSha256: job.requestSha256,
    commit: job.request.commit, tree: job.request.tree,
    sequence: job.sequence, state: job.state, changedAt: job.at,
    cancellationRequested: job.cancellationRequested,
    artifactsReady: job.state === 'completed',
    resultSha256: job.state === 'completed' ? job.details.resultSha256 : null,
    // A failed job's exit code tells a red gate from a worker fault (70: publication
    // refused; 124: the worker's own time limit). It is not a verdict on its own.
    exitCode: job.state === 'failed' ? job.details.exitCode : null,
    gateVerified: false,
  };
}

function resultBytes(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0
      && stat.size > 0 && stat.size <= 1024 * 1024, 'bounded private result required');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert(read > 0, 'result truncated');
      offset += read;
    }
    assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, offset), 0, 'result grew beyond bound');
    return bytes;
  } finally { closeSync(fd); }
}

/** The supervisor publishes only these fixed artifacts under its job directory
 * before committing completed. No request/returned field chooses a path. Hashes
 * are checked again by the encoder against its own descriptors and by the local
 * result validator, so a changed artifact cannot become accepted evidence.
 */
export function* remoteGateJobResultFrame(input) {
  const job = readRemoteGateJob(input);
  assert.equal(job.state, 'completed', 'job artifacts are not ready');
  const directory = privateRoot(join(job.directory, 'artifacts'));
  const paths = Object.fromEntries(['result.json', 'evidence.json', 'gate.log', 'browser.tsv']
    .map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) {
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
      && (stat.mode & 0o077) === 0, 'private regular job artifact required');
  }
  const raw = resultBytes(paths['result.json']);
  assert.equal(sha256(raw), job.details.resultSha256, 'result differs from durable job');
  const result = JSON.parse(raw.toString('utf8'));
  assert.equal(result?.id, job.id, 'result belongs to another job');
  assert.equal(result?.requestSha256, job.requestSha256, 'result request differs');
  yield* remoteGateFrame('result', paths, { expectedSha256: { 'result.json': job.details.resultSha256 } });
}
