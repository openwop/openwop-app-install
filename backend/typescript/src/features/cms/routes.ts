/**
 * CMS routes (ADR 0009) — host-extension, sample-grade. Org-scoped under
 * /v1/host/sample/cms/orgs/:orgId, gated by the shared `requireOrgScope` (ADR
 * 0027: CMS is always-on, so no toggle gate — the org-scoped RBAC remains):
 *   read (list/get/versions/by-slug)        → workspace:read
 *   content edits (create/patch/delete) + submit → workspace:write
 *   editorial approve/reject/publish/archive/restore → host:members:manage
 * Tenant+org IDOR-guarded throughout.
 *
 * @see docs/adr/0009-cms-page-builder.md
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope, requireString, optionalString } from '../featureRoute.js';
import {
  createPage,
  deletePage,
  getPage,
  getPublishedBySlug,
  listPages,
  listVersions,
  restoreVersion,
  transitionPage,
  updatePage,
  type WorkflowAction,
} from './cmsService.js';

export function registerCmsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/sample/cms/orgs/:orgId';

  // ── Reads ──
  app.get(`${BASE}/pages`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      res.json({ pages: await listPages(user.tenantId, orgId) });
    } catch (err) {
      next(err);
    }
  });

  // by-slug MUST precede /pages/:pageId (else 'by-slug' is captured as :pageId).
  app.get(`${BASE}/pages/by-slug/:slug`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      const hit = await getPublishedBySlug(user.tenantId, orgId, req.params.slug);
      if (!hit) throw new OpenwopError('not_found', 'No published page at that slug.', 404, { slug: req.params.slug });
      res.json(hit);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/pages/:pageId/versions`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      res.json({ versions: await listVersions(user.tenantId, orgId, req.params.pageId) });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/pages/:pageId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:read');
      const page = await getPage(user.tenantId, orgId, req.params.pageId);
      if (!page) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(page);
    } catch (err) {
      next(err);
    }
  });

  // ── Content edits (workspace:write) ──
  app.post(`${BASE}/pages`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:write');
      const body = (req.body ?? {}) as { title?: unknown; slug?: unknown; sections?: unknown };
      const page = await createPage({
        tenantId: user.tenantId,
        orgId,
        title: requireString(body.title, 'title'),
        ...(optionalString(body.slug) ? { slug: String(body.slug) } : {}),
        sections: body.sections,
        createdBy: user.userId,
      });
      res.status(201).json(page);
    } catch (err) {
      next(err);
    }
  });

  app.patch(`${BASE}/pages/:pageId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:write');
      // Editorial gate (code-review #1): editors may only edit DRAFTS. Editing a
      // page that is live/under-review/archived changes content outside the
      // review flow, so it requires the admin tier — editors must `unpublish`
      // (→ draft) first. Re-authorize for the admin scope when not a draft.
      const current = await getPage(user.tenantId, orgId, req.params.pageId);
      if (!current) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      if (current.status !== 'draft') await requireOrgScope(req,'host:members:manage');
      const body = (req.body ?? {}) as { title?: unknown; slug?: unknown; sections?: unknown };
      const patch: { title?: string; slug?: string; sections?: unknown } = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.slug === 'string') patch.slug = body.slug;
      if (body.sections !== undefined) patch.sections = body.sections;
      const updated = await updatePage(user.tenantId, orgId, req.params.pageId, patch, user.userId);
      if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/pages/:pageId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'workspace:write');
      const ok = await deletePage(user.tenantId, orgId, req.params.pageId);
      if (!ok) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Editorial workflow (Phase 2) ──
  // submit is an editor action; approve/reject/publish/archive are the
  // admin/owner tier (host:members:manage). The service validates the legal
  // status transition (409 otherwise).
  const transition = (action: WorkflowAction, scope: 'workspace:write' | 'host:members:manage') =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { user, orgId } = await requireOrgScope(req,scope);
        const updated = await transitionPage(user.tenantId, orgId, req.params.pageId, action, user.userId);
        if (!updated) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    };
  app.post(`${BASE}/pages/:pageId/submit`, transition('submit', 'workspace:write'));
  app.post(`${BASE}/pages/:pageId/approve`, transition('approve', 'host:members:manage'));
  app.post(`${BASE}/pages/:pageId/reject`, transition('reject', 'host:members:manage'));
  app.post(`${BASE}/pages/:pageId/publish`, transition('publish', 'host:members:manage'));
  app.post(`${BASE}/pages/:pageId/archive`, transition('archive', 'host:members:manage'));
  app.post(`${BASE}/pages/:pageId/unpublish`, transition('unpublish', 'host:members:manage'));

  // Restore a past version into the draft (admin/owner).
  app.post(`${BASE}/pages/:pageId/restore/:versionId`, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req,'host:members:manage');
      const restored = await restoreVersion(user.tenantId, orgId, req.params.pageId, req.params.versionId, user.userId);
      if (!restored) throw new OpenwopError('not_found', 'Page not found.', 404, { pageId: req.params.pageId });
      res.json(restored);
    } catch (err) {
      next(err);
    }
  });
}
