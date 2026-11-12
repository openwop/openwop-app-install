/**
 * ADR 0828 phase 3 — the checks before Publish: a to-do marker blocks, missing
 * search and social settings and untranslated sections warn, and each finding
 * points at where it is fixed.
 *
 * Sabotage-witnessed (/grade-tests w17): breaking the TODO regex, scanning the
 * whole page instead of each section, emitting the "no to-dos" ok always (or as
 * a warn), flipping the author/description/social warns to ok, dropping the
 * null-search-record guard, the withheld-locale skip, the per-locale count, or
 * the title trim each turn a case red.
 */
import { describe, it, expect } from 'vitest';
import { publishChecks } from '../publishChecks.js';
import type { Page } from '../cmsClient.js';

const page = (over: Partial<Page> = {}): Page => ({
  pageId: 'p1', title: 'Launch post', slug: 'launch', status: 'draft', version: 1, updatedAt: '2026-10-05T00:00:00Z',
  sections: [
    { sectionId: 'sec:a', type: 'richText', data: { heading: 'Intro', text: 'Hello' } },
    { sectionId: 'sec:b', type: 'richText', data: { heading: 'Examples', text: '[TODO: one concrete example.]' } },
  ],
  ...over,
});
const opts = { baseLocale: 'en', locales: ['en'] };
const byId = (checks: ReturnType<typeof publishChecks>, id: string) => checks.find((c) => c.id === id);

describe('publishChecks', () => {
  it('a [TODO] marker anywhere in a section blocks, and points at that section', () => {
    const checks = publishChecks(page(), { noindex: false, metaDescription: 'Fine.' }, opts);
    expect(byId(checks, 'todo:sec:b')).toMatchObject({ level: 'block', sectionId: 'sec:b', fixOn: 'section' });
    expect(byId(checks, 'todo:sec:a')).toBeUndefined();
    expect(byId(checks, 'todo')).toBeUndefined();
  });

  it('no to-dos is a passed check, not silence', () => {
    const p = page({ sections: [{ sectionId: 'sec:a', type: 'richText', data: { text: 'Done.' } }] });
    expect(byId(publishChecks(p, null, opts), 'todo')).toMatchObject({ level: 'ok' });
  });

  it('a post without an author, description or social image warns about each, on the Page tab', () => {
    const checks = publishChecks(page({ kind: 'post' }), { noindex: false }, opts);
    expect(byId(checks, 'author')).toMatchObject({ level: 'warn', fixOn: 'page' });
    expect(byId(checks, 'description')).toMatchObject({ level: 'warn', fixOn: 'page' });
    expect(byId(checks, 'social')).toMatchObject({ level: 'warn', fixOn: 'page' });
  });

  it('an unread search record makes no claim about it', () => {
    const checks = publishChecks(page({ kind: 'post' }), null, opts);
    expect(byId(checks, 'description')).toBeUndefined();
    expect(byId(checks, 'social')).toBeUndefined();
  });

  it('counts untranslated sections per locale, and skips a withheld locale', () => {
    const p = page({ localePublishState: { fr: 'draft' } });
    const checks = publishChecks(p, null, { baseLocale: 'en', locales: ['en', 'es', 'fr'] });
    expect(byId(checks, 'locale:es')).toMatchObject({ level: 'warn', values: { locale: 'es', count: 2, total: 2 } });
    expect(byId(checks, 'locale:fr')).toBeUndefined();
  });

  it('an empty title blocks', () => {
    expect(byId(publishChecks(page({ title: '  ' }), null, opts), 'title')).toMatchObject({ level: 'block', fixOn: 'page' });
  });

  // ADR 1100 D3 — a shared-section reference carries `data: {}`, so the raw list
  // hid its pictures; the check reads the resolved sections. Sabotage: ignore
  // `resolvedSections` → the first expectation goes red.
  it('the accessibility check reads the RESOLVED sections, so a shared section\'s pictures count', () => {
    const p = page({ sections: [{ sectionId: 'sec:ref', type: 'image', data: {}, ref: { sharedSectionId: 'sh1' } }] });
    const resolvedSections = [{ sectionId: 'sec:ref', type: 'image' as const, data: { token: 'tok:x', alt: '' } }];
    expect(byId(publishChecks(p, null, { ...opts, resolvedSections }), 'a11y')).toMatchObject({ level: 'warn', sectionId: 'sec:ref' });
    expect(byId(publishChecks(p, null, opts), 'a11y')).toMatchObject({ level: 'ok' });
  });

  it('a picture ref inside a section (`<id>#<n>`) points the fix at the section', () => {
    const p = page({ sections: [{ sectionId: 'c1', type: 'columns', data: { columns: [{ imageToken: 't1', alt: 'ok' }, { imageToken: 't2', alt: '' }] } }] });
    expect(byId(publishChecks(p, null, opts), 'a11y')).toMatchObject({ level: 'warn', sectionId: 'c1' });
  });

  it('an unread shared section makes the check incomplete, never passed', () => {
    const p = page({ sections: [{ sectionId: 'sec:ref', type: 'image', data: {}, ref: { sharedSectionId: 'sh1' } }] });
    expect(byId(publishChecks(p, null, { ...opts, sharedUnread: true }), 'a11y')).toMatchObject({ level: 'warn', key: 'checkA11yIncomplete' });
  });

  it('issues found while a shared section is unread are flagged as not all there are', () => {
    const p = page({ sections: [{ sectionId: 'i1', type: 'image', data: { token: 't', alt: '' } }, { sectionId: 'r1', type: 'image', data: {}, ref: { sharedSectionId: 'sh' } }] });
    const checks = publishChecks(p, null, { ...opts, sharedUnread: true });
    expect(byId(checks, 'a11y')).toMatchObject({ level: 'warn', key: 'checkA11y' });
    expect(byId(checks, 'a11y-incomplete')).toMatchObject({ level: 'warn', key: 'checkA11yIncomplete' });
  });
});
