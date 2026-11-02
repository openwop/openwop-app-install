#!/usr/bin/env node
/** ADR 0863 D9 P2: installed as /usr/local/libexec/openwop-ci-worker, the ONLY
 * command sshd runs for the gate key (authorized_keys `restrict,command=`).
 * One frame in on stdin, at most one frame out on stdout. The exit code is
 * WORKER_EXIT (0 ok, 65 refused, 75 busy); stderr carries a one-line reason,
 * never request content. Configuration is installed, never submitted. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteGateLauncher } from './lib/remote-gate-runner.mjs';
import { handleRemoteGateConnection, WORKER_EXIT } from './lib/remote-gate-worker.mjs';

const config = JSON.parse(readFileSync(process.env.OPENWOP_CI_WORKER_CONFIG ?? '/etc/openwop-ci/worker.json', 'utf8'));
const launch = remoteGateLauncher(config, join(dirname(fileURLToPath(import.meta.url)), 'remote-gate-runner.mjs'));
try {
  process.exitCode = await handleRemoteGateConnection(process.stdin, process.stdout, { config, launch });
  if (process.exitCode === WORKER_EXIT.busy) console.error('busy: another gate is unfinished');
} catch (error) {
  console.error(`refused: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
  process.exitCode = WORKER_EXIT.refused;
}
