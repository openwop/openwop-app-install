/**
 * A bare `YYYY-MM-DD` renders as that calendar date in a negative-offset zone.
 *
 * THE DEFECT THIS PINS (2026-10-30, KickTodo live pass, America/Detroit).
 * `toDate` did `new Date('2026-10-30')`, which is UTC midnight, i.e. Oct 29 at
 * 20:00 in Detroit. Every date-only label rendered a day early:
 * - Plan's TODAY cell said "29 THU" for a server `dateLocal` of 2026-10-30;
 * - the week range read "Oct 29 – Nov 4";
 * - November's month header said "October";
 * - Progress history showed "Oct 29".
 * The +365 d date-bomb sweep shifts the clock, not the zone, so it cannot see this
 * class. In a UTC host this test would pass vacuously, hence the pinned zone.
 *
 * Red when (witnessed on the pre-fix format.ts): a date-only string is parsed as
 * an instant again.
 */
import { afterAll, describe, expect, it } from 'vitest';

// Pin the zone BEFORE the formatter module builds (and caches) an Intl formatter.
const hostTz = process.env.TZ;
process.env.TZ = 'America/Detroit';
afterAll(() => {
  if (hostTz === undefined) delete process.env.TZ; else process.env.TZ = hostTz;
});

const { formatDate, formatDateTime, formatRelativeTime, isDatable, UNDATED } = await import('../format.js');

describe('format: a date-only string is a calendar date (negative-offset zone)', () => {
  it('runs in a negative-offset zone (else every case below is vacuous)', () => {
    expect(new Date(2026, 9, 30).getTimezoneOffset()).toBeGreaterThan(0);
  });

  it("renders the server's dateLocal as itself, not the day before", () => {
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric' };
    expect(formatDate('2026-10-30', opts)).toBe(formatDate(new Date(2026, 9, 30), opts));
    expect(formatDate('2026-10-30', { dateStyle: 'full' })).toContain('30');
    expect(formatDate('2026-10-30', { dateStyle: 'full' })).not.toContain('29');
  });

  it('a month header for the 1st names that month', () => {
    const opts: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };
    expect(formatDate('2026-11-01', opts)).toBe(formatDate(new Date(2026, 10, 1), opts));
  });

  it("a caller's explicit timeZone cannot move a calendar date", () => {
    // DealDetailPage passes `timeZone: 'UTC'` for a date-only `dueDate`.
    expect(formatDate('2026-10-30', { dateStyle: 'medium', timeZone: 'UTC' }))
      .toBe(formatDate('2026-10-30', { dateStyle: 'medium' }));
  });

  it('a timestamp is still an instant (02:00Z on the 30th is the 29th in Detroit)', () => {
    expect(formatDate('2026-10-30T02:00:00Z', { day: 'numeric' })).toBe(formatDate(new Date(2026, 9, 29), { day: 'numeric' }));
  });

  it('date-time and relative helpers read a date-only as LOCAL midnight', () => {
    expect(formatDateTime('2026-10-30')).toBe(formatDateTime(new Date(2026, 9, 30)));
    expect(formatRelativeTime('2026-10-31', new Date(2026, 9, 30))).toBe(formatRelativeTime(new Date(2026, 9, 31), new Date(2026, 9, 30)));
  });

  it('an out-of-range date-only stays undatable instead of rolling over', () => {
    expect(isDatable('2026-13-45')).toBe(false);
    expect(formatDate('2026-02-30')).toBe(UNDATED);
  });
});
