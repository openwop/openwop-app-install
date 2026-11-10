/**
 * Every plural form in the CMS catalogs interpolates `{{count}}`.
 *
 * i18next picks a plural form from the `count` option, and the callers pass
 * `{ count }`. A form that names another variable renders literally: a per-line
 * edit once renamed `{{count}}` to `{{n}}` in 31 strings per locale and the
 * editor showed "{{n}} / 160" and "Fix {{n}} first" (ADR 1038 grading, I18N-1),
 * with nothing red until a workspace test happened to read one.
 *
 * The locale table is checked against `SUPPORTED_LOCALES`, so a new locale's
 * catalog cannot be left out of the scan, and each form must carry the exact
 * `{{count}}` token.
 *
 * Sabotage-witnessed (2026-11-03; re-probed /grade-tests wave 88): renaming
 * `{{count}}` in one `_one` or `_other` form in any one locale turns this red.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../../../i18n/locales.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const PLURAL = /_(zero|one|two|few|many|other)$/;
const CATALOGS: Array<[string, Record<string, unknown>]> = [['en', en], ['es', es], ['fr', fr], ['pt-BR', ptBR]];

describe('cms catalog plural forms', () => {
  it.each(CATALOGS)('%s: every plural form interpolates {{count}}', (locale, catalog) => {
    // The table covers exactly the supported locales (and this one is among them).
    expect(CATALOGS.map(([l]) => l).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(SUPPORTED_LOCALES).toContain(locale);
    const forms = Object.entries(catalog).filter((e): e is [string, string] => PLURAL.test(e[0]) && typeof e[1] === 'string');
    expect(forms.length).toBeGreaterThan(10);
    expect(forms.filter(([, v]) => !/\{\{count\}\}/.test(v)).map(([k]) => k)).toEqual([]);
  });
});
