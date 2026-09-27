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

/**
 * True when `value` parses to a real instant.
 *
 * DESIGN.md §4.5 rule 10 — "if the store can't date it, the UI doesn't claim
 * it" — needs a way to ASK, so a cell with no timestamp can render NOTHING
 * rather than a stray `UNDATED` glyph where a real time belongs.
 *
 * This is the caller's half of a two-layer guard. The formatters below no
 * longer throw (they fall back to `UNDATED` — see `guardDate`), so skipping
 * this check is no longer fatal; it is merely less honest. Ask here when the
 * field is genuinely optional; rely on the fallback only for data that is
 * supposed to be there and isn't.
 */
export function isDatable(value: unknown): boolean {
  if (value == null || value === '') return false;
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return false;
  return Number.isFinite(toDate(value).getTime());
}

/**
 * What a date formatter renders when its input cannot be parsed. The app
 * already uses this glyph for "no value" in data cells (funnel conversion,
 * experiment verdicts), so it reads as absence rather than as a wrong answer.
 */
export const UNDATED = '—';

/**
 * The last line of defence for the date formatters below.
 *
 * THE TRADE-OFF, made explicitly. Silent fallbacks are a known trap — they
 * swallow failures and let a broken app look healthy — so the app's default
 * posture is to fail loudly (see the failed-read canon in DESIGN.md §4.6).
 * These helpers are the deliberate exception, because of WHERE they fail:
 * `Intl.*Format` throws a `RangeError` on an unparseable date, and a throw
 * inside a render unmounts the React tree. That is failing loud AT THE
 * CUSTOMER — the one audience for whom loudness has no value. It surfaces as a
 * blank page, not as a stack trace anyone acts on, and the largest caller
 * cluster is the dashboard tiles on the ALWAYS-ON home route.
 *
 * So a malformed date degrades to `UNDATED` instead of taking the page with
 * it. The loudness is not discarded, it is MOVED: `formatterFallback.test.ts`
 * asserts this path exists and that callers with genuinely optional dates use
 * `isDatable()` to render nothing at all (rule 10) rather than a stray glyph.
 * A wrong-looking dash in one cell is recoverable; a white screen is not.
 */
function guardDate<T>(value: unknown, format: () => T): T | string {
  if (!isDatable(value)) return UNDATED;
  try { return format(); } catch { return UNDATED; }
}

/** Locale-grouped number, e.g. `1,234,567` (en) / `1.234.567` (de). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return numberFmt(options).format(value);
}

/**
 * Currency amount; symbol/separators/placement localize, the amount stays in
 * `currency`.
 *
 * GUARDED, for the same reason the date formatters are (see `guardDate`): a
 * throw inside a render unmounts the React tree, and `Intl.NumberFormat` throws
 * `RangeError` on any `currency` that is not a well-formed ISO-4217 code —
 * `'dollars'`, `'$'`, `'US$'`, `'EUROS'` all do. That matters wherever the code
 * is not host-authored: production plan budgets carry a MODEL-EMITTED currency
 * (validated only as a ≤8-char string), so a plan whose model wrote "dollars"
 * would take the whole page down rather than render an ugly label. Falling back
 * to `1,234 dollars` is exactly what the un-localized code did before, which is
 * ugly and never fatal.
 */
export function formatCurrency(value: number, currency = 'USD', options?: Intl.NumberFormatOptions): string {
  try {
    return numberFmt({ style: 'currency', currency, ...options }).format(value);
  } catch {
    return `${formatNumber(value, options)} ${currency}`;
  }
}

/** Currency amount given in MINOR units (AP2 / cents). Derives the currency's own
 *  decimal count so JPY (0) / BHD (3) format correctly — not a bare `/100`. */
export function formatCurrencyMinor(minor: number, currency = 'USD'): string {
  const dp = numberFmt({ style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return formatCurrency(minor / 10 ** dp, currency);
}

/**
 * USD money renderer shared by every cost surface (chat turn cost, run cost
 * panel, builder cost badges/chips). Small numbers get more decimals so
 * sub-cent model costs stay legible; large ones round to cents. Lifted from
 * `chat/lib/cost.ts` (ux-11) so builder + runs + chat render money one way.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return formatCurrency(0, 'USD', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (usd < 0.001) return formatCurrency(usd, 'USD', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  if (usd < 1) return formatCurrency(usd, 'USD', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return formatCurrency(usd, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Percentage from a 0–1 ratio, e.g. `formatPercent(0.42)` → `42%`. */
export function formatPercent(ratio: number, options?: Intl.NumberFormatOptions): string {
  return numberFmt({ style: 'percent', ...options }).format(ratio);
}

/** Date only (medium by default), locale-ordered. `UNDATED` if unparseable. */
export function formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
  return guardDate(value, () => dateFmt(options ?? { dateStyle: 'medium' }).format(toDate(value)));
}

/** Time only. 12/24-hour follows the locale unless overridden. */
export function formatTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
  return guardDate(value, () => dateFmt(options ?? { timeStyle: 'short' }).format(toDate(value)));
}

/** Combined date + time, locale-ordered. */
export function formatDateTime(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string {
  return guardDate(value, () => dateFmt(options ?? { dateStyle: 'medium', timeStyle: 'short' }).format(toDate(value)));
}

/** A localized weekday name from a 0–6 index (0 = Sunday). `style` defaults to the
 *  full name ('long'). Uses a fixed UTC reference week so the index never shifts. */
export function formatWeekday(dayIndex: number, style: 'long' | 'short' = 'long'): string {
  const ref = new Date(Date.UTC(1970, 0, 4 + ((dayIndex % 7) + 7) % 7)); // 1970-01-04 = Sunday (UTC)
  return dateFmt({ weekday: style, timeZone: 'UTC' }).format(ref);
}

/** Human relative time from now (`"in 3 days"`, `"5 minutes ago"`). Past is negative. */
export function formatRelativeTime(value: Date | string | number, now: Date | string | number = new Date()): string {
  if (!isDatable(value) || !isDatable(now)) return UNDATED;
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
  currencyMinor: formatCurrencyMinor,
  usd: formatUsd,
  percent: formatPercent,
  date: formatDate,
  time: formatTime,
  dateTime: formatDateTime,
  weekday: formatWeekday,
  relativeTime: formatRelativeTime,
  list: formatList,
  bytes: formatBytes,
  durationSeconds: formatDurationSeconds,
  durationMs: formatDurationMs,
} as const;

export type Formatter = typeof format;
