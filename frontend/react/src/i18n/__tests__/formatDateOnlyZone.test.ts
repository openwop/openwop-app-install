/**
 * A bare `YYYY-MM-DD` renders as that calendar date in a negative-offset zone.
 *
 * THE DEFECT THIS GUARDS (incident fix #5406, cfbdc09ac, 2026-10-30, KickTodo live
 * pass, America/Detroit). `toDate` did `new Date('2026-10-30')`, which is UTC
 * midnight, i.e. Oct 29 at 20:00 in Detroit. Every date-only label rendered a day
 * early:
 * - Plan's TODAY cell said "29 THU" for a server `dateLocal` of 2026-10-30;
 * - the week range read "Oct 29 – Nov 4";
 * - November's month header said "October";
 * - Progress history showed "Oct 29".
 * The +365 d date-bomb sweep shifts the clock, not the zone, so it cannot see this
 * class. In a UTC host this test would pass vacuously, hence the pinned zone.
 *
 * Expectations are literals for the `en` locale (pinned below), never values
 * computed by the formatter under test.
 *
 * DOUBLE GUARD (both in `src/i18n/format.ts`): `formatDate` has its own date-only
 * branch (formats `Date.UTC(y, m, d)` in `timeZone: 'UTC'`), and `toDate` returns
 * LOCAL midnight. With no caller zone either one alone renders the right day, so
 * the plain `formatDate` cases go red only when BOTH are broken (held-pair probe:
 * hold the branch off, break `toDate`). The explicit-zone case uses
 * `Pacific/Honolulu` (UTC−10) so the branch alone is witnessed: a caller zone
 * that wins, or the branch turned off, renders Oct 29 there.
 *
 * Red when (witnessed 2026-11-03): `toDate` parses a date-only as an instant again
 * (date-time / relative case); an out-of-range part rolls over; the date-only
 * pattern loses its `$` anchor (timestamp case); the caller's `timeZone` wins over
 * the forced UTC, or the date-only branch is skipped (explicit-zone case).
 */
import { afterAll, describe, expect, it } from 'vitest';

// Pin the zone BEFORE the formatter module builds (and caches) an Intl formatter.
const hostTz = process.env.TZ;
process.env.TZ = 'America/Detroit';
afterAll(() => {
  if (hostTz === undefined) delete process.env.TZ; else process.env.TZ = hostTz;
});

const { formatDate, formatDateTime, formatRelativeTime, isDatable, setFormatLocale, UNDATED } = await import('../format.js');
setFormatLocale('en');

describe('format: a date-only string is a calendar date (negative-offset zone)', () => {
  it('runs in a negative-offset zone (else every case below is vacuous)', () => {
    expect(new Date(2026, 9, 30).getTimezoneOffset()).toBeGreaterThan(0);
  });

  it("renders the server's dateLocal as itself, not the day before", () => {
    expect(formatDate('2026-10-30', { weekday: 'short', day: 'numeric' })).toBe('30 Fri');
    expect(formatDate('2026-10-30', { dateStyle: 'full' })).toBe('Friday, October 30, 2026');
  });

  it('a month header for the 1st names that month', () => {
    expect(formatDate('2026-11-01', { month: 'long', year: 'numeric' })).toBe('November 2026');
  });

  it("a caller's explicit timeZone cannot move a calendar date", () => {
    // DealDetailPage passes `timeZone: 'UTC'` for a date-only `dueDate`.
    expect(formatDate('2026-10-30', { dateStyle: 'medium', timeZone: 'UTC' })).toBe('Oct 30, 2026');
    // A zone west of the host's: if the caller's zone won, this would read Oct 29.
    expect(formatDate('2026-10-30', { dateStyle: 'medium', timeZone: 'Pacific/Honolulu' })).toBe('Oct 30, 2026');
  });

  it('a timestamp is still an instant (02:00Z on the 30th is the 29th in Detroit)', () => {
    expect(formatDate('2026-10-30T02:00:00Z', { day: 'numeric' })).toBe('29');
  });

  it('date-time and relative helpers read a date-only as LOCAL midnight', () => {
    expect(formatDateTime('2026-10-30')).toBe('Oct 30, 2026, 12:00 AM');
    expect(formatRelativeTime('2026-10-31', new Date(2026, 9, 30))).toBe('tomorrow');
  });

  it('an out-of-range date-only stays undatable instead of rolling over', () => {
    expect(isDatable('2026-13-45')).toBe(false);
    expect(formatDate('2026-02-30')).toBe(UNDATED);
  });
});
