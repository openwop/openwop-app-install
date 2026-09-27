'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ManagedProcesses } = require('../src/serverManager.js');

function fakeChild() {
  return { killed: false, kill(sig) { this.killed = true; this.sig = sig; } };
}

test('ensure() spawns + owns when not already running', async () => {
  const spawned = [];
  const m = new ManagedProcesses({
    spawnFn: (cmd, args) => { const c = fakeChild(); spawned.push({ cmd, args, c }); return c; },
    isRunningFn: async () => false,
  });
  const r = await m.ensure('backend', 'openwop-app-backend', ['--port', '8000']);
  assert.deepEqual(r, { started: true, adopted: false });
  assert.equal(m.isOwned('backend'), true);
  assert.equal(spawned.length, 1);
});

test('ensure() adopts (does not spawn or own) when already running', async () => {
  let spawnCalls = 0;
  const m = new ManagedProcesses({
    spawnFn: () => { spawnCalls++; return fakeChild(); },
    isRunningFn: async () => true,
  });
  const r = await m.ensure('backend', 'x');
  assert.deepEqual(r, { started: false, adopted: true });
  assert.equal(m.isOwned('backend'), false);
  assert.equal(spawnCalls, 0);
});

test('ensure() is idempotent for the same key', async () => {
  let spawnCalls = 0;
  const m = new ManagedProcesses({ spawnFn: () => { spawnCalls++; return fakeChild(); }, isRunningFn: async () => false });
  await m.ensure('backend', 'x');
  const second = await m.ensure('backend', 'x');
  assert.deepEqual(second, { started: false, adopted: false });
  assert.equal(spawnCalls, 1);
});

test('stop() kills an owned process but NOT an adopted one', async () => {
  const owned = fakeChild();
  const m = new ManagedProcesses({ spawnFn: () => owned, isRunningFn: async () => false });
  await m.ensure('backend', 'x');
  m.stop('backend');
  assert.equal(owned.killed, true);
  assert.equal(owned.sig, 'SIGTERM');

  const adoptedMgr = new ManagedProcesses({ spawnFn: () => fakeChild(), isRunningFn: async () => true });
  await adoptedMgr.ensure('shim', 'y');
  adoptedMgr.stop('shim'); // must not throw; nothing to kill
  assert.equal(adoptedMgr.isOwned('shim'), false);
});

test('stopAll() tears down every owned process', async () => {
  const a = fakeChild(); const b = fakeChild();
  const kids = [a, b];
  let i = 0;
  const m = new ManagedProcesses({ spawnFn: () => kids[i++], isRunningFn: async () => false });
  await m.ensure('backend', 'x');
  await m.ensure('shim', 'y');
  m.stopAll();
  assert.equal(a.killed, true);
  assert.equal(b.killed, true);
});
