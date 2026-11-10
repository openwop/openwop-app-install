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
  const { job, result } = await runInstalledJob({ config, id: arg });
  // The journal's details (an exit code, or the closed cleanup reasons) and the
  // supervisor's own verdict reach the VM's journal, so an `interrupted` gate says
  // why (shadow 7, 2026-11-02). No request content, paths or secrets.
  console.log(JSON.stringify({ id: arg, state: job.state, details: job.details,
    ...(result ? { exitCode: result.exitCode, owned: result.owned, cleanup: result.cleanup } : {}) }));
}
