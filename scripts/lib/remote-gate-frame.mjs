/** ADR 0863 D9: private SSH data framing, not the OpenWOP protocol. This module
 * transports inert bytes only. It neither authenticates SSH nor executes CI.
 * The caller validates the request/result contract after the whole frame arrives.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { privateRoot } from './remote-gate-source.mjs';

const MAGIC = Buffer.from('OPENWOP-CI/1\n');
const END = Buffer.from('END\n');
const HEADER_MAX = 4096;
const CHUNK = 64 * 1024;
const MiB = 1024 * 1024;
// A full gate's log measured ~247 MB on the remote VM (2026-11-02), and a longer
// run outgrew 256 MiB: its log could not be served, and a green gate that long
// could not have been fetched at all. 1 GiB leaves headroom; still bounded.
const GATE_LOG_MAX = 1024 * MiB;
export const REMOTE_GATE_RESULT_FILES = Object.freeze({
  'result.json': MiB, 'evidence.json': MiB, 'gate.log.gz': GATE_LOG_MAX, 'browser.tsv': 8 * MiB,
});
const KINDS = Object.freeze({
  source: Object.freeze({ 'request.json': MiB, 'refs.manifest': 8 * MiB, 'source.bundle': 1024 * MiB }),
  result: REMOTE_GATE_RESULT_FILES,
  control: Object.freeze({ 'request.json': MiB, 'operation.json': 4096 }),
  status: Object.freeze({ 'status.json': 4096 }),
  // A finished job's kept gate log, for diagnosing a red or interrupted gate.
  log: Object.freeze({ 'gate.log.gz': GATE_LOG_MAX }),
});

function schema(kind) {
  assert(Object.hasOwn(KINDS, kind), 'unknown frame kind');
  return KINDS[kind];
}
function validateHeader(header, kind) {
  const fields = schema(kind);
  assert(header && typeof header === 'object' && !Array.isArray(header), 'frame header object');
  assert.deepEqual(Object.keys(header).sort(), ['files', 'kind', 'version'], 'frame header fields');
  assert.equal(header.version, 1, 'frame version');
  assert.equal(header.kind, kind, 'frame direction differs');
  assert(Array.isArray(header.files), 'frame files');
  assert.deepEqual(header.files.map(file => file?.name), Object.keys(fields), 'fixed frame artifact names/order');
  for (const file of header.files) {
    assert.deepEqual(Object.keys(file).sort(), ['bytes', 'name', 'sha256'], 'frame artifact fields');
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= fields[file.name], 'frame artifact size exceeds bound');
    assert.match(file.sha256, /^[a-f0-9]{64}$/, 'frame artifact digest');
  }
  return header;
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    assert(written > 0, 'artifact write stopped');
    offset += written;
  }
}

/** Encoder for Readable.from(..., {objectMode:false}). Paths are local caller
 * configuration; only fixed basenames reach the wire. Keep file descriptors open
 * across both passes, and refuse changed content before emitting the end marker.
 */
export function* remoteGateFrame(kind, paths, { expectedSha256 = {} } = {}) {
  const fields = schema(kind);
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(fields).sort(), 'local artifact set');
  // A durable job may already have committed an artifact digest. Compare it to
  // the bytes held by this encoder's descriptor, not an earlier path read.
  assert(expectedSha256 && typeof expectedSha256 === 'object' && !Array.isArray(expectedSha256), 'expected digest map');
  const expected = { ...expectedSha256 };
  for (const [name, digest] of Object.entries(expected)) {
    assert(Object.hasOwn(fields, name), 'unknown expected artifact');
    assert.match(digest, /^[a-f0-9]{64}$/, 'expected artifact digest');
  }
  const opened = [];
  try {
    for (const [name, max] of Object.entries(fields)) {
      const fd = openSync(paths[name], constants.O_RDONLY | constants.O_NOFOLLOW);
      const item = { fd, name }; opened.push(item);
      const stat = fstatSync(fd);
      assert(stat.isFile() && stat.size > 0 && stat.size <= max, 'bounded regular artifact required');
      const hash = createHash('sha256'); const buffer = Buffer.alloc(CHUNK);
      let offset = 0;
      while (offset < stat.size) {
        const n = readSync(fd, buffer, 0, Math.min(CHUNK, stat.size - offset), offset);
        assert(n > 0, 'artifact truncated during hashing');
        hash.update(buffer.subarray(0, n)); offset += n;
      }
      item.bytes = stat.size; item.sha256 = hash.digest('hex');
      if (Object.hasOwn(expected, name)) assert.equal(item.sha256, expected[name], 'artifact differs from durable job');
    }
    const header = Buffer.from(JSON.stringify({ version: 1, kind,
      files: opened.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }));
    assert(header.length <= HEADER_MAX, 'frame header too large');
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    yield MAGIC; yield length; yield header;
    for (const file of opened) {
      const hash = createHash('sha256'); let offset = 0;
      while (offset < file.bytes) {
        const buffer = Buffer.alloc(Math.min(CHUNK, file.bytes - offset));
        const n = readSync(file.fd, buffer, 0, buffer.length, offset);
        assert(n > 0, 'artifact truncated during transfer');
        offset += n; const chunk = buffer.subarray(0, n); hash.update(chunk); yield chunk;
      }
      assert.equal(fstatSync(file.fd).size, file.bytes, 'artifact size changed during transfer');
      assert.equal(hash.digest('hex'), file.sha256, 'artifact bytes changed during transfer');
    }
    yield END;
  } finally { for (const { fd } of opened) closeSync(fd); }
}

/** Receive into newly allocated private files; return paths only after all
 * digests, end marker AND EOF pass. A stalled, interrupted, truncated, trailing or
 * oversized frame is never a submission/result. No received string is a path.
 * This owns the input Readable and destroys it on failure. A caller retains a
 * successful spool through request/result verification and cleans it afterwards.
 */
export async function receiveRemoteGateFrame(input, { kind, root, signal,
  idleTimeoutMs = 15_000, totalTimeoutMs = 600_000 } = {}) {
  schema(kind);
  assert(input instanceof Readable && !input.readableObjectMode, 'binary Readable required');
  for (const n of [idleTimeoutMs, totalTimeoutMs]) assert(Number.isSafeInteger(n) && n > 0 && n <= 600_000, 'bounded frame timeout');
  const work = mkdtempSync(join(privateRoot(root), 'frame-'));
  const iterator = input[Symbol.asyncIterator]();
  const deadline = performance.now() + totalTimeoutMs;
  let buffer = Buffer.alloc(0); let offset = 0;
  const check = () => {
    signal?.throwIfAborted();
    assert(performance.now() < deadline, 'frame total timeout');
  };
  async function next() {
    check();
    let timer; let onAbort;
    try {
      return await Promise.race([iterator.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('frame read timeout')), Math.min(idleTimeoutMs, deadline - performance.now()));
        if (signal) {
          onAbort = () => reject(signal.reason ?? new Error('frame aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      })]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
  async function consume(count, accept) {
    while (count > 0) {
      check();
      if (offset === buffer.length) {
        const part = await next();
        assert(!part.done, 'truncated frame');
        assert(Buffer.isBuffer(part.value), 'nonbinary frame chunk');
        buffer = part.value; offset = 0;
        if (buffer.length === 0) continue;
      }
      const size = Math.min(count, buffer.length - offset, CHUNK);
      accept(buffer.subarray(offset, offset + size)); offset += size; count -= size;
    }
  }
  async function small(count) {
    const parts = []; await consume(count, bytes => parts.push(Buffer.from(bytes)));
    return Buffer.concat(parts);
  }
  try {
    assert((await small(MAGIC.length)).equals(MAGIC), 'frame magic differs');
    const length = (await small(4)).readUInt32BE();
    assert(length > 0 && length <= HEADER_MAX, 'frame header size exceeds bound');
    const raw = await small(length); const text = raw.toString('utf8');
    assert(Buffer.from(text).equals(raw), 'frame header encoding');
    const header = validateHeader(JSON.parse(text), kind);
    const paths = {};
    for (const file of header.files) {
      const path = join(work, file.name); const fd = openSync(path, 'wx', 0o600);
      try {
        const hash = createHash('sha256');
        await consume(file.bytes, bytes => { hash.update(bytes); writeAll(fd, bytes); });
        assert.equal(hash.digest('hex'), file.sha256, 'received artifact digest differs');
      } finally { closeSync(fd); }
      paths[file.name] = path;
    }
    assert((await small(END.length)).equals(END), 'frame end marker differs');
    assert.equal(offset, buffer.length, 'trailing frame bytes');
    assert.equal((await next()).done, true, 'trailing frame bytes');
    return { work, paths, header };
  } catch (error) {
    input.destroy(); rmSync(work, { recursive: true, force: true }); throw error;
  }
}
