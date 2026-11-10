/** ADR 0863 D9 P2: the installed worker's SSH entry. One connection carries ONE
 * frame on stdin and gets one frame (or nothing, with a closed exit code) back.
 *
 *   source  -> rebuild the candidate and admit the job (`accepted`), reply with
 *              its status. Nothing runs yet. Refused while another job is unfinished.
 *   control -> status / cancel / fetch / log / start, through remoteGateControlResponse.
 *              `start` launches an `accepted` job's runner, once.
 *
 * Admission and launch are separate on purpose (closes the D9 P3 residual): a
 * gate only runs after the submitter has seen the job's status and asked for it,
 * so the submitter always holds the request bytes that can cancel it. A job that
 * is admitted but never started is cancelled at the next admission after
 * `acceptedStartGraceMs` (`accepted` -> `cancelled` launches nothing).
 *
 * Every path, the trust pins and the launcher are installed configuration;
 * nothing in the frame selects a command, a directory or an environment. The
 * gate itself never runs inside the SSH session: the launcher starts the runner
 * outside it (systemd on the VM), so a dropped connection cannot stop or orphan
 * a gate. This module does not authenticate SSH; sshd's forced command does.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { receiveRemoteGateFrame, remoteGateFrame } from './remote-gate-frame.mjs';
import { admitRemoteGateJob, readRemoteGateJob, requestRemoteGateCancellation } from './remote-gate-job.mjs';
import { remoteGateControlResponse } from './remote-gate-control.mjs';
import { privateRoot, reconstructRemoteGateSource } from './remote-gate-source.mjs';
import { remoteGateJobStatus } from './remote-gate-status.mjs';

const MAGIC = Buffer.from('OPENWOP-CI/1\n');
const HEADER_MAX = 4096;
const UNFINISHED = new Set(['accepted', 'starting', 'running', 'cancelling']);
const LOCK_STALE_MS = 120_000;
const ACCEPTED_START_GRACE_MS = 5 * 60_000;
const startMarker = (runnerRoot, id) => join(privateRoot(runnerRoot), `started-${id}`);
/** Closed exit codes the controller reads (sysexits): never a gate verdict. */
export const WORKER_EXIT = Object.freeze({ ok: 0, refused: 65, busy: 75 });

/** Read the frame prefix to learn its kind, then hand the receiver a stream that
 * replays those bytes. The receiver validates the whole frame again. */
async function peekKind(input, { timeoutMs = 15_000 } = {}) {
  const iterator = input[Symbol.asyncIterator]();
  const parts = []; let have = 0;
  const deadline = performance.now() + timeoutMs;
  async function need(n) {
    while (have < n) {
      let timer;
      const part = await Promise.race([iterator.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('frame read timeout')), Math.max(1, deadline - performance.now()));
      })]).finally(() => clearTimeout(timer));
      assert(!part.done, 'truncated frame');
      assert(Buffer.isBuffer(part.value), 'nonbinary frame chunk');
      parts.push(part.value); have += part.value.length;
    }
    return Buffer.concat(parts);
  }
  let bytes = await need(MAGIC.length + 4);
  assert(bytes.subarray(0, MAGIC.length).equals(MAGIC), 'frame magic differs');
  const length = bytes.readUInt32BE(MAGIC.length);
  assert(length > 0 && length <= HEADER_MAX, 'frame header size exceeds bound');
  bytes = await need(MAGIC.length + 4 + length);
  const kind = JSON.parse(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + length).toString('utf8'))?.kind;
  assert(kind === 'source' || kind === 'control', 'unknown frame kind');
  async function* replay() {
    yield bytes;
    for (;;) { const part = await iterator.next(); if (part.done) return; yield part.value; }
  }
  return { kind, stream: Readable.from(replay(), { objectMode: false }) };
}

/** Exclusive, short-lived admission lock: the unfinished-job check and the
 * admission must not interleave with another connection's. A lock older than
 * LOCK_STALE_MS belongs to a dead connection and is removed. */
function withAdmissionLock(root, fn, now = Date.now()) {
  const lock = join(privateRoot(root), '.admission.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && now - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; }
      return { busy: true };
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** A job journaled for another runner or policy. A policy changes only when the
 * VM is re-provisioned at boot, so no live runner can own one; without this rule
 * every upgrade left all earlier jobs unreadable, and an unreadable job counts as
 * unfinished, so the worker answered busy for good (D9 P3 dry run, 2026-11-01). */
export function retiredRemoteGateJob(requestBytes, trust) {
  try {
    const r = JSON.parse(requestBytes.toString('utf8'));
    return typeof r?.policySha256 === 'string' && typeof r?.runnerId === 'string'
      && (r.policySha256 !== trust.policySha256 || r.runnerId !== trust.runnerId);
  } catch { return false; }
}

/** Every job under root that has not reached a terminal state. A job that cannot
 * be read counts as unfinished: an unknown job must never make room for another.
 * A retired job (another runner or policy) does not count. */
export function unfinishedRemoteGateJobs({ root, trust, now = Date.now() }) {
  const out = [];
  for (const name of readdirSync(privateRoot(root))) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    try {
      const requestBytes = readFileSync(join(root, name, 'request.json'));
      if (retiredRemoteGateJob(requestBytes, trust)) continue;
      const job = readRemoteGateJob({ root, requestBytes, trust, now });
      if (UNFINISHED.has(job.state)) out.push({ id: name, state: job.state, at: job.at, requestBytes });
    } catch { out.push({ id: name, state: 'unreadable' }); }
  }
  return out;
}

/** Cancel admitted jobs nobody started within the grace, and remove their rebuilt
 * checkouts. A job with a start marker is being launched and is left alone. */
export function expireUnstartedRemoteGateJobs({ root, runnerRoot, trust, graceMs = ACCEPTED_START_GRACE_MS, now = Date.now() }) {
  const expired = [];
  for (const job of unfinishedRemoteGateJobs({ root, trust, now })) {
    if (job.state !== 'accepted' || now - Date.parse(job.at) <= graceMs) continue;
    if (existsSync(startMarker(runnerRoot, job.id))) continue;
    requestRemoteGateCancellation({ root, trust, requestBytes: job.requestBytes, now });
    for (const name of readdirSync(privateRoot(runnerRoot))) {
      if (name.startsWith(`request-${job.id}-`)) rmSync(join(runnerRoot, name), { recursive: true, force: true });
    }
    expired.push(job.id);
  }
  return expired;
}

function statusFrame(spool, jobInput) {
  const path = join(spool, 'status.json');
  writeFileSync(path, JSON.stringify(remoteGateJobStatus(jobInput)) + '\n', { flag: 'wx', mode: 0o600 });
  return remoteGateFrame('status', { 'status.json': path });
}

/** Handle one SSH connection. `config` is installed, never submitted:
 * { root, spoolRoot, runnerRoot, trust }. `launch({ id, root, sourceWork })` must
 * start the runner OUTSIDE this process tree and return once it is queued.
 * Returns the exit code; writes at most one frame to `output`. */
export async function handleRemoteGateConnection(input, output, { config, launch, now = () => Date.now() }) {
  const { root, spoolRoot, runnerRoot, trust } = config;
  const graceMs = config.acceptedStartGraceMs ?? ACCEPTED_START_GRACE_MS;
  // `start`: launch an accepted job's runner exactly once (an exclusive marker),
  // outside this process tree. A failed launch removes the marker and errors.
  const start = async ({ id }) => {
    const marker = startMarker(runnerRoot, id);
    try { writeFileSync(marker, '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    try { await launch({ id, root }); } catch (error) { rmSync(marker, { force: true }); throw error; }
  };
  // Sync (status frames) or async (control responses) chunk sources alike.
  const write = async chunks => { for await (const chunk of chunks) if (!output.write(chunk)) await new Promise(r => output.once('drain', r)); };
  const { kind, stream } = await peekKind(input);
  if (kind === 'control') {
    await write(remoteGateControlResponse(stream, { root, spoolRoot, trust, logRoot: config.logRoot, start, now: now() }));
    return WORKER_EXIT.ok;
  }
  const frame = await receiveRemoteGateFrame(stream, { kind: 'source', root: spoolRoot, totalTimeoutMs: 600_000 });
  let sourceWork;
  try {
    const requestBytes = readFileSync(frame.paths['request.json']);
    const jobInput = { root, requestBytes, trust, now: now() };
    // An existing job is reconnected to, never rebuilt or started again.
    try {
      lstatSync(join(privateRoot(root), JSON.parse(requestBytes.toString('utf8')).id));
      readRemoteGateJob(jobInput);
      await write(statusFrame(frame.work, jobInput));
      return WORKER_EXIT.ok;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    withAdmissionLock(root, () => expireUnstartedRemoteGateJobs({ root, runnerRoot, trust, graceMs, now: now() }), now());
    if (unfinishedRemoteGateJobs({ root, trust, now: now() }).length) return WORKER_EXIT.busy;
    const rebuilt = reconstructRemoteGateSource({ runnerRoot, requestBytes,
      refsBytes: readFileSync(frame.paths['refs.manifest']), bundlePath: frame.paths['source.bundle'], trust, now: now() });
    sourceWork = rebuilt.work;
    const admitted = withAdmissionLock(root, () => {
      if (unfinishedRemoteGateJobs({ root, trust, now: now() }).length) return { busy: true };
      return admitRemoteGateJob(jobInput);
    }, now());
    if (admitted.busy) return WORKER_EXIT.busy;
    if (!admitted.created) { await write(statusFrame(frame.work, jobInput)); return WORKER_EXIT.ok; }
    sourceWork = undefined; // kept for `start`; expiry or the runner removes it
    await write(statusFrame(frame.work, jobInput));
    return WORKER_EXIT.ok;
  } finally {
    rmSync(frame.work, { recursive: true, force: true });
    if (sourceWork) rmSync(sourceWork, { recursive: true, force: true });
  }
}
