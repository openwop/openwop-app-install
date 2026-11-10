/** ADR 0863 D9 P2: the installed runner. The worker admits a job and launches
 * this OUTSIDE the SSH session; it supervises the canonical gate, settles the
 * journal, keeps the gate log for diagnosis and removes the rebuilt checkout.
 *
 * Installed configuration (never submitted):
 *   { root, spoolRoot, runnerRoot, logRoot, trust: {runnerId, policySha256},
 *     node, installDir, env, launcher: 'systemd-run' | 'detach', timing? }
 * `env` is the gate's whole environment; HOME is set to the job's private home.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, openSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRemoteGateJob, requestRemoteGateCancellation } from './remote-gate-job.mjs';
import { processTableFor } from './remote-gate-process.mjs';
import { retiredRemoteGateJob } from './remote-gate-worker.mjs';
import { privateRoot } from './remote-gate-source.mjs';
import { recoverRemoteGateJob, runRemoteGateJob } from './remote-gate-supervisor.mjs';

const KEEP_LOGS = 20;
const ACCEPTED_GRACE_MS = 10 * 60_000;
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

function jobInput(config, id, now = Date.now()) {
  assert.match(id, /^[a-f0-9]{32}$/, 'job id');
  return { root: config.root, trust: config.trust, now, requestBytes: readFileSync(join(privateRoot(config.root), id, 'request.json')) };
}
function sourceWorkFor(config, id) {
  const found = readdirSync(privateRoot(config.runnerRoot)).filter(n => n.startsWith(`request-${id}-`));
  assert(found.length <= 1, 'more than one rebuilt checkout for a job');
  return found.length ? join(config.runnerRoot, found[0]) : null;
}
function keepLog(config, id, path) {
  if (!existsSync(path)) return;
  const logs = privateRoot(config.logRoot);
  copyFileSync(path, join(logs, `${id}.log.gz`));
  const old = readdirSync(logs).filter(n => /^[a-f0-9]{32}\.log\.gz$/.test(n))
    .map(n => [n, statSync(join(logs, n)).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(KEEP_LOGS);
  for (const [n] of old) rmSync(join(logs, n), { force: true });
}

/** Run ONE admitted job to a terminal state. Never relaunches: a job that is not
 * `accepted` is left to recovery by runRemoteGateJob itself. */
export async function runInstalledJob({ config, id, table = processTableFor() }) {
  const input = jobInput(config, id);
  const work = sourceWorkFor(config, id);
  assert(work, 'rebuilt checkout missing');
  const repo = join(work, 'source');
  const artifactsDirectory = join(work, 'artifacts');
  mkdirSync(artifactsDirectory, { mode: 0o700 });
  try {
    return await runRemoteGateJob({
      job: input, table, artifactsDirectory, cwd: repo, output: 'ignore',
      command: config.node,
      args: [join(config.installDir, 'remote-gate-gate.mjs'), join(input.root, id, 'request.json'), repo, artifactsDirectory],
      env: { ...config.env, HOME: join(work, 'home') },
      timing: config.timing ?? {},
    });
  } finally {
    keepLog(config, id, join(artifactsDirectory, 'gate.log.gz'));
    rmSync(work, { recursive: true, force: true });
    rmSync(join(config.runnerRoot, `started-${id}`), { force: true });
  }
}

/** Boot sweep. A running/cancelling job whose supervisor died becomes interrupted;
 * a stale `starting` too (recoverRemoteGateJob). An `accepted` job older than the
 * grace was admitted but never launched: it is cancelled, which is legal from
 * `accepted` and launches nothing. Rebuilt checkouts of finished jobs are removed. */
export async function recoverInstalledJobs({ config, table = processTableFor(), now = Date.now() }) {
  const report = [];
  for (const id of readdirSync(privateRoot(config.root)).filter(n => /^[a-f0-9]{32}$/.test(n))) {
    try {
      const input = jobInput(config, id, now);
      if (retiredRemoteGateJob(input.requestBytes, config.trust)) {
        const work = sourceWorkFor(config, id); if (work) rmSync(work, { recursive: true, force: true });
        report.push({ id, state: 'retired' }); continue;
      }
      let job = readRemoteGateJob(input);
      if (job.state === 'accepted' && now - Date.parse(job.at) > ACCEPTED_GRACE_MS) {
        job = requestRemoteGateCancellation(input).job;
      } else if (!TERMINAL.has(job.state)) {
        job = (await recoverRemoteGateJob({ job: input, table, now })).job;
      }
      if (TERMINAL.has(job.state)) {
        const work = sourceWorkFor(config, id); if (work) rmSync(work, { recursive: true, force: true });
        rmSync(join(config.runnerRoot, `started-${id}`), { force: true });
      }
      report.push({ id, state: job.state });
    } catch (error) { report.push({ id, error: String(error.message ?? error) }); }
  }
  return report;
}

/** Start the runner outside the caller's process tree and session. */
export function remoteGateLauncher(config, runnerEntry) {
  if (config.launcher === 'systemd-run') {
    return ({ id }) => new Promise((resolve, reject) => execFile('/usr/bin/systemd-run',
      ['--user', `--unit=openwop-gate-${id}`, '--collect', '--quiet', '--', config.node, runnerEntry, id],
      { timeout: 30_000 }, error => (error ? reject(new Error(`launch failed: ${error.code ?? error.signal}`)) : resolve())));
  }
  assert.equal(config.launcher, 'detach', 'launcher');
  // `detach` is for tests and local trials: the runner's stderr goes to the log
  // root (systemd's journal holds it on the VM).
  return ({ id }) => new Promise((resolve, reject) => {
    const err = openSync(join(privateRoot(config.logRoot), `runner-${id}.err`), 'a', 0o600);
    const child = spawn(config.node, [runnerEntry, id], { detached: true, stdio: ['ignore', 'ignore', err], env: process.env });
    closeSync(err);
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
