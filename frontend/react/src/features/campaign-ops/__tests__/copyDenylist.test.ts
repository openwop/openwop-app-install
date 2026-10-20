/**
 * ADR 0926 D1 — the Operations copy uses plain words only. No string in any of
 * the four locales may name the engine underneath: an operator reads "page",
 * "change" and "approved", never these terms.
 *
 * Sabotage: adding `step_writing: 'Running the workflow'` to `en.ts` reds the
 * en case; a key present in `en` but missing from `fr` reds the parity case.
 */
import { describe, expect, it } from 'vitest';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const DENYLIST = ['node', 'chain', 'workflow', 'run', 'canvas', 'model', 'provider', 'LLM', 'token', 'hash', 'ADR', 'envelope'];
const LOCALES: Record<string, Record<string, string>> = { en, es, fr, 'pt-BR': ptBR };

function hits(table: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    for (const word of DENYLIST) {
      if (new RegExp(`\\b${word}s?\\b`, 'i').test(value)) out.push(`${key}: "${value}" contains "${word}"`);
    }
  }
  return out;
}

describe('campaign-ops copy (ADR 0926 D1)', () => {
  it('no en string uses engine vocabulary', () => {
    expect(hits(en)).toEqual([]);
  });

  it.each(['es', 'fr', 'pt-BR'])('no %s string uses the English engine vocabulary either', (loc) => {
    expect(hits(LOCALES[loc]!)).toEqual([]);
  });

  it('the denylist itself catches a planted term (the check can fail)', () => {
    expect(hits({ k: 'Running the Workflow' })).toHaveLength(1);
    expect(hits({ k: 'Run it' })).toHaveLength(1);
    expect(hits({ k: 'Sending…' })).toEqual([]);
  });

  it('all four locales carry the same keys', () => {
    const keys = Object.keys(en).sort();
    for (const [loc, table] of Object.entries(LOCALES)) expect(Object.keys(table).sort(), loc).toEqual(keys);
  });
});
