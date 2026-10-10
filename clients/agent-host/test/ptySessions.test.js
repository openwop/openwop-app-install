// ADR 0785 P2 — PTY session lifecycle, with a fake PTY (the real one is exercised by
// the smoke test at the bottom, which spawns /bin/echo through node-pty itself).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtySessions, STOP_GRACE_MS } from '../src/ptySessions.js';

function fakeFactory() {
  const spawned = [];
  const factory = (command, args, opts) => {
    let dataCb = () => {}; let exitCb = () => {};
    const p = {
      pid: 1000 + spawned.length, command, args, opts, written: [], resized: [], signals: [],
      onData: (cb) => { dataCb = cb; }, onExit: (cb) => { exitCb = cb; },
      write: (d) => p.written.push(d), resize: (c, r) => p.resized.push([c, r]), kill: (s) => p.signals.push(s),
      emit: (d) => dataCb(d), exit: (code) => exitCb({ exitCode: code }),
    };
    spawned.push(p);
    return p;
  };
  return { factory, spawned };
}

test('output is buffered for replay and forwarded with its generation', () => {
  const { factory, spawned } = fakeFactory();
  const out = [];
  const s = new PtySessions({ ptyFactory: factory, onOutput: (id, g, c) => out.push([id, g, c.toString()]) });
  const g = s.start('t1', { command: 'claude', args: ['--x'], env: {} });
  spawned[0].emit('hello ');
  spawned[0].emit('world');
  assert.deepEqual(out, [['t1', g, 'hello '], ['t1', g, 'world']]);
  assert.equal(s.replay('t1').toString(), 'hello world');
  assert.equal(spawned[0].opts.env.TERM, 'xterm-256color');
});

test('the replay buffer is bounded — oldest chunks fall off first', () => {
  const { factory, spawned } = fakeFactory();
  const s = new PtySessions({ ptyFactory: factory, replayCapacity: 10 });
  s.start('t', { command: 'c', env: {} });
  for (const c of ['aaaa', 'bbbb', 'cccc', 'dddd']) spawned[0].emit(c);
  assert.equal(s.replay('t').toString(), 'ccccdddd');
});

test('GENERATIONS: a late exit or output from a replaced process never touches its replacement', () => {
  const { factory, spawned } = fakeFactory();
  const exits = []; const out = [];
  const s = new PtySessions({ ptyFactory: factory, onExit: (id, g) => exits.push(g), onOutput: (id, g, c) => out.push(c.toString()), setTimer: () => {} });
  const g1 = s.start('t', { command: 'c', env: {} });
  const g2 = s.start('t', { command: 'c', env: {} }); // replaces g1
  assert.notEqual(g1, g2);
  spawned[0].emit('stale');
  spawned[0].exit(0);
  assert.deepEqual(exits, []);
  assert.deepEqual(out, []);
  assert.equal(s.write('t', 'x', g1), false, 'input addressed to the old generation is refused');
  assert.equal(s.write('t', 'x', g2), true);
  spawned[1].exit(3);
  assert.deepEqual(exits, [g2]);
});

test('STOP: SIGHUP first, then SIGKILL to the process group after the grace period if it ignored the hangup', () => {
  const { factory, spawned } = fakeFactory();
  const timers = []; const killed = [];
  const s = new PtySessions({ ptyFactory: factory, setTimer: (fn, ms) => timers.push([fn, ms]), killGroup: (pid, sig) => killed.push([pid, sig]) });
  s.start('t', { command: 'claude', env: {} });
  assert.equal(s.stop('t'), true);
  assert.deepEqual(spawned[0].signals, ['SIGHUP']);
  assert.equal(timers[0][1], STOP_GRACE_MS);
  timers[0][0](); // Claude Code ignores SIGHUP: still running when the grace ends
  assert.deepEqual(killed, [[spawned[0].pid, 'SIGKILL']]);
});

test('STOP: no SIGKILL when the process exited within the grace period', () => {
  const { factory, spawned } = fakeFactory();
  const timers = []; const killed = []; const exits = [];
  const s = new PtySessions({ ptyFactory: factory, setTimer: (fn) => timers.push(fn), killGroup: (p, g) => killed.push(p), onExit: (id, g, code, requested) => exits.push(requested) });
  s.start('t', { command: 'c', env: {} });
  s.stop('t');
  spawned[0].exit(0);
  timers[0]();
  assert.deepEqual(killed, []);
  assert.deepEqual(exits, [true], 'the exit is reported as requested, so no crash banner is shown');
});

test('resize clamps to sane bounds and refuses garbage', () => {
  const { factory, spawned } = fakeFactory();
  const s = new PtySessions({ ptyFactory: factory });
  s.start('t', { command: 'c', env: {} });
  assert.equal(s.resize('t', 99999, 2), true);
  assert.deepEqual(spawned[0].resized, [[1000, 5]]);
  assert.equal(s.resize('t', 'abc', 10), false);
});

test('the real node-pty spawns (smoke) — including the macOS spawn-helper repair', async () => {
  const { nodePtyFactory } = await import('../src/ptySessions.js');
  const s = new PtySessions({ ptyFactory: nodePtyFactory() });
  const done = new Promise((resolve) => { s.onExit = (id, g, code) => resolve(code); });
  s.start('smoke', { command: '/bin/echo', args: ['pty-ok'], env: process.env });
  assert.equal(await done, 0);
  assert.match(s.replay('smoke').toString(), /pty-ok/);
});
