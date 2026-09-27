/**
 * The content-locale grammar the editor validates against (RFC 0206 §A) — a
 * lowercase 2–3 letter language, an optional titlecase script, an optional
 * uppercase or 3-digit region: `es`, `pt-BR`, `fil`, `zh-Hant`, `zh-Hant-TW`,
 * `es-419`. Byte-identical to the vendored `schemas/v2/localized-content-*`
 * pattern and to backend `host/i18n/locale.ts` `LOCALE_RE` (a test pins the
 * schema half); the server re-validates regardless.
 */
export const CONTENT_LOCALE_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/**
 * What an admin typed → the canonical tag, or null when no canonical form fits
 * the grammar. Case and `_` are the common slips (`pt-br`, `zh-hant-tw`,
 * `en_US`), and RFC 5646 says tags compare case-insensitively, so they are
 * repaired rather than refused (ADR 0748): `Intl.getCanonicalLocales` does the
 * casing. A tag with a variant or an extlang (`de-CH-1996`, `zh-yue`) stays
 * outside the grammar and is refused.
 */
export function canonicalContentLocale(input: string): string | null {
  const raw = input.trim().replace(/_/g, '-');
  if (raw === '') return null;
  if (CONTENT_LOCALE_RE.test(raw)) return raw;
  try {
    const [canonical] = Intl.getCanonicalLocales(raw);
    return canonical !== undefined && CONTENT_LOCALE_RE.test(canonical) ? canonical : null;
  } catch {
    return null; // not a well-formed BCP 47 tag at all
  }
}
