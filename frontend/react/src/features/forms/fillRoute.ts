/**
 * ADR 0331 §D3 — the public `/f/:formId` hosted-fill route matcher, extracted
 * as a pure function (the shareRoute/storeRoute/publicPageRoute precedent).
 * Form ids contain `:` (`form:<uuid>`) and app-generated links percent-encode
 * (`form%3A…`), so the charset accepts `%` and the decode is guarded —
 * a malformed sequence is a non-match, never a render-crashing URIError.
 */

/** Returns the decoded form id for a `/f/:formId` path, or null otherwise. */
export function matchFormFillId(pathname: string): string | null {
  const m = pathname.match(/^\/f\/([A-Za-z0-9%:_-]+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}
