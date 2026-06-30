/**
 * ADR 0052 — app version recording (§D4) + the app-migration runner (§D5).
 *
 * Against the sqlite memory backend (which applies the `__app_meta` migration on
 * open): a fresh install first-records the version, an upgrade is detected from
 * the prior, and the app-migration runner applies pending migrations in order,
 * forward-only + idempotently, recording its counter.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { recordAppVersion, APP_VERSION_KEY } from '../src/host/appVersion.js';
import { runAppMigrations, APP_MIGRATION_KEY, type AppMigration } from '../src/host/appMigrations.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { APP_VERSION } from '../src/version.js';

let store: Storage | null = null;
afterEach(async () => { await store?.close(); store = null; __resetHostExtPersistence(); });

describe('ADR 0052 §D4 — app version recording', () => {
  it('first-records on a fresh install, then reports same / upgrade', async () => {
    store = openSqliteStorage(':memory:');
    // The real APP_MIGRATIONS now include the ADR 0102 profile-permission backfill,
    // which operates over a host-ext DurableCollection — wire it first (matching the
    // boot order in index.ts where initHostExtPersistence precedes recordAppVersion).
    initHostExtPersistence(store);

    const fresh = await recordAppVersion(store);
    expect(fresh.kind).toBe('first-record');
    expect(fresh.from).toBeNull();
    expect(await store.getAppMeta(APP_VERSION_KEY)).toBe(APP_VERSION);

    // Same-version boot is a no-op transition.
    expect((await recordAppVersion(store)).kind).toBe('same');

    // Simulate an instance that came from an older version.
    await store.setAppMeta(APP_VERSION_KEY, '0.0.9');
    const up = await recordAppVersion(store);
    expect(up.kind).toBe('upgrade');
    expect(up.from).toBe('0.0.9');
    expect(await store.getAppMeta(APP_VERSION_KEY)).toBe(APP_VERSION); // re-stamped to current
  });
});

describe('ADR 0052 §D5 — app-migration runner', () => {
  it('applies pending migrations in order, records the counter, and is forward-only + idempotent', async () => {
    store = openSqliteStorage(':memory:');
    const applied: number[] = [];
    const mk = (version: number): AppMigration => ({
      version, name: `m${version}`, run: async () => { applied.push(version); },
    });

    // Out-of-order input → applied ascending; counter advances to the max.
    const first = await runAppMigrations(store, [mk(2), mk(1)]);
    expect(first.applied).toEqual([1, 2]);
    expect(applied).toEqual([1, 2]);
    expect(await store.getAppMeta(APP_MIGRATION_KEY)).toBe('2');

    // Re-running the SAME set is a no-op (forward-only; counter already at 2).
    applied.length = 0;
    const second = await runAppMigrations(store, [mk(2), mk(1)]);
    expect(second.applied).toEqual([]);
    expect(applied).toEqual([]);

    // A newly-appended migration (version 3) runs; 1 and 2 do NOT re-run.
    const third = await runAppMigrations(store, [mk(1), mk(2), mk(3)]);
    expect(third.applied).toEqual([3]);
    expect(applied).toEqual([3]);
    expect(await store.getAppMeta(APP_MIGRATION_KEY)).toBe('3');
  });

  it('empty migration set is a no-op and records nothing', async () => {
    store = openSqliteStorage(':memory:');
    const r = await runAppMigrations(store, []);
    expect(r.applied).toEqual([]);
    expect(await store.getAppMeta(APP_MIGRATION_KEY)).toBeNull();
  });
});
