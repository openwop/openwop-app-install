/**
 * CMS workflow surface (ADR 0014 / ADR 0064 Phase 3) — `ctx.features.cms`, the
 * typed surface a workflow node calls to READ localized content. Tenant comes
 * from the run scope; reads are org-scoped + published-only (the §F public-
 * delivery guard), so a workflow can fetch a page resolved for a target locale
 * exactly as the public delivery surface does.
 *
 * Reads are read-only by design (AI translation stays in the `feature.cms.nodes`
 * translate node — provider is run-scoped, the "generate in-run" rule, ADR 0064).
 * The ONE write — `createDraftPage` (ADR 0162) — delegates to `cmsService.createPage`,
 * which hard-codes `status:'draft'`; the surface never publishes, so a generated page
 * always passes a human gate before going live. Tenant comes from the run scope (never
 * args) — the cross-tenant isolation guard; org is node-supplied (the service enforces
 * the tenant+org key, the same posture as every other write surface).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { resolveSection } from '../../host/i18n/index.js';
import { getContentLanguageSettings, getPublishedBySlug, listPages, createPage } from './cmsService.js';

export function buildCmsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;

  return {
    // Create a DRAFT page (ADR 0162) from a Campaign Studio landing-page draft. The
    // service sanitizes every section + enforces slug uniqueness; status is 'draft'
    // (never published here). Idempotent on a deterministic `pageId` so a node
    // replay/fork returns the same page rather than duplicating it.
    createDraftPage: async (args) => {
      const slug = optStr(args.slug);
      const pageId = optStr(args.pageId);
      const page = await createPage({
        tenantId,
        orgId: str(args.orgId),
        title: str(args.title) || 'Untitled campaign page',
        sections: args.sections,
        createdBy: scope.runId ?? 'workflow',
        ...(slug ? { slug } : {}),
        ...(pageId ? { pageId } : {}),
      });
      return { pageId: page.pageId, slug: page.slug, status: page.status, title: page.title };
    },

    // Published pages for an org (titles/slugs/status — not section bodies).
    listPages: async (args) => {
      const pages = await listPages(tenantId, str(args.orgId));
      return {
        pages: pages
          .filter((p) => p.status === 'published')
          .map((p) => ({ pageId: p.pageId, slug: p.slug, title: p.title, status: p.status })),
      };
    },

    // A published page resolved for the requested locale (exact → language-family
    // → base, RFC 0103 §C). `locale` defaults to the org's baseLocale. Published-
    // only; sections carry resolved `data` with NO `localizations` leaked.
    getPage: async (args) => {
      const orgId = str(args.orgId);
      const slug = str(args.slug);
      const hit = await getPublishedBySlug(tenantId, orgId, slug);
      if (!hit) return { page: null, locale: null };
      const settings = await getContentLanguageSettings(tenantId, orgId);
      const locale = optStr(args.locale) || settings.baseLocale;
      return {
        locale,
        page: {
          slug: hit.page.slug,
          title: hit.page.title,
          sections: hit.page.sections.map((s) => ({
            sectionId: s.sectionId,
            sectionType: s.type,
            data: resolveSection(s, locale, settings.baseLocale),
          })),
        },
      };
    },
  };
}
