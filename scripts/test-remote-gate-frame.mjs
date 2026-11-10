import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { remoteGateFrame, receiveRemoteGateFrame } from './lib/remote-gate-frame.mjs';

const MAGIC = Buffer.from('OPENWOP-CI/1\n');
const names = {
  source: ['request.json', 'refs.manifest', 'source.bundle'],
  result: ['result.json', 'evidence.json', 'gate.log.gz', 'browser.tsv'],
};
function fixture(t, kind = 'source') {
  const root = mkdtempSync(join(tmpdir(), 'remote-frame-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spool = join(root, 'spool'); mkdirSync(spool, { mode: 0o700 });
  const peer = join(spool, 'peer'); writeFileSync(peer, 'preserve peer data');
  const paths = Object.fromEntries(names[kind].map((name, i) => {
    const path = join(root, name);
    // Includes binary NUL and shell-looking text; it must only become file data.
    writeFileSync(path, Buffer.concat([Buffer.from(`${name}: $(touch forbidden);\0`), Buffer.alloc(i * 75_000 + 1, i)]));
    return [name, path];
  }));
  const frame = () => Buffer.concat([...remoteGateFrame(kind, paths)]);
  const receive = bytes => receiveRemoteGateFrame(Readable.from([bytes], { objectMode: false }), { kind, root: spool });
  return { root, spool, paths, frame, receive, peer };
}
function editHeader(frame, edit) {
  const size = frame.readUInt32BE(MAGIC.length);
  const h = JSON.parse(frame.subarray(MAGIC.length + 4, MAGIC.length + 4 + size));
  edit(h);
  const bytes = Buffer.from(JSON.stringify(h)); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  return Buffer.concat([MAGIC, length, bytes, frame.subarray(MAGIC.length + 4 + size)]);
}

for (const kind of ['source', 'result']) test(`${kind} frame round-trips exact bytes in private files`, async t => {
  const f = fixture(t, kind);
  const chunks = [...remoteGateFrame(kind, f.paths)];
  assert(chunks.every(c => c.length <= 64 * 1024));
  const result = await receiveRemoteGateFrame(Readable.from(chunks, { objectMode: false }), { kind, root: f.spool });
  assert.deepEqual(Object.keys(result.paths), names[kind]);
  assert.equal(statSync(result.work).mode & 0o777, 0o700);
  for (const [name, path] of Object.entries(result.paths)) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(path), readFileSync(f.paths[name]));
  }
  assert.equal(readFileSync(f.peer, 'utf8'), 'preserve peer data');
  assert.equal(existsSync(join(f.root, 'forbidden')), false);
});

test('header and body boundaries may split across arbitrary input chunks', async t => {
  const f = fixture(t); const frame = f.frame();
  const chunks = [];
  for (let offset = 0; offset < frame.length; offset += 137) chunks.push(frame.subarray(offset, offset + 137));
  const result = await receiveRemoteGateFrame(Readable.from(chunks, { objectMode: false }), { kind: 'source', root: f.spool });
  assert.deepEqual(readFileSync(result.paths['source.bundle']), readFileSync(f.paths['source.bundle']));
});

for (const [name, mutate, pattern] of [
  ['wrong protocol', b => { b[0] ^= 1; return b; }, /frame magic differs/],
  ['oversized header', b => { b.writeUInt32BE(4097, MAGIC.length); return b; }, /header size exceeds bound/],
  ['truncated header', b => b.subarray(0, 30), /truncated frame/],
  ['truncated artifact', b => b.subarray(0, b.length - 17), /truncated frame/],
  ['changed artifact bytes', b => { b[b.length - 6] ^= 1; return b; }, /artifact digest differs/],
  ['wrong end marker', b => { b[b.length - 1] ^= 1; return b; }, /end marker differs/],
  ['trailing data', b => Buffer.concat([b, Buffer.from('extra command')]), /trailing frame bytes/],
  ['opposite direction', b => editHeader(b, h => { h.kind = 'result'; }), /direction differs/],
  ['path traversal', b => editHeader(b, h => { h.files[0].name = '../outside'; }), /artifact names\/order/],
  ['duplicate artifact', b => editHeader(b, h => { h.files[1].name = h.files[0].name; }), /artifact names\/order/],
  ['unknown command field', b => editHeader(b, h => { h.command = 'touch forbidden'; }), /header fields/],
  ['unknown artifact field', b => editHeader(b, h => { h.files[0].path = '/tmp/forbidden'; }), /artifact fields/],
  ['oversized request', b => editHeader(b, h => { h.files[0].bytes = 1024 * 1024 + 1; }), /artifact size exceeds bound/],
  ['oversized bundle', b => editHeader(b, h => { h.files[2].bytes = 1024 ** 3 + 1; }), /artifact size exceeds bound/],
  ['fractional size', b => editHeader(b, h => { h.files[0].bytes = 1.5; }), /artifact size exceeds bound/],
  ['empty artifact', b => editHeader(b, h => { h.files[0].bytes = 0; }), /artifact size exceeds bound/],
  ['missing artifact', b => editHeader(b, h => { h.files.pop(); }), /artifact names\/order/],
]) test(`refuses ${name}; cleans only its own partial spool`, async t => {
  const f = fixture(t);
  await assert.rejects(f.receive(mutate(f.frame())), pattern);
  assert.deepEqual(readdirSync(f.spool), ['peer']);
  assert.equal(readFileSync(f.peer, 'utf8'), 'preserve peer data');
});

test('trailing data in a separate chunk cannot pass the EOF check', async t => {
  const f = fixture(t);
  async function* chunks() { yield f.frame(); await Promise.resolve(); yield Buffer.from('extra'); }
  await assert.rejects(receiveRemoteGateFrame(Readable.from(chunks(), { objectMode: false }),
    { kind: 'source', root: f.spool }), /trailing frame bytes/);
  assert.deepEqual(readdirSync(f.spool), ['peer']);
});

test('an interrupted input after writing partial bytes cannot return a usable spool', async t => {
  const f = fixture(t);
  async function* chunks() { yield f.frame().subarray(0, 1500); throw new Error('transport interrupted'); }
  await assert.rejects(receiveRemoteGateFrame(Readable.from(chunks(), { objectMode: false }),
    { kind: 'source', root: f.spool }), /transport interrupted/);
  assert.deepEqual(readdirSync(f.spool), ['peer']);
});

test('idle timeout destroys its input and removes partial files', async t => {
  const f = fixture(t); const input = new PassThrough();
  input.write(f.frame().subarray(0, 1500));
  await assert.rejects(receiveRemoteGateFrame(input, { kind: 'source', root: f.spool,
    idleTimeoutMs: 20, totalTimeoutMs: 1000 }), /frame read timeout/);
  assert.equal(input.destroyed, true);
  assert.deepEqual(readdirSync(f.spool), ['peer']);
});

test('abort while awaiting input destroys its stream and preserves peers', async t => {
  const f = fixture(t); const input = new PassThrough(); const controller = new AbortController();
  const receive = receiveRemoteGateFrame(input, { kind: 'source', root: f.spool, signal: controller.signal });
  controller.abort(new Error('cancel this transfer'));
  await assert.rejects(receive, /cancel this transfer/);
  assert.equal(input.destroyed, true);
  assert.deepEqual(readdirSync(f.spool), ['peer']);
});

test('continuous slow input cannot evade the total transfer deadline', async t => {
  const f = fixture(t); const input = new PassThrough(); let sent = 0;
  const frame = f.frame();
  const timer = setInterval(() => { input.write(frame.subarray(sent, ++sent)); }, 2);
  try {
    await assert.rejects(receiveRemoteGateFrame(input, { kind: 'source', root: f.spool,
      idleTimeoutMs: 1000, totalTimeoutMs: 30 }), /frame (?:read|total) timeout/);
    assert(sent > 0, 'the stream made progress before the total deadline');
    assert.equal(input.destroyed, true);
    assert.deepEqual(readdirSync(f.spool), ['peer']);
  } finally { clearInterval(timer); }
});

test('file replaced during encoding is refused before an end marker is emitted', t => {
  const f = fixture(t); const iterator = remoteGateFrame('source', f.paths);
  const first = iterator.next(); assert.deepEqual(first.value, MAGIC);
  const path = f.paths['source.bundle']; const original = readFileSync(path);
  const changed = Buffer.from(original); changed[0] ^= 1; writeFileSync(path, changed);
  assert.throws(() => [...iterator], /artifact bytes changed during transfer/);
});

test('encoder refuses artifact symlinks; receiver refuses a nonprivate root', async t => {
  const f = fixture(t); const linked = join(f.root, 'linked'); symlinkSync(f.paths['source.bundle'], linked);
  assert.throws(() => [...remoteGateFrame('source', { ...f.paths, 'source.bundle': linked })], /ELOOP/);
  chmodSync(f.spool, 0o755);
  await assert.rejects(f.receive(f.frame()), /private owned directory/);
  assert.deepEqual(readdirSync(f.spool), ['peer']);
});
