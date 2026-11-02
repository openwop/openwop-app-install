/** ADR 0863 D9: the installed worker's PID-identity supervisor.
 *
 * The gate runs under a holder shell that leads a NEW process group and stays
 * alive (TERM/INT/HUP ignored) after the gate exits, so the group id cannot be
 * reused while discovery runs. The group is DISCOVERY ONLY: every signal goes to
 * one pid after its full identity is re-read, never kill(-pgid). Cleanup is
 * `verified` only on positive evidence; anything else is `uncertain` with closed
 * reasons, which the journal records as `interrupted` (never fetchable, never GREEN).
 *
 * Residuals this cannot remove on macOS (no pidfd, no subreaper):
 *   R1  a descendant's pid could be reused between the identity re-read and kill;
 *   R2  a descendant that leaves the group before any sample sees it is invisible;
 *   R3  identity has one-second start resolution.
 * The Linux table removes all three (subreaper holder, pidfd, /proc starttime).
 * Membership and the holder come from the platform table.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CLEANUP_REASONS, readRemoteGateJob, transitionRemoteGateJob } from './remote-gate-job.mjs';
import { publishRemoteGateArtifacts } from './remote-gate-publish.mjs';
import { compareIdentity, identityKey } from './remote-gate-process.mjs';

export const PUBLICATION_REFUSED_EXIT = 70; // the command exited 0; publication refused

function bounded(n, name) {
  assert(Number.isSafeInteger(n) && n > 0 && n <= 24 * 3600_000, `${name} must be a bounded positive integer`);
}

/** Run ONE gate command and return its exit plus a cleanup verdict.
 * `shouldCancel` is polled each sample; `table` is a platform process table. */
export async function superviseRemoteGate({ command, args = [], cwd, env, output = 'ignore', table,
  sampleMs = 2000, quietMs = 2000, graceMs = 5000, maxMs = 4 * 3600_000,
  shouldCancel = () => false } = {}) {
  for (const [name, n] of Object.entries({ sampleMs, quietMs, graceMs, maxMs })) bounded(n, name);
  assert(typeof command === 'string' && command.length > 0 && Array.isArray(args), 'gate argv');
  const holder = spawn(table.holder.file, table.holder.args(command, args),
    { cwd, env, detached: true, stdio: ['ignore', output, output, 'pipe'] });
  await new Promise((resolve, reject) => { holder.once('spawn', resolve); holder.once('error', reject); });
  const pgid = holder.pid;
  let holderExited = false;
  const holderExit = new Promise(resolve => holder.once('exit', () => { holderExited = true; resolve(); }));
  let exitText = '';
  let exitCode = null;
  const gateExit = new Promise(resolve => {
    holder.stdio[3].setEncoding('utf8');
    holder.stdio[3].on('data', chunk => { exitText += chunk; });
    holder.stdio[3].on('end', () => {
      const code = /^(\d{1,3})\n$/.exec(exitText);
      exitCode = code ? Number(code[1]) : null;
      resolve();
    });
  });

  const owned = new Map();
  const reasons = new Set();
  async function sample({ final = false } = {}) {
    let rows;
    try { rows = await table.list(); } catch { reasons.add('scan_failed'); return null; }
    const byPid = new Map(rows.map(row => [row.pid, row]));
    if (holderExited) reasons.add('holder_lost');
    const holderRow = byPid.get(pgid);
    if (!holderExited && (!holderRow || holderRow.unreadable || holderRow.pgid !== pgid)) reasons.add('scan_failed');
    const memberPids = table.members(rows, pgid);
    const members = [];
    for (const row of rows) {
      if (row.pid === pgid) continue;
      // Final verification cannot prove the group empty past an unreadable row.
      if (row.unreadable) { if (final) reasons.add('identity_unreadable'); continue; }
      if (!memberPids.has(row.pid)) continue;
      members.push(row);
      // Discovery only while the holder pins the group id: after that, a new
      // group with this id could belong to a stranger.
      if (!holderExited) owned.set(identityKey(row), row);
    }
    for (const id of owned.values()) {
      const now = byPid.get(id.pid);
      const same = compareIdentity(id, now);
      if (same === 'unknown') reasons.add('identity_unreadable');
      if (same === 'same' && !memberPids.has(now.pid)) reasons.add('escaped_group');
    }
    return { byPid, members };
  }
  function live(scan) {
    return [...owned.values()].filter(id => compareIdentity(id, scan.byPid.get(id.pid)) === 'same');
  }
  async function signalOwned(signal) {
    const scan = await sample(); // the identity re-read immediately before each round
    if (!scan) return;
    for (const id of live(scan)) await table.signal(id, signal);
  }
  async function drained(until) {
    while (performance.now() < until) {
      const scan = await sample();
      if (scan && scan.members.length === 0 && live(scan).length === 0) return true;
      await delay(sampleMs);
    }
    return false;
  }

  const started = performance.now();
  let cancelled = false;
  let timedOut = false;
  await sample();
  while (exitCode === null && !holderExited) {
    if (await shouldCancel()) { cancelled = true; break; }
    if (performance.now() - started > maxMs) { timedOut = true; break; }
    await Promise.race([delay(sampleMs), gateExit, holderExit]);
    await sample();
  }
  if (cancelled || timedOut) await signalOwned('SIGTERM');
  await Promise.race([gateExit, holderExit, delay(graceMs)]);
  // Descendants left behind by a finished gate are cleaned the same way.
  if (!(await drained(performance.now() + graceMs))) {
    await signalOwned('SIGTERM');
    if (!(await drained(performance.now() + graceMs))) {
      await signalOwned('SIGKILL');
      await drained(performance.now() + graceMs);
    }
  }
  await delay(quietMs);
  const final = await sample({ final: true });
  if (final && (final.members.length > 0 || live(final).length > 0)) reasons.add('members_remain');
  // The holder is our direct, unreaped child: signalling it cannot hit a reused pid.
  if (!holderExited) holder.kill('SIGKILL');
  await holderExit;
  await gateExit;
  const reasonList = CLEANUP_REASONS.filter(reason => reasons.has(reason));
  return {
    exitCode, cancelled, timedOut, owned: owned.size,
    cleanup: reasonList.length ? { cleanup: 'uncertain', reasons: reasonList }
      : { cleanup: 'verified', owned: owned.size },
  };
}

async function selfOwner(table) {
  const row = (await table.list()).find(r => r.pid === process.pid);
  assert(row && !row.unreadable, 'supervisor identity unreadable');
  return { pid: row.pid, startedAt: row.startedAt, executable: row.executable };
}
async function ownerAlive(table, owner) {
  let rows;
  try { rows = await table.list(); } catch { return 'unknown'; }
  const row = rows.find(r => r.pid === owner.pid);
  if (!row) return 'gone';
  if (row.unreadable) return 'unknown';
  return row.startedAt === owner.startedAt && row.executable === owner.executable ? 'same' : 'different';
}

/** Transition from the CURRENT sequence, re-reading after a lost CAS. A
 * cancellation that wins in between turns a verified finish into `cancelled`. */
function settle(at, decide) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const job = readRemoteGateJob(at());
    const next = decide(job);
    if (!next) return job;
    const result = transitionRemoteGateJob({ ...at(), expectedSequence: job.sequence, ...next });
    if (result.changed) return result.job;
  }
  throw new Error('job kept changing while settling; inspect existing job');
}

/** The installed entry: acquire `starting` by CAS, record this supervisor as
 * `running.owner`, supervise, then settle the journal. A lost start launches
 * nothing. Never relaunches; a job found mid-flight belongs to recovery.
 *
 * `clock` is read at EVERY journal call. A job runs for most of an hour, and
 * the worker records a cancellation at its own later time; reading the journal
 * with the time this job started rejects that record as out of order (found by
 * the D9 P2 end-to-end test, 2026-11-01: the runner crashed, the job stuck in
 * `cancelling`). Tests pass a fixed clock; production uses Date.now. */
export async function runRemoteGateJob({ job: base, command, args, cwd, env, output, table,
  artifactsDirectory, timing = {}, clock = Date.now }) {
  const at = () => ({ ...base, now: clock() });
  const first = readRemoteGateJob(at());
  if (first.state !== 'accepted') return { started: false, job: first };
  const start = transitionRemoteGateJob({ ...at(), expectedSequence: first.sequence, state: 'starting' });
  if (!start.changed) return { started: false, job: start.job };
  let owner;
  try { owner = await selfOwner(table); } catch {
    return { started: false, job: settle(at, () => ({ state: 'interrupted',
      details: { cleanup: 'uncertain', reasons: ['identity_unreadable'] } })) };
  }
  const running = transitionRemoteGateJob({ ...at(), expectedSequence: start.job.sequence,
    state: 'running', details: { owner } });
  if (!running.changed) {
    // Cancellation won before launch: nothing was started, nothing is owned.
    return { started: false, job: settle(at, job => job.state === 'cancelling'
      ? { state: 'cancelled', details: { cleanup: 'verified', owned: 0 } } : null) };
  }
  const shouldCancel = () => {
    try { return readRemoteGateJob(at()).state === 'cancelling'; } catch { return true; } // damaged journal: stop
  };
  const result = await superviseRemoteGate({ command, args, cwd, env, output, table, shouldCancel, ...timing });
  const job = settle(at, current => {
    if (current.state !== 'running' && current.state !== 'cancelling') return null;
    if (result.cleanup.cleanup !== 'verified') return { state: 'interrupted', details: result.cleanup };
    if (current.state === 'cancelling') return { state: 'cancelled', details: result.cleanup };
    if (result.exitCode === 0 && !result.cancelled && !result.timedOut) return null; // publish below
    return { state: 'failed', details: { exitCode: result.timedOut ? 124
      : Math.min(255, Math.max(1, result.exitCode ?? 1)) } };
  });
  if (job.state !== 'running') return { started: true, result, job };
  try {
    const published = publishRemoteGateArtifacts({ ...at(), expectedSequence: job.sequence,
      owner, exitCode: 0, artifactsDirectory });
    if (published.changed) return { started: true, result, job: published.job };
  } catch { /* fall through: the command passed, publication did not */ }
  return { started: true, result, job: settle(at, current => current.state === 'cancelling'
    ? { state: 'cancelled', details: result.cleanup }
    : current.state === 'running' ? { state: 'failed', details: { exitCode: PUBLICATION_REFUSED_EXIT } } : null) };
}

/** Boot recovery. A job left `running`/`cancelling` by a supervisor whose
 * identity is gone or different cannot have its owned set rebuilt: it becomes
 * `interrupted/supervisor_restarted`. A live owner, or an unreadable one, is left
 * alone. `starting` is only abandoned after `startGraceMs`. Never relaunches. */
export async function recoverRemoteGateJob({ job: input, table, startGraceMs = 60_000, now = Date.now() }) {
  const job = readRemoteGateJob(input);
  const restarted = { state: 'interrupted', details: { cleanup: 'uncertain', reasons: ['supervisor_restarted'] } };
  if (job.state === 'starting') {
    if (now - Date.parse(job.at) < startGraceMs) return { changed: false, job };
  } else if (job.state === 'running' || job.state === 'cancelling') {
    const owner = await ownerAlive(table, job.supervisor);
    if (owner === 'same' || owner === 'unknown') return { changed: false, job };
  } else return { changed: false, job };
  return transitionRemoteGateJob({ ...input, expectedSequence: job.sequence, ...restarted });
}
