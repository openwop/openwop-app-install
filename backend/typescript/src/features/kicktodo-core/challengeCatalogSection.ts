/**
 * ADR 0641 phase 4 — the `challengeCatalog` content section.
 *
 * ONE registered resolver serves BOTH jobs decision 5 identified:
 *
 *   cms.page carrying a `challengeCatalog` section
 *     → this resolver, registered at feature init
 *     → prerenderService resolves it SERVER-SIDE   → crawlable, anonymous
 *     → SectionRenderer renders it CLIENT-SIDE     → interactive for humans
 *     → CMS never imports the feature              → no cross-feature edge
 *
 * The registry is an inversion, which is why it closes with no kernel migration
 * and no new primitive: the FEATURE registers, `host/contentDataSources.ts`
 * holds only the map, and `publishing` calls through it without knowing KickTodo
 * exists.
 *
 * REGISTERED ESSENTIAL. An acquisition page whose catalog resolves empty is a
 * well-formed indexed document listing zero challenges, and every check we have
 * passes it. See `EssentialSectionUnresolved`.
 *
 * The section's target org rides its OWN `data`, not `ContentResolveContext`:
 * `contentDataSources.ts` documents `pageTenantId` as informational and
 * best-effort, so a resolver that enforced same-tenant on it would be enforcing
 * on a field its own contract says not to trust. The org in `data` is what the
 * page author chose to publish, and it resolves through the same public gate an
 * anonymous HTTP caller would hit — so the section can never surface anything
 * the anonymous wire would not.
 */

import { registerContentSectionResolver, type ContentResolveContext, type ResolvedContentSection } from '../../host/contentDataSources.js';
import { publicChallengeCatalog } from './publicCatalogService.js';

export const CHALLENGE_CATALOG_SECTION_TYPE = 'challengeCatalog';

export async function resolveChallengeCatalogSection(
  data: Record<string, unknown>,
  ctx: ContentResolveContext,
): Promise<ResolvedContentSection | null> {
  const orgId = typeof data.orgId === 'string' ? data.orgId.trim() : '';
  // Declining on a missing orgId rather than defaulting to the page's tenant:
  // a default here would silently publish SOME org's catalog on a page whose
  // author never named one. Under `essential` this decline fails the page,
  // which is the honest outcome for a misconfigured acquisition surface.
  if (!orgId) return null;

  // Same door an anonymous HTTP caller uses — published-only, toggle-gated on
  // the org's server-resolved tenant, scalar-projected. Calling the public
  // service rather than the store is what makes no-cloaking true BY
  // CONSTRUCTION: the crawler cannot be shown anything a visitor could not get.
  const catalog = await publicChallengeCatalog(orgId, ctx.locale);

  return {
    items: catalog.challenges.map((c) => ({
      title: c.title,
      body: c.summary,
      // `href` stays absent. `contentDataSources.ts` records why: "entities have
      // no public page routes; the entityDetail slug-binding deferral". Emitting
      // a guessed URL here would put a 404 in a crawlable document — worse than
      // an unlinked entry. The deferral is real and is not this phase's to close.
    })),
  };
}

/** Called at feature init. Separate from the resolver so tests can exercise the
 *  resolver without touching the process-wide registry. */
export function registerChallengeCatalogSection(): void {
  registerContentSectionResolver(CHALLENGE_CATALOG_SECTION_TYPE, resolveChallengeCatalogSection, {
    essential: true,
  });
}
