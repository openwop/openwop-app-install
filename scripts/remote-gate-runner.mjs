#!/usr/bin/env node
/** ADR 0863 D9 P2: launched by the worker outside the SSH session
 * (`systemd-run --user` on the VM), or run at boot with `--recover`.
 *   remote-gate-runner.mjs <job-id>     supervise one admitted job
 *   remote-gate-runner.mjs --recover    settle jobs a dead runner left behind */
import { readFileSync } from 'node:fs';
import { recoverInstalledJobs, runInstalledJob } from './lib/remote-gate-runner.mjs';

const config = JSON.parse(readFileSync(process.env.OPENWOP_CI_WORKER_CONFIG ?? '/etc/openwop-ci/worker.json', 'utf8'));
const arg = process.argv[2];
if (arg === '--recover') {
  for (const row of await recoverInstalledJobs({ config })) console.log(JSON.stringify(row));
} else {
  const { job } = await runInstalledJob({ config, id: arg });
  console.log(JSON.stringify({ id: arg, state: job.state }));
}
