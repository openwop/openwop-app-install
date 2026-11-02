#!/usr/bin/env node
/** ADR 0863 D9 P2: the canonical gate, as the supervisor's one command.
 *
 *   remote-gate-gate.mjs <request.json> <checkout> <artifacts-dir>
 *
 * Runs in the rebuilt checkout: `npm ci` in the three workspaces, then ONE
 * Hyvemind gate (the openwop preset runs `npm run ci` once), exactly as
 * merge-train.sh gates a train. It writes the four fixed artifacts and exits
 * with the gate's exit code. A missing evidence record or browser ledger is a
 * failure (exit 1), never a quiet pass. Installed beside the worker; never read
 * from the submitted checkout. Environment is the runner's, fixed and closed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './lib/remote-gate-result.mjs';

const [requestPath, repo, out] = process.argv.slice(2);
if (!requestPath || !repo || !out) { console.error('usage: remote-gate-gate.mjs <request.json> <checkout> <artifacts-dir>'); process.exit(2); }
const requestBytes = readFileSync(requestPath);
const request = JSON.parse(requestBytes.toString('utf8'));
const logPath = join(out, 'gate.log');
const log = openSync(logPath, 'wx', 0o600);
const say = text => { writeFileSync(log, `${new Date().toISOString()} ${text}\n`); };
const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const clean = () => git(['status', '--porcelain=v1', '--untracked-files=all']) === '';

function step(command, args, cwd) {
  say(`▶ ${[command, ...args].join(' ')} (in ${cwd === repo ? '.' : cwd.slice(repo.length + 1)})`);
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', log, log], env: process.env });
    child.once('error', error => { say(`spawn failed: ${error.code}`); resolve(127); });
    child.once('exit', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
}

const startedAt = new Date().toISOString();
const treeBefore = git(['rev-parse', 'HEAD^{tree}']).trim();
const dirtyBefore = !clean();
const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
say(`remote gate ${request.id} commit ${request.commit} node ${process.versions.node} npm ${npmVersion}`);

let exitCode = 0;
for (const ws of ['.', 'backend/typescript', 'frontend/react']) {
  if (exitCode === 0) exitCode = await step('npm', ['ci', '--no-audit', '--no-fund'], join(repo, ws));
}
// ci.sh refuses the required browser lane without Chromium, and the browser build
// follows the checkout's Playwright version: install it (a no-op when present)
// into the runner's persistent PLAYWRIGHT_BROWSERS_PATH, as ci.sh's setup says.
if (exitCode === 0) exitCode = await step('npx', ['playwright', 'install', 'chromium'], join(repo, 'frontend/react'));
if (exitCode === 0) exitCode = await step('npx', ['-y', 'hyvemind@0.2.0', 'gate'], repo);

// Evidence written by THIS run only: the newest record started after us.
const evidenceDir = join(repo, '.hyve', 'evidence');
const records = existsSync(evidenceDir) ? readdirSync(evidenceDir).filter(n => /^gate-.*\.json$/.test(n))
  .map(n => join(evidenceDir, n)).filter(p => statSync(p).mtimeMs >= Date.parse(startedAt)).sort() : [];
const ledger = join(repo, '.openwop-ci-e2e-ledger');
const missing = [records.length ? null : 'Hyvemind evidence', existsSync(ledger) ? null : 'browser ledger'].filter(Boolean);
if (missing.length) { say(`missing: ${missing.join(', ')}`); if (exitCode === 0) exitCode = 1; }
// Publication accepts only private files; a copy would keep the source's mode.
const privateCopy = (from, name, fallback) => writeFileSync(join(out, name),
  from ? readFileSync(from) : fallback, { flag: 'wx', mode: 0o600 });
privateCopy(records.at(-1), 'evidence.json', '{}\n');
privateCopy(existsSync(ledger) ? ledger : null, 'browser.tsv', 'missing\n');

const finishedAt = new Date().toISOString();
const treeAfter = git(['rev-parse', 'HEAD^{tree}']).trim();
const dirtyAfter = !clean();
say(`gate exit ${exitCode}; tree ${treeAfter === treeBefore ? 'unchanged' : 'CHANGED'}; ${dirtyAfter ? 'DIRTY' : 'clean'}`);
closeSync(log);
const digest = name => sha256(readFileSync(join(out, name)));
const result = {
  version: 1, id: request.id, requestSha256: sha256(requestBytes),
  ...Object.fromEntries(['runnerId', 'policySha256', 'commit', 'main', 'refsSha256', 'bundleSha256'].map(k => [k, request[k]])),
  treeBefore, treeAfter, dirtyBefore, dirtyAfter, exitCode,
  nodeVersion: process.versions.node, npmVersion,
  // The runner passes a fixed environment with no lane-skip variable; this lists
  // none because none can be set, not because it inspected the lanes.
  disabledLanes: [], startedAt, finishedAt,
  artifacts: { gateLog: digest('gate.log'), evidence: digest('evidence.json'), browserLedger: digest('browser.tsv') },
};
writeFileSync(join(out, 'result.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
process.exit(exitCode);
