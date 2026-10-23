/**
 * ADR 0926 D1 — the Operations copy uses plain words only. No string in any of
 * the four locales may name the engine underneath: an operator reads "page",
 * "change" and "approved", never these terms.
 *
 * Two lists: the English engine terms (checked in every locale, with their
 * inflections — "Running", "Runner", "hashed"), and each locale's OWN word for
 * those terms (es/fr/pt-BR), so a translated "flux de travail" is caught too.
 * This file is the only matcher for this policy; there is no product-side copy.
 *
 * Sabotage-witnessed (wave 55/56 probes, each red here): `title: 'Operations
 * workflow'` in en; the same plant in es; `job_running: 'Running the change'`
 * in en (an inflection); `title: 'Opérations du flux de travail'` in fr (a
 * localized term); a key dropped from fr (the parity case).
 */
import { describe, expect, it } from 'vitest';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const DENYLIST = ['node', 'chain', 'workflow', 'run', 'canvas', 'model', 'provider', 'LLM', 'token', 'hash', 'ADR', 'envelope'];
type OtherLocale = 'es' | 'fr' | 'pt-BR';
/**
 * Each locale's own word for an engine term. Checked against the catalogs on
 * 2026-10-22: none of these occurs in current copy. Deliberately NOT listed:
 * pt-BR `tela` (also "screen", legitimate plain copy) and pt-BR `nó` (its
 * plural `nós` is "we").
 */
const LOCAL_DENYLIST: Record<OtherLocale, string[]> = {
  es: ['flujo de trabajo', 'nodo', 'cadena', 'modelo', 'proveedor', 'lienzo', 'ejecución'],
  fr: ['flux de travail', 'nœud', 'chaîne', 'modèle', 'fournisseur', 'jeton', 'exécution'],
  'pt-BR': ['fluxo de trabalho', 'cadeia', 'modelo', 'provedor', 'execução'],
};
const LOCALES: Record<OtherLocale, Record<string, string>> = { es, fr, 'pt-BR': ptBR };

// Letter-aware boundaries: `\b` is ASCII-only and fails next to `é`/`ç`/`œ`.
const englishTerm = (word: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?:s|es|ed|ing|ning|ner|ners)?(?![\\p{L}\\p{N}_])`, 'iu');
const localTerm = (word: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])${word}s?(?![\\p{L}\\p{N}_])`, 'iu');

function hits(table: Record<string, string>, locale?: OtherLocale): string[] {
  const out: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ...DENYLIST.map((w): [string, RegExp] => [w, englishTerm(w)]),
    ...(locale ? LOCAL_DENYLIST[locale].map((w): [string, RegExp] => [w, localTerm(w)]) : []),
  ];
  for (const [key, value] of Object.entries(table)) {
    for (const [word, re] of patterns) {
      if (re.test(value)) out.push(`${key}: "${value}" contains "${word}"`);
    }
  }
  return out;
}

describe('campaign-ops copy (ADR 0926 D1)', () => {
  it('no en string uses engine vocabulary', () => {
    expect(hits(en)).toEqual([]);
  });

  it.each(['es', 'fr', 'pt-BR'] as const)('no %s string uses the English engine vocabulary either', (loc) => {
    expect(hits(LOCALES[loc])).toEqual([]);
  });

  it.each(['es', 'fr', 'pt-BR'] as const)('no %s string uses its own word for an engine term', (loc) => {
    expect(hits(LOCALES[loc], loc)).toEqual([]);
  });

  it('the denylist itself catches a planted term (the check can fail)', () => {
    expect(hits({ k: 'Running the Workflow' })).toHaveLength(2);
    expect(hits({ k: 'Run it' })).toHaveLength(1);
    expect(hits({ k: 'Running the change' })).toHaveLength(1);
    expect(hits({ k: 'Runner' })).toHaveLength(1);
    expect(hits({ k: 'Sending…' })).toEqual([]);
    expect(hits({ k: 'Opérations du flux de travail' }, 'fr')).toHaveLength(1);
    expect(hits({ k: 'Un nœud' }, 'fr')).toHaveLength(1);
    expect(hits({ k: 'Los modelos' }, 'es')).toHaveLength(1);
    expect(hits({ k: 'Nesta tela, nós aprovamos' }, 'pt-BR')).toEqual([]);
  });

  // Twin: `scripts/check-i18n.mjs` check 4 "CROSS-LOCALE PARITY (fatal)" owns
  // this for every feature namespace in `npm run build`, and for pt-BR
  // `src/i18n/__tests__/i18n.test.ts` ("lazy pt-BR has exact key parity…").
  // Kept here (protected file) as the vitest-lane witness for this namespace.
  it('all four locales carry the same keys (twin of check-i18n check 4)', () => {
    const keys = Object.keys(en).sort();
    for (const [loc, table] of Object.entries(LOCALES)) expect(Object.keys(table).sort(), loc).toEqual(keys);
  });
});
