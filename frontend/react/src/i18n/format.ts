/**
 * Locale-aware formatting layer (ADR 0065).
 *
 * The single home for every date / time / relative-time / number / currency /
 * percent / unit / byte / list rendering. All output is bound to the active
 * locale via the native `Intl` APIs — NO hand-rolled `toFixed`,
 * `toLocaleString()`, or `'$' +` formats in UI code. The active locale is kept
 * in sync with i18next by a `languageChanged` listener in `index.ts`.
 *
 * `Intl.*` constructors are expensive, so formatters are memoized per
 * (locale + options) key and reused; the cache clears on locale change.
 */

import { DEFAULT_LOCALE } from './locales.js';

let activeLocale: string = DEFAULT_LOCALE;

/** Update the locale all formatters resolve against. Called by the i18next bridge. */
export function setFormatLocale(locale: string): void {
  if (locale && locale !== activeLocale) {
    activeLocale = locale;
    cache.clear();
  }
}

/** The locale formatters currently resolve against. */
export function getFormatLocale(): string {
  return activeLocale;
}

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.ListFormat>();

function keyed<T>(kind: string, options: unknown, make: () => T): T {
  const key = `${activeLocale}|${kind}|${JSON.stringify(options ?? {})}`;
  const hit = cache.get(key);
  if (hit) return hit as T;
  const made = make();
  cache.set(key, made as never);
  return made;
}

function numberFmt(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return keyed('num', options, () => new Intl.NumberFormat(activeLocale, options));
}
function dateFmt(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return keyed('date', options, () => new Intl.DateTimeFormat(activeLocale, options));
}
function relativeFmt(options?: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return keyed('rel', options, () => new Intl.RelativeTimeFormat(activeLocale, { numeric: 'auto', ...options }));
}
function listFmt(options?: Intl.ListFormatOptions): Intl.ListFormat {
  return keyed('list', options, () => new Intl.ListFormat(activeLocale, options));
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Locale-grouped number, e.g. `1,234,567` (en) / `1.234.567` (de). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return numberFmt(options).format(value);
}

/** Currency amount; symbol/separators/placement localize, the amount stays in `currency`. */
export function formatCurrency(value: number, currency = 'USD', options?: Intl.NumberFormatOptions): string {
  return numberFmt({ style: 'currency', currency, ...options }).format(value);
}

/** Percentage from a 0–1 ratio, e.g. `formatPercent(0.42)` → `42%`. */
export function formatPercent(ratio: number, options?: Intl.NumberFormatOptions): string {
  return numberFmt({ style: 'percent', ...options }).format(ratio);
}

/** Date only (medium by default), locale-ordered. */
export function formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
  return dateFmt(options ?? { dateStyle: 'medium' }).format(toDate(value));
}

/** Time only. 12/24-hour follows the locale unless overridden. */
export function formatTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
  return dateFmt(options ?? { timeStyle: 'short' }).format(toDate(value));
}

/** Combined date + time, locale-ordered. */
export function formatDateTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
  return dateFmt(options ?? { dateStyle: 'medium', timeStyle: 'short' }).format(toDate(value));
}

/** Human relative time from now (`"in 3 days"`, `"5 minutes ago"`). Past is negative. */
export function formatRelativeTime(value: Date | string | number, now: Date | string | number = new Date()): string {
  const deltaMs = toDate(value).getTime() - toDate(now).getTime();
  const sec = deltaMs / 1000;
  const abs = Math.abs(sec);
  const fmt = relativeFmt();
  if (abs < 60) return fmt.format(Math.round(sec), 'second');
  if (abs < 3600) return fmt.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return fmt.format(Math.round(sec / 3600), 'hour');
  if (abs < 2592000) return fmt.format(Math.round(sec / 86400), 'day');
  if (abs < 31536000) return fmt.format(Math.round(sec / 2592000), 'month');
  return fmt.format(Math.round(sec / 31536000), 'year');
}

/** A grammatical list, e.g. `"A, B, and C"` (en) — conjunctions localize. */
export function formatList(items: string[], options?: Intl.ListFormatOptions): string {
  return listFmt(options).format(items);
}

/** A byte count in the locale's number format, e.g. `"1.4 kB"`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return numberFmt({ style: 'unit', unit: 'byte', unitDisplay: 'narrow' }).format(bytes);
  const kb = bytes / 1024;
  if (kb < 1024) {
    return numberFmt({ style: 'unit', unit: 'kilobyte', unitDisplay: 'short', maximumFractionDigits: 1 }).format(kb);
  }
  return numberFmt({ style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 1 }).format(kb / 1024);
}

/** A short duration in seconds, e.g. `"1.5 sec"` — unit label localizes. */
export function formatDurationSeconds(seconds: number, fractionDigits = 1): string {
  return numberFmt({ style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: fractionDigits }).format(seconds);
}

/** A short duration given in milliseconds, rendered in seconds. */
export function formatDurationMs(ms: number, fractionDigits = 1): string {
  return formatDurationSeconds(ms / 1000, fractionDigits);
}

/** The whole API as one object — handy for `const f = useFormat()`. */
export const format = {
  number: formatNumber,
  currency: formatCurrency,
  percent: formatPercent,
  date: formatDate,
  time: formatTime,
  dateTime: formatDateTime,
  relativeTime: formatRelativeTime,
  list: formatList,
  bytes: formatBytes,
  durationSeconds: formatDurationSeconds,
  durationMs: formatDurationMs,
} as const;

export type Formatter = typeof format;
