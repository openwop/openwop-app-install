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
 *
 * SCOPE (corrected w16): this file drives the SERVICE (`listPublicBlog`, which computes the
 * locale the routes declare) and the PRERENDER — it never boots the routes, so the
 * `setHeader('Content-Language')` / `vary('Accept-Language')` lines in
 * `features/publishing/routes.ts` (`/blog`) are not asserted here (a grade-code row).
 * Every leg runs over a PUBLISHED post with an `es` overlay; until w16 no post was
 * published, so legs 1 and 4 iterated zero posts and could not fail
 * (`w16g2-blog-negotiated`, `w16g2-blog-withheld` were vacuous).
 *
 * Sabotage-witnessed: echoing the request locale (`blog-echo`, legs 2 + 4), dropping the
 * negotiated locale (`blog-negotiated`, leg 1), not withholding (`blog-withheld`, leg 4),
 * and the prerender dropping the reader's header (`blog-prerender`, leg 3).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createPage, transitionPage, updateContentLanguageSettings, setLocalePublishState } from '../src/features/cms/cmsService.js';
import { listPublicBlog } from '../src/features/publishing/publishingService.js';
import { prerenderBlogIndex } from '../src/features/publishing/prerenderService.js';
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

/** A PUBLISHED post whose excerpt has an authored `es` overlay. */
async function publishedPost(): Promise<string> {
  const page = await createPage({
    tenantId: T, orgId: ORG, title: 'Post', createdBy: 'u1', kind: 'post',
    sections: [{ type: 'richText', data: { text: 'english body' }, localizations: { es: { text: 'cuerpo' } } }],
  });
  const live = await transitionPage(T, ORG, page.pageId, 'publish', 'u1');
  expect(live?.status).toBe('published');
  return page.pageId;
}

describe('ADR 0668 D3 — the blog lane declares its locale', () => {
  it('leg 1: listPublicBlog returns the NEGOTIATED locale, not an echo of the request', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
    await publishedPost();
    const r = await listPublicBlog(ORG, undefined, 'es');
    // `Content-Language` is built from this: the locale the excerpt was actually resolved in.
    expect(r.locale).toBe('es');
    expect(r.posts.map((p) => p.excerpt)).toEqual(['cuerpo']);
  });

  it('leg 2: with NO authored locales it returns the base locale — computed, never guessed', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: [] }, 'u1');
    await publishedPost();
    // This is the `localizable === false` short-circuit, where no negotiation runs at all.
    // Echoing the request here would declare `fr` over English content.
    const r = await listPublicBlog(ORG, undefined, 'fr');
    expect(r.locale).toBe('en');
    expect(r.posts.map((p) => p.excerpt)).toEqual(['english body']);
  });

  it('leg 3 (CMSLWF-20): the PRERENDER passes the reader\'s locale to its own content', async () => {
    // The regression this pins: prerenderBlogIndex negotiated for <html lang> and called
    // listPublicBlog with NO acceptLanguage, so the excerpts stayed base-language.
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
    await publishedPost();
    const html = await prerenderBlogIndex(ORG, 'https://x.test', 'Site', 'es');
    expect(html).toContain('<p>cuerpo</p>');
    expect(html).not.toContain('english body');
  });

  it('leg 4: a withheld locale is not served to the blog lane either', async () => {
    await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
    const pageId = await publishedPost();
    await setLocalePublishState(T, ORG, pageId, 'es', 'draft', 'u1');
    const r = await listPublicBlog(ORG, undefined, 'es');
    // Withholding removes `es` from the negotiable set AND strips its overlay, so the
    // reader gets base content — and the response must DECLARE base, not the request.
    expect(r.locale).toBe('en');
    expect(r.posts.map((p) => p.excerpt)).toEqual(['english body']);
  });
});
