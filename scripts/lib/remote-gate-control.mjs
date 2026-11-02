/** ADR 0863 D9: fixed worker control dispatch over the existing bounded frame.
 * This does not install a worker, authenticate SSH, admit/start work or signal
 * processes. The installed entry point supplies root/trust; submitted data can
 * only inspect, request cancellation, or fetch an already completed job.
 */
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remoteGateFrame, receiveRemoteGateFrame } from './remote-gate-frame.mjs';
import { readRemoteGateJob, requestRemoteGateCancellation } from './remote-gate-job.mjs';
import { privateRoot } from './remote-gate-source.mjs';
import { remoteGateJobStatus, remoteGateJobResultFrame } from './remote-gate-status.mjs';

function operation(bytes) {
  const text = bytes.toString('utf8');
  assert(Buffer.from(text).equals(bytes), 'control encoding');
  const value = JSON.parse(text);
  assert(value && typeof value === 'object' && !Array.isArray(value), 'control object');
  assert.deepEqual(Object.keys(value).sort(), ['operation', 'version'], 'control fields');
  assert.equal(value.version, 1, 'control version');
  assert(['status', 'cancel', 'fetch', 'log'].includes(value.operation), 'unknown control operation');
  return value.operation;
}

/** Consume and validate the ENTIRE request, including EOF, before any journal
 * mutation. A disconnected cancel may have committed its intent; reconnect by
 * status, never by resubmission. Cancellation's response is the current journal
 * state, not a promise that running processes stopped. The caller must consume
 * or close this generator; finally removes only its newly allocated spool.
 *
 * The private receive directory is never returned and only fixed local artifact
 * names are opened. The same trusted-account assumption as the journal applies;
 * this is not isolation from a malicious process using the worker's account.
 */
export async function* remoteGateControlResponse(input, { root, spoolRoot, trust, logRoot, signal, now } = {}) {
  const frame = await receiveRemoteGateFrame(input, { kind: 'control', root: spoolRoot, signal,
    idleTimeoutMs: 5000, totalTimeoutMs: 30000 });
  try {
    const action = operation(readFileSync(frame.paths['operation.json']));
    const requestBytes = readFileSync(frame.paths['request.json']);
    signal?.throwIfAborted();
    const jobInput = { root, requestBytes, trust, now: now ?? Date.now() };
    if (action === 'fetch') {
      for (const chunk of remoteGateJobResultFrame(jobInput)) {
        signal?.throwIfAborted();
        yield chunk;
      }
      return;
    }
    if (action === 'log') {
      // Only a FINISHED job's log, only to the holder of its exact request bytes
      // (readRemoteGateJob refuses other bytes), and only from the installed
      // log root under a name derived from the validated job id.
      const job = readRemoteGateJob(jobInput);
      assert(['completed', 'failed', 'interrupted', 'cancelled'].includes(job.state), 'job is not finished');
      assert(logRoot, 'no log root configured');
      for (const chunk of remoteGateFrame('log', { 'gate.log': join(privateRoot(logRoot), `${job.id}.log`) })) {
        signal?.throwIfAborted();
        yield chunk;
      }
      return;
    }
    if (action === 'cancel') requestRemoteGateCancellation(jobInput);
    const status = remoteGateJobStatus(jobInput);
    const path = join(frame.work, 'status.json');
    writeFileSync(path, JSON.stringify(status) + '\n', { flag: 'wx', mode: 0o600 });
    for (const chunk of remoteGateFrame('status', { 'status.json': path })) {
      signal?.throwIfAborted();
      yield chunk;
    }
  } finally { rmSync(frame.work, { recursive: true, force: true }); }
}
