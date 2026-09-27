/**
 * Docs routes (ADR 0392 Phase 1) — the ONE new public route: the docs nav tree.
 * The single doc PAGE is served by the existing Publishing route
 * (`GET /public/:orgId/pages/:slug`) — docs are CMS pages, so there is no second
 * page renderer. Under the already-allowlisted `/public/:orgId/*` prefix
 * (no auth; published-only).
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { publicBaseUrl, authorizeOrgScope } from '../featureRoute.js';
import { listPublishedDocs, llmsTxt } from './docsService.js';
import { backfillDocsKb } from './docsKnowledgeService.js';
import { sendError } from '../../middleware/errorEnvelope.js';

export function registerDocsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get('/v1/host/openwop-app/public/:orgId/docs', async (req, res, next) => {
    try {
      res.json({ docs: await listPublishedDocs(req.params.orgId) });
    } catch (err) { next(err); }
  });

  // ADR 0392 Phase 4 (+R2 correction — it IS a channel: IDE agents probe it).
  // Title = the operator's site name, matching the prerender's source of truth.
  app.get('/v1/host/openwop-app/public/:orgId/llms.txt', async (req, res, next) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('text/plain').send(await llmsTxt(req.params.orgId, publicBaseUrl(req), process.env.OPENWOP_PUBLIC_SITE_NAME?.trim() || 'Documentation'));
    } catch (err) { next(err); }
  });

  // R2-D11 — the ROOT-path door the llms.txt convention (and every probing
  // agent) expects, mirroring the `/` + `/p/**` prerender doors: the hosting
  // rewrite sends `/llms.txt` here, and the org is the configured public site
  // org. Unset org / no published docs ⇒ honest 404.
  app.get('/llms.txt', async (req, res, next) => {
    try {
      const siteOrg = process.env.OPENWOP_PUBLIC_SITE_ORG_ID?.trim();
      if (!siteOrg) { sendError(res, 404, 'not_found', 'No public documentation site is configured on this host.'); return; }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('text/plain').send(await llmsTxt(siteOrg, publicBaseUrl(req), process.env.OPENWOP_PUBLIC_SITE_NAME?.trim() || 'Documentation'));
    } catch (err) { next(err); }
  });

  // Grade-pass D4/D8 — the AUTHED backfill/reconcile sweep (idempotent; the
  // publish authority gate, same tier as approving a publish). The returned
  // counts are the on-demand docs↔KB drift signal.
  app.post('/v1/host/openwop-app/docs/orgs/:orgId/backfill', async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: 'docs', label: 'Product documentation' }, 'host:members:manage');
      res.json(await backfillDocsKb(tenantId, orgId));
    } catch (err) { next(err); }
  });
}
