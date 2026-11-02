#!/usr/bin/env node
/** ADR 0863 D9: gate the checkout's HEAD on the remote gate VM.
 *   node scripts/remote-gate.mjs run      (from a clean checkout at the candidate)
 * Prints one JSON outcome: verdict green | red | fallback. A fallback means
 * "gate locally". Reads ~/.config/openwop-ci/runner.json; never merges anything. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRunnerConfig, runRemoteGateOnGcp } from './lib/remote-gate-gcp.mjs';

if (process.argv[2] !== 'run') { console.error('usage: remote-gate.mjs run'); process.exit(2); }
const config = assertRunnerConfig(JSON.parse(readFileSync(join(homedir(), '.config/openwop-ci/runner.json'), 'utf8')));
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const main = execFileSync('git', ['-C', repo, 'rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).trim();
const work = mkdtempSync(join(tmpdir(), 'openwop-remote-gate-')); chmodSync(work, 0o700);
const home = mkdtempSync(join(work, 'home-'));
const gcloud = process.env.OPENWOP_GCLOUD ?? 'gcloud';
try {
  const logDir = join(homedir(), '.cache/openwop-ci/logs'); mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const outcome = await runRemoteGateOnGcp({ config, gcloud, repo, home, commit, main, workRoot: work, logDir,
    log: m => console.error(`remote-gate: ${m}`) });
  console.log(JSON.stringify(outcome));
  process.exitCode = outcome.verdict === 'green' ? 0 : outcome.verdict === 'red' ? 1 : 3;
} finally { rmSync(work, { recursive: true, force: true }); }
