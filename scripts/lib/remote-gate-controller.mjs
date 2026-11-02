/** ADR 0863 D9 P2: the submitting Mac's controller. It snapshots a clean
 * candidate, sends it to the worker, polls status by the same request bytes,
 * fetches a completed job's artifacts and accepts them with the LOCAL validator.
 *
 * Outcomes are closed: `green` (accepted evidence), `red` (the remote gate ran
 * and failed with an exit code), or `fallback` with a reason (busy, refused,
 * transport failure, interrupted, cancelled, timed out, evidence refused). A
 * fallback means "gate locally", never "red" (release-manager requirement, D9).
 * Nothing here merges, deploys, or imports a remote GREEN into the local ledger.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptRemoteGateResult } from './remote-gate-accept.mjs';
import { receiveRemoteGateFrame, remoteGateFrame } from './remote-gate-frame.mjs';
import { prepareRemoteGateSource, privateRoot } from './remote-gate-source.mjs';
import { remoteGateSshPlan } from './remote-gate-ssh.mjs';

export const WORKER_EXIT = Object.freeze({ ok: 0, refused: 65, busy: 75, ssh: 255 });
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const WORKER_FAULT_EXITS = new Set([70, 124]);

/** A connector opens ONE worker connection: { stdin, stdout, exit: Promise<code>,
 * authenticatedHostKey }. The SSH connector derives the host identity from strict
 * checking against the single pinned key: any exit other than ssh's own 255 means
 * that pin authenticated the server. */
export function sshConnector({ trust, privateDir }) {
  return () => {
    const knownHosts = join(privateRoot(privateDir), `known_hosts-${trust.runnerId}`);
    const plan = remoteGateSshPlan(trust, knownHosts);
    writeFileSync(knownHosts, plan.knownHostsBytes, { mode: 0o600 });
    const child = spawn(plan.executable, plan.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    let stderr = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { if (stderr.length < 4096) stderr += d; });
    const exit = new Promise(resolve => child.once('close', code => resolve(code ?? WORKER_EXIT.ssh)));
    return { stdin: child.stdin, stdout: child.stdout, exit,
      authenticatedHostKey: exit.then(code => (code === WORKER_EXIT.ssh ? null : plan.pinnedHostKey)), stderr: () => stderr };
  };
}

async function exchange(connect, chunks, kind, spoolRoot, { idleTimeoutMs = 15_000 } = {}) {
  const conn = connect();
  conn.stdin.on('error', () => {}); // a worker that exits early closes the pipe
  const pump = (async () => {
    for (const chunk of chunks) if (!conn.stdin.write(chunk)) await new Promise(r => conn.stdin.once('drain', r));
    conn.stdin.end();
  })().catch(() => {});
  let frame = null; let receiveError = null;
  const receive = receiveRemoteGateFrame(conn.stdout, { kind, root: spoolRoot, idleTimeoutMs, totalTimeoutMs: 600_000 })
    .then(f => { frame = f; }, e => { receiveError = e; });
  const [code] = await Promise.all([conn.exit, pump, receive]);
  const hostKey = await conn.authenticatedHostKey;
  if (code !== WORKER_EXIT.ok || receiveError) {
    if (frame) rmSync(frame.work, { recursive: true, force: true });
    const said = (conn.stderr?.() ?? '').trim().split('\n').filter(l => !/numpy|tcp_upload_bandwidth|^WARNING:?\s*$/i.test(l)).slice(-3).join(' | ');
    return { code: code === WORKER_EXIT.ok ? WORKER_EXIT.refused : code,
      reason: [`exit ${code}`, said, receiveError ? `receive: ${receiveError.message}` : ''].filter(Boolean).join('; ') };
  }
  return { code, frame, authenticatedHostKey: hostKey };
}

function readStatus(frame) {
  try { return JSON.parse(readFileSync(frame.paths['status.json'], 'utf8')); }
  finally { rmSync(frame.work, { recursive: true, force: true }); }
}

/** Send one control operation for an existing request. */
export async function remoteGateControl({ connect, requestBytes, operation, spoolRoot }) {
  const dir = mkdtempSync(join(privateRoot(spoolRoot), 'control-'));
  try {
    writeFileSync(join(dir, 'request.json'), requestBytes, { mode: 0o600 });
    writeFileSync(join(dir, 'operation.json'), JSON.stringify({ version: 1, operation }), { mode: 0o600 });
    const chunks = remoteGateFrame('control', { 'request.json': join(dir, 'request.json'), 'operation.json': join(dir, 'operation.json') });
    return await exchange(connect, chunks, { fetch: 'result', log: 'log' }[operation] ?? 'status', spoolRoot);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const fallback = (reason, extra = {}) => ({ verdict: 'fallback', reason, ...extra });

/** Gate `commit` on the worker. `main` is the refreshed origin/main it builds on.
 * `home` is the local git HOME used by the acceptance re-inspection. */
export async function runRemoteGate({ repo, home, commit, main, trust, workRoot, connect,
  pollMs = 30_000, maxMs = 3 * 3600_000, maxUnreachablePolls = 10, logDir = null, log = () => {} }) {
  const spoolRoot = privateRoot(workRoot);
  let prepared;
  try { prepared = prepareRemoteGateSource({ repo, outputRoot: spoolRoot, commit, main, trust }); }
  catch (error) { return fallback('candidate not snapshot-able', { detail: String(error.message) }); }
  const { requestBytes } = prepared;
  const id = JSON.parse(requestBytes.toString('utf8')).id;
  // Best effort: never leave a job of ours running on the VM after we fall back.
  // A job the worker has not admitted yet cannot be cancelled (the journal only
  // knows admitted jobs); it runs to its own time limit and reads as busy.
  const abandon = () => remoteGateControl({ connect, requestBytes, operation: 'cancel', spoolRoot }).catch(() => {});
  // Bring a finished job's gate log home (into logDir, when the caller gives one).
  const keepLog = async () => {
    if (!logDir) return null;
    try {
      const got = await remoteGateControl({ connect, requestBytes, operation: 'log', spoolRoot });
      if (got.code !== WORKER_EXIT.ok) return null;
      const dest = join(logDir, `${id}.log`);
      try { copyFileSync(got.frame.paths['gate.log'], dest); } finally { rmSync(got.frame.work, { recursive: true, force: true }); }
      return dest;
    } catch { return null; }
  };
  try {
    // The worker replies only after rebuilding and verifying the candidate, which
    // takes minutes for a full-history bundle: wait up to the receiver's maximum.
    const sent = await exchange(connect, remoteGateFrame('source', {
      'request.json': join(prepared.work, 'request.json'), 'refs.manifest': join(prepared.work, 'refs.manifest'),
      'source.bundle': prepared.bundlePath }), 'status', spoolRoot, { idleTimeoutMs: 600_000 });
    if (sent.code === WORKER_EXIT.busy) return fallback('worker busy', { id });
    let status;
    if (sent.frame) status = readStatus(sent.frame);
    else {
      // The reply was lost but the job may exist (D9 P3 dry run, 2026-11-01: the
      // worker admitted and launched a gate after this side stopped waiting). Ask.
      const asked = await remoteGateControl({ connect, requestBytes, operation: 'status', spoolRoot });
      if (asked.code !== WORKER_EXIT.ok) {
        await abandon();
        return fallback(sent.code === WORKER_EXIT.ssh ? 'ssh failed' : 'worker refused', { id, detail: sent.reason });
      }
      status = readStatus(asked.frame);
    }
    log(`remote gate ${id}: ${status.state}`);
    const began = performance.now();
    let unreachable = 0;
    while (!TERMINAL.has(status.state)) {
      if (performance.now() - began > maxMs) {
        await abandon();
        return fallback('remote gate timed out', { id });
      }
      await delay(pollMs);
      const polled = await remoteGateControl({ connect, requestBytes, operation: 'status', spoolRoot });
      if (polled.code !== WORKER_EXIT.ok) {
        // A VM stopped mid-gate (budget stop, preemption, a reset) must not hold
        // the train for the whole time limit: give up after this many in a row.
        if (++unreachable >= maxUnreachablePolls) { await abandon(); return fallback('remote worker unreachable', { id }); }
        log(`status poll failed (${polled.code}: ${polled.reason}); retrying`); continue;
      }
      unreachable = 0;
      const next = readStatus(polled.frame);
      if (next.state !== status.state) log(`remote gate ${id}: ${next.state}`);
      status = next;
    }
    // 70 and 124 are the worker's own faults (publication refused, its time limit),
    // not the candidate's: gate locally rather than report a red nobody earned.
    if (status.state === 'failed' && WORKER_FAULT_EXITS.has(status.exitCode)) return fallback(`remote worker fault (exit ${status.exitCode})`, { id, status });
    if (status.state === 'failed') return { verdict: 'red', id, reason: 'remote gate failed', status, log: await keepLog() };
    if (status.state !== 'completed') return fallback(`remote gate ${status.state}`, { id, status, log: await keepLog() });
    const fetched = await remoteGateControl({ connect, requestBytes, operation: 'fetch', spoolRoot });
    if (fetched.code !== WORKER_EXIT.ok) return fallback('fetch failed', { id, detail: fetched.reason });
    try {
      const p = fetched.frame.paths;
      const accepted = acceptRemoteGateResult({ repo, home, requestBytes, trust,
        resultBytes: readFileSync(p['result.json']), gateLog: readFileSync(p['gate.log']),
        evidenceBytes: readFileSync(p['evidence.json']), browserLedger: readFileSync(p['browser.tsv']),
        authenticatedHostKey: fetched.authenticatedHostKey });
      return { verdict: 'green', id, accepted };
    } catch (error) {
      return fallback('remote evidence refused', { id, detail: String(error.message) });
    } finally { rmSync(fetched.frame.work, { recursive: true, force: true }); }
  } catch (error) {
    await abandon();
    return fallback('controller error', { id, detail: String(error.message) });
  } finally { rmSync(prepared.work, { recursive: true, force: true }); }
}
