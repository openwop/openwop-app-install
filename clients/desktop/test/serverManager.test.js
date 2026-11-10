// ADR 0181 Phase E / ADR 0182 Phase 4 — "owns what it starts": the desktop stops
// only processes it spawned, and an already-running backend is adopted and left
// alone on quit. Not in `npm run ci`: run `npm test` in clients/desktop.
//
// Sabotage that turns it red (each probed): spawning without the args, skipping
// adoption, not recording ownership, the idempotence check, the signal, keeping
// the entry after stop (Start would then be a no-op forever), stopping one of many.
// Double guard, an equivalent mutant: an adopted entry stores `child: null` AND
// `owned: false`, so `entry.owned` in stop() cannot be probed alone, and a hold on
// `child` reds "ensure() adopts" by itself. The adopted half therefore witnesses
// "spawned nothing, kept no entry".

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
  assert.deepEqual(spawned.map(({ cmd, args }) => [cmd, args]), [['openwop-app-backend', ['--port', '8000']]]);
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
  let spawns = 0;
  const m = new ManagedProcesses({ spawnFn: () => { spawns++; return owned; }, isRunningFn: async () => false });
  await m.ensure('backend', 'x');
  m.stop('backend');
  assert.equal(owned.killed, true);
  assert.equal(owned.sig, 'SIGTERM');
  assert.equal(m.isOwned('backend'), false);
  // The menu's Stop then Start: the entry is gone, so Start spawns again.
  assert.deepEqual(await m.ensure('backend', 'x'), { started: true, adopted: false });
  assert.equal(spawns, 2);

  let adoptedSpawns = 0;
  const adoptedMgr = new ManagedProcesses({ spawnFn: () => { adoptedSpawns++; return fakeChild(); }, isRunningFn: async () => true });
  await adoptedMgr.ensure('shim', 'y');
  adoptedMgr.stop('shim'); // must not throw; nothing to kill
  assert.equal(adoptedMgr.isOwned('shim'), false);
  assert.equal(adoptedSpawns, 0);
  // No entry left either: a later ensure probes again and re-adopts.
  assert.deepEqual(await adoptedMgr.ensure('shim', 'y'), { started: false, adopted: true });
});

test('stopAll() tears down every owned process', async () => {
  const a = fakeChild(); const b = fakeChild();
  const kids = [a, b];
  let i = 0;
  const m = new ManagedProcesses({ spawnFn: () => kids[i++], isRunningFn: async (key) => key === 'adopted' });
  await m.ensure('backend', 'x');
  await m.ensure('adopted', 'z');
  await m.ensure('shim', 'y');
  m.stopAll();
  assert.equal(a.killed, true);
  assert.equal(b.killed, true);
  assert.equal(i, 2); // the adopted key spawned nothing
  assert.deepEqual([...m.owned.keys()], []);
});
