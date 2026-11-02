import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRemoteGateSource, reconstructRemoteGateSource } from './lib/remote-gate-source.mjs';
import { sha256 } from './lib/remote-gate-result.mjs';

const json = value => Buffer.from(JSON.stringify(value));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'remote-source-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'origin'); const runnerRoot = join(root, 'worker');
  mkdirSync(repo); mkdirSync(runnerRoot, { mode: 0o700 });
  const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'user.name=Remote Test', '-c', 'user.email=remote@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd: repo, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'docs/adr'), { recursive: true });
  writeFileSync(join(repo, 'docs/adr/0001-base.md'), 'base ADR\n');
  git('add', 'docs'); git('commit', '-qm', 'base'); const main = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', main); git('tag', '-a', 'v0.1.0', '-m', 'old release');
  git('checkout', '-qb', 'peer'); writeFileSync(join(repo, 'docs/adr/0999-peer.md'), 'peer-only ADR\n');
  git('add', 'docs'); git('commit', '-qm', 'peer-only ADR');
  git('checkout', '-q', 'main'); writeFileSync(join(repo, 'candidate.txt'), 'exact candidate\n');
  git('add', 'candidate.txt'); git('commit', '-qm', 'candidate');
  const trust = { runnerId: 'test-worker', policySha256: 'a'.repeat(64) };
  const f = { root, repo, runnerRoot, git, trust, now: Date.parse('2026-10-28T01:00:00Z'), bundlePath: join(root, 'source.bundle') };
  f.refresh = () => {
    if (existsSync(f.bundlePath)) rmSync(f.bundlePath);
    git('bundle', 'create', f.bundlePath, '--all', 'HEAD');
    f.refsBytes = Buffer.from(`${git('for-each-ref', '--format=%(objectname) %(refname)')}\n`);
    f.request = { version: 1, id: '1'.repeat(32), createdAt: '2026-10-28T00:00:00Z', expiresAt: '2026-10-28T06:00:00Z',
      commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), main,
      refsSha256: sha256(f.refsBytes), bundleSha256: sha256(readFileSync(f.bundlePath)), ...trust };
  };
  f.refresh();
  f.run = () => reconstructRemoteGateSource({ ...f, requestBytes: json(f.request) });
  return f;
}

test('reconstructs exact clean candidate, annotated tags and peer-only ADR history', t => {
  const f = fixture(t); const result = f.run();
  assert.equal(readFileSync(join(result.repo, 'candidate.txt'), 'utf8'), 'exact candidate\n');
  assert.equal(existsSync(join(result.repo, 'docs/adr/0999-peer.md')), false);
  const g = (...args) => execFileSync('/usr/bin/git', args, { cwd: result.repo, encoding: 'utf8' }).trim();
  assert.match(g('log', '--all', '--format=%s'), /peer-only ADR/);
  assert.equal(g('cat-file', '-t', 'refs/tags/v0.1.0'), 'tag');
  assert.equal(g('rev-parse', 'HEAD^{tree}'), f.request.tree);
  assert.equal(g('status', '--porcelain'), '');
  assert.equal(g('remote'), '');
  assert.equal(result.main, f.request.main);
});

for (const [name, mutate, pattern] of [
  ['changed valid bundle bytes', f => {
    const before = readFileSync(f.bundlePath); rmSync(f.bundlePath);
    f.git('-c', 'pack.compression=0', 'bundle', 'create', f.bundlePath, '--all', 'HEAD');
    assert.notDeepEqual(readFileSync(f.bundlePath), before, 'negative control needs different valid bundle bytes');
  }, /bundle bytes differ/],
  ['changed valid ref serialization', f => { f.refsBytes = Buffer.from(`${f.refsBytes.toString().trim().split('\n').reverse().join('\n')}\n`); }, /ref manifest bytes differ/],
  ['wrong tree', f => { f.request.tree = '0'.repeat(40); }, /candidate tree differs/],
  ['wrong candidate', f => { f.request.commit = f.request.main; }, /bundle heads differ/],
  ['wrong main', f => { f.request.main = f.request.commit; }, /manifest main differs/],
  ['another runner', f => { f.request.runnerId = 'elsewhere'; }, /request runner differs/],
  ['expired request', f => { f.now = Date.parse('2026-10-28T06:00:01Z'); }, /not currently valid/],
  ['request-selected command', f => { f.request.command = 'touch unsafe'; }, /request fields/],
  ['missing manifested ref', f => { f.refsBytes = Buffer.from(f.refsBytes.toString().split('\n').filter(l => !l.endsWith('refs/heads/peer')).join('\n')); f.request.refsSha256 = sha256(f.refsBytes); }, /bundle heads differ/],
  ['duplicate ref', f => { f.refsBytes = Buffer.concat([f.refsBytes, Buffer.from(`${f.request.main} refs/remotes/origin/main\n`)]); f.request.refsSha256 = sha256(f.refsBytes); }, /duplicate ref/],
  ['ref command injection', f => { f.refsBytes = Buffer.from(`${f.request.main} refs/heads/evil\ncreate refs/heads/pwn ${f.request.main}\n`); f.request.refsSha256 = sha256(f.refsBytes); }, /invalid ref manifest line/],
  ['replace refs', f => { f.git('update-ref', `refs/replace/${f.request.main}`, f.request.commit); f.refresh(); }, /replace refs/],
]) test(`refuses ${name} and leaves no partially reconstructed work`, t => {
  const f = fixture(t); mutate(f);
  assert.throws(f.run, pattern);
  assert.deepEqual(readdirSync(f.runnerRoot), []);
  assert.equal(readFileSync(join(f.repo, 'candidate.txt'), 'utf8'), 'exact candidate\n');
});

test('refuses incremental history even if its prerequisite exists in the submitting repo', t => {
  const f = fixture(t); rmSync(f.bundlePath);
  f.git('bundle', 'create', f.bundlePath, 'HEAD', `^${f.request.main}`);
  f.request.bundleSha256 = sha256(readFileSync(f.bundlePath));
  assert.throws(f.run, /lacks these prerequisite commits/);
  assert.deepEqual(readdirSync(f.runnerRoot), []);
});

test('refuses an absolute symlink before checking out candidate files', t => {
  const f = fixture(t);
  symlinkSync('/etc/passwd', join(f.repo, 'outside'));
  f.git('add', 'outside'); f.git('commit', '-qm', 'unsafe link'); f.refresh();
  assert.throws(f.run, /symlink escapes checkout/);
  assert.deepEqual(readdirSync(f.runnerRoot), []);
});

test('refuses a bundle symlink and a nonprivate runner root', t => {
  const f = fixture(t); const actual = f.bundlePath;
  f.bundlePath = join(f.root, 'bundle-link'); symlinkSync(actual, f.bundlePath);
  assert.throws(f.run, /bounded regular bundle/);
  f.bundlePath = actual; chmodSync(f.runnerRoot, 0o755);
  assert.throws(f.run, /private owned directory/);
  assert.deepEqual(readdirSync(f.runnerRoot), []);
});

test('ambient Git filters and object-store overrides cannot affect reconstruction', t => {
  const f = fixture(t); const marker = join(f.root, 'unexpected-filter');
  writeFileSync(join(f.repo, '.gitattributes'), '*.txt filter=attack\n');
  f.git('add', '.gitattributes'); f.git('commit', '-qm', 'filter attribute'); f.refresh();
  const config = join(f.root, 'hostile.gitconfig');
  writeFileSync(config, `[filter "attack"]\n smudge = touch ${marker}\n required = true\n`);
  const saved = { ...process.env };
  try {
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_OBJECT_DIRECTORY = '/nonexistent-object-store';
    process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'core.worktree'; process.env.GIT_CONFIG_VALUE_0 = '/nonexistent-worktree';
    const result = f.run();
    assert.equal(readFileSync(join(result.repo, 'candidate.txt'), 'utf8'), 'exact candidate\n');
    assert.equal(existsSync(marker), false);
  } finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); }
});

test('submitting clean source round-trips without changing source refs or worktree', t => {
  const f = fixture(t); const outputRoot = join(f.root, 'submissions'); mkdirSync(outputRoot, { mode: 0o700 });
  const beforeRefs = f.git('for-each-ref');
  const options = { repo: f.repo, outputRoot, commit: f.request.commit, main: f.request.main, trust: f.trust, now: f.now };
  const first = prepareRemoteGateSource(options); const second = prepareRemoteGateSource(options);
  assert.notEqual(JSON.parse(first.requestBytes).id, JSON.parse(second.requestBytes).id);
  const result = reconstructRemoteGateSource({ ...first, runnerRoot: f.runnerRoot, trust: f.trust, now: f.now });
  assert.equal(result.tree, f.request.tree);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('for-each-ref'), beforeRefs);
  assert.equal(f.git('rev-parse', 'HEAD'), f.request.commit);
});

test('a candidate in a linked worktree snapshots and rebuilds (worktree HEADs are not refs)', t => {
  // `bundle create --all` also bundles every `worktrees/<name>/HEAD`, which
  // for-each-ref never lists, so a linked worktree (the merge train's own) was
  // refused as "heads differ" (D9 P3 dry run, 2026-11-01).
  const f = fixture(t); const outputRoot = join(f.root, 'submissions'); mkdirSync(outputRoot, { mode: 0o700 });
  const linked = join(f.root, 'linked'); const other = join(f.root, 'other');
  f.git('worktree', 'add', '-q', '--detach', linked, f.request.commit);
  f.git('worktree', 'add', '-q', '--detach', other, f.request.main);
  const prepared = prepareRemoteGateSource({ repo: linked, outputRoot, commit: f.request.commit, main: f.request.main, trust: f.trust, now: f.now });
  const result = reconstructRemoteGateSource({ ...prepared, runnerRoot: f.runnerRoot, trust: f.trust, now: f.now });
  assert.equal(result.tree, f.request.tree);
});

for (const [name, mutate, pattern] of [
  ['untracked files', f => writeFileSync(join(f.repo, 'untracked.txt'), 'private uncommitted work'), /clean and committed/],
  ['unstaged changes', f => writeFileSync(join(f.repo, 'candidate.txt'), 'private edited work'), /clean and committed/],
  ['staged changes', f => { writeFileSync(join(f.repo, 'candidate.txt'), 'staged work'); f.git('add', 'candidate.txt'); }, /clean and committed/],
  ['moved main', f => f.git('update-ref', 'refs/remotes/origin/main', f.request.commit), /source main moved/],
  ['moved candidate', f => f.git('checkout', '-q', 'peer'), /candidate HEAD moved/],
]) test(`submission refuses ${name} without discarding or stashing it`, t => {
  const f = fixture(t); const outputRoot = join(f.root, 'submissions'); mkdirSync(outputRoot, { mode: 0o700 });
  mutate(f); const beforeStatus = f.git('status', '--porcelain'); const beforeRefs = f.git('for-each-ref');
  assert.throws(() => prepareRemoteGateSource({ repo: f.repo, outputRoot, commit: f.request.commit,
    main: f.request.main, trust: f.trust, now: f.now }), pattern);
  assert.equal(f.git('status', '--porcelain'), beforeStatus);
  assert.equal(f.git('for-each-ref'), beforeRefs);
  assert.deepEqual(readdirSync(outputRoot), []);
});
