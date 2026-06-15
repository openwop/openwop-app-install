/**
 * System home-page editor (ADR 0027) — the host-level surface a SUPER ADMIN uses
 * to edit the public homepage, regardless of any org/tenant. Authority is
 * host-level (`requireSuperadmin`), NOT org-scoped RBAC: it drives `cmsService`
 * on the reserved system site (`host/systemSite.ts`), which no real tenant owns,
 * so `requireOrgScope` and every real tenant's isolation are untouched.
 *
 *   GET /v1/host/openwop-app/site-page   the system home page (working copy)  [superadmin]
 *   PUT /v1/host/openwop-app/site-page   edit title/sections + re-publish     [superadmin]
 *
 * The public render is served by the existing public Publishing surface
 * (`GET /v1/host/openwop-app/public/host-site/pages/home`) — published-only, unchanged.
 */
import type { Express } from 'express';
import { requireSuperadmin } from '../host/superadmin.js';
import { editSystemHomePage, getSystemHomePage } from '../host/systemSite.js';

export function registerSitePageRoutes(app: Express): void {
  app.get('/v1/host/openwop-app/site-page', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Home-page editing');
      res.json({ page: await getSystemHomePage() });
    } catch (err) { next(err); }
  });

  app.put('/v1/host/openwop-app/site-page', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'Home-page editing');
      const body = (req.body ?? {}) as { title?: unknown; sections?: unknown };
      const patch: { title?: string; sections?: unknown } = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (body.sections !== undefined) patch.sections = body.sections;
      res.json({ page: await editSystemHomePage(patch, req.principal?.principalId ?? 'superadmin') });
    } catch (err) { next(err); }
  });
}
