/**
 * Feature loop round 2, row 35 — a WITHHELD locale is never served, on any lane.
 *
 * `localizePage` derived its withheld set as `supportedLocales.filter(state === 'draft')`,
 * so a `localePublishState` entry only bit while its locale was ALSO configured. A
 * `pt` overlay held at `draft` therefore reached a `pt-BR` reader through the RFC 0103
 * language-family step as soon as `pt` left `supportedLocales` — and removing a locale
 * is the ungated "fail-safe" direction. One settings write published a withheld,
 * typically machine-drafted translation with no review row and `page.version` unmoved.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  createPage, updateContentLanguageSettings, localizePage, getContentLanguageSettings, setLocalePublishState, getPage,
} from '../src/features/cms/cmsService.js';

const T = 'tWithheld';
const ORG = 'org-1';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

const pagePt = async () => createPage({
  tenantId: T, orgId: ORG, title: 'P', createdBy: 'u1',
  sections: [{ type: 'richText', data: { text: 'english body' }, localizations: { pt: { text: 'corpo retido' } } }],
});

describe('a withheld locale is never served', () => {
  it('stays withheld after its locale is removed from supportedLocales (family reach via pt-BR)', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['pt', 'pt-BR'] }, 'u1');
    const created = await pagePt();
    await setLocalePublishState(T, ORG, created.pageId, 'pt', 'draft', 'u1');
    const before = localizePage((await getPage(T, ORG, created.pageId))!, 'pt-BR', await getContentLanguageSettings(T, ORG));
    expect(JSON.stringify(before.page.sections), 'precondition: withheld while configured').not.toContain('corpo retido');

    // The narrowing write — the "fail-safe" direction.
    await updateContentLanguageSettings(T, ORG, { supportedLocales: ['pt-BR'] }, 'u1');
    const after = localizePage((await getPage(T, ORG, created.pageId))!, 'pt-BR', await getContentLanguageSettings(T, ORG));
    expect(JSON.stringify(after.page.sections), 'a withheld pt overlay reached a pt-BR reader').not.toContain('corpo retido');
  });

  it('withholding an unconfigured family locale holds it back from a configured regional reader', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['pt-BR'] }, 'u1');
    const created = await pagePt();
    await setLocalePublishState(T, ORG, created.pageId, 'pt', 'draft', 'u1');
    const { page } = localizePage((await getPage(T, ORG, created.pageId))!, 'pt-BR', await getContentLanguageSettings(T, ORG));
    expect(JSON.stringify(page.sections)).not.toContain('corpo retido');
    expect(JSON.stringify(page.sections)).toContain('english body');
  });

  it('a published (absent-state) family overlay is still served — the fix narrows only withheld keys', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['pt-BR'] }, 'u1');
    const created = await pagePt();
    const { page } = localizePage(created, 'pt-BR', await getContentLanguageSettings(T, ORG));
    expect(JSON.stringify(page.sections)).toContain('corpo retido');
  });
});
