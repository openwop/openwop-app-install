/**
 * The checks run before a page is published or sent for review (ADR 0828
 * phase 3). Pure: the page, its search record and the locale settings in, a
 * list of findings out. A `block` finding stops Publish; a `warn` is shown and
 * can be published past; an `ok` confirms a check passed.
 *
 * Each finding names where to fix it: a section (selected in the workspace)
 * or the Page tab. The labels are i18n keys the dialog resolves.
 */
import { checkContentA11y } from '../../a11y/contentA11y.js';
import { cmsPageToA11yModel } from './cmsA11y.js';
import type { Page, Section } from './cmsClient.js';
import type { PageSeo } from '../publishing/publishingClient.js';

export type CheckLevel = 'block' | 'warn' | 'ok';
export interface PublishCheck {
  id: string;
  level: CheckLevel;
  /** i18n key in the `cms` namespace. */
  key: string;
  values?: Record<string, string | number>;
  /** Where to fix it. */
  sectionId?: string;
  fixOn?: 'section' | 'page';
}

/** A `[TODO …]` marker left in content, the seed's convention for "the author
 *  still owes this". Matched in any string field, any depth. */
const TODO = /\[TODO\b/i;

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => strings(x, out));
  return out;
}

function isEmptySection(s: Section): boolean {
  if (s.ref) return false;
  const d = (s.data ?? {}) as Record<string, unknown>;
  if (s.type === 'richText') return !String(d.text ?? '').trim() && !String(d.heading ?? '').trim();
  if (s.type === 'image') return !String(d.token ?? '').trim();
  if (s.type === 'hero') return !String(d.heading ?? '').trim();
  return false;
}

export function publishChecks(page: Page, seo: PageSeo | null, opts: { baseLocale: string; locales: readonly string[] }): PublishCheck[] {
  const out: PublishCheck[] = [];

  // ── Blockers ──
  if (!page.title.trim()) out.push({ id: 'title', level: 'block', key: 'checkNoTitle', fixOn: 'page' });
  const todoSections = page.sections.filter((s) => strings(s.data).some((x) => TODO.test(x)));
  for (const s of todoSections) out.push({ id: `todo:${s.sectionId}`, level: 'block', key: 'checkTodo', sectionId: s.sectionId, fixOn: 'section' });
  if (todoSections.length === 0) out.push({ id: 'todo', level: 'ok', key: 'checkTodoOk' });

  // ── Suggestions ──
  const empty = page.sections.filter(isEmptySection);
  for (const s of empty) out.push({ id: `empty:${s.sectionId}`, level: 'warn', key: 'checkEmptySection', sectionId: s.sectionId, fixOn: 'section' });
  if (page.sections.length === 0) out.push({ id: 'nosections', level: 'warn', key: 'checkNoSections' });

  if (page.kind === 'post') {
    out.push(page.authorId
      ? { id: 'author', level: 'ok', key: 'checkAuthorOk' }
      : { id: 'author', level: 'warn', key: 'checkNoAuthor', fixOn: 'page' });
  }

  if (seo) {
    const desc = (seo.metaDescription ?? '').trim();
    if (!desc) out.push({ id: 'description', level: 'warn', key: 'checkNoDescription', fixOn: 'page' });
    else if (desc.length > 160) out.push({ id: 'description', level: 'warn', key: 'checkLongDescription', values: { count: desc.length }, fixOn: 'page' });
    else out.push({ id: 'description', level: 'ok', key: 'checkDescriptionOk', values: { count: desc.length } });
    if (page.kind === 'post') {
      out.push(seo.ogImageToken
        ? { id: 'social', level: 'ok', key: 'checkSocialOk' }
        : { id: 'social', level: 'warn', key: 'checkNoSocial', fixOn: 'page' });
    }
  }

  const a11y = checkContentA11y(cmsPageToA11yModel(page.sections));
  if (a11y.length === 0) out.push({ id: 'a11y', level: 'ok', key: 'checkA11yOk' });
  else {
    const first = a11y.find((i) => i.nodeRef && page.sections.some((s) => s.sectionId === i.nodeRef));
    out.push({
      id: 'a11y', level: 'warn', key: 'checkA11y', values: { count: a11y.length }, fixOn: 'section',
      ...(first?.nodeRef ? { sectionId: first.nodeRef } : {}),
    });
  }

  // Untranslated sections per supported locale (shared refs translate in the
  // shared section, so they do not count here).
  const own = page.sections.filter((s) => !s.ref);
  for (const loc of opts.locales.filter((l) => l !== opts.baseLocale)) {
    if ((page.localePublishState ?? {})[loc] === 'draft') continue; // withheld: visitors get base
    const missing = own.filter((s) => !s.localizations?.[loc]).length;
    if (missing > 0) out.push({ id: `locale:${loc}`, level: 'warn', key: 'checkUntranslated', values: { locale: loc, count: missing, total: own.length } });
  }

  return out;
}
