/**
 * Per-section locale field merge (RFC 0103 §C) — the normative, byte-identical
 * resolution every conformant host MUST share so a client sending the same
 * `Accept-Language` resolves the same content everywhere.
 *
 * This is **core-shared infra**, not a feature: it depends on nothing under
 * `features/`. A content section carries base-locale `data` plus a sparse
 * `localizations` map keyed by BCP-47 tag; resolution overlays the negotiated
 * locale's fields over `data` with the fallback chain
 * `exact-locale → script-family → language-family → base`. The overlay is a **shallow** field
 * replace (nested objects are replaced, not deep-merged).
 *
 * @see ../../../docs/adr/0064-cms-content-localization.md
 * @see ../../../../openwop/spec/v1/localized-content.md §C
 */

/** A localizable record: base `data` + an optional sparse per-locale overlay map. */
export interface LocalizableSection {
  data: Record<string, unknown>;
  localizations?: Record<string, Record<string, unknown>>;
}

/** The primary language subtag of a BCP-47 tag (`pt-BR` → `pt`), lower-cased. */
function primarySubtag(tag: string): string {
  return tag.toLowerCase().split('-')[0] ?? tag.toLowerCase();
}

/**
 * Resolve one section's fields for the negotiated locale. Pure + total — never
 * throws; always returns a fresh object. Fallback: exact-locale override →
 * script-family override (RFC 0206) → language-family override → base `data`.
 */
export function resolveSection(
  section: LocalizableSection,
  negotiatedLocale: string,
  baseLocale: string,
): Record<string, unknown> {
  const base = section.data ?? {};
  const tag = matchedLocalizationTag(section.localizations, negotiatedLocale, baseLocale);
  return tag === null ? { ...base } : { ...base, ...section.localizations![tag] };
}

/**
 * The `localizations` key {@link resolveSection} overlays for `negotiatedLocale`,
 * or `null` when it serves the base. Exported so a caller can say which locale
 * it served (`Content-Language`) without re-deriving the chain (ADR 0937).
 * Fallback: exact-locale override → script-family override (RFC 0206) →
 * language-family override → base.
 */
export function matchedLocalizationTag(
  localizations: Record<string, unknown> | undefined,
  negotiatedLocale: string,
  baseLocale: string,
): string | null {
  // Base locale (or nothing authored) → the base payload verbatim.
  if (negotiatedLocale === baseLocale || !localizations || typeof localizations !== 'object') return null;
  const usable = (tag: string): boolean => {
    const v = localizations[tag];
    return !!v && typeof v === 'object';
  };

  // Exact-locale override.
  if (usable(negotiatedLocale)) return negotiatedLocale;

  // Script-family override (RFC 0206, `localized-content.md` §C): `zh-Hant-TW`
  // negotiated → `zh-Hant` overrides, BEFORE the language family, so a
  // Traditional-Chinese reader never falls through to a Simplified `zh` overlay.
  // Fires only on an `ll-Ssss` key, which the pre-RFC-0206 grammar never admitted,
  // so every section valid before resolves exactly as it did.
  const parts = negotiatedLocale.split('-');
  if (parts.length >= 3 && /^[A-Za-z]{4}$/.test(parts[1] ?? '')) {
    const script = `${parts[0]}-${parts[1]}`;
    if (usable(script)) return script;
  }

  // Language-family override (`pt-BR` negotiated → `pt` overrides).
  if (negotiatedLocale.includes('-')) {
    const fam = primarySubtag(negotiatedLocale);
    if (usable(fam)) return fam;
  }

  // No match → base payload.
  return null;
}

/**
 * ADR 0406 D3 — the values-level resolution for localized ENTITY fields.
 * A named wrapper over the SAME normative chain (exact → family → base;
 * RFC 0103 §C) so entities and sections can never drift: one algorithm,
 * two callers. Scalar-typed for the entities value map.
 */
export function resolveLocalizedValues<T extends Record<string, string | number | boolean>>(
  values: T,
  localizations: Record<string, Partial<T>> | undefined,
  negotiatedLocale: string,
  baseLocale: string,
): T {
  return resolveSection(
    { data: values, ...(localizations ? { localizations } : {}) },
    negotiatedLocale,
    baseLocale,
  ) as T;
}
