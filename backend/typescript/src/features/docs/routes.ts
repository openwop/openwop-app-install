/**
 * Docs routes (ADR 0392 Phase 1) — the ONE new public route: the docs nav tree.
 * The single doc PAGE is served by the existing Publishing route
 * (`GET /public/:orgId/pages/:slug`) — docs are CMS pages, so there is no second
 * page renderer. Under the already-allowlisted `/public/:orgId/*` prefix
 * (no auth; published-only).
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { publicBaseUrl, requireFeatureEnabled } from '../featureRoute.js';
import { listPublishedDocs, llmsTxt, publishedDocsOrNull, type DocsNavItem } from './docsService.js';
import { backfillDocsKb, gateOpen } from './docsKnowledgeService.js';
import { sendError } from '../../middleware/errorEnvelope.js';
import { systemSiteLlmsPreamble } from '../../host/systemSiteProfile.js';
import { publicDocsTenant } from '../../host/publicDocsLane.js';
import { getOrg } from '../../host/accessControlService.js';
import { getPublishedBySlug } from '../cms/cmsService.js';
import { requireCmsScope } from '../cms/cmsScope.js';
import { SYSTEM_SITE_ORG } from '../../host/systemSite.js';
import { OpenwopError } from '../../types.js';
import { platformDocumentDoor, type DocumentAdmission } from '../publishing/routes.js';
import { buildHtmlDocument } from '../publishing/prerenderService.js';
import { escapeHtml } from '../publishing/sectionHtml.js';

/** The strict CMS slug shape (the SPA's `matchDocsSlug` applies the same one). */
const DOCS_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** ADR 1057 D1 (grade-ux N1) — the ONE canonical spelling of a docs URL; the SPA
 *  applies the same rule (`frontend/react/src/features/docs/docsRoute.ts`
 *  `canonicalDocsPath`). `/docs/` → `/docs`; a docs slug in another case or with a
 *  trailing slash → `/docs/<lowercase>`. Null when already canonical, or when the
 *  remainder is not a slug at all (that is a 404, not a redirect). */
export function canonicalDocsPath(path: string): string | null {
  if (path === '/docs/') return '/docs';
  const m = /^\/docs\/(.+?)\/?$/.exec(path);
  if (!m) return null;
  let rest: string;
  try { rest = decodeURIComponent(m[1]!); } catch { return null; }
  const folded = rest.toLowerCase();
  if (!DOCS_SLUG.test(folded)) return null;
  const canonical = `/docs/${folded}`;
  return canonical === path ? null : canonical;
}

/** ADR 1057 D1 — `/docs/:slug` for a crawler: a variant spelling 301'd to the
 *  canonical one, the docs page prerendered, a renamed slug 301'd to its new URL,
 *  anything else (unknown, not a docs page, docs off or lapsed) an honest 404. */
async function admitDocsPage(siteOrg: string, slug: string, req: Request): Promise<DocumentAdmission> {
  const canonical = canonicalDocsPath(req.path);
  if (canonical) return { kind: 'redirect', location: canonical };
  if (!DOCS_SLUG.test(slug)) return { kind: 'notFound' };
  const tenantId = await publicDocsTenant(siteOrg);
  if (!tenantId) return { kind: 'notFound' };
  const hit = await getPublishedBySlug(tenantId, siteOrg, slug);
  if (!hit || hit.page.collection !== 'docs') return { kind: 'notFound' };
  if (hit.redirectedFrom) return { kind: 'redirect', location: `/docs/${encodeURIComponent(hit.page.slug)}` };
  return { kind: 'render', slug };
}

/** The `docsNav` group prefix (`getting-started/10` → `getting-started`), the
 *  grouping the SPA's sidebar and index use (`DocsPublicPage.tsx` `groupOf`). */
const groupOf = (d: DocsNavItem): string | null => {
  const slash = d.order.indexOf('/');
  return slash > 0 ? d.order.slice(0, slash) : null;
};

/** ADR 1057 D1 — the crawler document for `/docs`: one link per published doc,
 *  grouped as readers see them, with itself as the canonical. No `lang`: the
 *  titles are the base locale and nothing here negotiated one (PUB2-B2 — an
 *  omitted claim over a wrong one). */
function docsIndexHtml(docs: DocsNavItem[], baseUrl: string, siteName: string | undefined): string {
  const groups = new Map<string | null, DocsNavItem[]>();
  for (const d of docs) {
    const g = groupOf(d);
    const items = groups.get(g);
    if (items) items.push(d); else groups.set(g, [d]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : 0));
  const list = (items: DocsNavItem[]): string => `<ul>\n${items.map((d) => `<li><a href="/docs/${encodeURIComponent(d.slug)}">${escapeHtml(d.title)}</a></li>`).join('\n')}\n</ul>`;
  const sections = ordered.map(([g, items]) => (g ? `<section>\n<h2>${escapeHtml(g.replace(/-/g, ' '))}</h2>\n${list(items)}\n</section>` : list(items))).join('\n');
  const title = siteName ? `${siteName} — Documentation` : 'Documentation';
  const description = siteName ? `Guides and reference for ${siteName}.` : 'Product documentation.';
  return buildHtmlDocument(
    { seo: { title, description, canonicalUrl: `${baseUrl.replace(/\/+$/, '')}/docs`, ogTitle: title, ogDescription: description, noindex: false }, ...(siteName ? { siteName } : {}) },
    `<main>\n<header><h1>Documentation</h1></header>\n${sections}\n</main>`,
  );
}

export function registerDocsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // ADR 1057 D1 — the crawlable platform-origin doors (the hosting rewrite sends
  // `/docs` + `/docs/**` here). The SAME door as `/` + `/p/:slug`: bots get the
  // prerender or an honest 404/301, humans get the SPA shell.
  app.get('/docs', platformDocumentDoor(() => '', {
    admit: async (siteOrg, _slug, req) => {
      if (req.path === '/docs/') return { kind: 'redirect', location: '/docs' };
      const docs = await publishedDocsOrNull(siteOrg);
      if (!docs) return { kind: 'notFound' };
      const org = await getOrg(siteOrg);
      const siteName = process.env.OPENWOP_PUBLIC_SITE_NAME?.trim() || (typeof org?.name === 'string' && org.name.trim()) || undefined;
      return { kind: 'html', html: docsIndexHtml(docs, publicBaseUrl(req), siteName) };
    },
  }));
  app.get('/docs/:slug', platformDocumentDoor((req) => req.params.slug as string, { admit: admitDocsPage }));
  // A nested path is never a doc. A crawler gets the 404; a human gets the shell,
  // whose router renders its own not-found (rather than the backend's JSON 404).
  app.get(/^\/docs\/.+\/.*/, platformDocumentDoor(() => '', { admit: async () => ({ kind: 'notFound' }) }));

  app.get('/host/openwop-app/public/:orgId/docs', async (req, res, next) => {
    try {
      res.json({ docs: await listPublishedDocs(req.params.orgId) });
    } catch (err) { next(err); }
  });

  // ADR 0392 Phase 4 (+R2 correction — it IS a channel: IDE agents probe it).
  // Title = the operator's site name, matching the prerender's source of truth.
  app.get('/host/openwop-app/public/:orgId/llms.txt', async (req, res, next) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('text/plain').send(await llmsTxt(req.params.orgId, publicBaseUrl(req), process.env.OPENWOP_PUBLIC_SITE_NAME?.trim() || 'Documentation', systemSiteLlmsPreamble(req.params.orgId)));
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
      res.type('text/plain').send(await llmsTxt(siteOrg, publicBaseUrl(req), process.env.OPENWOP_PUBLIC_SITE_NAME?.trim() || 'Documentation', systemSiteLlmsPreamble(siteOrg)));
    } catch (err) { next(err); }
  });

  // Grade-pass D4/D8 — the AUTHED backfill/reconcile sweep (idempotent; the
  // publish authority gate, same tier as approving a publish). The returned
  // counts are the on-demand docs↔KB drift signal.
  //
  // The scope goes through `requireCmsScope`, not `requireOrgScope`: docs are CMS
  // pages, and the host's own docs live on the reserved system-site org in
  // `SYSTEM_SITE_TENANT`. `requireOrgScope` looks the org up in the CALLER's
  // tenant, so the system site's backfill 404'd for everyone, superadmin included
  // (MEASURED 2026-11-11 in prod). `requireCmsScope` maps a superadmin onto the
  // system site, gives everyone else the same 404, and leaves real orgs on
  // `requireOrgScope`.
  //
  // The toggle is read for the DATA tenant. A real org's data tenant is the
  // caller's, so `requireFeatureEnabled` runs first, as before. The system site's
  // is `SYSTEM_SITE_TENANT`, so the caller's home toggle says nothing about it:
  // scope first (the uniform 404 for non-superadmins), then the same gate the
  // sync uses.
  app.post('/host/openwop-app/docs/orgs/:orgId/backfill', async (req, res, next) => {
    try {
      const systemSite = req.params.orgId === SYSTEM_SITE_ORG;
      if (!systemSite) await requireFeatureEnabled(req, 'docs', 'Product documentation');
      const { orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      if (systemSite && !(await gateOpen(tenantId))) {
        throw new OpenwopError('not_found', 'Product documentation is not enabled for the system site.', 404, { feature: 'docs' });
      }
      res.json(await backfillDocsKb(tenantId, orgId));
    } catch (err) { next(err); }
  });
}
