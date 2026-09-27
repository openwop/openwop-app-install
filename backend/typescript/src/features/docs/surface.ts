/**
 * Docs workflow surface (ADR 0392 Phase 3) — `ctx.features.docs`, the scope-bound
 * seam the docs MCP nodes read through (the notebooks/marketplace precedent; a
 * node never touches kbService directly). Search is TENANT-WIDE over the
 * tenant's managed `docs` collections (no site-org assumption); a KB hit's
 * documentId is the CMS page id, resolved back to the public `/docs/<slug>` URL.
 */
import type { FeatureSurfaceBuilder } from '../../host/featureSurfaces.js';
import type { SubjectCaller } from '../../host/subjectAccess.js';
import { listAllTenantCollections, tenantRetrieve } from '../kb/kbService.js';
import { getPage, getPublishedBySlug } from '../cms/cmsService.js';
import { flattenSections } from './docsKnowledgeService.js';

const docsUrl = (slug: string): string => `/docs/${slug}`;

/** The tenant's managed docs collections (id + owning org), for search + slug
 *  resolution across however many orgs the tenant authored docs in. */
async function docsCollections(tenantId: string, caller: SubjectCaller): Promise<Array<{ collectionId: string; orgId: string }>> {
  return (await listAllTenantCollections(tenantId, caller))
    .filter((c) => c.managed === 'docs')
    .map((c) => ({ collectionId: c.collectionId, orgId: c.orgId }))
    // Grade-pass D10: deterministic org order so a same-slug page in two docs
    // orgs always resolves to the SAME one (lowest orgId), never list-order luck.
    .sort((a, b) => a.orgId.localeCompare(b.orgId));
}

export const buildDocsSurface: FeatureSurfaceBuilder = (scope) => {
  // KBC-1 (ADR 0643 D2 precondition) — the run's acting human, absent for a
  // system run, passed to the KB service exactly as `ctx.features.kb` does.
  // Docs collections are `managed:'docs'` and never subject-bound, so this
  // changes nothing today; it is here so the ONE lane the precondition names
  // ("`docs/surface.ts` reads straight past it") is gated by construction rather
  // than by a filter someone could widen.
  const caller: SubjectCaller = { ...(scope.actingUserId ? { subject: scope.actingUserId } : {}) };
  return {
  /** Ranked docs hits for a query — title, snippet, /docs URL, score.
   *  NOTE (grade pass D9): results index/return the BASE-LOCALE text only — the
   *  docs→KB sync embeds `flattenSections` base data (no locale overlays), and
   *  there is no locale parameter on these tools. */
  search: async (args: Record<string, unknown>) => {
    const query = typeof args.query === 'string' ? args.query : '';
    const limit = Math.min(20, Math.max(1, typeof args.limit === 'number' ? args.limit : 8));
    if (!query.trim()) return { hits: [] };
    const collections = await docsCollections(scope.tenantId, caller);
    if (collections.length === 0) return { hits: [] };
    const collectionIds = collections.map((c) => c.collectionId);
    const result = await tenantRetrieve(scope.tenantId, { query, collectionIds, resultLimit: limit }, caller);
    const chunks = result?.chunks ?? [];
    // documentId (=pageId) → slug, resolved per hit (bounded to `limit`, cached).
    const slugByPage = new Map<string, string>();
    const hits: Array<{ title: string; snippet: string; url: string; score: number }> = [];
    const seen = new Set<string>();
    for (const c of chunks) {
      const pageId = c.assetId;
      if (!pageId || seen.has(pageId)) continue;
      seen.add(pageId);
      let slug = slugByPage.get(pageId);
      if (slug === undefined) {
        const found = await resolvePageAcross(scope.tenantId, collections, pageId);
        slug = found?.slug ?? '';
        slugByPage.set(pageId, slug);
      }
      if (!slug) continue; // page gone/unpublished — don't surface a dead hit
      hits.push({ title: c.documentTitle ?? '', snippet: c.content.slice(0, 320), url: docsUrl(slug), score: c.relevanceScore });
    }
    return { hits };
  },

  /** One published doc by slug — title, full text (BASE locale — see search
   *  note), /docs URL. */
  get: async (args: Record<string, unknown>) => {
    const slug = typeof args.slug === 'string' ? args.slug : '';
    if (!slug) return { doc: null };
    for (const { orgId } of await docsCollections(scope.tenantId, caller)) {
      const hit = await getPublishedBySlug(scope.tenantId, orgId, slug);
      if (hit && hit.page.collection === 'docs') {
        return { doc: { slug: hit.page.slug, title: hit.page.title, text: flattenSections(hit.page), url: docsUrl(hit.page.slug) } };
      }
    }
    return { doc: null };
  },
  };
};

/** Find a page id across the tenant's docs orgs (published only). */
async function resolvePageAcross(
  tenantId: string,
  collections: Array<{ collectionId: string; orgId: string }>,
  pageId: string,
): Promise<{ slug: string } | null> {
  for (const { orgId } of collections) {
    const page = await getPage(tenantId, orgId, pageId);
    if (page && page.status === 'published' && page.collection === 'docs') return { slug: page.slug };
  }
  return null;
}
