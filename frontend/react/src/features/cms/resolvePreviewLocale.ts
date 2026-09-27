/**
 * ADR 0592 §5 (CMSLU-5) — preview-in-locale resolution for the editor's
 * Public preview. A CLIENT-SIDE mirror of the normative per-section merge
 * (`backend host/i18n/resolveSection.ts`, RFC 0103 §C): exact-locale
 * override → language-family override → base `data`, shallow field replace.
 *
 * Mirror, not a fork: the semantics are pinned by the shared spec doc
 * (`openwop/spec/v1/localized-content.md §C`) and by the tests beside this
 * file — the preview must show what delivery will serve, so any divergence
 * here is a preview lie. Fail-closed by construction: callers only offer
 * locales from the org's configured set, and an unknown locale resolves to
 * base (never throws, never invents content).
 */
import type { Section } from './cmsClient.js';

function primarySubtag(tag: string): string {
  return tag.toLowerCase().split('-')[0] ?? tag.toLowerCase();
}

/** Resolve one section's fields for the preview locale (exact → family → base). */
export function resolvePreviewSection(
  section: Pick<Section, 'data' | 'localizations'>,
  locale: string,
  baseLocale: string,
): { data: Record<string, unknown>; fellBack: boolean } {
  const base = section.data ?? {};
  const localizations = section.localizations;
  if (locale === baseLocale || !localizations || typeof localizations !== 'object') {
    return { data: { ...base }, fellBack: locale !== baseLocale };
  }
  const exact = localizations[locale];
  if (exact && typeof exact === 'object') {
    return { data: { ...base, ...exact }, fellBack: false };
  }
  if (locale.includes('-')) {
    const fam = localizations[primarySubtag(locale)];
    if (fam && typeof fam === 'object') {
      return { data: { ...base, ...fam }, fellBack: false };
    }
  }
  return { data: { ...base }, fellBack: true };
}

/**
 * Resolve a whole section list for the preview locale. Returns the resolved
 * sections (same ids/types, resolved `data`, no `localizations` leaked — the
 * delivery shape) plus how many of them FELL BACK to base, for the honesty
 * badge ("previewing es — N of M sections fall back").
 */
export function resolvePreviewSections(
  sections: readonly Section[],
  locale: string,
  baseLocale: string,
  /** ADR 0592 §5 correction (review F5) — locales WITHHELD from delivery
   *  (`localePublishState[l] === 'draft'`). Their overlays are stripped
   *  BEFORE resolution, mirroring `localizePage`: a real visitor never sees
   *  a withheld overlay (not even via family fallback), so neither may the
   *  preview — previewing a withheld locale showing its overlay + a
   *  "complete" badge was a preview lie. */
  opts?: { withheld?: readonly string[] },
): { sections: Section[]; fallbackCount: number } {
  const withheld = opts?.withheld ?? [];
  let fallbackCount = 0;
  const resolved = sections.map((s) => {
    let source: Pick<Section, 'data' | 'localizations'> = s;
    if (withheld.length > 0 && s.localizations) {
      const loc = { ...s.localizations };
      for (const l of withheld) delete loc[l];
      source = { data: s.data, ...(Object.keys(loc).length > 0 ? { localizations: loc } : {}) };
    }
    const { data, fellBack } = resolvePreviewSection(source, locale, baseLocale);
    if (fellBack && locale !== baseLocale) fallbackCount += 1;
    const next: Section = { sectionId: s.sectionId, type: s.type, data };
    return next;
  });
  return { sections: resolved, fallbackCount };
}
