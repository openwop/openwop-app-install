/**
 * ADR 0889 grade remediation (AE-1) — locale-aware decimal INPUT for the suite
 * editor. es, fr and pt-BR write `0,5`; `Number('0,5')` is NaN, which used to
 * reach the server as `null` and come back as an English range error, on a
 * screen that DISPLAYS the same scores with a comma.
 *
 * Pure and dependency-free on purpose: `i18n/format.ts` is the long-term owner
 * of locale number handling, and this module can move there unchanged.
 */

function symbols(locale: string): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
  };
}

/**
 * Parse a number the user typed in `locale`. Accepts the locale's decimal
 * separator AND `.` (people paste values), drops the locale's group separator
 * (and the narrow/no-break spaces fr uses for it). `''` → undefined; anything
 * unreadable → NaN, so the caller's typed error still fires.
 */
export function parseDecimal(text: string, locale: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const { decimal, group } = symbols(locale);
  let s = trimmed.replace(/[\s  ]/g, '');
  // A group separator that is also `.` (es, pt-BR) is ambiguous with a pasted
  // decimal point; only strip it when the locale's own decimal is present too.
  if (group !== '.' || s.includes(decimal)) s = s.split(group).join('');
  if (decimal !== '.') s = s.replace(decimal, '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number.NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** A number shown back in an input, in the locale's own decimal (no grouping, full precision). */
export function showDecimal(n: number | undefined, locale: string): string {
  if (n === undefined) return '';
  return new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 20 }).format(n);
}
