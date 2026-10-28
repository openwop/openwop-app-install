/**
 * ADR 0959 D5 — CMS owns the `cms.page` playbook content kind: a page template a playbook
 * installs into a client org. Writes go through `createPage` / `updatePage` in the client org.
 * A playbook only ever creates DRAFTS and only updates a page that is still a draft: a live page
 * is an admin-only edit (ADR 0836), so this seam reports it `locked` instead of writing it.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { registerPlaybookContentAdapter, shallowFieldDiff } from '../../host/playbookContentAdapters.js';
import { createPage, getPage, updatePage, type Page } from './cmsService.js';

const pageIdOf = (key: string): string => `pb-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;

function normalize(p: Page): Record<string, unknown> {
  return { title: p.title, slug: p.slug, sections: p.sections.map((s) => ({ type: s.type, data: s.data })) };
}

export function registerCmsPlaybookContent(): void {
  registerPlaybookContentAdapter({
    kind: 'cms.page',
    label: 'CMS page',
    parse(payload) {
      const p = (payload ?? {}) as { title?: unknown; slug?: unknown; sections?: unknown };
      const title = typeof p.title === 'string' ? p.title.trim() : '';
      if (!title) throw new OpenwopError('validation_error', 'A CMS page needs a title.', 400, { field: 'content.payload.title' });
      if (p.sections !== undefined && !Array.isArray(p.sections)) throw new OpenwopError('validation_error', 'sections must be a list.', 400, { field: 'content.payload.sections' });
      return { title, ...(typeof p.slug === 'string' && p.slug ? { slug: p.slug } : {}), sections: (p.sections as unknown[] | undefined) ?? [] };
    },
    async read(ctx, resourceId) {
      const page = await getPage(ctx.tenantId, ctx.orgId, resourceId);
      if (!page) return null;
      return { value: normalize(page), revision: page.version, ...(page.status !== 'draft' ? { locked: `the page is ${page.status}; only a draft can be changed by a playbook` } : {}) };
    },
    diff: shallowFieldDiff,
    async create(ctx, desired) {
      const id = pageIdOf(ctx.key);
      if (await getPage(ctx.tenantId, ctx.orgId, id)) throw new OpenwopError('conflict', 'This page already exists; its earlier outcome needs review.', 409, { reason: 'content_outcome_unconfirmed', resourceId: id });
      const page = await createPage({
        tenantId: ctx.tenantId, orgId: ctx.orgId, title: String(desired.title), createdBy: ctx.by, pageId: pageIdOf(ctx.key),
        ...(desired.slug ? { slug: String(desired.slug) } : {}), sections: desired.sections,
      });
      return { resourceId: page.pageId, snapshot: { value: normalize(page), revision: page.version } };
    },
    async update(ctx, resourceId, desired, expected) {
      const out = await updatePage(ctx.tenantId, ctx.orgId, resourceId, {
        title: String(desired.title), ...(desired.slug ? { slug: String(desired.slug) } : {}), sections: desired.sections,
      }, ctx.by, {
        expectedVersion: Number(expected.revision),
        // ADR 0836 — decided on the row actually written: a page that left draft is not ours to change.
        authorize: async (current) => {
          if (current.status !== 'draft') throw new OpenwopError('conflict', 'This page is no longer a draft, so a playbook cannot change it.', 409, { reason: 'content_locked', pageId: resourceId });
        },
      });
      if (!out) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: resourceId });
      return { value: normalize(out), revision: out.version };
    },
  });
}
