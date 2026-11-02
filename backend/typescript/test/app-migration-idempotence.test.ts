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
 *
 * §THE SECOND WAY IT WAS WRONG (w66 grade). Run against EMPTY storage, nearly every
 * migration took its "nothing to do" path both times, so "survives a second
 * execution" was measured only where there was nothing to execute: a migration
 * that threw on finding its OWN earlier write stayed green (w66 idem-silent). The
 * store is now seeded with one triggering row per data-driven migration (a CRM
 * contact → 23; a strategy record and a priority-matrix list → 24; a legacy
 * unstamped user → 20), so the second execution meets the rows the first one
 * wrote, and the rows those migrations write must be byte-identical after the
 * second run. The advisory board is deliberately NOT seeded, so migration 24 also
 * takes its "not in use" branch on both executions (seeding all three hid that
 * branch: w66 idem-rerun-r2 read vacuous).
 *
 * TST-BXB-3 (MIG-LOCK-1). Red when: a shipped migration throws on a re-run over
 * its own output (idem-rerun, idem-silent), the runner re-applies the recorded
 * version (idem-filter), or records a counter other than the latest (idem-counter).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  runAppMigrations, APP_MIGRATIONS, latestAppMigration, APP_MIGRATION_KEY,
} from '../src/host/appMigrations.js';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { User } from '../src/features/users/usersService.js';
import type { Storage } from '../src/storage/storage.js';

async function freshStorage(): Promise<Storage> {
  const s = await openStorage('memory://');
  // The real boot order (`index.ts:183`) — migrations read host-ext collections, so
  // without this every migration throws and the assertions below would be measuring
  // a crash rather than idempotency.
  initHostExtPersistence(s);
  return s;
}

/** The keys the seeded migrations WRITE — compared byte-for-byte across the re-run. */
const WRITTEN_KEYS = [
  'hostext:feature-toggle:crm',
  'hostext:feature-toggle:strategy',
  'hostext:feature-toggle:priority-matrix',
];
/** Left unseeded on purpose: migration 24's not-in-use branch must run (and stay a no-op). */
const UNSEEDED_TOGGLE = 'hostext:feature-toggle:advisory-board';

/** One triggering row per data-driven migration, so each takes its WRITE path. */
async function seedTriggers(s: Storage): Promise<void> {
  await s.kvSet('hostext:crm:contact:c-idem', JSON.stringify({ contactId: 'c-idem', tenantId: 'user:idem' }));
  await s.kvSet('hostext:strategy:record:r-idem', JSON.stringify({ id: 'r-idem', tenantId: 'user:idem' }));
  await s.kvSet('hostext:priority-matrix:list:l-idem', JSON.stringify({ id: 'l-idem', tenantId: 'user:idem' }));
  const legacyUser: User = {
    userId: 'user:idem-legacy', tenantId: 'ws:idem', principalId: 'saml:idem-legacy', groups: [],
    source: 'saml', status: 'active', email: 'idem@acme.test',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await new DurableCollection<User>('users:user', (u) => u.userId).put(legacyUser);
}

describe('the real APP_MIGRATIONS set is concurrency-safe', () => {
  let storage: Storage;
  beforeEach(async () => { storage = await freshStorage(); });

  it('fixture guard: there is a non-empty migration set to exercise', () => {
    // Without this the file passes vacuously on an empty array — the exact way a
    // gate stops gating.
    // MEASURED at 9a982be0b: 24 migrations (versions 1-24). A floor, so a new
    // migration does not red it; far below it the loop below would be guarding
    // a set that has silently shrunk.
    expect(APP_MIGRATIONS.length).toBeGreaterThanOrEqual(24);
  });

  it('every migration run() survives a SECOND execution against the same storage', async () => {
    // THE property. The version guard does not provide it; concurrent instances all
    // execute `run()`, so each must tolerate running twice — over the rows it wrote.
    await seedTriggers(storage);
    for (const m of APP_MIGRATIONS) {
      await m.run(storage);
      const afterFirst = await Promise.all(WRITTEN_KEYS.map((k) => storage.kvGet(k)));
      await expect(
        m.run(storage),
        `migration ${m.version} (${m.name}) failed on a second execution — not concurrency-safe`,
      ).resolves.toBeUndefined();
      expect(
        await Promise.all(WRITTEN_KEYS.map((k) => storage.kvGet(k))),
        `migration ${m.version} (${m.name}) rewrote a row on its second execution`,
      ).toEqual(afterFirst);
    }
    // Non-vacuity: the seeds really drove the write paths.
    for (const k of WRITTEN_KEYS) expect(await storage.kvGet(k), `${k} was written by the first execution`).not.toBeNull();
    // ...and the unseeded feature took the not-in-use branch both times, writing nothing.
    expect(await storage.kvGet(UNSEEDED_TOGGLE)).toBeNull();
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
