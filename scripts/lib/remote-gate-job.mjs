/** ADR 0863 D9: request-scoped durable job journal. This does not execute a gate,
 * signal processes, authenticate SSH, or turn a completed job into GREEN.
 * The installed worker must persist starting before spawning its supervisor.
 * A crash in starting is unresolved work, never permission to start it again.
 */
import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, mkdtempSync,
  lstatSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRemoteGateRequest, sha256 } from './remote-gate-result.mjs';
import { privateRoot } from './remote-gate-source.mjs';

const NEXT = Object.freeze({
  accepted: ['starting', 'cancelled'],
  starting: ['running', 'failed', 'interrupted', 'cancelling', 'cancelled'],
  running: ['completed', 'failed', 'interrupted', 'cancelling', 'cancelled'],
  cancelling: ['cancelled', 'interrupted'],
  completed: [], failed: [], interrupted: [], cancelled: [],
});
const MAX_RECORDS = 8;
/** Closed reasons an installed supervisor may give for uncertain cleanup (D9).
 * `cleanup: "verified"` means every process OBSERVED in the gate's group is gone.
 * It does NOT mean no descendant survives: on macOS a process that leaves the
 * group before any sample sees it is invisible (residual R2). A Linux subreaper
 * closes that gap; until then, never read `verified` as "no survivors". */
export const CLEANUP_REASONS = Object.freeze(['identity_unreadable', 'escaped_group',
  'members_remain', 'scan_failed', 'supervisor_restarted', 'holder_lost']);
const entryName = sequence => `${String(sequence).padStart(4, '0')}.json`;
const bytes = value => Buffer.from(JSON.stringify(value) + '\n');

function readRegular(path, max) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0
      && stat.size > 0 && stat.size <= max, 'bounded private job record required');
    const value = readFileSync(fd);
    assert(value.length > 0 && value.length <= max, 'job record changed size');
    return value;
  } finally { closeSync(fd); }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
// Link a complete fsynced file under an immutable sequence name. A concurrent
// writer cannot overwrite the winner or expose a partially written JSON record.
function createRecord(directory, name, content) {
  const temp = mkdtempSync(join(directory, '.pending-'));
  const path = join(temp, 'record');
  try {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(path, join(directory, name)); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    syncDirectory(directory);
    return true;
  } finally {
    // Only a temporary path allocated by this invocation is removed.
    rmSync(temp, { recursive: true, force: true });
  }
}
function requestIdentity(requestBytes, trust) {
  // Status/reconnect must still work after the submission expires. Validate the
  // whole original contract at its creation time; only a new admission uses now.
  assert(Buffer.isBuffer(requestBytes) && requestBytes.length <= 1024 * 1024, 'bounded request bytes');
  const value = JSON.parse(requestBytes.toString('utf8'));
  return parseRemoteGateRequest(requestBytes, trust, Date.parse(value.createdAt));
}
function location(root, request) {
  return join(privateRoot(root), request.id); // ID was checked as exactly 32 hex.
}
function timestamp(value, earliest, now) {
  assert.equal(typeof value, 'string', 'job timestamp');
  const time = Date.parse(value);
  assert(Number.isFinite(time) && new Date(time).toISOString() === value
    && time >= earliest && time <= now, 'job timestamp order');
  return time;
}
function owner(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'supervisor identity required');
  assert.deepEqual(Object.keys(value).sort(), ['executable', 'pid', 'startedAt'], 'supervisor identity fields');
  assert(Number.isSafeInteger(value.pid) && value.pid > 1, 'supervisor pid');
  for (const key of ['startedAt', 'executable']) assert(typeof value[key] === 'string'
    && value[key].length > 0 && value[key].length <= 1024 && !/[\x00-\x1f\x7f]/.test(value[key]), 'supervisor identity value');
}
function validate(record, previous, request, requestSha256, now) {
  assert(record && typeof record === 'object' && !Array.isArray(record), 'job record');
  assert.deepEqual(Object.keys(record).sort(), ['at', 'details', 'id', 'previousSha256',
    'requestSha256', 'sequence', 'state', 'version'].sort(), 'job record fields');
  assert.equal(record.version, 1, 'job record version');
  assert.equal(record.id, request.id, 'job identity differs');
  assert.equal(record.requestSha256, requestSha256, 'job request differs');
  assert.equal(record.sequence, previous ? previous.record.sequence + 1 : 0, 'job sequence gap');
  assert.equal(record.previousSha256, previous ? sha256(previous.raw) : null, 'job history differs');
  timestamp(record.at, previous ? Date.parse(previous.record.at) : Date.parse(request.createdAt), now);
  assert(Object.hasOwn(NEXT, record.state), 'unknown job state');
  if (previous) assert(NEXT[previous.record.state].includes(record.state), 'job transition refused');
  else assert.equal(record.state, 'accepted', 'first job state');
  const details = record.details;
  assert(details && typeof details === 'object' && !Array.isArray(details), 'job details');
  // A cancelled job that may have launched processes carries the supervisor's
  // verified cleanup; one cancelled straight from `accepted` never launched any.
  const launched = record.state === 'cancelled' && previous?.record.state !== 'accepted';
  const fields = record.state === 'running' ? ['owner']
    : record.state === 'completed' ? ['exitCode', 'resultSha256']
      : record.state === 'failed' ? ['exitCode']
        : launched ? ['cleanup', 'owned']
          : record.state === 'interrupted' ? ['cleanup', 'reasons'] : [];
  assert.deepEqual(Object.keys(details).sort(), fields.sort(), 'job state detail fields');
  if (record.state === 'running') owner(details.owner);
  if (launched) {
    assert.equal(details.cleanup, 'verified', 'cancelled cleanup must be verified');
    assert(Number.isSafeInteger(details.owned) && details.owned >= 0 && details.owned <= 100_000, 'cancelled owned count');
  }
  if (record.state === 'interrupted') {
    assert.equal(details.cleanup, 'uncertain', 'interrupted cleanup is uncertain');
    assert(Array.isArray(details.reasons) && details.reasons.length > 0
      && details.reasons.every(reason => CLEANUP_REASONS.includes(reason))
      && new Set(details.reasons).size === details.reasons.length, 'interrupted cleanup reasons');
  }
  if (record.state === 'completed') {
    assert.equal(details.exitCode, 0, 'completed job exit');
    assert.match(details.resultSha256, /^[a-f0-9]{64}$/, 'completed result digest');
  }
  if (record.state === 'failed') assert(Number.isSafeInteger(details.exitCode)
    && details.exitCode > 0 && details.exitCode <= 255, 'failed job exit');
}

/** Read the immutable journal. Partial admissions, gaps, changed requests,
 * malformed records and symlinks refuse recovery rather than authorize a rerun.
 * `completed` only means artifacts are ready for the independent result reader.
 */
export function readRemoteGateJob({ root, requestBytes, trust, now = Date.now() }) {
  const request = requestIdentity(requestBytes, trust);
  const directory = privateRoot(location(root, request));
  const stored = readRegular(join(directory, 'request.json'), 1024 * 1024);
  assert(stored.equals(requestBytes), 'request ID already belongs to other bytes');
  const entries = readdirSync(directory).filter(name => /^\d{4}\.json$/.test(name)).sort();
  assert(entries.length > 0 && entries.length <= MAX_RECORDS, 'job admission/history is incomplete');
  let previous;
  let supervisor = null;
  let cancellationRequested = false;
  for (let sequence = 0; sequence < entries.length; sequence++) {
    assert.equal(entries[sequence], entryName(sequence), 'job sequence gap');
    const raw = readRegular(join(directory, entries[sequence]), 64 * 1024);
    const record = JSON.parse(raw.toString('utf8'));
    validate(record, previous, request, sha256(requestBytes), now);
    if (record.state === 'running') supervisor = record.details.owner;
    if (record.state === 'cancelling' || record.state === 'cancelled') cancellationRequested = true;
    previous = { record, raw };
  }
  return { directory, request, requestSha256: sha256(requestBytes), ...previous.record,
    recordSha256: sha256(previous.raw), supervisor, cancellationRequested };
}

/** Only the first exclusive admission reports created=true. Reconnects read the
 * same request, including after expiry, and NEVER acquire execution permission.
 */
export function admitRemoteGateJob({ root, requestBytes, trust, now = Date.now() }) {
  const request = requestIdentity(requestBytes, trust);
  const directory = location(root, request);
  try {
    lstatSync(directory);
    return { created: false, job: readRemoteGateJob({ root, requestBytes, trust, now }) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  parseRemoteGateRequest(requestBytes, trust, now);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { created: false, job: readRemoteGateJob({ root, requestBytes, trust, now }) };
  }
  // Keep an incomplete directory on EVERY error. Removing it would let a retry
  // erase evidence of an unknown admission and eventually duplicate execution.
  assert(createRecord(directory, 'request.json', requestBytes), 'request already exists');
  const record = { version: 1, id: request.id, requestSha256: sha256(requestBytes),
    sequence: 0, previousSha256: null, at: new Date(now).toISOString(), state: 'accepted', details: {} };
  validate(record, undefined, request, sha256(requestBytes), now);
  assert(createRecord(directory, entryName(0), bytes(record)), 'initial job state already exists');
  syncDirectory(privateRoot(root));
  return { created: true, job: readRemoteGateJob({ root, requestBytes, trust, now }) };
}

/** CAS a single transition using immutable sequence files. Losing contenders
 * receive changed=false and must not launch anything. No transition can restart
 * a starting/running/terminal job; an unknown start stays unresolved.
 */
export function transitionRemoteGateJob({ root, requestBytes, trust, expectedSequence,
  state, details = {}, now = Date.now() }) {
  const job = readRemoteGateJob({ root, requestBytes, trust, now });
  if (job.sequence !== expectedSequence) return { changed: false, job };
  if (state === 'starting') parseRemoteGateRequest(requestBytes, trust, now);
  const record = { version: 1, id: job.id, requestSha256: job.requestSha256,
    sequence: job.sequence + 1, previousSha256: job.recordSha256,
    at: new Date(now).toISOString(), state, details };
  // Reconstruct previous raw only from the immutable file; no caller field is trusted.
  const raw = readRegular(join(job.directory, entryName(job.sequence)), 64 * 1024);
  validate(record, { record: job, raw }, job.request, job.requestSha256, now);
  assert(record.sequence < MAX_RECORDS, 'job transition bound');
  const changed = createRecord(job.directory, entryName(record.sequence), bytes(record));
  return { changed, job: readRemoteGateJob({ root, requestBytes, trust, now }) };
}

/** Request cancellation through the SAME journal CAS used by start/publication.
 * An accepted job has no execution owner, so cancellation can finish immediately:
 * a concurrent starting transition either wins first or loses execution permission.
 * Starting/running jobs instead become cancelling. Only the installed supervisor
 * may record cancelled after observing that its owned processes have stopped.
 * This function never reads a caller PID, sends a signal, or claims cleanup.
 * A completed job wins a concurrent cancellation without losing its evidence.
 */
export function requestRemoteGateCancellation({ root, requestBytes, trust, now = Date.now() }) {
  const input = { root, requestBytes, trust, now };
  for (let attempt = 0; attempt < MAX_RECORDS; attempt++) {
    const job = readRemoteGateJob(input);
    if (job.state === 'cancelling' || NEXT[job.state].length === 0) return { changed: false, job };
    const state = job.state === 'accepted' ? 'cancelled' : 'cancelling';
    const result = transitionRemoteGateJob({ ...input, expectedSequence: job.sequence, state });
    if (result.changed) return result;
    // Another immutable transition won. Re-read its state; never overwrite it
    // or retry admission. There are fewer journal transitions than this bound.
  }
  throw new Error('job changed throughout cancellation; inspect existing job');
}
