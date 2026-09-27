/**
 * MIG-LOCK-1 — every app migration must survive a SECOND execution.
 *
 * `runAppMigrations` (`appMigrations.ts`) is a bare read-then-write: `getAppMeta` →
 * run pending → `setAppMeta`. There is **no lock and no CAS** — `Storage` exposes
 * neither. Cloud Run boots several instances at once on a deploy, so they all read
 * the same recorded version, all see the same pending set, and all execute it.
 *
 * The recorded version dedupes SEQUENTIAL boots. It does **nothing** for concurrent
 * ones. So the property that actually protects production is that each migration's
 * `run()` is itself safe to execute twice — true so far only by luck, enforced here.
 *
 * A lock was considered and REJECTED (see the `AppMigration.run` docstring): it needs
 * a new `Storage` primitive across both adapters, and covers only the concurrent-boot
 * case, whereas idempotency also covers retries, partial failure and a manual re-run.
 *
 * §HOW THIS TEST WAS WRONG FIRST — kept, because the fix is the point.
 * The original asserted `Promise.all([runAppMigrations(s), runAppMigrations(s)])`.
 * That is VACUOUS: with in-memory storage the first runner completes before the
 * second's read resolves, so it measured two SEQUENTIAL runs and proved only that the
 * version guard works. Injecting a deliberately non-idempotent migration into the
 * real `APP_MIGRATIONS` did not redden it — the sabotage probe is what caught that.
 *
 * It exercises the REAL `APP_MIGRATIONS` array, not a fixture; a synthetic set would
 * assert nothing about the migrations that actually ship.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  runAppMigrations, APP_MIGRATIONS, latestAppMigration, APP_MIGRATION_KEY,
} from '../src/host/appMigrations.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';

async function freshStorage(): Promise<Storage> {
  const s = await openStorage('memory://');
  // The real boot order (`index.ts:183`) — migrations read host-ext collections, so
  // without this every migration throws and the assertions below would be measuring
  // a crash rather than idempotency.
  initHostExtPersistence(s);
  return s;
}

describe('the real APP_MIGRATIONS set is concurrency-safe', () => {
  let storage: Storage;
  beforeEach(async () => { storage = await freshStorage(); });

  it('fixture guard: there is a non-empty migration set to exercise', () => {
    // Without this the file passes vacuously on an empty array — the exact way a
    // gate stops gating.
    expect(APP_MIGRATIONS.length).toBeGreaterThan(5);
  });

  it('every migration run() survives a SECOND execution against the same storage', async () => {
    // THE property. The version guard does not provide it; concurrent instances all
    // execute `run()`, so each must tolerate running twice.
    for (const m of APP_MIGRATIONS) {
      await m.run(storage);
      await expect(
        m.run(storage),
        `migration ${m.version} (${m.name}) failed on a second execution — not concurrency-safe`,
      ).resolves.toBeUndefined();
    }
  });

  it('running the whole set twice leaves the same recorded version', async () => {
    await runAppMigrations(storage);
    const after1 = await storage.getAppMeta(APP_MIGRATION_KEY);
    await runAppMigrations(storage);
    expect(await storage.getAppMeta(APP_MIGRATION_KEY)).toBe(after1);
    expect(Number(after1)).toBe(latestAppMigration(APP_MIGRATIONS));
  });

  it('a sequential re-run after a completed pass applies nothing', async () => {
    const first = await runAppMigrations(storage);
    expect(first.applied.length).toBeGreaterThan(0);
    const second = await runAppMigrations(storage);
    expect(second.applied).toEqual([]);
  });
});
