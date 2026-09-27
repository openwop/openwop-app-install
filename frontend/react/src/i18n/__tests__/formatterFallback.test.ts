/**
 * The date formatters must never be able to blank a page.
 *
 * `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat` throw a `RangeError` on an
 * unparseable date. Thrown inside a render, that unmounts the React tree — so a
 * single malformed timestamp from the store takes the whole page with it, and
 * the largest caller cluster is the dashboard tiles on the ALWAYS-ON home route.
 *
 * The app's default posture is to fail LOUDLY (DESIGN.md §4.6): a silent
 * fallback that hides a real failure is a trap. These helpers are the
 * deliberate exception, because of WHERE the loudness lands — at the customer,
 * as a blank screen, which no one can act on. The loudness is moved here
 * instead: this file is the thing that fails when the fallback is removed.
 *
 * Found the hard way — ADR 0519's new collection cells rendered `updatedAt` and
 * crashed the Email hub in an unrelated existing test.
 */
import { describe, it, expect } from 'vitest';
import {
  formatDate, formatTime, formatDateTime, formatRelativeTime, isDatable, UNDATED,
} from '../format.js';

/** Values a store can plausibly hand a cell. `''` and `undefined` are the
 *  common ones; the ISO-shaped garbage is the case truthiness checks miss. */
const UNPARSEABLE: unknown[] = [
  undefined, null, '', 'not-a-date', 'soon', '0000-00-00T00:00:00Z', NaN, {}, [],
];

describe('date formatters degrade instead of throwing', () => {
  for (const bad of UNPARSEABLE) {
    it(`survives ${JSON.stringify(bad) ?? String(bad)}`, () => {
      const v = bad as Date | string | number;
      expect(() => formatDate(v)).not.toThrow();
      expect(() => formatTime(v)).not.toThrow();
      expect(() => formatDateTime(v)).not.toThrow();
      expect(() => formatRelativeTime(v)).not.toThrow();
      expect(formatDate(v)).toBe(UNDATED);
      expect(formatRelativeTime(v)).toBe(UNDATED);
    });
  }

  it('still formats a real date normally', () => {
    const iso = '2026-06-18T12:00:00Z';
    expect(formatDate(iso)).not.toBe(UNDATED);
    expect(formatDateTime(iso)).not.toBe(UNDATED);
    expect(formatRelativeTime(iso, '2026-06-18T12:02:00Z')).toBe('2 minutes ago');
  });

  it('a malformed `now` cannot break a valid value either', () => {
    // `now` is usually defaulted, but a caller can pass one — and a bad `now`
    // would throw on the SUBTRACTION path, before any formatting.
    expect(() => formatRelativeTime('2026-06-18T12:00:00Z', 'garbage')).not.toThrow();
  });
});

describe('isDatable is the caller-side half', () => {
  it('rejects everything the formatters fall back on', () => {
    for (const bad of UNPARSEABLE) expect(isDatable(bad)).toBe(false);
  });

  it('accepts the three shapes the formatters take', () => {
    expect(isDatable('2026-06-18T12:00:00Z')).toBe(true);
    expect(isDatable(1750248000000)).toBe(true);
    expect(isDatable(new Date())).toBe(true);
  });
});
