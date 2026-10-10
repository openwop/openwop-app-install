/**
 * ADR 0820 §7 UI — store grouping is DATA (`distributions/bundles.json` `groups`);
 * its labels are i18n. Every declared group must have a title and a subtitle in
 * all four marketplace catalogs, or a new group would render as its raw id.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

const file = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'distributions', 'bundles.json'), 'utf8')) as {
  groups?: string[]; bundles: Record<string, { group?: string }>;
};

describe('store goal-groups have labels in every locale', () => {
  it('bundles.json declares groups and every bundle names one', () => {
    expect(file.groups?.length).toBeGreaterThan(0);
    for (const [id, b] of Object.entries(file.bundles)) expect(file.groups, id).toContain(b.group);
  });
  for (const [loc, cat] of Object.entries({ en, es, fr, 'pt-BR': ptBR })) {
    it(`${loc}: a title and subtitle per group`, () => {
      const keys = cat as Record<string, string>;
      for (const g of file.groups ?? []) {
        expect(keys[`group_${g}`], `${loc} group_${g}`).toBeTruthy();
        expect(keys[`groupSub_${g}`], `${loc} groupSub_${g}`).toBeTruthy();
      }
    });
  }
});
