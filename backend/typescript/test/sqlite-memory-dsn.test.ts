/**
 * H18 — `openSqliteStorage('memory://')` must not create a FILE named `memory:`.
 *
 * `openStorage()` maps the in-memory DSNs correctly, so the app path was never
 * affected; the hazard was DIRECT callers (e.g. `test/egress-policy.unit.test.ts`)
 * handing the DSN to `openSqliteStorage`, where `resolve('memory://')` normalises
 * to `<cwd>/memory:` and a real sqlite database appears under that name.
 *
 * Why it matters beyond tidiness: ADR 0551 P1 caught a stale on-disk `memory:`
 * DB stamped at a migration number that a later renumber reused — so the real
 * migration at that number was SKIPPED and the DB reported itself fully
 * migrated. An in-memory database cannot go stale.
 *
 * The file-creation assertions run under a THROWAWAY cwd, because a cwd-relative
 * `resolve()` is precisely the defect — the cwd is the probe, not incidental
 * setup. It is restored in a `finally`. Every storage a case opens is closed
 * before the case ends (a still-open `plain.db` handle used to be live when its
 * directory was removed).
 *
 * DOUBLE GUARD (named, /grade-tests wave 61): `sqlite://:memory:` is mapped by
 * its own line in `resolveSqliteTarget` AND by the `sqlite://` branch, which
 * strips the scheme and compares the rest with the sentinel. Deleting either
 * alone still yields `:memory:` (8fw3g1-sql-sqlitememory, vacuous by design);
 * the `memory://` and unknown-scheme mappings are witnessed (8fw3g1-sql-*).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage, resolveSqliteTarget } from '../src/storage/sqlite/index.js';
import { openStorage } from '../src/storage/index.js';

/** Run `fn` with cwd pointed at a throwaway dir; report what it left behind. */
async function inScratchCwd(fn: () => Promise<void> | void): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'owp-sqlite-dsn-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    await fn();
    return readdirSync(dir).sort();
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('sqlite in-memory DSN handling (H18)', () => {
  it('memory:// creates NO file on disk', async () => {
    const leftBehind = await inScratchCwd(async () => {
      const storage = openSqliteStorage('memory://');
      // Write something: an unused handle could plausibly defer file creation,
      // and this test must fail for the right reason.
      await storage.kvSet('h18', 'in-memory');
      expect(await storage.kvGet('h18')).toBe('in-memory');
      // The literal name the defect produced, checked against the scratch cwd.
      expect(existsSync('memory:')).toBe(false);
      await storage.close();
    });
    expect(leftBehind).toEqual([]);
  });

  it('memory:// behaves as in-memory — two opens are independent', async () => {
    const a = openSqliteStorage('memory://');
    const b = openSqliteStorage('memory://');
    await a.kvSet('h18:independence', 'a');
    expect(await a.kvGet('h18:independence')).toBe('a');
    // A shared FILE would make this visible in `b`; a private `:memory:` cannot.
    expect(await b.kvGet('h18:independence')).toBeNull();
    await a.close();
    await b.close();
  });

  it('every in-memory spelling normalises to the sqlite sentinel', () => {
    expect(resolveSqliteTarget(':memory:')).toBe(':memory:');
    expect(resolveSqliteTarget('memory://')).toBe(':memory:');
    expect(resolveSqliteTarget('sqlite://:memory:')).toBe(':memory:');
  });

  it('an unknown URL scheme throws instead of becoming a filename', async () => {
    expect(() => resolveSqliteTarget('postgres://user@host/db')).toThrow(
      /unsupported DSN scheme "postgres:\/\/"/,
    );
    const leftBehind = await inScratchCwd(() => {
      expect(() => openSqliteStorage('postgres://user@host/db')).toThrow(/unsupported DSN scheme/);
      expect(() => openSqliteStorage('redis://localhost')).toThrow(/unsupported DSN scheme/);
    });
    expect(leftBehind).toEqual([]);
  });

  it('a plain path is still a path, and sqlite:// still means that path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-sqlite-path-'));
    try {
      const plain = join(dir, 'plain.db');
      expect(resolveSqliteTarget(plain)).toBe(plain);
      expect(resolveSqliteTarget(`sqlite://${plain}`)).toBe(plain);
      const storage = openSqliteStorage(plain);
      await storage.kvSet('h18:durable', 'yes');
      expect(existsSync(plain)).toBe(true);
      await storage.close();
      // Durable: a second open of the same path sees the first open's write,
      // after the first handle is CLOSED (so the read is not a shared handle's).
      const reopened = openSqliteStorage(plain);
      expect(await reopened.kvGet('h18:durable')).toBe('yes');
      await reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('openStorage() routing is unchanged by the normalisation', async () => {
    const leftBehind = await inScratchCwd(async () => {
      const viaDsn = await openStorage('memory://');
      const viaSentinel = await openStorage(':memory:');
      await viaDsn.kvSet('h18:routing', 'dsn');
      expect(await viaSentinel.kvGet('h18:routing')).toBeNull();
      await viaDsn.close();
      await viaSentinel.close();
    });
    expect(leftBehind).toEqual([]);
  });
});
