#!/usr/bin/env node
/** ADR 0863 D9: gate a commit on the remote gate VM.
 *
 *   node remote-gate.mjs run [--repo <dir>] [--base <sha>] [--accept-out <file>] [--max-min <n>]
 *
 * --repo   a clean checkout at the candidate (default: the cwd's toplevel)
 * --base   the main the candidate was built on (default: its refs/remotes/origin/main)
 * --accept-out  on green, write the local acceptance record there (0600). merge-train
 *               keeps it OUTSIDE the train worktree and checks it before merging.
 * --max-min     the whole remote attempt's bound in minutes (default 180); past it the
 *               remote job is cancelled and the outcome is a fallback.
 * Prints one JSON outcome: verdict green | red | fallback, and exits 0 | 1 | 3. A
 * fallback means "gate locally". Reads <config>/runner.json (OPENWOP_CI_CONFIG_DIR,
 * default ~/.config/openwop-ci); never merges anything. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assertRunnerConfig, runRemoteGateOnGcp } from './lib/remote-gate-gcp.mjs';

const { positionals, values: opt } = parseArgs({ allowPositionals: true, options: {
  repo: { type: 'string' }, base: { type: 'string' }, 'accept-out': { type: 'string' }, 'max-min': { type: 'string' } } });
if (positionals[0] !== 'run') { console.error('usage: remote-gate.mjs run [--repo <dir>] [--base <sha>] [--accept-out <file>] [--max-min <n>]'); process.exit(2); }
const confDir = process.env.OPENWOP_CI_CONFIG_DIR ?? join(homedir(), '.config/openwop-ci');
const config = assertRunnerConfig(JSON.parse(readFileSync(join(confDir, 'runner.json'), 'utf8')));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const repo = opt.repo ?? git('rev-parse', '--show-toplevel');
const commit = git('-C', repo, 'rev-parse', 'HEAD');
const main = opt.base ?? git('-C', repo, 'rev-parse', 'refs/remotes/origin/main');
const maxMin = Number(opt['max-min'] ?? '180');
if (!Number.isFinite(maxMin) || maxMin <= 0) { console.error('remote-gate: --max-min must be a positive number'); process.exit(2); }
const work = mkdtempSync(join(tmpdir(), 'openwop-remote-gate-')); chmodSync(work, 0o700);
const home = mkdtempSync(join(work, 'home-'));
const gcloud = process.env.OPENWOP_GCLOUD ?? 'gcloud';
try {
  const logDir = join(homedir(), '.cache/openwop-ci/logs'); mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const outcome = await runRemoteGateOnGcp({ config, gcloud, repo, home, commit, main, workRoot: work, logDir,
    maxMs: Math.round(maxMin * 60_000), log: m => console.error(`remote-gate: ${m}`) });
  if (outcome.verdict === 'green' && opt['accept-out']) {
    const a = outcome.accepted;
    writeFileSync(opt['accept-out'], JSON.stringify({ version: 1, requestId: a.requestId, commit: a.commit, tree: a.tree, main,
      runnerId: a.runnerId, policySha256: config.policySha256, gateDurationMs: a.gateDurationMs,
      requiredBrowser: a.requiredBrowser, advisoryBrowser: a.advisoryBrowser, acceptedAt: new Date().toISOString() }) + '\n',
    { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(outcome));
  process.exitCode = outcome.verdict === 'green' ? 0 : outcome.verdict === 'red' ? 1 : 3;
} finally { rmSync(work, { recursive: true, force: true }); }
