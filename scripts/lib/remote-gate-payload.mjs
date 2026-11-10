#!/usr/bin/env node
// ADR 0863 D9 P6 — builds the remote gate's reviewed payload as a byte-for-byte
// reproducible .tar.gz and prints its sha256 (the runner policy pin).
//
//   node scripts/lib/remote-gate-payload.mjs <repo> <commit> <out.tgz> <file>...
//
// <file> paths are relative to <commit>:scripts. Why this is not `git archive`:
// archiving a TREE stamps the current time into every entry, and the fix for that,
// `git archive --mtime`, needs git >= 2.42 (Apple git is 2.39: it prints usage, writes
// nothing, and every Mac install failed). Its output also depended on the git
// version's tar layout and on whichever zlib the git binary links. Here every byte is
// decided by this file and node's bundled zlib:
//   - only the blobs' bytes and their git modes come from git (`git cat-file`);
//   - entries are sorted by path; a directory entry precedes its files;
//   - every header is ustar with mtime = the commit's committer time, uid/gid 0,
//     uname/gname "root", mode 0644 / 0755 (0755 = git mode 100755);
//   - gzip at level 9 with a fixed header (mtime 0, no name, OS byte 3), so the
//     host OS does not leak in (node writes 19 on macOS, 3 on Linux).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { isEntryModule } from './entry-module.mjs';

const git = (repo, args, encoding = 'utf8') =>
  execFileSync('git', ['-C', repo, ...args], { encoding, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] });

function header(name, { size, mode, mtime, type }) {
  if (Buffer.byteLength(name) > 100) throw new Error(`remote-gate-payload: path longer than 100 bytes: ${name}`);
  const h = Buffer.alloc(512, 0);
  const put = (off, len, s) => h.write(s, off, len, 'utf8');
  const oct = (off, len, n) => put(off, len, n.toString(8).padStart(len - 1, '0') + '\0');
  put(0, 100, name);
  oct(100, 8, mode);
  oct(108, 8, 0);
  oct(116, 8, 0);
  oct(124, 12, size);
  oct(136, 12, mtime);
  h.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  put(156, 1, type);
  put(257, 6, 'ustar\0');
  put(263, 2, '00');
  put(265, 32, 'root');
  put(297, 32, 'root');
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

export function buildPayload(repo, commit, files) {
  const mtime = Number(git(repo, ['log', '-1', '--format=%ct', commit]).trim());
  if (!Number.isInteger(mtime) || mtime <= 0) throw new Error(`remote-gate-payload: no commit time for ${commit}`);
  const paths = [...new Set(files)].sort();
  const dirs = new Set();
  for (const p of paths) for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i + 1));
  const entries = [...[...dirs].map(d => ({ name: d, dir: true })), ...paths.map(p => ({ name: p, dir: false }))]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts = [];
  for (const e of entries) {
    if (e.dir) { parts.push(header(e.name, { size: 0, mode: 0o755, mtime, type: '5' })); continue; }
    const spec = `${commit}:scripts/${e.name}`;
    const ls = git(repo, ['ls-tree', commit, '--', `scripts/${e.name}`]).trim();
    const gitMode = ls.split(/\s/)[0];
    if (gitMode !== '100644' && gitMode !== '100755') throw new Error(`remote-gate-payload: ${spec} is not a regular file (${gitMode || 'missing'})`);
    const body = git(repo, ['cat-file', 'blob', spec], 'buffer');
    parts.push(header(e.name, { size: body.length, mode: gitMode === '100755' ? 0o755 : 0o644, mtime, type: '0' }));
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  let tar = Buffer.concat(parts);
  tar = Buffer.concat([tar, Buffer.alloc((10240 - (tar.length % 10240)) % 10240, 0)]);
  const gz = gzipSync(tar, { level: 9 });
  gz.writeUInt32LE(0, 4); // header mtime
  gz[9] = 3;              // header OS: unix, whatever the host
  return gz;
}

if (isEntryModule(import.meta.url)) {
  const [repo, commit, out, ...files] = process.argv.slice(2);
  if (!repo || !commit || !out || files.length === 0) {
    console.error('usage: remote-gate-payload.mjs <repo> <commit> <out.tgz> <file>...');
    process.exit(2);
  }
  const gz = buildPayload(repo, commit, files);
  writeFileSync(out, gz);
  process.stdout.write(createHash('sha256').update(gz).digest('hex') + '\n');
}
