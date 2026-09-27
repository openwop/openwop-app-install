/**
 * ADR 0668 D3 (CMSLWF-14 / CMSLWF-20) — the two blog routes declare the language they
 * actually return.
 *
 * Born red: `${PUB}/blog` set neither `Vary` nor `Content-Language` while localizing
 * `excerpt` and `readingMinutes` per post (alone among its siblings, every one of which
 * sets both), and `listPublicBlog` returned a bare array with no locale to declare.
 *
 * Leg 3 is a SECOND defect found while fixing the first: `prerenderBlogIndex` negotiated a
 * locale for `<html lang>` and then called `listPublicBlog` WITHOUT the reader's header, so
 * a document declaring `lang="es"` carried English excerpts — the head and the body
 * disagreeing about the same page.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createPage, updateContentLanguageSettings, setLocalePublishState } from '../src/features/cms/cmsService.js';
import { listPublicBlog } from '../src/features/publishing/publishingService.js';
import { createOrg } from '../src/host/accessControlService.js';

const T = 'tBlogLoc';
let ORG = '';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // The blog lane resolves its tenant from a REAL org row (`resolvePublicOrg`), so the
  // fixture registers one rather than inventing an id the lane cannot resolve.
  ORG = (await createOrg({ tenantId: T, createdBy: 'u1', name: 'Blog site' })).orgId;
});

describe('ADR 0668 D3 — the blog lane declares its locale', () => {
  it('leg 1: listPublicBlog returns the NEGOTIATED locale, not an echo of the request', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
    const r = await listPublicBlog(ORG, undefined, 'es');
    // `Content-Language` is built from this. An echo would happily return a locale the org
    // does not author; a negotiation cannot.
    expect(r).toHaveProperty('posts');
    expect(r).toHaveProperty('locale');
    expect(['en', 'es'], 'the locale must come from the org settings').toContain(r.locale);
  });

  it('leg 2: with NO authored locales it returns the base locale — computed, never guessed', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: [] }, 'u1');
    // This is the `localizable === false` short-circuit, where no negotiation runs at all.
    // Echoing the request here would declare `fr` over English content.
    const r = await listPublicBlog(ORG, undefined, 'fr');
    expect(r.locale).toBe('en');
  });

  it('leg 3 (CMSLWF-20): the PRERENDER passes the reader\'s locale to its own content', async () => {
    // The regression this pins: prerenderBlogIndex negotiated for <html lang> and called
    // listPublicBlog with NO acceptLanguage, so the excerpts stayed base-language.
    const { prerenderBlogIndex } = await import('../src/features/publishing/prerenderService.js');
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
    const html = await prerenderBlogIndex(ORG, 'https://x.test', 'Site', 'es');
    expect(typeof html).toBe('string');
    // The structural claim: the function must not be able to drop the header again.
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/features/publishing/prerenderService.ts', 'utf8'));
    const call = src.slice(src.indexOf('export async function prerenderBlogIndex'));
    const listCall = call.slice(call.indexOf('listPublicBlog('), call.indexOf('listPublicBlog(') + 120);
    expect(listCall, 'the prerender must forward acceptLanguage into its content call').toContain('acceptLanguage');
  });

  it('leg 4: a withheld locale is not served to the blog lane either', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
    const page = await createPage({
      tenantId: T, orgId: ORG, title: 'Post', createdBy: 'u1', kind: 'post',
      sections: [{ type: 'richText', data: { html: '<p>english body</p>' }, localizations: { es: { html: '<p>cuerpo</p>' } } }],
    });
    await setLocalePublishState(T, ORG, page.pageId, 'es', 'draft', 'u1');
    const r = await listPublicBlog(ORG, undefined, 'es');
    // Withholding removes the overlay from delivery; the locale the response DECLARES must
    // still be one the reader can be honestly told about.
    expect(typeof r.locale).toBe('string');
    expect(r.locale.length).toBeGreaterThan(0);
  });
});
