/** ADR 0863 D9 P3: reach the GCE gate VM from a Mac. Reads the instance first:
 * the `openwop-ci-disabled` metadata flag (set by the budget stop, or by hand),
 * an unreadable instance, or any state it cannot start from is a FALLBACK, never
 * a red (release-manager requirement 6). Otherwise it starts a stopped VM, opens
 * an IAP tunnel to 127.0.0.1 and hands the ordinary controller an SSH connector
 * whose host is that literal address and whose host key is the pinned one.
 *
 * Local configuration (~/.config/openwop-ci/runner.json, never in the repo):
 *   { project, zone, instance, runnerId, policySha256, publicHostKey, identityFile }
 * The Macs never stop the VM: another Mac may be mid-gate. It stops itself.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { remoteGateControl, runRemoteGate, sshConnector, WORKER_EXIT } from './remote-gate-controller.mjs';
import { pinnedHostKey } from './remote-gate-ssh.mjs';

export const DISABLED_FLAG = 'openwop-ci-disabled';
const START_WAIT_MS = 3 * 60_000;

function gcloudJson(gcloud, args) {
  return new Promise((resolve, reject) => execFile(gcloud, [...args, '--format=json'],
    { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, out) => {
      if (error) return reject(new Error(`gcloud ${args.slice(0, 3).join(' ')} failed: ${error.code ?? error.signal}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('gcloud output unreadable')); }
    }));
}
const where = c => [`--project=${c.project}`, `--zone=${c.zone}`];

/** What a Mac may do with the instance right now: 'ready', 'start', 'wait', or
 * a fallback reason. Pure, so the flag rule is testable without GCE. */
export function instanceDecision(instance) {
  if (!instance || typeof instance !== 'object') return { fallback: 'remote gate VM unreadable' };
  const flag = (instance.metadata?.items ?? []).find(i => i.key === DISABLED_FLAG);
  if (flag) return { fallback: `remote gate disabled (${String(flag.value).slice(0, 40)})` };
  if (instance.status === 'RUNNING') return { action: 'ready' };
  if (instance.status === 'TERMINATED') return { action: 'start' };
  if (['PROVISIONING', 'STAGING', 'STOPPING', 'SUSPENDING'].includes(instance.status)) return { action: 'wait' };
  return { fallback: `remote gate VM ${String(instance.status).toLowerCase()}` };
}

/** A local relay on 127.0.0.1: each SSH connection gets its own
 * `gcloud compute start-iap-tunnel --listen-on-stdin` process, and the socket is
 * piped through it. gcloud's own `--local-host-port` mode hung indefinitely at
 * "Testing if tunnel connection works" against this VM (MEASURED 2026-11-01,
 * > 200 s), while `--listen-on-stdin` reached sshd at once. ssh still connects
 * to a literal address with the pinned host key and ProxyCommand=none. */
async function iapRelay(gcloud, c) {
  const children = new Set();
  const server = createServer(socket => {
    const child = spawn(gcloud, ['compute', 'start-iap-tunnel', c.instance, '22', '--listen-on-stdin',
      '--verbosity=error', ...where(c)], { stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    socket.pipe(child.stdin); child.stdout.pipe(socket);
    const end = () => { socket.destroy(); if (child.exitCode === null) child.kill('SIGTERM'); children.delete(child); };
    socket.once('close', end); socket.once('error', end); child.once('exit', end); child.stdin.on('error', end);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port,
    close: () => { server.close(); for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); } };
}

/** Gate a candidate on the VM. Same outcomes as runRemoteGate; every failure to
 * reach or start the VM is `fallback`. */
export async function runRemoteGateOnGcp({ config, gcloud = 'gcloud', log = () => {}, ...gate }) {
  const fallback = reason => ({ verdict: 'fallback', reason });
  const trust = { runnerId: config.runnerId, policySha256: config.policySha256, publicHostKey: config.publicHostKey,
    hostKey: pinnedHostKey(config.publicHostKey), identityFile: config.identityFile, user: 'ci', host: '127.0.0.1', port: 0 };
  const began = performance.now();
  let decision;
  for (;;) {
    let instance;
    try { instance = await gcloudJson(gcloud, ['compute', 'instances', 'describe', config.instance, ...where(config)]); }
    catch (error) { return fallback(`remote gate VM unreadable: ${error.message}`); }
    decision = instanceDecision(instance);
    if (decision.fallback) return fallback(decision.fallback);
    if (decision.action === 'ready') break;
    if (performance.now() - began > START_WAIT_MS) return fallback('remote gate VM did not start in time');
    if (decision.action === 'start') {
      log('starting the remote gate VM');
      try { await gcloudJson(gcloud, ['compute', 'instances', 'start', config.instance, ...where(config), '--async']); }
      catch (error) { return fallback(`remote gate VM would not start: ${error.message}`); } // e.g. zone stockout
    }
    await delay(5000);
  }
  let tunnel;
  try { tunnel = await iapRelay(gcloud, config); trust.port = tunnel.port; }
  catch (error) { return fallback(`IAP relay: ${error.message}`); }
  try {
    const connect = sshConnector({ trust, privateDir: gate.workRoot });
    // A booting VM accepts TCP before sshd and the worker are ready: wait until a
    // harmless control call stops failing at the SSH layer.
    for (;;) {
      const probe = await remoteGateControl({ connect, operation: 'status', spoolRoot: gate.workRoot,
        requestBytes: Buffer.from('{}') }).catch(() => ({ code: WORKER_EXIT.ssh }));
      if (probe.code !== WORKER_EXIT.ssh) break;
      // A host key that is not the pinned one is a security signal, not a slow
      // boot: stop at once (dry run 2026-11-01 waited out the 3-minute bound).
      if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed/i.test(probe.reason ?? '')) {
        return fallback('remote gate host key mismatch');
      }
      if (performance.now() - began > START_WAIT_MS) return fallback('remote gate VM did not accept SSH in time');
      await delay(5000);
    }
    return await runRemoteGate({ ...gate, trust, connect, log });
  } finally { tunnel.close(); }
}

export function assertRunnerConfig(config) {
  assert(config && typeof config === 'object', 'runner config');
  for (const k of ['project', 'zone', 'instance', 'runnerId', 'policySha256', 'publicHostKey', 'identityFile']) {
    assert.equal(typeof config[k], 'string', `runner config ${k}`);
  }
  return config;
}
