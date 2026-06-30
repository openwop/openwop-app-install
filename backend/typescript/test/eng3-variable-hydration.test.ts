/**
 * ENG-3 — cross-instance run-state hydration (variable bag durability).
 *
 * The per-run variable bag (`variablesRuntime.ts`) is an in-process Map that
 * write-throughs to durable `Storage` kv. When the dispatch sweeper re-runs a
 * crashed run on ANOTHER instance, that instance's in-memory Map is empty —
 * the executor calls `hydrateRunVariables(runId)` first so the bag is reloaded
 * from storage instead of running with an empty bag.
 *
 * This test simulates the cross-instance hand-off WITHOUT spinning a second
 * process: write the bag through one path, drop the in-memory cache (the state
 * a fresh instance starts in), then hydrate from the SAME backing storage and
 * assert every value survives.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { _setDurableStorageForTesting } from '../src/host/durable/durableKv.js';
import {
  seedRunVariables,
  setRunVariable,
  snapshotRunVariables,
  hydrateRunVariables,
  clearRunVariables,
  __resetAllRunVariablesForTests,
} from '../src/host/variablesRuntime.js';

let storage: Storage;

/** Let the fire-and-forget write-through (persistBag) flush to storage. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(async () => {
  storage = await openStorage('memory://');
  _setDurableStorageForTesting(storage);
  __resetAllRunVariablesForTests();
});

afterEach(() => {
  _setDurableStorageForTesting(null);
  __resetAllRunVariablesForTests();
});

describe('ENG-3 variable-bag hydration across instances', () => {
  it('a seeded bag survives a cache clear + hydrate from storage', async () => {
    const runId = 'run-hydrate-1';
    seedRunVariables(
      runId,
      [
        { name: 'greeting', defaultValue: 'hi' },
        { name: 'count', defaultValue: 0 },
        { name: 'overridden', defaultValue: 'default' },
      ],
      // `extra` has no matching variable decl, so it is ignored (not seeded).
      { overridden: 'from-inputs', extra: 'ignored-no-decl' },
    );
    await flush();

    // Sanity: precedence applied in the live cache; undeclared inputs dropped.
    expect(snapshotRunVariables(runId)).toEqual({
      greeting: 'hi',
      count: 0,
      overridden: 'from-inputs',
    });

    // Simulate "another instance": no in-memory bag for this run.
    __resetAllRunVariablesForTests();
    expect(snapshotRunVariables(runId)).toBeNull();

    // Hydrate from the durable backing store and assert the values survived.
    await hydrateRunVariables(runId);
    expect(snapshotRunVariables(runId)).toEqual({
      greeting: 'hi',
      count: 0,
      overridden: 'from-inputs',
    });
  });

  it('mid-run setRunVariable writes are visible after a cross-instance hydrate', async () => {
    const runId = 'run-hydrate-2';
    seedRunVariables(runId, [{ name: 'a', defaultValue: 1 }], {});
    setRunVariable(runId, 'b', { nested: true });
    setRunVariable(runId, 'a', 99); // mutate the seeded value
    await flush();

    __resetAllRunVariablesForTests();
    await hydrateRunVariables(runId);

    expect(snapshotRunVariables(runId)).toEqual({ a: 99, b: { nested: true } });
  });

  it('hydrate does NOT clobber a live (already-cached) bag — the live bag wins', async () => {
    const runId = 'run-hydrate-3';
    seedRunVariables(runId, [{ name: 'x', defaultValue: 'stored' }], {});
    await flush();

    // Live instance mutated x after the persisted snapshot was taken... but for
    // this test we assert hydrate is a no-op when the run is already cached.
    setRunVariable(runId, 'x', 'live-value');
    await hydrateRunVariables(runId); // run is in the cache ⇒ early-return, no reload
    expect(snapshotRunVariables(runId)).toEqual({ x: 'live-value' });
  });

  it('hydrate of an unknown run is a no-op (nothing persisted)', async () => {
    await hydrateRunVariables('run-never-seeded');
    expect(snapshotRunVariables('run-never-seeded')).toBeNull();
  });

  it('clearRunVariables removes the persisted bag so a later hydrate finds nothing', async () => {
    const runId = 'run-hydrate-4';
    seedRunVariables(runId, [{ name: 'k', defaultValue: 'v' }], {});
    await flush();

    clearRunVariables(runId);
    await flush();

    // New instance: empty cache, and storage no longer has the row.
    __resetAllRunVariablesForTests();
    await hydrateRunVariables(runId);
    expect(snapshotRunVariables(runId)).toBeNull();
  });

  it('without a durable storage handle, hydrate degrades to in-memory-only (no crash)', async () => {
    _setDurableStorageForTesting(null);
    const runId = 'run-hydrate-5';
    seedRunVariables(runId, [{ name: 'k', defaultValue: 'v' }], {}); // persist is a no-op
    // Live cache still works in-process.
    expect(snapshotRunVariables(runId)).toEqual({ k: 'v' });
    // After a cache clear there is nothing to hydrate from — but it must not throw.
    __resetAllRunVariablesForTests();
    await expect(hydrateRunVariables(runId)).resolves.toBeUndefined();
    expect(snapshotRunVariables(runId)).toBeNull();
  });
});
