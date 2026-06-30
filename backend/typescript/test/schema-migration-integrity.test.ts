/**
 * Migration-map integrity guard.
 *
 * The `recipient_role` notifications 500 (#935) came from a migration that was
 * DEFINED but never EXECUTED: the runner loops `current+1 … LATEST_SCHEMA_VERSION`,
 * and the cap was a separate hand-bumped literal that wasn't updated when the
 * migration was appended → the new version was silently out of range.
 *
 * `LATEST_SCHEMA_VERSION` is now DERIVED from the map (Math.max of the keys), so
 * that specific drift is structurally impossible. These tests lock the remaining
 * invariants — derived-equals-max (guards against anyone re-hardcoding it) and
 * contiguous-from-1 (a gap makes the runner throw at boot) — for BOTH backends.
 *
 * Type-only `import type { Database }` in the sqlite schema means importing it here
 * pulls in NO native dep; the migration fns are inspected, never invoked.
 */
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS as PG_MIGRATIONS,
  LATEST_SCHEMA_VERSION as PG_LATEST,
} from '../src/storage/postgres/schema.js';
import {
  MIGRATIONS as SQLITE_MIGRATIONS,
  LATEST_SCHEMA_VERSION as SQLITE_LATEST,
} from '../src/storage/sqlite/schema.js';

const versions = (map: Record<number, unknown>): number[] =>
  Object.keys(map).map(Number).sort((a, b) => a - b);

// Postgres and sqlite version NUMBERS are intentionally offset (postgres mig 23 ==
// sqlite mig 26, etc.), so we assert per-backend integrity, not cross-backend equality.
describe.each([
  ['postgres', PG_MIGRATIONS as Record<number, unknown>, PG_LATEST],
  ['sqlite', SQLITE_MIGRATIONS as Record<number, unknown>, SQLITE_LATEST],
])('migration-map integrity — %s', (_name, map, latest) => {
  const vs = versions(map);

  it('versions are contiguous from 1 (a gap makes applyMigrations throw at boot)', () => {
    expect(vs).toEqual(Array.from({ length: vs.length }, (_v, i) => i + 1));
  });

  it('LATEST_SCHEMA_VERSION equals the highest migration (no defined-but-unrun migration)', () => {
    expect(latest).toBe(vs[vs.length - 1]);
  });
});
