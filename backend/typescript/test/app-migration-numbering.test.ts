/**
 * APP_MIGRATIONS numbering is 1..N, unique and contiguous, in array order (ADR 1034).
 *
 * The app-migration runner applies every entry ABOVE the recorded counter. So if two PRs
 * each add "the next" number and one lands out of order — or a merge leaves two entries on
 * one number — the lower entry is skipped forever on every host that already recorded the
 * higher one, with no error anywhere. ADR 1034 ships entries 25 and 26 (partner-token and
 * geocode re-keys); a skipped 25 would leave plaintext partner tokens at rest.
 *
 * Red when: two entries share a version or a name, a number is skipped, or the array is
 * not in version order.
 */
import { describe, expect, it } from 'vitest';
import { APP_MIGRATIONS } from '../src/host/appMigrations.js';

describe('APP_MIGRATIONS numbering', () => {
  it('is exactly 1..N in array order, with unique names', () => {
    expect(APP_MIGRATIONS.length).toBeGreaterThanOrEqual(26); // anti-vacuity: ADR 1034's 25 + 26 are in
    expect(APP_MIGRATIONS.map((m) => m.version)).toEqual(APP_MIGRATIONS.map((_, i) => i + 1));
    expect(new Set(APP_MIGRATIONS.map((m) => m.name)).size).toBe(APP_MIGRATIONS.length);
  });
});
