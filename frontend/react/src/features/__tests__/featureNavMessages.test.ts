/**
 * ADR 0916 (Book AI P16) — a feature's nav translations reach the `nav`
 * namespace at registry load, confined to the feature's own key prefix.
 * Red under: accepting a key outside `<feature id>.` (it could overwrite a host
 * nav string), not merging per locale, or a shipped feature declaring more than
 * a nav catalog (the entry-chunk cost is why the cap lives here, not in code).
 */
import { describe, expect, it } from 'vitest';
import { applyFeatureNavMessages, FRONTEND_FEATURES } from '../registry.js';

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
    for (const f of FRONTEND_FEATURES) {
      for (const [locale, messages] of Object.entries(f.navMessages ?? {})) {
        const entries = Object.entries(messages);
        expect(entries.length, `${f.id} ${locale}`).toBeLessThanOrEqual(8);
        for (const [k, v] of entries) {
          expect(k.startsWith(`${f.id}.`), `${f.id} ${locale} ${k}`).toBe(true);
          expect(v.length, `${f.id} ${locale} ${k}`).toBeLessThanOrEqual(160);
        }
      }
    }
  });

  it('no shipped feature declares navMessages yet (adding them is a reviewed change)', () => {
    expect(FRONTEND_FEATURES.filter((f) => f.navMessages).map((f) => f.id)).toEqual([]);
  });
});
