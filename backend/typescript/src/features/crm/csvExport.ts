/**
 * CSV export (ADR 0210 §5) — buffered (no streaming precedent in the app;
 * bounded by the existing per-org/tenant entity caps), RFC 4180 quoting, and a
 * formula-injection guard (a leading `=+-@` is prefixed with `'` so a
 * spreadsheet never evaluates untrusted cell content as a formula).
 */

const FORMULA_PREFIX = /^[=+\-@]/;
const NEEDS_QUOTING = /[",\n\r]/;

/** One CSV cell: stringify, formula-guard, then RFC 4180-quote if needed. */
export function csvEscape(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (NEEDS_QUOTING.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Build an RFC 4180 CSV document (CRLF line endings, header row) from
 * `columns` (in order) over `rows`. A column named `customFields.<key>` reads
 * `row.customFields[<key>]`; every other column is a direct field accessor.
 * Array-valued fields (e.g. tags) join on `;`.
 */
export function toCsv<T extends object>(columns: readonly string[], rows: readonly T[]): string {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((r) => {
    // Entries-copy instead of an index-signature assertion — typed entity rows
    // (Company[], Deal[], …) pass through the generic with zero casts; the
    // per-row copy is bounded by the export caps.
    const row: Record<string, unknown> = Object.fromEntries(Object.entries(r));
    const cfRaw = row.customFields;
    const customFields: Record<string, unknown> | undefined =
      cfRaw && typeof cfRaw === 'object' && !Array.isArray(cfRaw)
        ? Object.fromEntries(Object.entries(cfRaw))
        : undefined;
    return columns
      .map((col) => {
        if (col.startsWith('customFields.')) {
          return csvEscape(customFields?.[col.slice('customFields.'.length)]);
        }
        const v = row[col];
        return csvEscape(Array.isArray(v) ? v.join(';') : v);
      })
      .join(',');
  });
  return [header, ...lines].join('\r\n') + '\r\n';
}

/** Union of `customFields` keys across every row, in first-seen order —
 *  the dynamic tail of an export's column list. */
export function customFieldColumns(rows: ReadonlyArray<{ customFields?: Record<string, unknown> }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.customFields ?? {})) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(`customFields.${key}`);
      }
    }
  }
  return out;
}
