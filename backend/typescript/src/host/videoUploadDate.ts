/**
 * A `video` section's `uploadDate` (ADR 0843 / ADR 1032).
 *
 * The CMS stores what the editor typed: a date (`YYYY-MM-DD`, what every row
 * stored before 2026-11-07 holds) or a full ISO 8601 datetime WITH a timezone
 * (`2026-11-02T09:30:00-05:00`, `…Z`). The VideoObject JSON-LD, though, must
 * carry a datetime with a timezone: Search Console reports a date-only value as
 * "Invalid datetime value for uploadDate" (myndhyve.ai, 2026-11-07). So the
 * prerender widens a date to midnight UTC and passes a datetime through, and
 * stored values are left as they are.
 */

const DATE = String.raw`(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`;
const TIME = String.raw`T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)`;

/** Accepted on write: a date, or a datetime with an explicit timezone. A
 *  datetime without one is refused, because it would be read in an unknown
 *  zone. */
export const UPLOAD_DATE_RE = new RegExp(`^${DATE}(?:${TIME})?$`);

/** True for a real calendar date (no 2026-02-30) in an accepted shape. */
export function isValidUploadDate(raw: string): boolean {
  const m = UPLOAD_DATE_RE.exec(raw);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

/** The JSON-LD value for a stored `uploadDate`: a date becomes
 *  `YYYY-MM-DDT00:00:00Z`, a datetime passes through, and anything else
 *  (a value that reached storage some other way) is dropped rather than
 *  emitted invalid. */
export function videoUploadDateTime(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUploadDate(s)) return '';
  return s.length === 10 ? `${s}T00:00:00Z` : s;
}
