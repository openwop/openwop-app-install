/**
 * ADR 0916 (Book AI P16) — `applyFeatureNavMessages`, the merge the registry
 * runs at load to put a feature's nav translations into the `nav` namespace,
 * confined to the feature's own key prefix.
 * Red under: accepting a key outside `<feature id>.` (it could overwrite a host
 * nav string), not merging per locale, or a shipped feature declaring more than
 * a nav catalog (the entry-chunk cost is why the cap lives here, not in code).
 *
 * CORRECTION (grade-tests wave 56): the header used to claim the translations
 * "reach the `nav` namespace at registry load". The one-line load-time wiring
 * (`registry.ts` `applyFeatureNavMessages(FRONTEND_FEATURES, … addResourceBundle …)`)
 * is NOT asserted: no shipped feature declares `navMessages` (case 3), so there is
 * nothing for it to add. That line is an honest ceiling until one does.
 * Sabotage-witnessed: w55g1-nm-* (round 1), w55g1-nm-*-r2 (round 2).
 */
import { describe, expect, it } from 'vitest';
import { applyFeatureNavMessages, FRONTEND_FEATURES, type FrontendFeature } from '../registry.js';

/** The nav-catalog cap (ADR 0916): ≤ 8 keys per locale, each `<feature id>.`-prefixed, values ≤ 160 chars. */
function navCatalogViolations(features: readonly Pick<FrontendFeature, 'id' | 'navMessages'>[]): string[] {
  const out: string[] = [];
  for (const f of features) {
    for (const [locale, messages] of Object.entries(f.navMessages ?? {})) {
      const entries = Object.entries(messages);
      if (entries.length > 8) out.push(`${f.id} ${locale}: ${entries.length} keys`);
      for (const [k, v] of entries) {
        if (!k.startsWith(`${f.id}.`)) out.push(`${f.id} ${locale} ${k}: unprefixed`);
        if (v.length > 160) out.push(`${f.id} ${locale} ${k}: ${v.length} chars`);
      }
    }
  }
  return out;
}

describe('applyFeatureNavMessages (ADR 0916)', () => {
  it("merges a feature's own keys per locale and drops foreign ones", () => {
    const added: Array<[string, Record<string, string>]> = [];
    applyFeatureNavMessages([{
      id: 'bookai-author-suite',
      navMessages: {
        fr: { 'bookai-author-suite.books': 'Livres', dashboard: 'Pirate', 'bookai-author-suitex.y': 'no' },
        'pt-BR': { 'bookai-author-suite.books': 'Livros' },
      },
    }], (locale, m) => added.push([locale, m]));
    expect(added).toEqual([['fr', { 'bookai-author-suite.books': 'Livres' }], ['pt-BR', { 'bookai-author-suite.books': 'Livros' }]]);
  });

  it('every shipped navMessages stays a nav catalog: at most 8 keys of 160 chars per locale, all prefixed', () => {
    // The check itself can fail: a synthetic over-cap declaration trips each of the three limits,
    // and an at-cap one (8 keys, 160 chars, prefixed) does not.
    const atCap = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`demo.k${i}`, 'x'.repeat(160)]));
    expect(navCatalogViolations([{ id: 'demo', navMessages: { fr: atCap } }])).toEqual([]);
    expect(navCatalogViolations([{
      id: 'demo',
      navMessages: {
        fr: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`demo.k${i}`, 'x'])),
        es: { dashboard: 'Panel', 'demo.long': 'x'.repeat(161) },
      },
    }])).toEqual(['demo fr: 9 keys', 'demo es dashboard: unprefixed', 'demo es demo.long: 161 chars']);
    // Over the SHIPPED features this is empty while case 3 holds (no feature declares navMessages),
    // so for shipped features it is a deliberate double guard with case 3: it is the standing rule
    // once case 3 relaxes (probes w55g1-nm-shipped-over-cap / -unprefixed red both).
    expect(navCatalogViolations(FRONTEND_FEATURES)).toEqual([]);
  });

  it('no shipped feature declares navMessages yet (adding them is a reviewed change)', () => {
    expect(FRONTEND_FEATURES.filter((f) => f.navMessages).map((f) => f.id)).toEqual([]);
  });
});
