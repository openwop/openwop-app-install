// ADR 0785 P2/Q2 — the daemon's output coalescing and its ordering guarantee, and (2026-10-05)
// a revoked pairing that must say so, not retry silently forever.
//
// Sabotage that reds it: a frame per read, a timer per read, a window other than 16 ms; a cap
// that ignores earlier reads or misses exactly 16 KiB; no flush before a replay or an exit; a
// probe answer other than 401 (or a network failure) read as refused; a 401 ignored; a second
// probe on a retry; a probe after a socket that DID open; a refused key that keeps running or
// reconnects; a retry dropped; back-off that does not double; close code 4001 not honoured.
//
// Safety: `PtySessions` defaults to a real 3 s timer and `process.kill(-pid)`, and -1 means every
// process this user owns. A case that opens a session and stops it must replace both on
// `d.sessions`, and fake PTYs here use a pid that is not 1.
//
// `npm run ci` does not run this file: run `node --test` in clients/agent-host.
// agent-host-publish.yml also runs it before a publish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHostDaemon } from '../src/daemon.js';

const FAKE_PID = 424242;

function harness() {
  const sent = []; const timers = [];
  let pty;
  const d = new AgentHostDaemon({
    apiRoot: 'http://x', token: 't', root: '/r',
    ptyFactory: () => { let onData = () => {}; let onExit = () => {}; pty = { pid: FAKE_PID, onData: (cb) => { onData = cb; }, onExit: (cb) => { onExit = cb; }, write() {}, resize() {}, kill() {}, emit: (s) => onData(s), exit: (exitCode) => onExit({ exitCode }) }; return pty; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  });
  d.ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  d.handle({ type: 'open', sessionId: 's', cols: 80, rows: 24 });
  return { d, sent, timers, emit: (s) => pty.emit(s), exit: (code) => pty.exit(code) };
}
const outputs = (sent) => sent.filter((m) => m.type === 'output').map((m) => Buffer.from(m.data, 'base64').toString());

test('a burst of small PTY reads becomes ONE output frame per window', () => {
  const { sent, timers, emit } = harness();
  for (const c of ['a', 'b', 'c', 'd']) emit(c);
  assert.deepEqual(outputs(sent), []);
  assert.deepEqual(timers.map((t) => t.ms), [16], 'one timer for the whole burst, at the 16 ms window');
  timers[0].fn();
  assert.deepEqual(outputs(sent), ['abcd']);
});

test('a burst past the size cap flushes immediately', () => {
  const { sent, emit } = harness();
  const half = 'x'.repeat(8 * 1024);
  emit(half);
  assert.deepEqual(outputs(sent), [], 'half the 16 KiB cap waits for the window');
  emit(half);
  assert.deepEqual(outputs(sent), [half + half]);
});

test('ORDER: queued output is flushed BEFORE a replay, so the replay never precedes bytes it contains', () => {
  const { d, sent, emit } = harness();
  emit('hello');
  d.handle({ type: 'attach', sessionId: 's', viewerId: 'v1' });
  const types = sent.map((m) => m.type).filter((t) => t === 'output' || t === 'replay');
  assert.deepEqual(types, ['output', 'replay']);
  assert.equal(Buffer.from(sent.find((m) => m.type === 'replay').data, 'base64').toString(), 'hello');
});

test('ORDER: queued output is flushed BEFORE an exit, so the last bytes are not lost', () => {
  const { sent, emit, exit } = harness();
  emit('bye');
  exit(0);
  assert.deepEqual(sent.map((m) => m.type).filter((t) => t === 'output' || t === 'exit'), ['output', 'exit']);
  assert.deepEqual(outputs(sent), ['bye']);
});

// ── 2026-10-05: a revoked pairing must say so, not retry silently forever.
const neverOpens = (socket) => socket.onclose?.({ code: 1006, reason: '' });
function failingDaemon(status, closes = neverOpens) {
  const logs = []; const timers = []; const probes = []; const sockets = []; const signals = [];
  class ScriptedSocket {
    constructor() { sockets.push(this); this.readyState = 0; queueMicrotask(() => closes(this)); }
    close() {}
  }
  const d = new AgentHostDaemon({
    apiRoot: 'https://direct.example', token: 'owk_t', root: '/r',
    ptyFactory: () => ({ pid: FAKE_PID, onData() {}, onExit() {}, kill: (s) => signals.push(s) }),
    WebSocketImpl: ScriptedSocket, log: (m) => logs.push(m),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    fetchFn: async (url, init) => {
      probes.push({ url, method: init.method, body: JSON.parse(init.body), auth: init.headers.authorization });
      if (status instanceof Error) throw status;
      return { status };
    },
  });
  // See the header: a session stopped here must never reach the real timer or kill.
  d.sessions.setTimer = () => {};
  d.sessions.killGroup = () => { throw new Error('the real process-group kill must not run in a test'); };
  return { d, logs, timers, probes, sockets, signals };
}
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

test('a handshake that never opens + a 401 probe ⇒ says the key was refused and STOPS retrying', async () => {
  const { d, logs, timers, probes, sockets } = failingDaemon(401);
  d.start();
  await settle();
  assert.equal(probes.length, 1);
  assert.equal(probes[0].url, 'https://direct.example/host/openwop-app/mcp');
  assert.equal(probes[0].auth, 'Bearer owk_t');
  assert.equal(probes[0].method, 'POST');
  assert.equal(probes[0].body.method, 'ping');
  assert.ok(logs.some((l) => /key was refused/.test(l)), logs.join('\n'));
  assert.equal(d.stopped, true);
  timers.splice(0).forEach((t) => t.fn()); // the queued retry must not reconnect
  await settle();
  assert.equal(sockets.length, 1);
  assert.equal(probes.length, 1);
});

test('any other probe answer (or a network failure) keeps the normal back-off, probed only ONCE per run', async () => {
  for (const status of [200, 403, 404, 500, new Error('offline')]) {
    const { d, logs, timers, probes, sockets } = failingDaemon(status);
    d.start();
    await settle();
    assert.equal(d.stopped, false, String(status));
    assert.ok(!logs.some((l) => /key was refused/.test(l)));
    assert.deepEqual(timers.map((t) => t.ms), [1000], `first retry after 1 s (${status})`);
    timers.splice(0).forEach((t) => t.fn()); // retry
    await settle();
    assert.equal(sockets.length, 2, `the retry reconnects (${status})`);
    assert.deepEqual(timers.map((t) => t.ms), [2000], `the back-off doubles (${status})`);
    assert.equal(probes.length, 1, `probe once, not per retry (${status})`);
    d.stop();
  }
});

test('a socket that opened and later dropped is routine: no key probe, just the retry', async () => {
  const { d, logs, timers, probes } = failingDaemon(401, (socket) => { socket.onopen?.(); neverOpens(socket); });
  d.start();
  await settle();
  assert.equal(probes.length, 0, 'even a 401 answer must never be asked for');
  assert.equal(d.stopped, false);
  assert.ok(!logs.some((l) => /key was refused/.test(l)));
  assert.deepEqual(timers.map((t) => t.ms), [1000]);
  d.stop();
});

test('close code 4001 says the device was revoked, stops its sessions and does not retry', async () => {
  const { d, logs, timers, probes, sockets, signals } = failingDaemon(200, (socket) => {
    socket.onopen?.();
    socket.onclose?.({ code: 4001, reason: 'revoked in the app' });
  });
  d.handle({ type: 'open', sessionId: 's', cols: 80, rows: 24 });
  d.start();
  await settle();
  assert.ok(logs.some((l) => /closed this device: revoked in the app/.test(l)), logs.join('\n'));
  assert.equal(d.stopped, true);
  assert.deepEqual(signals, ['SIGHUP']);
  assert.deepEqual(timers, [], 'no retry is queued');
  assert.equal(sockets.length, 1);
  assert.equal(probes.length, 0);
});
