// ADR 0785 P2/Q2 — the daemon's output coalescing and its ordering guarantee.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHostDaemon, COALESCE_MAX_BYTES } from '../src/daemon.js';

function harness() {
  const sent = []; const timers = [];
  let pty;
  const d = new AgentHostDaemon({
    apiRoot: 'http://x', token: 't', root: '/r',
    ptyFactory: () => { let onData = () => {}; pty = { pid: 1, onData: (cb) => { onData = cb; }, onExit: () => {}, write() {}, resize() {}, kill() {}, emit: (s) => onData(s) }; return pty; },
    setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  d.ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  d.handle({ type: 'open', sessionId: 's', cols: 80, rows: 24 });
  return { d, sent, timers, emit: (s) => pty.emit(s) };
}
const outputs = (sent) => sent.filter((m) => m.type === 'output').map((m) => Buffer.from(m.data, 'base64').toString());

test('a burst of small PTY reads becomes ONE output frame per window', () => {
  const { sent, timers, emit } = harness();
  for (const c of ['a', 'b', 'c', 'd']) emit(c);
  assert.deepEqual(outputs(sent), []);
  timers[0]();
  assert.deepEqual(outputs(sent), ['abcd']);
});

test('a burst past the size cap flushes immediately', () => {
  const { sent, emit } = harness();
  emit('x'.repeat(COALESCE_MAX_BYTES));
  assert.equal(outputs(sent).length, 1);
});

test('ORDER: queued output is flushed BEFORE a replay, so the replay never precedes bytes it contains', () => {
  const { d, sent, emit } = harness();
  emit('hello');
  d.handle({ type: 'attach', sessionId: 's', viewerId: 'v1' });
  const types = sent.map((m) => m.type).filter((t) => t === 'output' || t === 'replay');
  assert.deepEqual(types, ['output', 'replay']);
  assert.equal(Buffer.from(sent.find((m) => m.type === 'replay').data, 'base64').toString(), 'hello');
});

// ── 2026-10-05: a revoked pairing must say so, not retry silently forever.
class FailingSocket {
  constructor() { this.readyState = 0; queueMicrotask(() => this.onclose?.({ code: 1006, reason: '' })); }
  close() {}
}
function failingDaemon(status) {
  const logs = []; const timers = []; const probes = [];
  const d = new AgentHostDaemon({
    apiRoot: 'https://direct.example', token: 'owk_t', root: '/r', ptyFactory: () => ({}),
    WebSocketImpl: FailingSocket, log: (m) => logs.push(m),
    setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
    fetchFn: async (url, init) => { probes.push({ url, auth: init.headers.authorization }); if (status instanceof Error) throw status; return { status }; },
  });
  return { d, logs, timers, probes };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test('a handshake that never opens + a 401 probe ⇒ says the key was refused and STOPS retrying', async () => {
  const { d, logs, timers, probes } = failingDaemon(401);
  d.start();
  await settle();
  assert.equal(probes.length, 1);
  assert.equal(probes[0].url, 'https://direct.example/host/openwop-app/mcp');
  assert.equal(probes[0].auth, 'Bearer owk_t');
  assert.ok(logs.some((l) => /key was refused/.test(l)), logs.join('\n'));
  assert.equal(d.stopped, true);
  timers.splice(0).forEach((fn) => fn()); // the queued retry must not reconnect
  await settle();
  assert.equal(probes.length, 1);
});

test('any other probe answer (or a network failure) keeps the normal back-off, probed only ONCE per run', async () => {
  for (const status of [200, 403, 404, 500, new Error('offline')]) {
    const { d, logs, timers, probes } = failingDaemon(status);
    d.start();
    await settle();
    assert.equal(d.stopped, false, String(status));
    assert.ok(!logs.some((l) => /key was refused/.test(l)));
    timers.splice(0).forEach((fn) => fn()); // retry
    await settle();
    assert.equal(probes.length, 1, `probe once, not per retry (${status})`);
    d.stop();
  }
});
