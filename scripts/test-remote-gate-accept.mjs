import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptRemoteGateResult } from './lib/remote-gate-accept.mjs';
import { sha256 } from './lib/remote-gate-result.mjs';

const bytes = value => Buffer.from(JSON.stringify(value));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'remote-accept-test-'));
  const repo = join(home, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'user.name=Acceptance Test',
    '-c', 'user.email=accept@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'candidate.txt'), 'base\n');
  git('add', 'candidate.txt'); git('commit', '-qm', 'base');
  const main = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', main);
  writeFileSync(join(repo, 'candidate.txt'), 'candidate\n');
  git('add', 'candidate.txt'); git('commit', '-qm', 'candidate');
  const trust = { runnerId: 'accept-test', policySha256: 'a'.repeat(64), hostKey: `SHA256:${'A'.repeat(43)}` };
  const request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00Z',
    expiresAt: '2026-10-28T06:00:00Z', commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    main, refsSha256: 'e'.repeat(64), bundleSha256: 'f'.repeat(64), runnerId: trust.runnerId,
    policySha256: trust.policySha256 };
  const gateLog = Buffer.from('synthetic gate artifact; this is not a real remote run\n');
  const browserLedger = Buffer.from(`2026-10-28T00:30:00Z\t${request.commit.slice(0, 9)}\tran:pass;serial=FAIL\n`);
  const evidence = { tool: 'hyvemind', version: '0.2.0', head: request.commit, treeBefore: request.tree,
    treeAfter: request.tree, partial: false, verdict: 'green', startedAt: '2026-10-28T00:05:00Z',
    finishedAt: '2026-10-28T00:35:00Z', gates: [{ name: 'ci', run: 'npm run ci',
      exitCode: 0, durationMs: 1800000, pass: true }] };
  const f = { home, repo, git, trust, request, gateLog, browserLedger, evidence };
  f.input = () => {
    const requestBytes = bytes(request); const evidenceBytes = bytes(evidence);
    return { home: f.home, repo: f.repo, requestBytes, trust, gateLog, browserLedger, evidenceBytes,
      authenticatedHostKey: trust.hostKey, now: Date.parse('2026-10-28T00:40:00Z'),
      resultBytes: bytes({ ...request, requestSha256: sha256(requestBytes), treeBefore: request.tree,
        treeAfter: request.tree, dirtyBefore: false, dirtyAfter: false, exitCode: 0,
        nodeVersion: '22.23.4', npmVersion: '10.9.8', disabledLanes: [],
        startedAt: '2026-10-28T00:01:00Z', finishedAt: '2026-10-28T00:36:00Z',
        artifacts: { gateLog: sha256(gateLog), evidence: sha256(evidenceBytes), browserLedger: sha256(browserLedger) } }) };
  };
  return f;
}

test('reads an actual unchanged checkout and preserves the advisory result without merge authority', t => {
  const f = fixture(t); const before = f.git('status', '--porcelain');
  const result = acceptRemoteGateResult(f.input());
  assert.deepEqual(result.candidate, { commit: f.request.commit, tree: f.request.tree, main: f.request.main });
  assert.equal(result.advisoryBrowser, 'FAIL'); assert.equal(result.mergeAuthorized, false);
  assert.equal(f.git('status', '--porcelain'), before);
});

for (const [name, change, pattern] of [
  ['same-tree different commit', f => { f.git('commit', '--amend', '-qm', 'changed commit'); }, /HEAD moved/],
  ['wrong local tree claim', f => { f.request.tree = '0'.repeat(40); f.evidence.treeBefore = f.request.tree; f.evidence.treeAfter = f.request.tree; }, /tree differs/],
  ['modified tracked source', f => { writeFileSync(join(f.repo, 'candidate.txt'), 'changed\n'); }, /is dirty/],
  ['staged source', f => { writeFileSync(join(f.repo, 'candidate.txt'), 'staged\n'); f.git('add', 'candidate.txt'); }, /is dirty/],
  ['untracked source', f => { writeFileSync(join(f.repo, 'unexpected.txt'), 'untracked\n'); }, /is dirty/],
  ['new main observation', f => { f.git('update-ref', 'refs/remotes/origin/main', f.request.commit); }, /main observation moved/],
  ['nested checkout directory', f => { mkdirSync(join(f.repo, 'nested')); f.repo = join(f.repo, 'nested'); }, /checkout root/],
]) test(`refuses ${name} even when the worker artifacts agree with the request`, t => {
  const f = fixture(t); change(f); assert.throws(() => acceptRemoteGateResult(f.input()), pattern);
});

test('ambient Git redirection cannot substitute another clean checkout for dirty local source', t => {
  const f = fixture(t); const other = fixture(t);
  writeFileSync(join(f.repo, 'candidate.txt'), 'dirty local source\n');
  const previous = process.env.GIT_DIR; process.env.GIT_DIR = join(other.repo, '.git');
  try { assert.throws(() => acceptRemoteGateResult(f.input()), /is dirty/); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  assert.equal(readFileSync(join(f.repo, 'candidate.txt'), 'utf8'), 'dirty local source\n');
});
