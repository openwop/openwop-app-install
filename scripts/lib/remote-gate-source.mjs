/** ADR 0863 D9: reconstruct Git data only. Never install dependencies, execute
 * candidate files, fetch a network ref, or reuse a peer's checkout here.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { parseRemoteGateRequest, sha256 } from './remote-gate-result.mjs';

const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const MAX_REFS_BYTES = 8 * 1024 * 1024;

function copyBoundedBundle(source, destination) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const stat = fstatSync(input);
    assert(stat.isFile() && stat.size > 0 && stat.size <= MAX_BUNDLE_BYTES, 'bounded regular bundle required');
    output = openSync(destination, 'wx', 0o600);
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(input, buffer, 0, buffer.length, null);
      if (n === 0) break;
      total += n;
      assert(total <= MAX_BUNDLE_BYTES, 'copied bundle exceeds bound');
      hash.update(buffer.subarray(0, n));
      let offset = 0;
      while (offset < n) {
        const written = writeSync(output, buffer, offset, n - offset);
        assert(written > 0, 'bundle copy stopped writing');
        offset += written;
      }
    }
    return hash.digest('hex');
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

// The worker entry point must be installed outside the candidate; Git must not
// inherit GIT_CONFIG_*, alternate object stores, SSH commands, hooks or filters.
function gitAt(cwd, home, args, input) {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'protocol.allow=never', '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true', ...args], {
    cwd, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function privateRoot(root) {
  const stat = lstatSync(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o077) === 0, 'runner root must be a private owned directory');
  return realpathSync(root);
}

/** Read the submitting checkout again without changing its refs, index or files.
 * origin/main must already have been refreshed by the controller. This cannot
 * replace the merge train's later remote-main and PR-head preconditions.
 */
export function inspectRemoteGateCandidate({ repo, home, requestBytes, trust, now = Date.now() }) {
  const request = parseRemoteGateRequest(requestBytes, trust, now);
  const git = args => gitAt(repo, privateRoot(home), args);
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel']).trim()), realpathSync(repo), 'candidate must be checkout root');
  assert.equal(git(['rev-parse', 'HEAD']).trim(), request.commit, 'local candidate HEAD moved');
  assert.equal(git(['rev-parse', 'HEAD^{tree}']).trim(), request.tree, 'local candidate tree differs');
  assert.equal(git(['rev-parse', 'refs/remotes/origin/main']).trim(), request.main, 'local main observation moved');
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '', 'local candidate is dirty');
  git(['merge-base', '--is-ancestor', request.main, request.commit]);
  return { commit: request.commit, tree: request.tree, main: request.main };
}

/** The coordinator supplies a just-refreshed main SHA; this function never
 * fetches, changes a ref, creates a stash or captures uncommitted source. Ref
 * drift during the snapshot is a retryable refusal, not a global freeze.
 */
export function prepareRemoteGateSource({ repo, outputRoot, commit, main, trust, now = Date.now() }) {
  for (const [name, value] of Object.entries({ commit, main })) assert.match(value, /^[a-f0-9]{40}$/, name);
  assert.match(trust.runnerId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'runner identity');
  assert.match(trust.policySha256, /^[a-f0-9]{64}$/, 'locally approved runner policy');
  const work = mkdtempSync(join(privateRoot(outputRoot), 'submission-'));
  try {
    const home = join(work, 'home'); mkdirSync(home, { mode: 0o700 });
    const git = (args, input) => gitAt(repo, home, args, input);
    assert.equal(realpathSync(git(['rev-parse', '--show-toplevel']).trim()), realpathSync(repo), 'source must be checkout root');
    assert.equal(git(['rev-parse', '--is-shallow-repository']).trim(), 'false', 'shallow source is not complete history');
    const assertFrozen = () => {
      assert.equal(git(['rev-parse', 'HEAD']).trim(), commit, 'candidate HEAD moved');
      assert.equal(git(['rev-parse', 'refs/remotes/origin/main']).trim(), main, 'source main moved');
      assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '', 'source must be clean and committed');
    };
    assertFrozen(); git(['merge-base', '--is-ancestor', main, commit]);
    const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
    // The manifest is what the bundle RECORDED, not a second listing. In a busy
    // shared repository other sessions move refs all the time (fetches, pushes,
    // per-turn checkpoint refs), so "no ref moved during the snapshot" almost never
    // held (D9 P3 dry run, 2026-11-01). Only the candidate and main must be frozen,
    // and assertFrozen checks both around the bundle. Every other ref is a
    // consistent point-in-time view by construction. Names come from a listing,
    // bundled via --stdin: `--all` would also bundle each linked worktree's
    // `worktrees/<name>/HEAD`, which is not a ref. A ref deleted mid-bundle retries.
    const bundlePath = join(work, 'source.bundle');
    let refsBytes; let refs;
    for (let attempt = 1; ; attempt++) {
      const names = git(['for-each-ref', '--format=%(refname)']).trim().split('\n').filter(Boolean);
      rmSync(bundlePath, { force: true });
      try {
        git(['-c', 'pack.threads=1', 'bundle', 'create', bundlePath, '--stdin'], `${[...names, 'HEAD'].join('\n')}\n`);
      } catch (error) { if (attempt < 3) continue; throw error; }
      const heads = git(['bundle', 'list-heads', bundlePath]).trim().split('\n');
      assert.equal(heads.filter(l => l.endsWith(' HEAD')).join('\n'), `${commit} HEAD`, 'snapshot HEAD differs from candidate');
      const lines = heads.filter(l => !l.endsWith(' HEAD'))
        .sort((a, b) => { const x = a.slice(41); const y = b.slice(41); return x < y ? -1 : x > y ? 1 : 0; });
      refsBytes = Buffer.from(`${lines.join('\n')}\n`);
      refs = parseRefs(refsBytes, git);
      break;
    }
    assertFrozen();
    assert.equal(refs.get('refs/remotes/origin/main'), main, 'snapshot main differs');
    // Stream through the same bounded private-copy path used on the worker.
    // Removing the temporary copy leaves one immutable transport artifact.
    const hashCopy = join(work, 'hash-copy.bundle');
    const bundleSha256 = copyBoundedBundle(bundlePath, hashCopy); rmSync(hashCopy);
    const requestBytes = Buffer.from(JSON.stringify({ version: 1, id: randomBytes(16).toString('hex'),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
      commit, tree, main, refsSha256: sha256(refsBytes), bundleSha256,
      runnerId: trust.runnerId, policySha256: trust.policySha256 }));
    parseRemoteGateRequest(requestBytes, trust, now);
    writeFileSync(join(work, 'request.json'), requestBytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(work, 'refs.manifest'), refsBytes, { flag: 'wx', mode: 0o600 });
    return { work, requestBytes, refsBytes, bundlePath };
  } catch (error) { rmSync(work, { recursive: true, force: true }); throw error; }
}

function parseRefs(bytes, git) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_REFS_BYTES, 'bounded ref manifest required');
  const text = bytes.toString('utf8');
  assert(Buffer.from(text).equals(bytes) && text.endsWith('\n'), 'canonical ref manifest encoding');
  const refs = new Map();
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([a-f0-9]{40}) (refs\/[\x21-\x7e]+)$/.exec(line);
    assert(match, 'invalid ref manifest line');
    const [, oid, ref] = match;
    assert(!refs.has(ref), 'duplicate ref');
    assert(!ref.startsWith('refs/replace/'), 'replace refs are not supported');
    git(['check-ref-format', ref]);
    refs.set(ref, oid);
  }
  assert(refs.size <= 50_000, 'too many refs');
  return refs;
}

function assertSafeTree(git, commit, checkout) {
  const links = [];
  for (const entry of git(['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    assert(match, 'unsupported tree entry (including submodules)');
    const [, mode, oid, name] = match;
    assert(!name.includes('\ufffd') && !isAbsolute(name) && !name.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'), 'unsafe tree path');
    if (mode === '120000') {
      const target = git(['cat-file', 'blob', oid]);
      const resolved = posix.normalize(posix.join(posix.dirname(name), target));
      assert(!isAbsolute(target) && resolved !== '..' && !resolved.startsWith('../') && !target.includes('\0') && !target.includes('\ufffd'), 'symlink escapes checkout');
      links.push(join(checkout, name));
    }
  }
  return links;
}

/** runnerRoot is private operator-owned configuration, never request data.
 * request/trust and bundle/ref digests are checked before any source checkout.
 * On error, only the newly allocated owned directory is removed. A successful
 * caller owns `work` and must keep it for the gate/result lifecycle.
 */
export function reconstructRemoteGateSource({ runnerRoot, requestBytes, refsBytes, bundlePath, trust, now }) {
  const request = parseRemoteGateRequest(requestBytes, trust, now);
  assert.equal(sha256(refsBytes), request.refsSha256, 'ref manifest bytes differ');
  const work = mkdtempSync(join(privateRoot(runnerRoot), `request-${request.id}-`));
  try {
    const home = join(work, 'home'); const repo = join(work, 'source'); const template = join(work, 'template');
    for (const dir of [home, repo, template]) mkdirSync(dir, { mode: 0o700 });
    const git = (args, input) => gitAt(repo, home, args, input);
    const refs = parseRefs(refsBytes, git);
    assert.equal(refs.get('refs/remotes/origin/main'), request.main, 'manifest main differs');
    const stat = lstatSync(bundlePath);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_BUNDLE_BYTES, 'bounded regular bundle required');
    // Work only from a private copy. A writer changing the input during this
    // copy cannot change the bytes used after the checked digest.
    const bundle = join(work, 'source.bundle');
    assert.equal(copyBoundedBundle(bundlePath, bundle), request.bundleSha256, 'bundle bytes differ');
    git(['init', '-q', '--object-format=sha1', `--template=${template}`]);
    // Verify in an empty object database: incremental or shallow bundles with
    // missing prerequisites cannot borrow objects from an ambient repository.
    git(['bundle', 'verify', bundle]);
    const expectedHeads = [...refs].map(([ref, oid]) => `${oid} ${ref}`).concat(`${request.commit} HEAD`).sort();
    const heads = git(['bundle', 'list-heads', bundle]).trim().split('\n').sort();
    assert.deepEqual(heads, expectedHeads, 'bundle heads differ from frozen manifest');
    git(['bundle', 'unbundle', bundle]);
    git(['update-ref', '--stdin'], `start\n${[...refs].map(([ref, oid]) => `create ${ref} ${oid}\n`).join('')}prepare\ncommit\n`);
    git(['fsck', '--full', '--strict', '--no-reflogs']);
    assert.equal(git(['rev-parse', `${request.commit}^{commit}`]).trim(), request.commit, 'candidate commit differs');
    assert.equal(git(['rev-parse', `${request.commit}^{tree}`]).trim(), request.tree, 'candidate tree differs');
    git(['merge-base', '--is-ancestor', request.main, request.commit]);
    const links = assertSafeTree(git, request.commit, repo);
    git(['checkout', '-q', '--detach', request.commit]);
    for (const link of links) {
      const rel = relative(repo, realpathSync(link));
      assert(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'resolved symlink escapes checkout');
    }
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), '', 'reconstructed source is dirty');
    const reconstructedRefs = git(['for-each-ref', '--format=%(objectname) %(refname)']).trim().split('\n').sort();
    assert.deepEqual(reconstructedRefs, expectedHeads.filter(line => !line.endsWith(' HEAD')), 'reconstructed refs differ');
    return { work, repo, home, commit: request.commit, tree: request.tree, main: request.main,
      requestSha256: sha256(requestBytes), refsSha256: request.refsSha256, bundleSha256: request.bundleSha256 };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}
