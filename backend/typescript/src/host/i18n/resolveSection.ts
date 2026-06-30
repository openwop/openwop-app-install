/**
 * Per-section locale field merge (RFC 0103 §C) — the normative, byte-identical
 * resolution every conformant host MUST share so a client sending the same
 * `Accept-Language` resolves the same content everywhere.
 *
 * This is **core-shared infra**, not a feature: it depends on nothing under
 * `features/`. A content section carries base-locale `data` plus a sparse
 * `localizations` map keyed by BCP-47 tag; resolution overlays the negotiated
 * locale's fields over `data` with the fallback chain
 * `exact-locale → language-family → base`. The overlay is a **shallow** field
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
 * language-family override → base `data`.
 */
export function resolveSection(
  section: LocalizableSection,
  negotiatedLocale: string,
  baseLocale: string,
): Record<string, unknown> {
  const base = section.data ?? {};
  const localizations = section.localizations;

  // Base locale (or nothing authored) → the base payload verbatim.
  if (
    negotiatedLocale === baseLocale ||
    !localizations ||
    typeof localizations !== 'object'
  ) {
    return { ...base };
  }

  // Exact-locale override.
  const exact = localizations[negotiatedLocale];
  if (exact && typeof exact === 'object') {
    return { ...base, ...exact };
  }

  // Language-family override (`pt-BR` negotiated → `pt` overrides).
  if (negotiatedLocale.includes('-')) {
    const fam = localizations[primarySubtag(negotiatedLocale)];
    if (fam && typeof fam === 'object') {
      return { ...base, ...fam };
    }
  }

  // No match → base payload.
  return { ...base };
}
