/**
 * Publishing & SEO routes (ADR 0012). Two surfaces:
 *   - AUTHED  /v1/host/sample/publishing/orgs/:orgId/pages/:pageId/seo
 *       (requireOrgScope — GET workspace:read, PUT workspace:write)
 *   - PUBLIC  /v1/host/sample/public/:orgId/*  (NO auth — org→tenant from URL,
 *       published-only). The `/v1/host/sample/public` prefix is on
 *       PUBLIC_PATH_PREFIXES (auth.ts).
 *
 * ADR 0027: Publishing is always-on — no toggle gate. The authed SEO routes keep
 * their org-scoped RBAC; the public surface is gated only by the CMS `published`
 * status (the per-tenant toggle is gone — Sharing covers private/draft access).
 *
 * @see docs/adr/0012-publishing-seo.md · docs/adr/0027-cms-front-page-and-always-on-content.md
 */

import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope, publicBaseUrl } from '../featureRoute.js';
import {
  feedRss,
  getSeo,
  publicPageBySlug,
  putSeo,
  robotsTxt,
  sitemapXml,
} from './publishingService.js';

export function registerPublishingRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ── authed: per-page SEO metadata ──
  const SEO = '/v1/host/sample/publishing/orgs/:orgId/pages/:pageId/seo';

  app.get(SEO, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:read');
      res.json({ seo: await getSeo(user.tenantId, orgId, req.params.pageId) });
    } catch (err) { next(err); }
  });

  app.put(SEO, async (req, res, next) => {
    try {
      const { user, orgId } = await requireOrgScope(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json({ seo: await putSeo(user.tenantId, orgId, req.params.pageId, user.userId, body) });
    } catch (err) { next(err); }
  });

  // ── public: the published site (NO auth; org→tenant; toggle-gated) ──
  const PUB = '/v1/host/sample/public/:orgId';

  app.get(`${PUB}/pages/:slug`, async (req, res, next) => {
    try {
      res.json(await publicPageBySlug(req.params.orgId, req.params.slug, publicBaseUrl(req)));
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/sitemap.xml`, async (req, res, next) => {
    try {
      const xml = await sitemapXml(req.params.orgId, publicBaseUrl(req));
      res.type('application/xml').send(xml);
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/robots.txt`, async (req, res, next) => {
    try {
      const txt = await robotsTxt(req.params.orgId, publicBaseUrl(req));
      res.type('text/plain').send(txt);
    } catch (err) { next(err); }
  });

  app.get(`${PUB}/feed.rss`, async (req, res, next) => {
    try {
      const rss = await feedRss(req.params.orgId, publicBaseUrl(req));
      res.type('application/rss+xml').send(rss);
    } catch (err) { next(err); }
  });
}
